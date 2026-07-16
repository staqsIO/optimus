/**
 * Pure-helper tests for meeting-identity (STAQPRO-612).
 * Deterministic + offline — no DB, no LLM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSourceMeetingId,
  computeDedupKey,
  fifteenMinWindowStart,
  normalizeActionText,
} from '../../lib/runtime/meeting-identity.js';

describe('meeting-identity — computeSourceMeetingId', () => {
  it('prefers calendar event id when present', () => {
    const id = computeSourceMeetingId({
      calendarEventId: 'cal-abc-123',
      title: 'Anything',
      startTime: '2026-06-02T10:00:00Z',
      participantEmails: ['a@x.com'],
    });
    assert.equal(id, 'cal:cal-abc-123');
  });

  it('is stable/deterministic for the same envelope inputs', () => {
    const args = {
      title: 'Weekly Sync',
      startTime: '2026-06-02T10:07:00Z',
      participantEmails: ['b@x.com', 'a@x.com'],
    };
    const a = computeSourceMeetingId(args);
    const b = computeSourceMeetingId({ ...args, participantEmails: ['a@x.com', 'b@x.com'] });
    assert.ok(a.startsWith('mtg:'));
    assert.equal(a, b, 'participant order must not change the key');
  });

  it('collapses two captures within the same 15-min window to one key', () => {
    // TLDV vs Meet capture of the same meeting, jittered by a few minutes.
    const tldv = computeSourceMeetingId({
      title: 'Standup',
      startTime: '2026-06-02T09:01:00Z',
      participantEmails: ['a@x.com'],
    });
    const meet = computeSourceMeetingId({
      title: 'Standup',
      startTime: '2026-06-02T09:13:00Z',
      participantEmails: ['a@x.com'],
    });
    assert.equal(tldv, meet, 'same 15-min window + participants + title → same key');
  });

  it('different windows produce different keys', () => {
    const early = computeSourceMeetingId({ title: 'X', startTime: '2026-06-02T09:01:00Z' });
    const late = computeSourceMeetingId({ title: 'X', startTime: '2026-06-02T09:31:00Z' });
    assert.notEqual(early, late);
  });

  it('falls back to a stable source id when no envelope signal exists', () => {
    const id = computeSourceMeetingId({ fallbackId: 'doc-xyz' });
    assert.equal(id, 'src:doc-xyz');
  });

  it('returns null when nothing identifying is supplied', () => {
    assert.equal(computeSourceMeetingId({}), null);
  });
});

describe('meeting-identity — fifteenMinWindowStart', () => {
  it('rounds down to the 15-minute boundary', () => {
    const w1 = fifteenMinWindowStart('2026-06-02T09:14:59Z');
    const w2 = fifteenMinWindowStart('2026-06-02T09:00:00Z');
    assert.equal(w1, w2);
  });
  it('returns null for unparseable input', () => {
    assert.equal(fifteenMinWindowStart('not-a-date'), null);
    assert.equal(fifteenMinWindowStart(null), null);
  });
});

describe('meeting-identity — computeDedupKey', () => {
  it('is stable for equivalent action text (case/punct/whitespace insensitive)', () => {
    const a = computeDedupKey('cal:1', 'Send the  proposal to Acme.');
    const b = computeDedupKey('cal:1', 'send the proposal to acme');
    assert.equal(a, b);
    assert.ok(a.startsWith('cal:1:'));
  });

  it('differs across meetings for the same action text', () => {
    const a = computeDedupKey('cal:1', 'follow up');
    const b = computeDedupKey('cal:2', 'follow up');
    assert.notEqual(a, b);
  });

  it('returns null when either input is empty', () => {
    assert.equal(computeDedupKey('', 'x'), null);
    assert.equal(computeDedupKey('cal:1', '   '), null);
  });
});

describe('meeting-identity — normalizeActionText', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    assert.equal(normalizeActionText('  Ship   IT!! '), 'ship it');
  });
});
