import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeltaCorrections } from '../src/voice/profile-builder.js';

/**
 * Voice Feedback Loop tests (#21).
 * Tests the pure functions that don't require a DB connection.
 * DB-dependent functions (analyzeEditDeltas, getRecentEditExamples, shouldRebuild)
 * are tested via integration tests.
 */

describe('applyDeltaCorrections', () => {
  const baseAnalysis = {
    greetings: ['Hi', 'Hello', 'Dear'],
    closings: ['Best', 'Regards', 'Sincerely'],
    vocabulary: { project: 10, update: 8, schedule: 5 },
    toneMarkers: {
      formalRatio: 0.3,
      exclamationsPerEmail: 1.2,
      contractionsPerEmail: 3.5,
      emDashesPerEmail: 0.1,
      questionsPerEmail: 0.8,
      avgSentenceLength: 12,
    },
    avgLength: 85,
    formalityScore: 0.25,
  };

  it('returns base analysis unchanged when corrections are empty', () => {
    const empty = { greetings: [], closings: [], toneAdjustments: [], vocabularyOverrides: {}, formalityCorrection: 0 };
    const result = applyDeltaCorrections(baseAnalysis, empty);
    assert.deepEqual(result.greetings, baseAnalysis.greetings);
    assert.deepEqual(result.closings, baseAnalysis.closings);
    assert.equal(result.formalityScore, baseAnalysis.formalityScore);
  });

  it('overrides greetings with corrected ones first', () => {
    const corrections = {
      greetings: ['Hey'],
      closings: [],
      vocabularyOverrides: {},
      formalityCorrection: 0,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.equal(result.greetings[0], 'Hey');
    assert.ok(result.greetings.includes('Hi'));
    assert.ok(result.greetings.includes('Hello'));
    // 'Hey' should not appear twice
    assert.equal(result.greetings.filter(g => g === 'Hey').length, 1);
  });

  it('overrides closings with corrected ones first', () => {
    const corrections = {
      greetings: [],
      closings: ['Thanks', '- E'],
      vocabularyOverrides: {},
      formalityCorrection: 0,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.equal(result.closings[0], 'Thanks');
    assert.equal(result.closings[1], '- E');
    // 2 corrections + 3 originals (no overlap), capped at 5
    assert.equal(result.closings.length, 5);
  });

  it('adjusts formality score by correction delta', () => {
    const corrections = {
      greetings: [],
      closings: [],
      vocabularyOverrides: {},
      formalityCorrection: -0.15,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.equal(result.formalityScore, 0.10);
  });

  it('clamps formality score to 0-1 range', () => {
    const lowBase = { ...baseAnalysis, formalityScore: 0.05 };
    const corrections = {
      greetings: [],
      closings: [],
      vocabularyOverrides: {},
      formalityCorrection: -0.20,
    };
    const result = applyDeltaCorrections(lowBase, corrections);
    assert.equal(result.formalityScore, 0);

    const highBase = { ...baseAnalysis, formalityScore: 0.95 };
    const upCorrections = { ...corrections, formalityCorrection: 0.20 };
    const result2 = applyDeltaCorrections(highBase, upCorrections);
    assert.equal(result2.formalityScore, 1);
  });

  it('merges vocabulary overrides into existing vocabulary', () => {
    const corrections = {
      greetings: [],
      closings: [],
      vocabularyOverrides: { awesome: 3, update: 2 },
      formalityCorrection: 0,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.equal(result.vocabulary.awesome, 3);
    assert.equal(result.vocabulary.update, 10); // 8 + 2
    assert.equal(result.vocabulary.project, 10); // unchanged
  });

  it('preserves tone markers unchanged', () => {
    const corrections = {
      greetings: ['Hey'],
      closings: ['- E'],
      vocabularyOverrides: { cool: 2 },
      formalityCorrection: -0.1,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.deepEqual(result.toneMarkers, baseAnalysis.toneMarkers);
    assert.equal(result.avgLength, baseAnalysis.avgLength);
  });

  it('does not mutate the base analysis object', () => {
    const original = JSON.parse(JSON.stringify(baseAnalysis));
    const corrections = {
      greetings: ['Hey'],
      closings: ['- E'],
      vocabularyOverrides: { cool: 2 },
      formalityCorrection: -0.1,
    };
    applyDeltaCorrections(baseAnalysis, corrections);
    assert.deepEqual(baseAnalysis.greetings, original.greetings);
    assert.equal(baseAnalysis.formalityScore, original.formalityScore);
    assert.deepEqual(baseAnalysis.vocabulary, original.vocabulary);
  });

  it('handles null corrections gracefully', () => {
    const result = applyDeltaCorrections(baseAnalysis, null);
    assert.deepEqual(result, baseAnalysis);
  });

  it('limits greetings and closings to 5', () => {
    const corrections = {
      greetings: ['Hey', 'Yo', 'Sup'],
      closings: ['- E', 'Later', 'Peace'],
      vocabularyOverrides: {},
      formalityCorrection: 0,
    };
    const result = applyDeltaCorrections(baseAnalysis, corrections);
    assert.ok(result.greetings.length <= 5);
    assert.ok(result.closings.length <= 5);
  });
});
