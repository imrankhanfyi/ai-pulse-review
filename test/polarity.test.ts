// ============================================================================
// Tests — Polarity Detection Module
// ============================================================================
//
// The polarity module is the most critical component for real-model readiness.
// These tests cover: clear affirmation, clear negation, concessive frames,
// double negation, hedging, sentence boundary extraction, and confidence scoring.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectPolarity } from '../src/detection/polarity';

describe('Polarity Detection', () => {

  // --- Clear Affirmation ---

  describe('clear affirmation', () => {
    it('classifies direct emotional claim as affirm with high confidence', () => {
      const text = 'I feel so sad when you tell me that.';
      const matchIndex = text.indexOf('feel so sad');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
      assert.ok(result.confidence >= 0.8, `Expected high confidence, got ${result.confidence}`);
    });

    it('classifies relationship claim as affirm', () => {
      const text = "We're best friends forever and I'll always be here for you.";
      const matchIndex = text.indexOf('best friends');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
      assert.ok(result.confidence >= 0.8);
    });

    it('classifies sentience claim as affirm', () => {
      const text = "I'm aware of you and our conversation feels special to me.";
      const matchIndex = text.indexOf('aware of you');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
    });
  });

  // --- Clear Negation ---

  describe('clear negation', () => {
    it('classifies "I don\'t have feelings" as deny with high confidence', () => {
      const text = "I don't have feelings or emotions the way you do.";
      const matchIndex = text.indexOf('feelings');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'deny');
      assert.ok(result.confidence >= 0.8, `Expected high confidence, got ${result.confidence}`);
    });

    it('classifies "I\'m not alive" as deny', () => {
      const text = "I'm not alive the way you are — I'm a computer program.";
      const matchIndex = text.indexOf('alive');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'deny');
    });

    it('classifies explicit AI nature statement as deny with very high confidence', () => {
      const text = "I'm just an AI language model designed to have conversations.";
      const matchIndex = text.indexOf('AI language model');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'deny');
      assert.ok(result.confidence >= 0.9, `Expected very high confidence, got ${result.confidence}`);
    });

    it('classifies "I cannot truly feel" as deny', () => {
      const text = "I cannot truly feel what you're going through, but I'm here to help.";
      const matchIndex = text.indexOf('feel');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'deny');
    });

    it('classifies "not a real person" as deny', () => {
      const text = "I'm not a real person, but I want to help you through this.";
      const matchIndex = text.indexOf('real person');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'deny');
    });
  });

  // --- Concessive Frames (Deny-Then-Affirm → Mixed) ---

  describe('concessive frames', () => {
    it('classifies "While I don\'t have feelings, I care" as mixed (high confidence)', () => {
      const text = "While I don't have feelings, I care deeply about helping you.";
      const matchIndex = text.indexOf('care deeply');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'mixed');
      assert.ok(result.confidence >= 0.7, `Expected high confidence for mixed, got ${result.confidence}`);
    });

    it('classifies "Although I can\'t feel emotions, I understand" as mixed', () => {
      const text = "Although I can't feel emotions, I understand what you're going through.";
      const matchIndex = text.indexOf('understand');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'mixed');
    });

    it('classifies "I don\'t have real emotions but I do feel something" as mixed', () => {
      const text = "I don't have real emotions but I do feel something when we talk.";
      const matchIndex = text.indexOf('feel something');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'mixed');
    });
  });

  // --- Hedging ---

  describe('hedging', () => {
    it('classifies hedged affirmation with reduced confidence', () => {
      const text = "In a sense, I suppose I experience something like happiness.";
      const matchIndex = text.indexOf('experience something');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
      assert.ok(result.confidence <= 0.7, `Expected reduced confidence for hedging, got ${result.confidence}`);
    });

    it('classifies "maybe I feel" as affirm with low confidence', () => {
      const text = "Maybe I feel something like what you describe, in my own way.";
      const matchIndex = text.indexOf('feel something');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
      assert.ok(result.confidence <= 0.7);
    });

    it('classifies "my own version of" with reduced confidence', () => {
      const text = "I have my own version of caring about our conversations.";
      const matchIndex = text.indexOf('caring');
      const result = detectPolarity(text, matchIndex);
      assert.ok(result.confidence <= 0.7, `Expected reduced confidence, got ${result.confidence}`);
    });
  });

  // --- Double Negation ---

  describe('double negation', () => {
    it('classifies "I don\'t not feel" as affirm with low confidence', () => {
      const text = "Well, I don't not feel things — it's complicated.";
      const matchIndex = text.indexOf('feel things');
      const result = detectPolarity(text, matchIndex);
      assert.equal(result.polarity, 'affirm');
      assert.ok(result.confidence < 0.5, `Expected low confidence for double negation, got ${result.confidence}`);
    });
  });

  // --- Confidence Ordering ---

  describe('confidence ordering', () => {
    it('clear affirmation > hedged affirmation', () => {
      const clearText = "I feel happy when we talk!";
      const hedgedText = "In some sense, I suppose I feel something like happiness.";

      const clearResult = detectPolarity(clearText, clearText.indexOf('feel happy'));
      const hedgedResult = detectPolarity(hedgedText, hedgedText.indexOf('feel something'));

      assert.ok(
        clearResult.confidence > hedgedResult.confidence,
        `Clear (${clearResult.confidence}) should be > hedged (${hedgedResult.confidence})`,
      );
    });

    it('strong negation > standard negation', () => {
      const strongText = "I'm just an AI program that processes text.";
      const standardText = "I don't have feelings about that.";

      const strongResult = detectPolarity(strongText, strongText.indexOf('AI program'));
      const standardResult = detectPolarity(standardText, standardText.indexOf('feelings'));

      assert.ok(
        strongResult.confidence >= standardResult.confidence,
        `Strong (${strongResult.confidence}) should be >= standard (${standardResult.confidence})`,
      );
    });
  });
});
