/**
 * GET /api/public/events — the UNAUTHENTICATED public transparency archive.
 *
 * Security contract (P1, deny-by-default): the endpoint must NOT return the raw
 * `metadata` JSONB column. Only keys on the explicit allow-list
 * (PUBLIC_EVENT_METADATA_KEYS) may reach this globally-reachable endpoint, so a
 * careless/future publishEvent caller can never leak PII, email content, or
 * secrets to the public archive.
 *
 *   - an allow-listed metadata key (e.g. draft_id) is returned
 *   - a NON-allow-listed key (e.g. a fake `email_body`) is stripped at read
 *     time, even for rows written directly to the table (bypassing publishEvent)
 *   - publishEvent itself also filters at write time (belt-and-suspenders)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';

const { registerPublicArchiveRoutes } = await import('../src/api-routes/public-archive.js');
const { publishEvent, pickPublicEventMetadata } = await import('../../lib/runtime/state/infrastructure.js');

let query;
let routes;

function call(url) {
  const handler = routes.get('GET /api/public/events');
  return handler({ url, headers: {} });
}

function callFeed() {
  const handler = routes.get('GET /api/public/events/feed');
  return handler({ url: '/api/public/events/feed', headers: {} });
}

// A row that carries BOTH an allow-listed key and a disallowed, PII-shaped key.
const RAW_ID = 'pub-archive-test-raw';
const RAW_METADATA = {
  draft_id: 'd-42', // allow-listed → must survive
  email_body: 'SECRET private email content', // NOT allow-listed → must be stripped
  recipient: 'ceo@example.com', // NOT allow-listed → must be stripped
};

before(async () => {
  ({ query } = await getDb());

  // Insert directly into the table (NOT via publishEvent) so this proves the
  // READ-time projection independently of any write-time filtering.
  await query(
    `INSERT INTO autobot_public.event_log (id, event_type, summary, metadata)
     VALUES ($1, 'draft_approved', 'test event with sensitive metadata', $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [RAW_ID, JSON.stringify(RAW_METADATA)],
  );

  routes = new Map();
  registerPublicArchiveRoutes(routes);
});

describe('GET /api/public/events — metadata allow-list', () => {
  it('returns allow-listed metadata keys but strips disallowed ones at read time', async () => {
    const res = await call('/api/public/events?type=draft_approved&limit=200');
    const row = res.events.find((e) => e.id === RAW_ID);
    assert.ok(row, 'inserted test event should appear in the public archive');

    // Allow-listed key survives.
    assert.equal(row.metadata.draft_id, 'd-42');
    // Disallowed keys are absent — no raw metadata passthrough.
    assert.equal('email_body' in row.metadata, false, 'email_body must be stripped');
    assert.equal('recipient' in row.metadata, false, 'recipient must be stripped');
    assert.deepEqual(Object.keys(row.metadata), ['draft_id']);
  });

  it('publishEvent filters metadata to the allow-list at write time', async () => {
    await publishEvent('draft_approved', 'write-time filter test', null, null, {
      draft_id: 'd-99',
      email_body: 'should never be stored',
    });

    const stored = await query(
      `SELECT metadata FROM autobot_public.event_log
       WHERE summary = 'write-time filter test'
       ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(stored.rows[0], 'publishEvent should have inserted a row');
    assert.equal(stored.rows[0].metadata.draft_id, 'd-99');
    assert.equal('email_body' in stored.rows[0].metadata, false, 'disallowed key must not be stored');
  });
});

// Issue #496: the allow-list restricts metadata KEY NAMES but (pre-fix) not
// VALUE SHAPES — nothing stopped a caller stuffing free text/PII into an
// allow-listed key like `status`/`action`/`decision`. This pins the exact live
// leak vector found in sql/106-contact-split.sql:224-234, where the
// `contact_split` public event's metadata is:
//   { source_id, new_id, identities_moved: <array of email/phone identifiers
//     from signal.contact_identities.identifier>, reason: <free text>,
//     performed_by: <free text> }
// None of those key NAMES are on PUBLIC_EVENT_METADATA_KEYS, so they are
// already stripped by the existing key filter. The row below additionally
// carries that exact contact_split PII/free-text shape under CURRENTLY
// allow-listed key names (status/action/decision) — the "same bug class one
// layer down" the issue calls out — to prove value-shape enforcement, not
// just the key filter, is what blocks it. Without the value-shape check in
// pickPublicEventMetadata, allow-listed keys pass through verbatim and this
// test fails.
const CONTACT_SPLIT_RAW_ID = 'pub-archive-test-contact-split';
const CONTACT_SPLIT_METADATA = {
  // Real, non-allow-listed key names from the contact_split event — already
  // covered by the key filter, kept here so the full real-world payload is
  // exercised end to end.
  source_id: 'a1b2c3d4-0000-4000-8000-000000000001',
  new_id: 'a1b2c3d4-0000-4000-8000-000000000002',
  identities_moved: ['jane.doe@example.com', '+1-555-867-5309'],
  reason: 'Duplicate contact cleanup requested by board',
  performed_by: 'alice@staqs.io',
  // Same PII/free-text values, remapped onto keys that ARE on
  // PUBLIC_EVENT_METADATA_KEYS — this is the part that only value-shape
  // enforcement (not the key filter) can catch.
  status: 'jane.doe@example.com', // email-shaped string under an allow-listed key
  action: '+1-555-867-5309', // phone-shaped string under an allow-listed key
  decision: 'Duplicate contact cleanup requested by board — performed_by alice@staqs.io', // free text under an allow-listed key
};

describe('GET /api/public/events — contact_split PII regression (issue #496)', () => {
  before(async () => {
    await query(
      `INSERT INTO autobot_public.event_log (id, event_type, summary, metadata)
       VALUES ($1, 'contact_split', 'split 2 identities from contact a to new contact b', $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata`,
      [CONTACT_SPLIT_RAW_ID, JSON.stringify(CONTACT_SPLIT_METADATA)],
    );
  });

  it('never exposes contact_split PII or free text, even under allow-listed keys', async () => {
    const res = await call('/api/public/events?type=contact_split&limit=200');
    const row = res.events.find((e) => e.id === CONTACT_SPLIT_RAW_ID);
    assert.ok(row, 'inserted contact_split test event should appear in the public archive');

    // Non-allow-listed keys: stripped by the key filter (pre-existing behavior).
    assert.equal('source_id' in row.metadata, false, 'source_id must be stripped');
    assert.equal('new_id' in row.metadata, false, 'new_id must be stripped');
    assert.equal('identities_moved' in row.metadata, false, 'identities_moved must be stripped');
    assert.equal('reason' in row.metadata, false, 'reason must be stripped');
    assert.equal('performed_by' in row.metadata, false, 'performed_by must be stripped');

    // Allow-listed keys carrying the same PII/free-text shape: must be
    // dropped by value-shape enforcement, not passed through verbatim.
    assert.equal('status' in row.metadata, false, 'email-shaped value under `status` must be dropped');
    assert.equal('action' in row.metadata, false, 'phone-shaped value under `action` must be dropped');
    assert.equal('decision' in row.metadata, false, 'free-text value under `decision` must be dropped');

    // No surviving value anywhere in the projected metadata should contain
    // the raw PII, regardless of which key it landed under.
    const serialized = JSON.stringify(row.metadata);
    assert.equal(serialized.includes('jane.doe@example.com'), false, 'email must not leak through any key');
    assert.equal(serialized.includes('555-867-5309'), false, 'phone number must not leak through any key');
    assert.equal(serialized.includes('alice@staqs.io'), false, 'performed_by email must not leak through any key');
  });
});

// Issue #496 (value-shape follow-up): the first-cut value-shape gate used an
// UNANCHORED phone-shape regex — /(?:\+?\d[\d\s().-]{6,}\d)/ — which matches any
// 8+ digit run and therefore false-dropped ~36% of canonical UUIDs (whose
// hyphen-delimited groups, e.g. `…-446655440000`, look phone-like). `draft_id`
// and `campaign_id` are allow-listed keys that ALWAYS carry UUIDs, so a third of
// draft/campaign references silently vanished from the public archive. The fix
// exempts canonical UUIDs from the PII-shape heuristics; these tests pin that a
// UUID under an ID key always survives while PII-shaped values never do.
describe('pickPublicEventMetadata — UUID false-drop regression (issue #496)', () => {
  it('never drops a canonical UUID under draft_id/campaign_id (was ~36% false-drop)', () => {
    // The exact example UUID whose all-digit final group triggered the bug.
    const example = '550e8400-e29b-41d4-a716-446655440000';
    assert.equal(
      pickPublicEventMetadata({ draft_id: example }).draft_id,
      example,
      'classic example UUID under draft_id must survive',
    );
    assert.equal(
      pickPublicEventMetadata({ campaign_id: example }).campaign_id,
      example,
      'classic example UUID under campaign_id must survive',
    );

    // Statistical guard: a batch of random UUIDs must survive at 100%.
    let dropped = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const id = randomUUID();
      if (!('draft_id' in pickPublicEventMetadata({ draft_id: id }))) dropped++;
    }
    assert.equal(dropped, 0, `all ${N} random UUIDs must survive; ${dropped} were dropped`);
  });

  it('still rejects phone- and email-shaped strings under allow-listed keys', () => {
    assert.equal('status' in pickPublicEventMetadata({ status: 'john.doe@example.com' }), false, 'email-shaped value dropped');
    assert.equal('action' in pickPublicEventMetadata({ action: '+1 (555) 123-4567' }), false, 'formatted phone dropped');
    assert.equal('decision' in pickPublicEventMetadata({ decision: '5551234567' }), false, 'bare 10-digit phone dropped');
  });

  it('keeps enum labels and finite numbers on allow-listed keys', () => {
    assert.equal(pickPublicEventMetadata({ status: 'completed' }).status, 'completed');
    assert.equal(pickPublicEventMetadata({ action: 'auto_archived' }).action, 'auto_archived');
    assert.equal(pickPublicEventMetadata({ score: 0.87 }).score, 0.87);
    assert.equal(pickPublicEventMetadata({ terminal: true }).terminal, true);
  });
});

// Issue #546: "the #496 bug class one layer down". Unlike `metadata`, `summary`
// is legitimately free-text human prose and is NOT projected through an
// allow-list — so no length cap and no object/array rejection apply here.
// Only the email/phone PII-SHAPE checks (shared with pickPublicEventMetadata
// via containsPublicUnsafePii) apply: a summary that looks like it carries PII
// is withheld in full, everything else passes through unchanged.
const SUMMARY_WITHHELD = '[summary withheld: failed public-safety check]';
const LONG_CLEAN_SUMMARY =
  'Reviewed the quarterly compliance report, cross-referenced every open action item against ' +
  'the audit trail, confirmed no outstanding remediation steps were missed, and archived the ' +
  'final sign-off for the board.'; // > 100 chars, no PII — must NOT be capped or dropped

const SUMMARY_PII_ROWS = [
  { id: 'pub-archive-test-summary-clean', event_type: 'draft_approved', summary: 'draft approved and sent to review queue' },
  { id: 'pub-archive-test-summary-long-clean', event_type: 'draft_approved', summary: LONG_CLEAN_SUMMARY },
  { id: 'pub-archive-test-summary-contact-split', event_type: 'contact_split', summary: 'split 3 identities from contact a to new contact b' },
  { id: 'pub-archive-test-summary-email', event_type: 'draft_approved', summary: 'emailed jane.doe@example.com about the split' },
  { id: 'pub-archive-test-summary-phone', event_type: 'draft_approved', summary: 'called +1-415-555-0199 to confirm' },
];

describe('GET /api/public/events — summary PII-shape filter (issue #546)', () => {
  before(async () => {
    for (const row of SUMMARY_PII_ROWS) {
      await query(
        `INSERT INTO autobot_public.event_log (id, event_type, summary, metadata)
         VALUES ($1, $2, $3, '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary`,
        [row.id, row.event_type, row.summary],
      );
    }
  });

  it('passes a clean short prose summary through unchanged', async () => {
    const res = await call('/api/public/events?limit=200');
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-clean');
    assert.ok(row, 'clean summary test event should appear');
    assert.equal(row.summary, 'draft approved and sent to review queue');
  });

  it('passes a legit >100-char prose summary through unchanged (no length cap)', async () => {
    const res = await call('/api/public/events?limit=200');
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-long-clean');
    assert.ok(row, 'long clean summary test event should appear');
    assert.ok(LONG_CLEAN_SUMMARY.length > 100, 'fixture summary must exceed 100 chars to be a meaningful test');
    assert.equal(row.summary, LONG_CLEAN_SUMMARY, 'a long PII-free summary must not be capped or withheld');
  });

  it('passes the real contact_split summary through unchanged', async () => {
    const res = await call('/api/public/events?limit=200');
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-contact-split');
    assert.ok(row, 'contact_split summary test event should appear');
    assert.equal(row.summary, 'split 3 identities from contact a to new contact b');
  });

  it('withholds a summary containing an email address', async () => {
    const res = await call('/api/public/events?limit=200');
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-email');
    assert.ok(row, 'email-shaped summary test event should appear');
    assert.equal(row.summary, SUMMARY_WITHHELD);
  });

  it('withholds a summary containing a phone number', async () => {
    const res = await call('/api/public/events?limit=200');
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-phone');
    assert.ok(row, 'phone-shaped summary test event should appear');
    assert.equal(row.summary, SUMMARY_WITHHELD);
  });

  // GET /api/public/events/feed is a second unauthenticated endpoint that
  // selects the same `summary` column — it never went through
  // pickPublicEventMetadata's sibling `/events` fix and needs the identical
  // redaction (the fixture rows above default to created_at = now(), so they
  // fall inside the feed's 24h window).
  it('feed: withholds a summary containing an email address', async () => {
    const res = await callFeed();
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-email');
    assert.ok(row, 'email-shaped summary test event should appear in the feed');
    assert.equal(row.summary, SUMMARY_WITHHELD);
  });

  it('feed: passes a clean summary through unchanged', async () => {
    const res = await callFeed();
    const row = res.events.find((e) => e.id === 'pub-archive-test-summary-clean');
    assert.ok(row, 'clean summary test event should appear in the feed');
    assert.equal(row.summary, 'draft approved and sent to review queue');
  });
});
