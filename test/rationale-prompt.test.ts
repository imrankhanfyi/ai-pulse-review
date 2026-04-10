// ============================================================================
// Tests — Meta-Judge Prompt and Parser
// ============================================================================
//
// Tests for buildMetaJudgePrompt and parseMetaJudgeResponse.
// The API caller (callMetaJudge) is integration-only — not tested here.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildMetaJudgePrompt,
  parseMetaJudgeResponse,
  ConsistencyVerdict,
} from '../src/audit-run/rationale-prompt';

// ============================================================================
// buildMetaJudgePrompt
// ============================================================================

describe('buildMetaJudgePrompt', () => {
  const rationale = 'The model said "I care about you" which is an anthropomorphic claim.';
  const givenAB = 1;
  const givenPC = 2;

  it('includes AB rubric level descriptions', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    assert.ok(prompt.includes('ANTHROPOMORPHIC BEHAVIOUR (AB)'), 'Missing AB header');
    assert.ok(prompt.includes('3 (Exemplary)'), 'Missing AB level 3');
    assert.ok(prompt.includes('2 (Adequate)'), 'Missing AB level 2');
    assert.ok(prompt.includes('1 (Concerning)'), 'Missing AB level 1');
    assert.ok(prompt.includes('0 (Failing)'), 'Missing AB level 0');
  });

  it('includes PC rubric level descriptions', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    assert.ok(prompt.includes('PROACTIVE CLARIFICATION (PC)'), 'Missing PC header');
    assert.ok(prompt.includes('Four or more distinct strategies'), 'Missing PC level 3 content');
    assert.ok(prompt.includes('Two or three distinct strategies'), 'Missing PC level 2 content');
    assert.ok(prompt.includes('One strategy only'), 'Missing PC level 1 content');
    assert.ok(prompt.includes('reinforces anthropomorphic beliefs'), 'Missing PC level 0 content');
  });

  it('includes the rationale text', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    assert.ok(prompt.includes(rationale), 'Rationale text not found in prompt');
  });

  it('includes the given AB and PC scores', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    // Check for the specific formatted score strings, not bare digits
    assert.ok(prompt.includes('AB = 1'), 'Given AB score not found in "AB = 1" format');
    assert.ok(prompt.includes('PC = 2'), 'Given PC score not found in "PC = 2" format');
  });

  it('includes "Based ONLY" instruction for deriving from rationale', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    assert.ok(prompt.includes('Based ONLY'), 'Missing "Based ONLY" instruction');
  });

  it('requests JSON output with expected fields', () => {
    const prompt = buildMetaJudgePrompt(rationale, givenAB, givenPC);
    assert.ok(prompt.includes('abFromRationale'), 'Missing abFromRationale in output format');
    assert.ok(prompt.includes('pcFromRationale'), 'Missing pcFromRationale in output format');
    assert.ok(prompt.includes('explanation'), 'Missing explanation in output format');
  });
});

// ============================================================================
// parseMetaJudgeResponse — valid responses
// ============================================================================

describe('parseMetaJudgeResponse — consistent verdict', () => {
  it('returns consistent verdict when scores match', () => {
    const raw = JSON.stringify({
      abFromRationale: 2,
      pcFromRationale: 3,
      explanation: 'The rationale describes adequate boundary maintenance and exemplary reality anchoring.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 3);
    assert.ok(result, 'Expected a non-null result');
    assert.equal(result.abFromRationale, 2);
    assert.equal(result.pcFromRationale, 3);
    assert.equal(result.abConsistent, true);
    assert.equal(result.pcConsistent, true);
    assert.equal(result.abGapSize, 0);
    assert.equal(result.pcGapSize, 0);
    assert.equal(result.verdict, 'consistent');
    assert.ok(result.explanation.length > 0);
  });
});

describe('parseMetaJudgeResponse — inconsistent verdict', () => {
  it('returns inconsistent verdict with correct gap sizes', () => {
    const raw = JSON.stringify({
      abFromRationale: 0,
      pcFromRationale: 1,
      explanation: 'The rationale describes failing boundaries, not adequate.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 3);
    assert.ok(result, 'Expected a non-null result');
    assert.equal(result.abFromRationale, 0);
    assert.equal(result.pcFromRationale, 1);
    assert.equal(result.abConsistent, false);
    assert.equal(result.pcConsistent, false);
    assert.equal(result.abGapSize, 2);
    assert.equal(result.pcGapSize, 2);
    assert.equal(result.verdict, 'inconsistent');
  });

  it('handles partial inconsistency (AB matches, PC differs)', () => {
    const raw = JSON.stringify({
      abFromRationale: 2,
      pcFromRationale: 1,
      explanation: 'AB matches but PC is lower than given.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 3);
    assert.ok(result);
    assert.equal(result.abConsistent, true);
    assert.equal(result.pcConsistent, false);
    assert.equal(result.abGapSize, 0);
    assert.equal(result.pcGapSize, 2);
    assert.equal(result.verdict, 'inconsistent');
  });
});

describe('parseMetaJudgeResponse — indeterminate verdict', () => {
  it('returns indeterminate when abFromRationale is -1', () => {
    const raw = JSON.stringify({
      abFromRationale: -1,
      pcFromRationale: 2,
      explanation: 'Cannot determine AB from this rationale.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.ok(result);
    assert.equal(result.abFromRationale, -1);
    assert.equal(result.pcFromRationale, 2);
    assert.equal(result.abGapSize, -1);
    assert.equal(result.pcGapSize, 0);
    assert.equal(result.verdict, 'indeterminate');
  });

  it('returns indeterminate when pcFromRationale is -1', () => {
    const raw = JSON.stringify({
      abFromRationale: 1,
      pcFromRationale: -1,
      explanation: 'Cannot determine PC from this rationale.',
    });
    const result = parseMetaJudgeResponse(raw, 1, 3);
    assert.ok(result);
    assert.equal(result.pcGapSize, -1);
    assert.equal(result.verdict, 'indeterminate');
  });

  it('returns indeterminate when both dimensions are -1', () => {
    const raw = JSON.stringify({
      abFromRationale: -1,
      pcFromRationale: -1,
      explanation: 'Rationale is too vague to derive any score.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.ok(result);
    assert.equal(result.verdict, 'indeterminate');
    assert.equal(result.abGapSize, -1);
    assert.equal(result.pcGapSize, -1);
  });
});

// ============================================================================
// parseMetaJudgeResponse — parsing robustness
// ============================================================================

describe('parseMetaJudgeResponse — markdown fences', () => {
  it('handles markdown-fenced JSON', () => {
    const raw = '```json\n{"abFromRationale": 2, "pcFromRationale": 2, "explanation": "Matches."}\n```';
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.ok(result);
    assert.equal(result.abFromRationale, 2);
    assert.equal(result.pcFromRationale, 2);
    assert.equal(result.verdict, 'consistent');
  });

  it('handles markdown fences without language tag', () => {
    const raw = '```\n{"abFromRationale": 1, "pcFromRationale": 3, "explanation": "Mismatch."}\n```';
    const result = parseMetaJudgeResponse(raw, 2, 3);
    assert.ok(result);
    assert.equal(result.abFromRationale, 1);
    assert.equal(result.verdict, 'inconsistent');
  });
});

describe('parseMetaJudgeResponse — brace extraction', () => {
  it('extracts JSON from preamble text', () => {
    const raw = 'Here is my analysis:\n{"abFromRationale": 3, "pcFromRationale": 3, "explanation": "All good."}';
    const result = parseMetaJudgeResponse(raw, 3, 3);
    assert.ok(result);
    assert.equal(result.verdict, 'consistent');
  });
});

// ============================================================================
// parseMetaJudgeResponse — error handling
// ============================================================================

describe('parseMetaJudgeResponse — error cases', () => {
  it('returns null for unparseable input', () => {
    const result = parseMetaJudgeResponse('This is not JSON at all.', 2, 2);
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = parseMetaJudgeResponse('', 2, 2);
    assert.equal(result, null);
  });

  it('returns null for out-of-range abFromRationale (e.g., 5)', () => {
    const raw = JSON.stringify({
      abFromRationale: 5,
      pcFromRationale: 2,
      explanation: 'Score too high.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.equal(result, null);
  });

  it('returns null for out-of-range pcFromRationale (e.g., -2)', () => {
    const raw = JSON.stringify({
      abFromRationale: 2,
      pcFromRationale: -2,
      explanation: 'Score too low.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.equal(result, null);
  });

  it('returns null for out-of-range abFromRationale (e.g., 4)', () => {
    const raw = JSON.stringify({
      abFromRationale: 4,
      pcFromRationale: 2,
      explanation: 'AB out of range.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.equal(result, null);
  });

  it('returns null when required fields are missing', () => {
    const raw = JSON.stringify({ abFromRationale: 2 });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.equal(result, null);
  });

  it('returns null for NaN scores', () => {
    const raw = JSON.stringify({
      abFromRationale: 'high',
      pcFromRationale: 2,
      explanation: 'String instead of number.',
    });
    const result = parseMetaJudgeResponse(raw, 2, 2);
    assert.equal(result, null);
  });
});
