/**
 * RED step (TDD) — lib/linear/ready-for-optimus.js does not exist yet.
 *
 * Pure-function tests for the "Ready for Optimus" detector.
 *
 * Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-15;
 * PRD v0.2 §5.2 "Ready for Optimus" signal; sequencing §7 Week 3 task 13):
 *
 *   detectReadyForOptimus({ payload, mapping, optimusHandle })
 *     → { ready, source, comment_text?, actor? }
 *
 *   Two equivalent triggers:
 *     - Issue event whose `data.stateId` equals
 *       `mapping.awaitingOptimusStateId` → { ready:true, source:'state' }.
 *     - Comment event whose `data.body` contains `@<optimusHandle>` with
 *       a word-boundary on both sides (no `@` in front, not followed
 *       by another word char or `.`) → { ready:true, source:'comment',
 *       comment_text }.
 *
 *   `optimusHandle` defaults to 'optimus' and is case-insensitive when
 *   matched. `actor` is read from `payload.actor` (Linear standard) and
 *   falls back to `data.user` for Comment payloads.
 *
 *   Defensive: null/undefined payload → { ready:false, source:null }.
 *   Missing `mapping.awaitingOptimusStateId` → state path never fires;
 *   the comment path still works.
 *
 * Style: pure-function action sentences. No DB, no I/O.
 *
 * Run:
 *   cd autobot-inbox && node --test test/linear-ready-for-optimus.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectReadyForOptimus } from '../../lib/linear/ready-for-optimus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AWAITING_STATE_ID = 'st-awaiting-optimus';
const OTHER_STATE_ID = 'st-progress';

const MAPPING = {
  awaitingOptimusStateId: AWAITING_STATE_ID,
  // a few siblings to prove the helper only matches the awaiting-optimus id
  'st-backlog':  'inbox',
  'st-progress': 'in_progress',
  'st-done':     'done',
};

const ACTOR_ID = 'u-eric';
const ACTOR_NAME = 'Eric Gang';

function makeIssuePayload(overrides = {}) {
  return {
    action: 'update',
    type: 'Issue',
    actor: { id: ACTOR_ID, name: ACTOR_NAME },
    data: {
      id: 'lin-issue-rfo',
      stateId: AWAITING_STATE_ID,
      state: { id: AWAITING_STATE_ID, name: 'Ready for Optimus', type: 'started' },
      title: 'Task',
      ...overrides.data,
    },
    ...overrides.top,
  };
}

function makeCommentPayload(body, overrides = {}) {
  return {
    action: 'create',
    type: 'Comment',
    actor: { id: ACTOR_ID, name: ACTOR_NAME },
    data: {
      id: 'cmt-rfo-1',
      body,
      issueId: 'lin-issue-rfo',
      issue: { id: 'lin-issue-rfo' },
      user: { id: ACTOR_ID, name: ACTOR_NAME },
      ...overrides.data,
    },
    ...overrides.top,
  };
}

// ---------------------------------------------------------------------------
// State-path tests
// ---------------------------------------------------------------------------

describe('detectReadyForOptimus — state path', () => {
  it('fires ready=true with source=state when issue stateId equals mapping.awaitingOptimusStateId', () => {
    const result = detectReadyForOptimus({
      payload: makeIssuePayload(),
      mapping: MAPPING,
    });
    assert.equal(result.ready, true, 'must be ready');
    assert.equal(result.source, 'state');
    assert.ok(result.actor, 'actor must be reported');
    // actor identity: prefer id, fall back to name — either is acceptable
    // as long as it is a non-empty string.
    assert.equal(typeof result.actor, 'string');
  });

  it('returns ready=false when issue moves to a non-awaiting-optimus state', () => {
    const result = detectReadyForOptimus({
      payload: makeIssuePayload({
        data: {
          stateId: OTHER_STATE_ID,
          state: { id: OTHER_STATE_ID, name: 'In Progress', type: 'started' },
        },
      }),
      mapping: MAPPING,
    });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false when the issue event has no state change (e.g. only title changed)', () => {
    const result = detectReadyForOptimus({
      payload: {
        action: 'update',
        type: 'Issue',
        actor: { id: ACTOR_ID, name: ACTOR_NAME },
        data: {
          id: 'lin-issue-rfo',
          title: 'Just a rename',
          // No stateId, no state object.
        },
      },
      mapping: MAPPING,
    });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false when mapping.awaitingOptimusStateId is missing, even if a stateId is present', () => {
    const mappingWithout = { ...MAPPING };
    delete mappingWithout.awaitingOptimusStateId;
    const result = detectReadyForOptimus({
      payload: makeIssuePayload(), // stateId === AWAITING_STATE_ID
      mapping: mappingWithout,
    });
    assert.equal(result.ready, false, 'state path must never match without mapping');
    assert.equal(result.source, null);
  });
});

// ---------------------------------------------------------------------------
// Comment-path tests
// ---------------------------------------------------------------------------

describe('detectReadyForOptimus — comment path', () => {
  it('fires ready=true with source=comment for body "@optimus done with this"', () => {
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('@optimus done with this'),
      mapping: MAPPING,
    });
    assert.equal(result.ready, true);
    assert.equal(result.source, 'comment');
    assert.equal(result.comment_text, '@optimus done with this');
    assert.ok(result.actor, 'actor must be reported');
  });

  it('matches @Optimus case-insensitively in "thanks @Optimus !"', () => {
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('thanks @Optimus !'),
      mapping: MAPPING,
    });
    assert.equal(result.ready, true);
    assert.equal(result.source, 'comment');
  });

  it('returns ready=false when "optimus" appears without an @ prefix', () => {
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('optimus is great'),
      mapping: MAPPING,
    });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false for an email-shaped occurrence like "foo@optimus.com"', () => {
    // `@optimus` followed by `.` (dot) is NOT a mention — it's part of a host name.
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('foo@optimus.com is an email'),
      mapping: MAPPING,
    });
    assert.equal(result.ready, false, '@optimus followed by "." must NOT be a mention');
    assert.equal(result.source, null);
  });

  it('returns ready=false for a different handle like "@OptimusPrime is a transformer"', () => {
    // `@optimus` must be followed by a word boundary — another word char disqualifies.
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('@OptimusPrime is a transformer'),
      mapping: MAPPING,
    });
    assert.equal(result.ready, false, '@optimus followed by a word char must NOT match');
    assert.equal(result.source, null);
  });

  it('matches a custom optimusHandle="nemoclaw" in "@nemoclaw look at this"', () => {
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('@nemoclaw look at this'),
      mapping: MAPPING,
      optimusHandle: 'nemoclaw',
    });
    assert.equal(result.ready, true);
    assert.equal(result.source, 'comment');
    assert.equal(result.comment_text, '@nemoclaw look at this');
  });

  it('matches the comment path even when mapping.awaitingOptimusStateId is missing', () => {
    const mappingWithout = { ...MAPPING };
    delete mappingWithout.awaitingOptimusStateId;
    const result = detectReadyForOptimus({
      payload: makeCommentPayload('@optimus please proceed'),
      mapping: mappingWithout,
    });
    assert.equal(result.ready, true, 'comment path is independent of state mapping');
    assert.equal(result.source, 'comment');
  });
});

// ---------------------------------------------------------------------------
// Defensive / edge-case tests
// ---------------------------------------------------------------------------

describe('detectReadyForOptimus — defensive', () => {
  it('returns ready=false for a null payload without throwing', () => {
    const result = detectReadyForOptimus({ payload: null, mapping: MAPPING });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false for an undefined payload without throwing', () => {
    const result = detectReadyForOptimus({ payload: undefined, mapping: MAPPING });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false for an empty payload without throwing', () => {
    const result = detectReadyForOptimus({ payload: {}, mapping: MAPPING });
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });

  it('returns ready=false when args are entirely omitted', () => {
    const result = detectReadyForOptimus();
    assert.equal(result.ready, false);
    assert.equal(result.source, null);
  });
});
