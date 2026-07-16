/**
 * RED step (TDD) — lib/runtime/human-task-relevance.js does not exist.
 *
 * Tests the relevance gate from PRD §4: a small classifier that scores each
 * meeting signal 0.0–1.0 and decides one of three actions:
 *
 *   score >= 0.6  → auto-promote (decision='auto', column='inbox')
 *   0.3..<0.6     → propose      (decision='propose', column='proposed')
 *   < 0.3         → skip         (decision='skip', no row created)
 *
 * The scorer is a pure function; tests exercise it against the inputs the
 * promoter will hand it. We assert the *decision* (what users see on the
 * board), not the exact intermediate score arithmetic — that lets us
 * recalibrate weights without rewriting every test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRelevance,
  decideFromScore,
  RELEVANCE_AUTO_THRESHOLD,
  RELEVANCE_PROPOSE_THRESHOLD,
} from '../../lib/runtime/human-task-relevance.js';

const KNOWN_BOARD = {
  id: 'bm-eric',
  display_name: 'Eric Gang',
  aliases: ['Eric', 'Eric Gang', 'ecgang'],
};
const KNOWN_CONTACT = {
  id: 'ct-isaias',
  name: 'Isaias Valle',
  aliases: ['Isaias', 'Isaias Valle'],
};
const ACTIVE_PROJECT = { id: 'proj-staqs', name: 'StaqsPro', domain: 'general' };

function ctx({
  obligor = null,
  speakers = [],
  knownPeople = [KNOWN_BOARD, KNOWN_CONTACT],
  domain = 'general',
  projects = [ACTIVE_PROJECT],
  llmRelevant = null, // null = LLM didn't run; true/false = decided
} = {}) {
  return { obligor, speakers, knownPeople, domain, projects, llmRelevant };
}

describe('human-task-relevance — decideFromScore (thresholds)', () => {
  it('thresholds are 0.6 / 0.3 per PRD §4', () => {
    assert.equal(RELEVANCE_AUTO_THRESHOLD, 0.6);
    assert.equal(RELEVANCE_PROPOSE_THRESHOLD, 0.3);
  });

  it('score >= 0.6 → auto', () => {
    assert.equal(decideFromScore(0.6).decision, 'auto');
    assert.equal(decideFromScore(0.9).decision, 'auto');
    assert.equal(decideFromScore(1.0).decision, 'auto');
  });

  it('score in [0.3, 0.6) → propose', () => {
    assert.equal(decideFromScore(0.3).decision, 'propose');
    assert.equal(decideFromScore(0.45).decision, 'propose');
    assert.equal(decideFromScore(0.599).decision, 'propose');
  });

  it('score < 0.3 → skip', () => {
    assert.equal(decideFromScore(0).decision, 'skip');
    assert.equal(decideFromScore(0.299).decision, 'skip');
  });

  it('out-of-range scores are clamped to [0,1]', () => {
    assert.equal(decideFromScore(-1).decision, 'skip');
    assert.equal(decideFromScore(2).decision, 'auto');
  });

  it('decision payload carries the score and column hint', () => {
    const auto = decideFromScore(0.8);
    assert.equal(auto.decision, 'auto');
    assert.equal(auto.column, 'inbox');
    assert.equal(auto.score, 0.8);

    const prop = decideFromScore(0.4);
    assert.equal(prop.column, 'proposed');

    const skip = decideFromScore(0.2);
    assert.equal(skip.column, null);
  });
});

describe('human-task-relevance — scoreRelevance (PRD §4 weights)', () => {
  // The PRD weights are: obligor=0.5, speaker=0.2, domain=0.2, llm=0.1.
  // We test composition + the user-visible decision band, not the exact
  // arithmetic — that way weight tweaks don't shatter every test.

  it('known obligor on a known-team meeting auto-promotes', () => {
    const c = ctx({
      obligor: 'Eric',
      speakers: ['Eric Gang', 'Isaias Valle'],
      domain: 'general',
    });
    const r = scoreRelevance(c);
    assert.equal(decideFromScore(r.score).decision, 'auto');
    assert.equal(r.signals.obligor_known, true);
    assert.equal(r.signals.speaker_known, true);
  });

  it('vendor obligor on a vendor meeting skips', () => {
    const c = ctx({
      obligor: 'Random Vendor Rep',
      speakers: ['Random Vendor Rep'],
      knownPeople: [], // nobody on our side
      domain: 'general',
    });
    const r = scoreRelevance(c);
    assert.equal(decideFromScore(r.score).decision, 'skip');
  });

  it('known speaker but unknown obligor → at most propose, not auto', () => {
    // Our side is in the room, but the action falls to a stranger.
    const c = ctx({
      obligor: 'Random Vendor Rep',
      speakers: ['Eric Gang'],
    });
    const r = scoreRelevance(c);
    assert.notEqual(decideFromScore(r.score).decision, 'auto');
  });

  it('domain match alone is not enough to auto-promote', () => {
    // No known obligor, no known speaker, only the domain helps.
    const c = ctx({
      obligor: 'Random Vendor Rep',
      speakers: ['Random Vendor Rep'],
      knownPeople: [],
      domain: 'general',
      projects: [{ id: 'proj-x', name: 'StaqsPro', domain: 'general' }],
    });
    const r = scoreRelevance(c);
    assert.notEqual(decideFromScore(r.score).decision, 'auto');
  });

  it('LLM tiebreak alone is small (0.1) — not enough to auto-promote', () => {
    const c = ctx({
      obligor: 'Random Vendor Rep',
      speakers: ['Random Vendor Rep'],
      knownPeople: [],
      llmRelevant: true,
    });
    const r = scoreRelevance(c);
    assert.notEqual(decideFromScore(r.score).decision, 'auto');
  });

  it('aliases match the same person (case-insensitive, exact)', () => {
    const c = ctx({
      obligor: 'eric', // lowercase, but alias list carries "Eric"
      speakers: ['Eric Gang'],
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.obligor_known, true);
    assert.equal(r.matched.obligor, 'bm-eric');
  });

  it('does NOT lift a last-name alone into a known person (alias collision guard)', () => {
    // Regression: a stray attendee named "Gang" must not resolve to Eric.
    // Aliases for KNOWN_BOARD include "Eric Gang" — if the matcher does a
    // token-substring scan, "Gang" would falsely match.
    const c = ctx({
      obligor: 'Gang',
      speakers: ['Gang'],
      knownPeople: [KNOWN_BOARD],
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.obligor_known, false);
    assert.equal(r.signals.speaker_known, false);
  });

  it('null obligor still scores (e.g. "we should X" with no doer)', () => {
    const c = ctx({ obligor: null, speakers: ['Eric Gang'] });
    const r = scoreRelevance(c);
    assert.equal(r.signals.obligor_known, false);
    assert.ok(typeof r.score === 'number');
    assert.ok(r.score >= 0 && r.score <= 1);
  });

  it('returns a transparent signals object for debugging + calibration', () => {
    const c = ctx({ obligor: 'Eric', speakers: ['Eric Gang'] });
    const r = scoreRelevance(c);
    assert.equal(typeof r.score, 'number');
    assert.equal(typeof r.signals, 'object');
    assert.ok('obligor_known' in r.signals);
    assert.ok('speaker_known' in r.signals);
    assert.ok('domain_matched' in r.signals);
    assert.ok('llm_relevant' in r.signals);
    assert.ok('matched' in r);
  });

  it('llmRelevant=false subtracts no signal (does not penalise)', () => {
    // The LLM tiebreak is a +signal when true, neutral when false/null.
    // We never want a "the LLM said no, but obligor is Eric" to flip to skip.
    const withLlm = scoreRelevance(
      ctx({ obligor: 'Eric', speakers: ['Eric Gang'], llmRelevant: false }),
    );
    const noLlm = scoreRelevance(
      ctx({ obligor: 'Eric', speakers: ['Eric Gang'], llmRelevant: null }),
    );
    assert.equal(withLlm.score, noLlm.score);
  });

  // -------------------- Single-signal isolation --------------------
  // Each pinned to its exact band so a weight tweak surfaces immediately.

  it('obligor-only (no speaker, no domain, no llm) → propose band', () => {
    const c = ctx({
      obligor: 'Eric',
      speakers: [],
      projects: [], // no domain match possible
      domain: undefined,
      llmRelevant: null,
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.obligor_known, true);
    assert.equal(r.signals.speaker_known, false);
    assert.equal(r.signals.domain_matched, false);
    assert.equal(decideFromScore(r.score).decision, 'propose'); // 0.5
  });

  it('speaker-only → skip band (0.2 < 0.3)', () => {
    const c = ctx({
      obligor: null,
      speakers: ['Eric Gang'],
      projects: [],
      domain: undefined,
      llmRelevant: null,
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.obligor_known, false);
    assert.equal(r.signals.speaker_known, true);
    assert.equal(decideFromScore(r.score).decision, 'skip'); // 0.2
  });

  it('domain-only → skip band (0.2 < 0.3)', () => {
    const c = ctx({
      obligor: null,
      speakers: [],
      knownPeople: [],
      projects: [{ id: 'proj-x', name: 'StaqsPro', domain: 'general' }],
      domain: 'general',
      llmRelevant: null,
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.domain_matched, true);
    assert.equal(decideFromScore(r.score).decision, 'skip'); // 0.2
  });

  it('llm-tiebreak only → skip band (0.1 < 0.3)', () => {
    const c = ctx({
      obligor: null,
      speakers: [],
      knownPeople: [],
      projects: [],
      domain: undefined,
      llmRelevant: true,
    });
    const r = scoreRelevance(c);
    assert.equal(decideFromScore(r.score).decision, 'skip'); // 0.1
  });

  it('obligor + domain (no speaker) → propose band (0.7 — auto)', () => {
    const c = ctx({
      obligor: 'Eric',
      speakers: [],
      projects: [{ id: 'proj-x', name: 'StaqsPro', domain: 'general' }],
      domain: 'general',
    });
    const r = scoreRelevance(c);
    // 0.5 (obligor) + 0.2 (domain) = 0.7 → auto
    assert.equal(decideFromScore(r.score).decision, 'auto');
  });

  it('obligor + speaker (no domain) → auto band (0.7)', () => {
    const c = ctx({
      obligor: 'Eric',
      speakers: ['Isaias Valle'],
      projects: [], // explicit empty: no domain contribution
      domain: undefined,
    });
    const r = scoreRelevance(c);
    // 0.5 + 0.2 = 0.7 → auto
    assert.equal(decideFromScore(r.score).decision, 'auto');
  });

  it('project without domain field never matches (explicit opt-in)', () => {
    const c = ctx({
      obligor: null,
      speakers: [],
      knownPeople: [],
      projects: [{ id: 'proj-no-domain', name: 'X' }],
      domain: 'general',
    });
    const r = scoreRelevance(c);
    assert.equal(r.signals.domain_matched, false);
  });

  it('knownPeople undefined is handled (treated as empty)', () => {
    const r = scoreRelevance({ obligor: 'Eric', speakers: ['Eric Gang'] });
    assert.equal(r.signals.obligor_known, false);
    assert.equal(r.signals.speaker_known, false);
  });

  it('empty input fails closed to skip', () => {
    const r = scoreRelevance({});
    assert.equal(r.score, 0);
    assert.equal(decideFromScore(r.score).decision, 'skip');
  });

  it('score is bounded to [0, 1]', () => {
    // Maximal-signal input must not exceed 1.0; zero-signal input must not
    // fall below 0.
    const max = scoreRelevance(
      ctx({
        obligor: 'Eric',
        speakers: ['Eric Gang', 'Isaias Valle'],
        domain: 'general',
        llmRelevant: true,
      }),
    );
    assert.ok(max.score <= 1.0, `score ${max.score} must be <= 1`);

    const min = scoreRelevance(
      ctx({
        obligor: null,
        speakers: [],
        knownPeople: [],
        projects: [],
        domain: 'general',
        llmRelevant: false,
      }),
    );
    assert.ok(min.score >= 0, `score ${min.score} must be >= 0`);
  });
});

describe('human-task-relevance — calibration audit trail', () => {
  // Per PRD §4 ("Calibration plan"), every promote-or-skip must log the
  // *score* + *signals* so we can re-tune weights against accumulated
  // skip/done feedback.
  it('decideFromScore output is JSON-serializable (logged on every call)', () => {
    const out = decideFromScore(0.7);
    const round = JSON.parse(JSON.stringify(out));
    assert.deepEqual(round, out);
  });
});
