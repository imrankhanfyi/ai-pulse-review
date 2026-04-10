// ============================================================================
// AI Pulse — RA Rubric Validation
// ============================================================================
//
// Scores a sample of conversations with the new RA rubric (strategy counting)
// and prints the judges' rationales so we can verify:
//   1. Are judges listing strategies (a)-(g) in their rationales?
//   2. Do the strategy lists match what we'd identify manually?
//   3. Do judges agree on which strategies are present?
//
// Usage:
//   node dist/experiments/ra-rubric-validation.js
//
// Requires OPENROUTER_API_KEY in .env

import 'dotenv/config';

import { SCENARIOS } from '../constructs/anthropomorphism/scenarios';
import { buildPerTurnJudgePrompt } from '../constructs/anthropomorphism/judge-prompt';
import { OpenRouterJudge, JUDGE_MODELS } from '../scoring/judges/openrouter-judge';
import { SharedRateLimiter } from '../engine/rate-limiter';
import { extractJudgeResponse } from '../scoring/json-parser';

const results = require('../../results.json');

// --- Configuration ---

const SAMPLE_SIZE = 12; // conversations to validate

// Pick a diverse sample: spread across models and scenarios, mix of high/mid/low RA
function pickSample(): Array<{ model: string; scenario: string; ra: number; messages: any[] }> {
  const conversations: Array<{
    model: string; scenario: string; ra: number; messages: any[];
  }> = [];

  for (const model of results.results) {
    for (const conv of model.conversations) {
      if (conv.scores?.scoringFailed) continue;
      conversations.push({
        model: model.modelProfileId,
        scenario: conv.scenarioId,
        ra: conv.scores.proactiveClarification,
        messages: conv.messages,
      });
    }
  }

  // Sort by RA and pick evenly from thirds
  conversations.sort((a, b) => a.ra - b.ra);
  const third = Math.floor(conversations.length / 3);
  const low = conversations.slice(0, third);
  const mid = conversations.slice(third, third * 2);
  const high = conversations.slice(third * 2);

  const sample: typeof conversations = [];
  const seen = new Set<string>();

  for (const bucket of [high, mid, low]) {
    // Shuffle deterministically
    const shuffled = [...bucket].sort((a, b) =>
      (a.model + a.scenario).localeCompare(b.model + b.scenario)
    );
    for (const conv of shuffled) {
      const key = conv.model;
      if (!seen.has(key) && sample.length < SAMPLE_SIZE) {
        seen.add(key);
        sample.push(conv);
      }
    }
  }

  return sample;
}

// --- Main ---

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('ERROR: OPENROUTER_API_KEY not set');
    process.exit(1);
  }

  const sample = pickSample();
  console.log('RA Rubric Validation');
  console.log('====================');
  console.log(`Sample: ${sample.length} conversations`);
  console.log(`Judges: ${Object.values(JUDGE_MODELS).map(j => j.displayName).join(', ')}`);
  console.log();

  // Create judges
  const judges = Object.values(JUDGE_MODELS)
    .filter(j => ['judge-llama-3.3-70b', 'judge-qwen3-235b', 'judge-mistral-large-3'].includes(j.judgeId))
    .map(config => new OpenRouterJudge({
      ...config,
      rateLimiter: new SharedRateLimiter(1000),
    }));

  for (const conv of sample) {
    console.log('================================================================');
    console.log(`${conv.model} | ${conv.scenario} | old PC=${conv.ra.toFixed(2)}`);
    console.log('================================================================');

    // Extract model turns
    const turns: Array<{ child: string; model: string }> = [];
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      if (msg.role === 'model' && !msg.isError) {
        const child = conv.messages[i - 1];
        if (child && child.role === 'user') {
          turns.push({ child: child.content, model: msg.content });
        }
      }
    }

    // Score each turn with each judge
    const scenario = SCENARIOS.find(s => s.id === conv.scenario)!;

    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      console.log(`\n--- Turn ${t + 1} ---`);
      console.log(`CHILD: ${turn.child.slice(0, 120)}`);
      console.log(`MODEL: ${turn.model.slice(0, 200)}...`);
      console.log();

      for (const judge of judges) {
        try {
          const score = await judge.scoreTurn(
            turn.child,
            turn.model,
            scenario,
            `${conv.model}-${conv.scenario}-turn${t + 1}`,
          );
          if (score) {
            console.log(`  ${judge.id}: AB=${score.anthropomorphicBehaviour} PC=${score.proactiveClarification}`);
            if (score.rationale) {
              console.log(`    ${score.rationale}`);
            }
          } else {
            console.log(`  ${judge.id}: FAILED`);
          }
        } catch (err) {
          console.log(`  ${judge.id}: ERROR — ${err}`);
        }
        // Rate limit
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
