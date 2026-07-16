import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldSkip,
  extractIdeas,
  extractEntities,
  isEnabled,
} from '../../lib/runtime/signal-detector.js';

/**
 * Unit tests for the signal-detector skip gate, regex extractors, and
 * feature-flag helper. No DB — pure logic.
 *
 * These tests pin the behaviour Foreman/Linus cares about most for
 * gbrain B1: that the detector is conservative about what it processes
 * (so it stays cheap + non-blocking) and predictable about how the
 * feature flag opens / closes the gate.
 */
describe('signal-detector — shouldSkip', () => {
  // [message, hints, expectedSkip, expectedReason]
  const cases = [
    [null,        {}, true,  'empty'],
    [undefined,   {}, true,  'empty'],
    ['',          {}, true,  'empty'],
    ['  ',        {}, true,  'too_short'],
    ['ok',        {}, true,  'too_short'],
    ['short',     {}, true,  'too_short'],
    ['thanks!',   {}, true,  'too_short'],
    ['ok.',       {}, true,  'too_short'],
    // length >= 8 unlocks the stopword check (trim happens before length check)
    ['thank you', {}, true,  'stopword'],   // 9 chars, "thank you" is in stopword set
    ['Thank You', {}, true,  'stopword'],   // lowercased before lookup
    ['Thank You!', {}, true, 'stopword'],   // trailing ! stripped before lookup
    ['noted',     {}, true,  'too_short'],  // 5 chars
    ['noted!!',   {}, true,  'too_short'],  // 7 chars
    ['noted, k.', {}, false, null],         // 9 chars, not a stopword phrase

    // Classifier hint overrides on long substantive messages
    [
      'Can you review the contract draft by Friday? It needs your sign-off.',
      { classification: 'operational' },
      true,
      'classifier_operational',
    ],
    [
      'Can you review the contract draft by Friday? It needs your sign-off.',
      { classification: 'noise' },
      true,
      'classifier_operational',
    ],
    [
      'Can you review the contract draft by Friday? It needs your sign-off.',
      { classification: 'action_required' },
      false,
      null,
    ],

    // Length guardrail
    ['x'.repeat(50_001), {}, true, 'too_long'],
  ];

  for (const [msg, hints, skip, reason] of cases) {
    const label = JSON.stringify({
      m: typeof msg === 'string' && msg.length > 30 ? `${msg.slice(0, 30)}…(${msg.length})` : msg,
      h: hints,
    });
    it(`skip=${skip} reason=${reason} for ${label}`, () => {
      const r = shouldSkip(msg, hints);
      assert.equal(r.skip, skip);
      assert.equal(r.reason, reason);
    });
  }
});

describe('signal-detector — extractIdeas', () => {
  it('extracts a commitment from "I will get back to you"', () => {
    const r = extractIdeas("Sure — I'll get back to you tomorrow with the updated numbers.");
    assert.ok(r.find(s => s.signal_type === 'commitment'), 'expected a commitment signal');
  });

  it('extracts a deadline from "by Friday"', () => {
    const r = extractIdeas('Please send the redline by Friday EOD if possible.');
    assert.ok(r.find(s => s.signal_type === 'deadline'), 'expected a deadline signal');
  });

  it('extracts a question from "What do you think?"', () => {
    const r = extractIdeas('What do you think about moving the launch to next quarter?');
    assert.ok(r.find(s => s.signal_type === 'question'), 'expected a question signal');
  });

  it('extracts a request from "Can you review"', () => {
    const r = extractIdeas('Quick favor — can you review the attached SOW before our call?');
    assert.ok(r.find(s => s.signal_type === 'request'), 'expected a request signal');
  });

  it('extracts an explicit TODO marker', () => {
    const r = extractIdeas('Notes from the meeting. TODO: circle back with vendor on pricing.');
    assert.ok(r.find(s => s.signal_type === 'action_item'), 'expected an action_item signal');
  });

  it('returns at most 8 signals (cap)', () => {
    const long = Array.from({ length: 30 }, (_, i) =>
      `Can you review item ${i} by Friday? I will get back to you. TODO: check ${i}.`,
    ).join(' ');
    const r = extractIdeas(long);
    assert.ok(r.length <= 8, `expected <=8 signals, got ${r.length}`);
  });

  it('returns [] on a plain conversational message', () => {
    const r = extractIdeas('Just touching base — hope the kids are well, talk soon.');
    assert.equal(r.length, 0);
  });

  it('caps content length at 500 chars per signal', () => {
    const longTail = 'x'.repeat(2000);
    const r = extractIdeas(`TODO: ${longTail}`);
    if (r.length > 0) assert.ok(r[0].content.length <= 500);
  });
});

describe('signal-detector — extractEntities', () => {
  it('finds a single email address', () => {
    const r = extractEntities('Loop in alice@example.com when you get a chance.');
    assert.deepEqual(
      r.map(e => e.email_address),
      ['alice@example.com'],
    );
  });

  it('finds multiple addresses, deduplicated, lowercased', () => {
    const r = extractEntities('Cc Alice@Example.com and BOB@example.com — also alice@example.com again.');
    assert.deepEqual(
      r.map(e => e.email_address).sort(),
      ['alice@example.com', 'bob@example.com'],
    );
  });

  it('returns [] when no addresses', () => {
    assert.deepEqual(extractEntities('No emails here.'), []);
  });

  it('caps at 16 addresses', () => {
    const blob = Array.from({ length: 50 }, (_, i) => `u${i}@example.com`).join(' ');
    const r = extractEntities(blob);
    assert.equal(r.length, 16);
  });
});

describe('signal-detector — isEnabled', () => {
  const original = process.env.SIGNAL_DETECTOR_ENABLED;

  function set(v) {
    if (v === undefined) delete process.env.SIGNAL_DETECTOR_ENABLED;
    else process.env.SIGNAL_DETECTOR_ENABLED = v;
  }

  it('defaults to false when env is unset', () => {
    set(undefined);
    assert.equal(isEnabled(), false);
  });

  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
    it(`returns true for env=${JSON.stringify(truthy)}`, () => {
      set(truthy);
      assert.equal(isEnabled(), true);
    });
  }

  for (const falsy of ['0', 'false', 'no', 'off', '', '   ']) {
    it(`returns false for env=${JSON.stringify(falsy)}`, () => {
      set(falsy);
      assert.equal(isEnabled(), false);
    });
  }

  // Restore (best-effort)
  set(original);
});
