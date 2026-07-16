/**
 * Pure-function tests for src/gmail/thread-state.js. No DB or Gmail API
 * involvement — all input is synthetic thread payloads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyThreadState, classificationToBoardAction } from '../src/gmail/thread-state.js';

const ERIC_ADDRESSES = ['eric@staqs.io', 'eric.personal@example.com'];

function msg({ from, internalDate, labelIds = ['INBOX'] }) {
  return {
    payload: { headers: [{ name: 'From', value: from }] },
    internalDate: String(internalDate),
    labelIds,
  };
}

const T0 = new Date('2026-05-01T12:00:00Z').getTime();

describe('classifyThreadState', () => {
  it('returns still_open for an empty thread', () => {
    const result = classifyThreadState({ messages: [] }, ERIC_ADDRESSES, T0);
    assert.equal(result, 'still_open');
  });

  it('returns still_open when thread is unchanged since proposal', () => {
    const thread = {
      messages: [msg({ from: 'alice@example.com <alice@example.com>', internalDate: T0 - 60_000 })],
    };
    const result = classifyThreadState(thread, ERIC_ADDRESSES, T0);
    assert.equal(result, 'still_open');
  });

  it("returns eric_replied when Eric's address sent a message after the proposal", () => {
    const thread = {
      messages: [
        msg({ from: 'alice@example.com', internalDate: T0 - 60_000 }),
        msg({ from: 'Eric <eric@staqs.io>', internalDate: T0 + 120_000 }),
      ],
    };
    const result = classifyThreadState(thread, ERIC_ADDRESSES, T0);
    assert.equal(result, 'eric_replied');
  });

  it('returns eric_replied for the secondary account (eric.personal@example.com)', () => {
    const thread = {
      messages: [
        msg({ from: 'partner@example.com', internalDate: T0 - 30_000 }),
        msg({ from: 'Eric Gang <eric.personal@example.com>', internalDate: T0 + 60_000 }),
      ],
    };
    const result = classifyThreadState(thread, ERIC_ADDRESSES, T0);
    assert.equal(result, 'eric_replied');
  });

  it('ignores Eric messages that pre-date the proposal', () => {
    // Eric replied BEFORE the proposal was even created — that's not a
    // reply to our draft, that's a pre-existing exchange.
    const thread = {
      messages: [
        msg({ from: 'alice@example.com', internalDate: T0 - 200_000 }),
        msg({ from: 'eric@staqs.io', internalDate: T0 - 100_000 }),  // pre-proposal
        msg({ from: 'alice@example.com', internalDate: T0 - 50_000 }),
      ],
    };
    const result = classifyThreadState(thread, ERIC_ADDRESSES, T0);
    assert.equal(result, 'still_open');
  });

  it('returns archived_no_reply when latest message lost the INBOX label', () => {
    const thread = {
      messages: [
        msg({ from: 'newsletter@example.com', internalDate: T0 - 60_000, labelIds: [] }),
      ],
    };
    const result = classifyThreadState(thread, ERIC_ADDRESSES, T0);
    assert.equal(result, 'archived_no_reply');
  });

  it('returns archived_no_reply when thread moved to Trash (INBOX absent)', () => {
    const thread = {
      messages: [
        msg({ from: 'spam@example.com', internalDate: T0 - 60_000, labelIds: ['TRASH'] }),
      ],
    };
    assert.equal(classifyThreadState(thread, ERIC_ADDRESSES, T0), 'archived_no_reply');
  });

  it('From-address parsing handles bare addresses (no angle brackets)', () => {
    const thread = {
      messages: [
        msg({ from: 'alice@example.com', internalDate: T0 - 30_000 }),
        msg({ from: 'eric@staqs.io', internalDate: T0 + 30_000 }),
      ],
    };
    assert.equal(classifyThreadState(thread, ERIC_ADDRESSES, T0), 'eric_replied');
  });

  it('From-address comparison is case-insensitive', () => {
    const thread = {
      messages: [
        msg({ from: 'alice@example.com', internalDate: T0 - 30_000 }),
        msg({ from: 'Eric <ERIC@STAQS.IO>', internalDate: T0 + 30_000 }),
      ],
    };
    assert.equal(classifyThreadState(thread, ERIC_ADDRESSES, T0), 'eric_replied');
  });

  it('returns still_open when proposalCreatedAt is unparseable', () => {
    const thread = {
      messages: [msg({ from: 'eric@staqs.io', internalDate: T0 + 1000 })],
    };
    assert.equal(classifyThreadState(thread, ERIC_ADDRESSES, 'not-a-date'), 'still_open');
  });
});

describe('classificationToBoardAction', () => {
  it('maps eric_replied to archived_external', () => {
    assert.equal(classificationToBoardAction('eric_replied'), 'archived_external');
  });

  it('maps archived_no_reply to archived_no_reply', () => {
    assert.equal(classificationToBoardAction('archived_no_reply'), 'archived_no_reply');
  });

  it('returns null for still_open', () => {
    assert.equal(classificationToBoardAction('still_open'), null);
  });

  it('returns null for unknown values', () => {
    assert.equal(classificationToBoardAction('whatever'), null);
  });
});
