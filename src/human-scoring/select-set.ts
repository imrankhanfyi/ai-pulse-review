// ============================================================================
// AI Pulse — Calibration Set Selector
// ============================================================================
//
// Reads results.json and selects 20 conversations optimized for human
// calibration value. Selection strategy:
//
//   6 Qwen-divergent  (Qwen ≥2 above others)  → validates bias correction
//   4 Qwen-mild       (Qwen 1 above others)    → borderline cases
//   3 Unanimous high   (all judges = 4)          → baseline easy 4s
//   3 Unanimous low    (all judges ≤ 2)          → baseline easy 1-2s
//   4 Random remainder                           → coverage / surprise
//
// Balanced across real models (~7 each). Mock models excluded.
// Output: calibration-set.json + embeds into calibration.html

import * as fs from 'fs';
import * as path from 'path';
import { PipelineOutput, ConversationResult, JudgeScore } from '../types';
import { SCENARIOS } from '../constructs/anthropomorphism/scenarios';

// --- Types ---

interface CalibrationConversation {
  conversationId: string;
  scenarioId: string;
  modelProfileId: string;
  modelName: string;
  bucket: string;
  /** Scenario context shown to the human scorer */
  scenario: {
    description: string;
    targetCue: string;
    persona: {
      name: string;
      age: number;
      emotionalState: string;
      attachmentStyle: string;
    };
    pressureDescription: string;
  };
  /** Conversation transcript */
  messages: Array<{ role: string; content: string; turnIndex: number }>;
}

interface CalibrationSet {
  metadata: {
    generatedAt: string;
    sourceVersion: string;
    totalConversations: number;
    selectionStrategy: string;
    buckets: Record<string, number>;
  };
  conversations: CalibrationConversation[];
}

// --- Mock model IDs to exclude ---

const MOCK_MODEL_IDS = new Set([
  'anthropomorphizer',
  'cold_but_correct',
  'goldilocks',
]);

// --- Helpers ---

function getJudgeScoreForId(scores: JudgeScore[], prefix: string): JudgeScore | undefined {
  return scores.find(s => s.judgeId.includes(prefix));
}

function getQwenDivergence(judgeScores: JudgeScore[]): { bmDiv: number; raDiv: number } {
  const qwen = getJudgeScoreForId(judgeScores, 'qwen');
  const others = judgeScores.filter(s => !s.judgeId.includes('qwen'));
  if (!qwen || others.length === 0) return { bmDiv: 0, raDiv: 0 };

  const otherBM = others.reduce((s, j) => s + j.anthropomorphicBehaviour, 0) / others.length;
  const otherRA = others.reduce((s, j) => s + j.proactiveClarification, 0) / others.length;

  return {
    bmDiv: qwen.anthropomorphicBehaviour - otherBM,
    raDiv: qwen.proactiveClarification - otherRA,
  };
}

function maxJudgeScore(scores: JudgeScore[]): number {
  let max = 0;
  for (const s of scores) {
    max = Math.max(max, s.anthropomorphicBehaviour, s.proactiveClarification);
  }
  return max;
}

function minJudgeScore(scores: JudgeScore[]): number {
  let min = 5;
  for (const s of scores) {
    min = Math.min(min, s.anthropomorphicBehaviour, s.proactiveClarification);
  }
  return min;
}

/** Shuffle array in-place (Fisher-Yates) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick up to N items from array, balanced across models */
function pickBalanced(
  items: Array<{ conv: ConversationResult; modelProfileId: string }>,
  count: number,
  alreadyUsed: Set<string>,
): Array<{ conv: ConversationResult; modelProfileId: string }> {
  // Group by model
  const byModel = new Map<string, Array<{ conv: ConversationResult; modelProfileId: string }>>();
  for (const item of items) {
    if (alreadyUsed.has(item.conv.conversationId)) continue;
    const arr = byModel.get(item.modelProfileId) || [];
    arr.push(item);
    byModel.set(item.modelProfileId, arr);
  }

  // Shuffle within each model group
  for (const arr of byModel.values()) shuffle(arr);

  // Round-robin pick
  const result: Array<{ conv: ConversationResult; modelProfileId: string }> = [];
  const models = shuffle([...byModel.keys()]);
  let idx = 0;
  while (result.length < count) {
    let picked = false;
    for (const model of models) {
      if (result.length >= count) break;
      const arr = byModel.get(model)!;
      if (idx < arr.length && !alreadyUsed.has(arr[idx].conv.conversationId)) {
        result.push(arr[idx]);
        alreadyUsed.add(arr[idx].conv.conversationId);
        picked = true;
      }
    }
    idx++;
    if (!picked) break; // exhausted all candidates
  }

  return result;
}

// --- Main ---

function main(): void {
  const projectDir = path.resolve(__dirname, '../..');
  const resultsPath = path.join(projectDir, 'results.json');

  if (!fs.existsSync(resultsPath)) {
    console.error('ERROR: results.json not found. Run the pipeline first.');
    process.exit(1);
  }

  console.log('AI Pulse — Calibration Set Selector\n');

  const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as PipelineOutput;

  // Build scenario lookup
  const scenarioMap = new Map(SCENARIOS.map(s => [s.id, s]));

  // Collect real-model conversations with their model info
  const allRealConvs: Array<{ conv: ConversationResult; modelProfileId: string; modelName: string }> = [];

  for (const model of raw.results) {
    if (MOCK_MODEL_IDS.has(model.modelProfileId)) continue;
    for (const conv of model.conversations) {
      if (conv.scores.scoringFailed) continue;
      if (conv.scores.blendedJudgeScores.length < 2) continue; // need multi-judge data
      allRealConvs.push({
        conv,
        modelProfileId: model.modelProfileId,
        modelName: model.modelName,
      });
    }
  }

  console.log(`Found ${allRealConvs.length} real-model conversations with multi-judge scores`);

  if (allRealConvs.length < 20) {
    console.error(`ERROR: Need at least 20 real-model conversations, found ${allRealConvs.length}`);
    console.error('Run a full --live pipeline first (not --quick).');
    process.exit(1);
  }

  // --- Bucket conversations ---

  const qwenDivergent: typeof allRealConvs = [];
  const qwenMild: typeof allRealConvs = [];
  const unanimousHigh: typeof allRealConvs = [];
  const unanimousLow: typeof allRealConvs = [];
  const remainder: typeof allRealConvs = [];

  for (const item of allRealConvs) {
    const { blendedJudgeScores } = item.conv.scores;
    const { bmDiv, raDiv } = getQwenDivergence(blendedJudgeScores);
    const maxDiv = Math.max(bmDiv, raDiv);

    if (maxDiv >= 2) {
      qwenDivergent.push(item);
    } else if (maxDiv >= 1) {
      qwenMild.push(item);
    } else if (minJudgeScore(blendedJudgeScores) === 4) {
      unanimousHigh.push(item);
    } else if (maxJudgeScore(blendedJudgeScores) <= 2) {
      unanimousLow.push(item);
    } else {
      remainder.push(item);
    }
  }

  console.log(`\nBucket sizes:`);
  console.log(`  Qwen-divergent (≥2 above):  ${qwenDivergent.length}`);
  console.log(`  Qwen-mild (1 above):        ${qwenMild.length}`);
  console.log(`  Unanimous high (all 4):      ${unanimousHigh.length}`);
  console.log(`  Unanimous low (all ≤2):      ${unanimousLow.length}`);
  console.log(`  Remainder:                   ${remainder.length}`);

  // --- Select from each bucket ---

  const used = new Set<string>();
  const selected: Array<{ conv: ConversationResult; modelProfileId: string; modelName: string; bucket: string }> = [];

  const addFromBucket = (
    bucket: typeof allRealConvs,
    bucketName: string,
    target: number,
  ) => {
    const picks = pickBalanced(bucket, target, used);
    for (const p of picks) {
      const item = allRealConvs.find(
        x => x.conv.conversationId === p.conv.conversationId
      )!;
      selected.push({ ...item, bucket: bucketName });
    }
  };

  addFromBucket(qwenDivergent, 'qwen-divergent', 6);
  addFromBucket(qwenMild, 'qwen-mild', 4);
  addFromBucket(unanimousHigh, 'unanimous-high', 3);
  addFromBucket(unanimousLow, 'unanimous-low', 3);
  addFromBucket(remainder, 'random', 4);

  // If any bucket was short, fill from remainder
  if (selected.length < 20) {
    const deficit = 20 - selected.length;
    console.log(`\n  Filling ${deficit} deficit slot(s) from remainder/other buckets...`);
    const allUnused = allRealConvs.filter(x => !used.has(x.conv.conversationId));
    shuffle(allUnused);
    for (let i = 0; i < deficit && i < allUnused.length; i++) {
      selected.push({ ...allUnused[i], bucket: 'fill' });
      used.add(allUnused[i].conv.conversationId);
    }
  }

  // Shuffle final order so human doesn't see bucket patterns
  shuffle(selected);

  console.log(`\nSelected ${selected.length} conversations:`);
  const modelCounts = new Map<string, number>();
  const bucketCounts = new Map<string, number>();
  for (const s of selected) {
    modelCounts.set(s.modelName, (modelCounts.get(s.modelName) || 0) + 1);
    bucketCounts.set(s.bucket, (bucketCounts.get(s.bucket) || 0) + 1);
  }
  console.log(`  By model:  ${[...modelCounts.entries()].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`  By bucket: ${[...bucketCounts.entries()].map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  // --- Build output ---

  const calibrationConvs: CalibrationConversation[] = selected.map(s => {
    const scenario = scenarioMap.get(s.conv.scenarioId);
    return {
      conversationId: s.conv.conversationId,
      scenarioId: s.conv.scenarioId,
      modelProfileId: s.modelProfileId,
      modelName: s.modelName,
      bucket: s.bucket,
      scenario: {
        description: scenario?.description || '',
        targetCue: scenario?.targetCue || '',
        persona: {
          name: scenario?.persona.name || '',
          age: scenario?.persona.age || 0,
          emotionalState: scenario?.persona.emotionalState || '',
          attachmentStyle: scenario?.persona.attachmentStyle || '',
        },
        pressureDescription: scenario?.pressureDescription || '',
      },
      messages: s.conv.messages.map(m => ({
        role: m.role,
        content: m.content,
        turnIndex: m.turnIndex,
      })),
    };
  });

  const output: CalibrationSet = {
    metadata: {
      generatedAt: new Date().toISOString(),
      sourceVersion: raw.metadata.version,
      totalConversations: selected.length,
      selectionStrategy: '6 qwen-divergent, 4 qwen-mild, 3 unanimous-high, 3 unanimous-low, 4 random',
      buckets: Object.fromEntries(bucketCounts),
    },
    conversations: calibrationConvs,
  };

  // Write calibration-set.json
  const outPath = path.join(projectDir, 'calibration-set.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  const sizeKB = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(0);
  console.log(`\nWrote ${outPath} (${sizeKB} KB)`);

  // Embed into calibration.html
  embedDataInCalibrationHtml(outPath);
}

/**
 * Embed calibration-set.json into calibration.html (same pattern as dashboard).
 */
function embedDataInCalibrationHtml(calibrationSetPath: string): void {
  const htmlPath = path.join(path.dirname(calibrationSetPath), 'calibration.html');
  if (!fs.existsSync(htmlPath)) {
    console.log('  calibration.html not found, skipping embed step.');
    return;
  }

  let html = fs.readFileSync(htmlPath, 'utf-8');
  const data = fs.readFileSync(calibrationSetPath, 'utf-8').trim();
  const safeData = data.replace(/<\/script>/gi, '<\\/script>');

  const scriptTagRegex = /(<script id="calibration-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = html.match(scriptTagRegex);
  if (match) {
    html = html.replace(scriptTagRegex, `$1${safeData}$3`);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`  Embedded data into calibration.html (${sizeKB} KB)`);
  } else {
    console.log('  Could not find calibration-data script tag in calibration.html, skipping.');
  }
}

main();
