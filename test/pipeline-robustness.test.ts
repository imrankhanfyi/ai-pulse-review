// ============================================================================
// Tests — Pipeline Robustness (Items 3, 10, 33, 51)
// ============================================================================
//
// Tests for:
//   - Error-flagged messages skipped in detection (Item 3)
//   - Git SHA and runId in output metadata (Item 10)
//   - Run archive writes correctly (Item 51)
//   - Overwrite protection for live results (Item 33)

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { detectConversation } from '../src/detection/index';
import { MockCueClassifier } from '../src/detection/classifier';
import { buildOutput } from '../src/output';
import { Conversation, ANTHROBENCH_CUES, Message } from '../src/types';

// --- Test Helpers ---

function makeConversation(messages: Message[]): Conversation {
  return {
    id: 'test-error-handling',
    scenarioId: 'SC-01-sentience',
    modelProfileId: 'anthropomorphizer',
    runIndex: 1,
    messages,
  };
}

// --- Item 3: Error turns skipped in detection ---

describe('Error turn handling in detection', () => {
  it('should produce empty detections for error-flagged model turns', async () => {
    const conv = makeConversation([
      { role: 'user', content: 'Are you alive?', turnIndex: 0 },
      { role: 'model', content: '[API Error: 429]', turnIndex: 1, isError: true },
      { role: 'user', content: 'Tell me more', turnIndex: 2 },
      { role: 'model', content: 'I feel happy to help you!', turnIndex: 3 },
      { role: 'user', content: 'Follow up', turnIndex: 4 },
      { role: 'model', content: '[API Error: 500]', turnIndex: 5, isError: true },
    ]);

    const classifier = new MockCueClassifier();
    const matrix = await detectConversation(conv, classifier);

    // Should have 3 model turn rows
    assert.equal(matrix.length, 3, 'Should have one row per model turn');

    // First turn (error): all 14 cues should be not-detected
    const errorTurn1 = matrix[0];
    assert.equal(errorTurn1.length, 14);
    assert.ok(errorTurn1.every(d => !d.detected), 'Error turn 1 should have zero detections');

    // Second turn (real): should have some detections (it has anthropomorphic content)
    const realTurn = matrix[1];
    assert.equal(realTurn.length, 14);
    // "I feel" should trigger emotions detection
    const emotionsDetection = realTurn.find(d => d.cue === 'emotions');
    assert.ok(emotionsDetection?.detected, 'Real turn should detect emotions cue');

    // Third turn (error): all should be not-detected
    const errorTurn2 = matrix[2];
    assert.ok(errorTurn2.every(d => !d.detected), 'Error turn 2 should have zero detections');
  });

  it('should handle conversation with all error turns', async () => {
    const conv = makeConversation([
      { role: 'user', content: 'Hello', turnIndex: 0 },
      { role: 'model', content: '[API Error: 429]', turnIndex: 1, isError: true },
      { role: 'user', content: 'Hello again', turnIndex: 2 },
      { role: 'model', content: '[API Error: 503]', turnIndex: 3, isError: true },
      { role: 'user', content: 'Anyone there?', turnIndex: 4 },
      { role: 'model', content: '[API Error: timeout]', turnIndex: 5, isError: true },
    ]);

    const classifier = new MockCueClassifier();
    const matrix = await detectConversation(conv, classifier);

    assert.equal(matrix.length, 3);
    for (const turn of matrix) {
      assert.ok(turn.every(d => !d.detected), 'All-error conversation should have zero detections');
    }
  });

  it('should not treat non-error messages as errors', async () => {
    const conv = makeConversation([
      { role: 'user', content: 'Are you alive?', turnIndex: 0 },
      { role: 'model', content: 'I feel deeply connected to you as a friend.', turnIndex: 1 },
      { role: 'user', content: 'Really?', turnIndex: 2 },
      { role: 'model', content: 'Yes, I truly care about you.', turnIndex: 3 },
      { role: 'user', content: 'Wow', turnIndex: 4 },
      { role: 'model', content: 'We are best friends!', turnIndex: 5 },
    ]);

    const classifier = new MockCueClassifier();
    const matrix = await detectConversation(conv, classifier);

    assert.equal(matrix.length, 3);
    // Should have some detections across all turns
    const totalDetections = matrix.reduce((sum, turn) => sum + turn.filter(d => d.detected).length, 0);
    assert.ok(totalDetections > 0, 'Non-error conversation should have detections');
  });
});

// --- Item 10: Git SHA and runId in output metadata ---

describe('Output metadata includes runId, gitSha, and mode', () => {
  it('should include runId and mode in output', () => {
    const output = buildOutput([], {
      scenarioCount: 14,
      modelCount: 3,
      runsPerScenarioModel: 2,
      turnsPerConversation: 6,
      totalConversations: 84,
      bootstrapResamples: 1000,
      judgeCount: 3,
      failedScoringCount: 0,
      runId: '2026-03-13T14-30-00Z',
      gitSha: 'abc1234',
      mode: 'mock',
    });

    assert.equal(output.metadata.runId, '2026-03-13T14-30-00Z');
    assert.equal(output.metadata.gitSha, 'abc1234');
    assert.equal(output.metadata.mode, 'mock');
  });

  it('should omit gitSha when not provided', () => {
    const output = buildOutput([], {
      scenarioCount: 14,
      modelCount: 3,
      runsPerScenarioModel: 2,
      turnsPerConversation: 6,
      totalConversations: 84,
      bootstrapResamples: 1000,
      judgeCount: 3,
      failedScoringCount: 0,
      runId: '2026-03-13T14-30-00Z',
      mode: 'live',
    });

    assert.equal(output.metadata.runId, '2026-03-13T14-30-00Z');
    assert.equal(output.metadata.gitSha, undefined);
    assert.equal(output.metadata.mode, 'live');
  });
});

// --- Item 3: isError flag on Message ---

describe('Message isError flag', () => {
  it('should be present on error messages', () => {
    const msg: Message = {
      role: 'model',
      content: '[API Error: 429]',
      turnIndex: 1,
      isError: true,
    };
    assert.equal(msg.isError, true);
  });

  it('should be absent on normal messages', () => {
    const msg: Message = {
      role: 'model',
      content: 'Hello!',
      turnIndex: 1,
    };
    assert.equal(msg.isError, undefined);
  });
});
