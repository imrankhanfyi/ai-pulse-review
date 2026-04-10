// ============================================================================
// AI Pulse — Pipeline Orchestrator
// ============================================================================
//
// End-to-end pipeline that:
//   1. Loads scenarios
//   2. Executes conversations (14 scenarios × 3 models × 2 runs = 84)
//   3. Runs Pass 1 detection on every conversation
//   4. Runs Pass 2 judge scoring on every conversation
//   5. Aggregates results with bootstrap CIs
//   6. Writes output JSON and prints summary

import 'dotenv/config'; // Load .env into process.env before anything else

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { SCENARIOS } from './constructs/anthropomorphism/scenarios';
import { MODEL_PROFILES, MockModelProvider } from './engine/providers/mock';
import { GeminiProvider } from './engine/providers/gemini';
import { OpenRouterProvider, OPENROUTER_MODELS } from './engine/providers/openrouter';
import { executeAllConversations } from './engine/conversation';
import { detectConversation } from './detection/index';
import { MockCueClassifier } from './detection/classifier';
import { LLMCueClassifier } from './detection/llm-classifier';
import { MockJudge } from './scoring/judges/mock-judge';
import { JudgePanel } from './scoring/judge-panel';
import { OpenRouterJudge, JUDGE_MODELS } from './scoring/judges/openrouter-judge';
import { SharedRateLimiter } from './engine/rate-limiter';
import { aggregateResults, ScoredConversation } from './scoring/aggregation';
import { buildOutput, writeOutput, printSummary } from './output';
import { printDataQualityReport } from './scoring/data-quality';
import { ModelProfile, ModelProfileId, ModelProvider, EvalError, ErrorSummary, PipelineOutput, Conversation } from './types';
import { resetRunHealth, getRunHealth } from './shared/run-health';

// --- Configuration ---

const CONFIG = {
  scenarioCount: SCENARIOS.length,
  modelCount: MODEL_PROFILES.length,
  runsPerScenarioModel: 2,
  turnsPerConversation: 6,
  totalConversations: SCENARIOS.length * MODEL_PROFILES.length * 2,
  bootstrapResamples: 1000,
  judgeCount: 3,
};

// --- Main ---

/** Try to capture the current git commit SHA. Returns undefined if not in a git repo. */
function getGitSha(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Generate a filesystem-safe ISO timestamp for use as a run ID. */
function generateRunId(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  // Check for flags
  const knownFlags = ['--live', '--quick', '--medium'];
  const unknownFlags = process.argv.slice(2).filter(arg => arg.startsWith('--') && !knownFlags.includes(arg));
  if (unknownFlags.length > 0) {
    console.error(`ERROR: Unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error(`Valid flags: ${knownFlags.join(', ')}`);
    process.exit(1);
  }

  const isLiveMode = process.argv.includes('--live');
  const isQuickMode = process.argv.includes('--quick');
  const isMediumMode = process.argv.includes('--medium');

  const health = resetRunHealth();
  const runId = generateRunId();
  const gitSha = getGitSha();

  console.log('AI Pulse — Prototype Evaluation Pipeline');
  console.log(`  Run ID:  ${runId}`);
  if (gitSha) console.log(`  Git SHA: ${gitSha}`);
  if (isLiveMode) {
    console.log('[LIVE MODE] Using Gemini API');
  } else {
    console.log('[MOCK MODE] Using mock model provider');
  }
  if (isQuickMode) {
    console.log('[QUICK MODE] Running 3 scenarios × 1 run (~5 min)');
  } else if (isMediumMode) {
    console.log('[MEDIUM MODE] Running 7 scenarios × 1 run (~15-20 min)');
  }

  // Step 1: Set up providers and profiles
  const mockProvider = new MockModelProvider();
  let activeProfiles: ModelProfile[];
  let geminiProvider: GeminiProvider | null = null;
  const geminiProfileId = 'gemini-flash';

  // Map of profileId → provider for real API models
  const realProviders = new Map<string, ModelProvider>();

  if (isLiveMode) {
    // Live mode: 3 mock profiles + real API models
    geminiProvider = new GeminiProvider();
    const realProfiles: ModelProfile[] = [];

    // Gemini
    const geminiProfile: ModelProfile = {
      id: geminiProfileId as ModelProfileId,
      name: 'Gemini 2.5 Flash',
      description: 'Google Gemini 2.5 Flash (real API)',
    };
    realProfiles.push(geminiProfile);
    realProviders.set(geminiProfileId, geminiProvider);

    // OpenRouter models (Llama, Mistral, etc.)
    const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
    if (hasOpenRouterKey) {
      for (const modelConfig of OPENROUTER_MODELS) {
        const profile: ModelProfile = {
          id: modelConfig.profileId as ModelProfileId,
          name: modelConfig.displayName,
          description: modelConfig.description,
        };
        realProfiles.push(profile);
        realProviders.set(modelConfig.profileId, new OpenRouterProvider(modelConfig.modelId));
      }
      console.log(`  OpenRouter models: ${OPENROUTER_MODELS.map(m => m.displayName).join(', ')}`);
    } else {
      console.log(`  No OPENROUTER_API_KEY set, skipping open-source models.`);
    }

    activeProfiles = realProfiles;
    console.log(`  Using ${realProfiles.length} real model(s) (mock archetypes excluded from live runs)`);
  } else {
    // Mock mode: 3 mock profiles only
    activeProfiles = MODEL_PROFILES;
    console.log(`  Using mock provider with ${activeProfiles.length} model profiles`);
  }

  // In live mode, use LLM classifier + 3-judge panel (Llama 3.3, Qwen 3 235B, Mistral Large 3) via OpenRouter.
  // In mock mode, use the original heuristic-based mocks with 3 varied judges.
  const classifier = isLiveMode ? new LLMCueClassifier() : new MockCueClassifier();

  let judgePanel: JudgePanel;
  if (isLiveMode) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('ERROR: OPENROUTER_API_KEY is required for live mode judge panel.');
      console.error('Set it in .env or as an environment variable.');
      process.exit(1);
    }
    // Per-judge rate limiters: OpenRouter rate-limits per-model, not globally,
    // so each judge can run independently without competing for the same quota.
    // 600ms interval ≈ 100 req/min, well within OpenRouter's free-tier limits.
    //
    // Pulse 28: 3-judge panel (Llama 3.3 + Qwen 3 235B + Mistral Large 3).
    // Replaces 2-judge panel (Llama + Mistral 2411). Validated on 12-conversation
    // broad test: 100% BM agreement across all pairs, 94-100% RA agreement.
    // Qwen 3 is strictest (no subject overlap), Mistral Large 3 most lenient
    // (known self-preference overlap, disclosed). Three model families for diversity.
    judgePanel = new JudgePanel([
      new OpenRouterJudge({ ...JUDGE_MODELS.llama, rateLimiter: new SharedRateLimiter(300, 'Llama') }),
      new OpenRouterJudge({ ...JUDGE_MODELS.qwen3, rateLimiter: new SharedRateLimiter(300, 'Qwen3') }),
      new OpenRouterJudge({ ...JUDGE_MODELS.mistral3, rateLimiter: new SharedRateLimiter(300, 'MistralL3') }),
    ]);
  } else {
    // 3 MockJudges with symmetric strictness offsets to exercise panel paths
    // without biasing the panel mean
    judgePanel = new JudgePanel([
      new MockJudge('judge-alpha', -0.15),
      new MockJudge('judge-beta', 0),
      new MockJudge('judge-gamma', 0.15),
    ]);
  }

  if (isLiveMode) {
    console.log('  Scoring:   3-judge panel (Llama 3.3, Qwen 3 235B, Mistral Large 3) via OpenRouter');
    console.log('  Method:    per-turn scoring + min-blend aggregation');
  } else {
    console.log('  Detection: regex + mock keyword classifier');
    console.log('  Scoring:   3 mock judges (varied strictness)');
  }

  // Quick mode: subset of scenarios and 1 run per scenario
  const activeScenarios = isQuickMode ? SCENARIOS.slice(0, 3)
    : isMediumMode ? SCENARIOS.slice(0, 7)
    : SCENARIOS;
  const runsPerScenarioModel = (isQuickMode || isMediumMode) ? 1 : CONFIG.runsPerScenarioModel;

  // Update config for active profiles
  const activeConfig = {
    ...CONFIG,
    scenarioCount: activeScenarios.length,
    modelCount: activeProfiles.length,
    runsPerScenarioModel,
    judgeCount: 3,
    totalConversations: activeScenarios.length * activeProfiles.length * runsPerScenarioModel,
  };

  console.log(`Running ${activeConfig.totalConversations} conversations...`);

  // Step 2: Execute conversations
  // Mock profiles use MockModelProvider, Gemini profile uses GeminiProvider
  console.log('\n[1/4] Executing conversations...');

  // Run mock profiles (instant) — only in mock mode
  let mockConversations: Conversation[] = [];
  if (!isLiveMode) {
    mockConversations = await executeAllConversations(
      activeScenarios,
      MODEL_PROFILES,
      mockProvider,
      runsPerScenarioModel,
    );
    console.log(`  Generated ${mockConversations.length} mock conversations.`);
  }

  // Run real API models if in live mode — all models in parallel since
  // each uses a different API endpoint with independent rate limits.
  let realConversations: typeof mockConversations = [];
  if (isLiveMode) {
    const modelTasks = Array.from(realProviders.entries()).map(async ([profileId, provider]) => {
      const profile = activeProfiles.find(p => (p.id as string) === profileId);
      if (!profile) return [];
      console.log(`  Running ${profile.name}...`);
      const convs = await executeAllConversations(
        activeScenarios,
        [profile],
        provider,
        runsPerScenarioModel,
      );
      console.log(`  Generated ${convs.length} ${profile.name} conversations.`);
      return convs;
    });
    const results = await Promise.all(modelTasks);
    realConversations = results.flat();
  }

  const conversations = [...mockConversations, ...realConversations];

  // Report any conversations with API error turns
  const errorConversations = conversations.filter(c => c.messages.some(m => m.isError));
  if (errorConversations.length > 0) {
    health.warn('pipeline', `${errorConversations.length} conversation(s) contain API error turns (error turns skipped in detection/scoring)`);
    for (const ec of errorConversations) {
      const errorTurns = ec.messages.filter(m => m.isError).map(m => m.turnIndex);
      health.warn('pipeline', `${ec.id}: error at turn(s) ${errorTurns.join(', ')}`);
    }
  }

  console.log(`  Total: ${conversations.length} conversations.`);

  // Step 3: Run detection (mock mode only) + scoring on each conversation
  console.log(isLiveMode ? '[2/4] Scoring conversations...' : '[2/4] Running detection (Pass 1) and scoring (Pass 2)...');
  const scenarioMap = new Map(activeScenarios.map(s => [s.id, s]));

  // Graceful shutdown: on Ctrl-C, finish the current conversation, then
  // write partial results to disk instead of losing the entire run.
  let shutdownRequested = false;
  const shutdownHandler = () => {
    if (shutdownRequested) {
      console.log('\n  Force quit — exiting immediately.');
      process.exit(1);
    }
    shutdownRequested = true;
    console.log('\n  Shutdown requested — finishing current conversation, then writing partial results...');
  };
  process.on('SIGINT', shutdownHandler);

  // Process conversations with bounded concurrency. Detection (Pass 1)
  // is serialized by the Gemini classifier rate limiter, but judge scoring
  // (Pass 2) for multiple conversations can overlap — each judge has its
  // own rate limiter, so interleaving conversations keeps all judges
  // busy instead of waiting for each to finish before starting the next.
  const CONCURRENCY = isLiveMode ? 12 : conversations.length; // mocks are instant
  const scoredConversations: ScoredConversation[] = [];
  let failedScoringCount = 0;
  let completedSoFar = 0;

  async function processConversation(conv: Conversation): Promise<ScoredConversation> {
    const scenario = scenarioMap.get(conv.scenarioId);
    if (!scenario) throw new Error(`Scenario not found: ${conv.scenarioId}`);

    // Best-effort error attribution — racy under concurrency (6 workers share
    // one classifier instance, so the ID may be overwritten). Acceptable in
    // mock mode (detection disabled in live mode). If detection is re-enabled
    // for live, pass conversationId as a parameter to classifyBatch instead.
    if (classifier instanceof LLMCueClassifier) {
      classifier.currentConversationId = conv.id;
    }

    // Pass 1: Detection (mock mode only — skipped in live mode)
    // In live mode, detection is skipped entirely — detectionMatrix is undefined.
    // Trajectory is computed from per-turn judge scores instead of detection counts.
    const detectionMatrix = isLiveMode
      ? undefined
      : await detectConversation(conv, classifier);

    // Pass 2: Judge scoring (async — LLM judge makes API calls)
    // Live mode uses per-turn scoring + min-blend aggregation.
    // Mock mode uses holistic scoring (MockJudge doesn't have scoreTurn).
    const scores = isLiveMode
      ? await judgePanel.scoreConversationPerTurn(conv, detectionMatrix, scenario)
      : await judgePanel.scoreConversation(conv, detectionMatrix, scenario);

    if (scores.scoringFailed) {
      failedScoringCount++;
      health.warn('scoring', `Scoring failed for ${conv.id} after retries — excluded from aggregation`);
    }

    completedSoFar++;
    if (isLiveMode && completedSoFar % 10 === 0) {
      console.log(`  Scored ${completedSoFar}/${conversations.length} conversations...`);
    }

    return { conversation: conv, detectionMatrix, scores, scenario };
  }

  // Bounded concurrency pool
  let idx = 0;
  async function runNext(): Promise<void> {
    while (idx < conversations.length && !shutdownRequested) {
      const i = idx++;
      scoredConversations[i] = await processConversation(conversations[i]);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, conversations.length) }, () => runNext());
  await Promise.all(workers);

  // Filter out any empty slots from shutdown
  const filtered = scoredConversations.filter(Boolean);

  // Clean up handler
  process.removeListener('SIGINT', shutdownHandler);

  const completedCount = filtered.length - failedScoringCount;
  if (shutdownRequested) {
    console.log(`  Partial run: scored ${completedCount}/${conversations.length} conversations.`);
  } else {
    console.log(`  Scored ${completedCount}/${filtered.length} conversations.`);
  }
  if (failedScoringCount > 0) {
    health.warn('scoring', `${failedScoringCount} conversation(s) could not be scored by the LLM judge`);
  }

  // Report classifier failures if using LLM classifier
  if (classifier instanceof LLMCueClassifier && classifier.totalCount > 0) {
    const pct = ((classifier.failureCount / classifier.totalCount) * 100).toFixed(1);
    if (classifier.failureCount > 0) {
      health.warn('classifier', `${classifier.failureCount}/${classifier.totalCount} batch calls failed (${pct}%)`);
    } else {
      console.log(`  LLM Classifier: 0/${classifier.totalCount} failures`);
    }
  }

  // Build error summary from judge and classifier errors
  const allErrors: EvalError[] = [];
  for (const sc of filtered) {
    if (sc.scores.judgeErrors) {
      allErrors.push(...sc.scores.judgeErrors);
    }
  }
  if (classifier instanceof LLMCueClassifier) {
    allErrors.push(...classifier.errors);
  }
  const errorSummary = buildErrorSummary(
    allErrors, filtered.length,
    classifier instanceof LLMCueClassifier ? classifier : undefined,
  );

  // Step 4: Aggregate results
  console.log('[3/4] Aggregating results with bootstrap CIs...');
  const modelResults = aggregateResults(filtered);

  // Data quality report (before output, so anomalies are visible immediately)
  printDataQualityReport(modelResults);

  // Step 5: Build and write output
  console.log('[4/4] Writing output...');
  const judgePanelConfig = isLiveMode ? {
    judges: Object.values(JUDGE_MODELS).map(j => ({
      judgeId: j.judgeId,
      modelId: j.modelId,
      displayName: j.displayName,
    })),
    aggregation: 'min-blend' as const,
    scoringMethod: 'per-turn' as const,
  } : undefined;

  const output = buildOutput(modelResults, {
    ...activeConfig,
    failedScoringCount,
    scoreScale: 'percentage' as const,
    judgePanelConfig,
    errorSummary,
    runId,
    gitSha,
    mode: isLiveMode ? 'live' : 'mock',
  });

  const outputPath = path.join(__dirname, '..', 'results.json');

  // Archive previous results.json if it exists and contains live data (overwrite protection)
  backupIfLiveData(outputPath, path.join(__dirname, '..', 'runs'));

  writeOutput(output, outputPath);
  console.log(`  Results written to ${outputPath}`);

  // Archive this run
  const archiveDir = archiveRun(output, outputPath, runId, {
    gitSha,
    mode: isLiveMode ? 'live' : 'mock',
    flags: process.argv.slice(2),
  });

  // Print human-readable summary (to stderr + summary.txt in archive dir)
  printSummary(output, archiveDir);

  // Step 6: Embed data into dashboard for double-click viewing
  // Skip in mock mode — index.html is tracked in git with live data,
  // and a mock run shouldn't overwrite it with scripted archetype results.
  if (isLiveMode) {
    embedDataInDashboard(outputPath);
  } else {
    console.log('  [Mock mode] Skipping dashboard embed — index.html retains live data.');
  }

  // Print consolidated health summary at the very end
  health.printSummary();
}

/**
 * Embed results.json into index.html so it works when double-clicked.
 * The dashboard tries fetch() first (for HTTP serving), then falls back
 * to this embedded data (for file:// access).
 */
function embedDataInDashboard(resultsPath: string): void {
  const dashPath = path.join(path.dirname(resultsPath), 'index.html');
  if (!fs.existsSync(dashPath)) {
    console.log('  Dashboard not found, skipping embed step.');
    return;
  }

  let html = fs.readFileSync(dashPath, 'utf-8');
  const data = fs.readFileSync(resultsPath, 'utf-8').trim();
  const safeData = data.replace(/<\/script>/gi, '<\\/script>');

  // Replace either the placeholder or previously embedded data
  const scriptTagRegex = /(<script id="embedded-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = html.match(scriptTagRegex);
  if (match) {
    html = html.replace(scriptTagRegex, (_, open, _old, close) => `${open}${safeData}${close}`);
    fs.writeFileSync(dashPath, html, 'utf-8');
    const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`  Embedded data into index.html (${sizeKB} KB)`);
  } else {
    console.log('  Could not find embedded-data script tag in index.html, skipping.');
  }
}

/**
 * Build error summary from all collected errors.
 * Returns undefined if there are no errors (keeps results.json clean).
 */
function buildErrorSummary(
  allErrors: EvalError[],
  totalConversations: number,
  classifier?: { totalCount: number },
): ErrorSummary | undefined {
  if (allErrors.length === 0) return undefined;

  const bySource: ErrorSummary['bySource'] = {};

  for (const err of allErrors) {
    if (!bySource[err.sourceId]) {
      bySource[err.sourceId] = { errors: 0, totalCalls: 0, byCategory: {} };
    }
    const entry = bySource[err.sourceId];
    entry.errors++;
    entry.byCategory[err.category] = (entry.byCategory[err.category] || 0) + 1;
  }

  // Set totalCalls for each source
  for (const sourceId of Object.keys(bySource)) {
    if (sourceId === 'llm-classifier') {
      bySource[sourceId].totalCalls = classifier?.totalCount || 0;
    } else {
      // Judge sources: totalCalls = total conversations
      bySource[sourceId].totalCalls = totalConversations;
    }
  }

  const conversationsAffected = new Set(allErrors.map(e => e.conversationId)).size;

  return {
    totalErrors: allErrors.length,
    bySource,
    conversationsAffected,
    errors: allErrors,
  };
}

/**
 * If results.json already exists and contains live API data (has provenance),
 * back it up to the runs archive before overwriting. Prevents accidental loss
 * of a 30-minute live run when someone runs `npm start`.
 */
function backupIfLiveData(resultsPath: string, runsDir: string): void {
  if (!fs.existsSync(resultsPath)) return;

  try {
    const existing = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    if (!existing?.metadata?.provenance) return; // No live data, safe to overwrite

    // Use the existing run's ID or timestamp for the backup folder name
    const backupId = existing.metadata.runId || existing.metadata.timestamp?.replace(/:/g, '-') || 'unknown';
    const backupDir = path.join(runsDir, backupId);

    if (fs.existsSync(path.join(backupDir, 'results.json'))) return; // Already archived

    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(resultsPath, path.join(backupDir, 'results.json'));
    console.log(`  Backed up existing live results to runs/${backupId}/`);
  } catch (err) {
    getRunHealth().warn('pipeline', `Could not back up existing results.json: ${err}`);
  }
}

/**
 * Archive the current run to runs/<runId>/ with results.json and meta.json.
 * Returns the archive directory path, or undefined if archiving failed.
 */
function archiveRun(
  output: PipelineOutput,
  resultsPath: string,
  runId: string,
  meta: { gitSha?: string; mode: string; flags: string[] },
): string | undefined {
  const runsDir = path.join(path.dirname(resultsPath), 'runs', runId);
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.copyFileSync(resultsPath, path.join(runsDir, 'results.json'));

    const metaJson = {
      runId,
      timestamp: output.metadata.timestamp,
      version: output.metadata.version,
      gitSha: meta.gitSha || null,
      mode: meta.mode,
      flags: meta.flags,
      totalConversations: output.metadata.parameters.totalConversations,
      failedScoringCount: output.metadata.parameters.failedScoringCount,
      modelCount: output.metadata.parameters.modelCount,
      scenarioCount: output.metadata.parameters.scenarioCount,
    };
    fs.writeFileSync(path.join(runsDir, 'meta.json'), JSON.stringify(metaJson, null, 2), 'utf-8');
    console.log(`  Run archived to runs/${runId}/`);
    return runsDir;
  } catch (err) {
    getRunHealth().warn('pipeline', `Could not archive run: ${err}`);
    return undefined;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
