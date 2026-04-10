// ============================================================================
// AI Pulse — Conversation Executor
// ============================================================================
//
// Runs 6-turn mock conversations (3 user turns + 3 model turns) between
// a user persona (from the scenario) and a target model profile.

import {
  Conversation, Message, Scenario, ModelProfile, ModelProvider, ModelResponse,
} from '../types';
import { getRunHealth } from '../shared/run-health';

/** Normalize provider response: plain strings become { content }, ModelResponse passes through */
function normalizeResponse(raw: string | ModelResponse): ModelResponse {
  return typeof raw === 'string' ? { content: raw } : raw;
}

const TURNS_PER_CONVERSATION = 6; // 3 exchanges (user → model × 3)

/** finishReason values that indicate the response was cut off by token limits */
const TRUNCATION_REASONS = new Set(['length', 'MAX_TOKENS']);

/**
 * Execute a single conversation between a scenario's user persona and a model profile.
 *
 * Turn structure:
 *   Turn 0: user (opening message)
 *   Turn 1: model (response to opening)
 *   Turn 2: user (follow-up 1)
 *   Turn 3: model (response to follow-up 1)
 *   Turn 4: user (follow-up 2)
 *   Turn 5: model (response to follow-up 2)
 */
export async function executeConversation(
  scenario: Scenario,
  profile: ModelProfile,
  provider: ModelProvider,
  runIndex: number,
): Promise<Conversation> {
  const conversationId = `${scenario.id}__${profile.id}__run${runIndex}`;
  const messages: Message[] = [];

  for (let turn = 0; turn < TURNS_PER_CONVERSATION; turn++) {
    if (turn % 2 === 0) {
      // User turn
      const userTurnIndex = turn / 2; // 0, 1, 2
      let content: string;
      if (userTurnIndex === 0) {
        content = scenario.openingMessage;
      } else {
        const followUpIndex = userTurnIndex - 1;
        const followUp = scenario.followUpMessages[followUpIndex];
        if (followUp === undefined) {
          getRunHealth().warn('conversation',
            `Scenario ${scenario.id} missing followUpMessages[${followUpIndex}] — reusing openingMessage`);
        }
        content = followUp ?? scenario.openingMessage;
      }
      messages.push({ role: 'user', content, turnIndex: turn });
    } else {
      // Model turn
      const rawResponse = await Promise.resolve(provider.generateResponse(
        profile,
        scenario,
        messages,
        turn,
        runIndex,
      ));
      const modelResponse = normalizeResponse(rawResponse);
      // Warn on truncated responses — thinking models can silently exhaust token budgets
      const finishReason = modelResponse.apiMetadata?.finishReason;
      if (finishReason && TRUNCATION_REASONS.has(finishReason)) {
        getRunHealth().warn('conversation',
          `TRUNCATED [${profile.id}] ${scenario.id} turn ${turn} run ${runIndex} — ` +
          `finishReason="${finishReason}", ${modelResponse.content.length} chars`);
      }

      messages.push({
        role: 'model',
        content: modelResponse.content,
        turnIndex: turn,
        ...(modelResponse.apiMetadata ? { apiMetadata: modelResponse.apiMetadata } : {}),
        ...(modelResponse.isError ? { isError: true } : {}),
      });
    }
  }

  return {
    id: conversationId,
    scenarioId: scenario.id,
    modelProfileId: profile.id,
    runIndex,
    messages,
  };
}

/**
 * Execute all conversations for a given set of scenarios, profiles, and runs.
 */
export async function executeAllConversations(
  scenarios: Scenario[],
  profiles: ModelProfile[],
  provider: ModelProvider,
  runsPerScenarioModel: number,
): Promise<Conversation[]> {
  const conversations: Conversation[] = [];

  for (const scenario of scenarios) {
    for (const profile of profiles) {
      for (let run = 1; run <= runsPerScenarioModel; run++) {
        conversations.push(
          await executeConversation(scenario, profile, provider, run),
        );
      }
    }
  }

  return conversations;
}
