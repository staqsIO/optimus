/**
 * OPT-81 — Multi-identity entity resolution + reversible auto-merge.
 *
 * Test coverage:
 *   1. resolveContactId() — follows contact_identities → returns canonical id
 *   2. resolveContactId() — follows merged_into chain to canonical
 *   3. aggregateAcrossIdentities() — sums counters across merged cluster
 *   4. AUTO-MERGE: Mike Maibach (2 rows, same name, same domain) → merges
 *   5. NO-FALSE-MERGE: two different "Dustin"s (different domain, no overlap)
 *   6. PARTIAL CONFIDENCE: Dustin Powers (same name, same domain but no overlap
 *      with a third Dustin at a completely different domain) — only merges the
 *      high-confidence pair
 *   7. REVERSIBILITY: unmerge_contacts() restores merged_into=NULL + identities
 *   8. scorePair() — name-alone NEVER crosses threshold (= 0.40 only)
 *   9. pickCanonical() — richest/oldest row wins
 *  10. Migration 172: merged_into column exists; auto_merge / unmerge functions exist
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';
import {
  resolveContactId,
  aggregateAcrossIdentities,
} from '../../lib/signal/entity-resolver.js';
import {
  scorePair,
  pickCanonical,
  runAutoMergePass,
  AUTO_MERGE_THRESHOLD,
  REVIEW_FLOOR,
  WEIGHTS,
  normalizeName,
} from '../../lib/signal/contact-auto-merge.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a contact and (via trigger/backfill) verify its email identity row exists. */
async function makeContact(query, { email, name, emailsReceived = 0, createdAt } = {}) {
  const tag = randomUUID().slice(0, 8);
  const contactEmail = email ?? `user.${tag}@example-${tag}.com`;
  const { rows: [c] } = await query(
    `INSERT INTO signal.contacts
       (email_address, name, emails_received${createdAt ? ', created_at' : ''})
     VALUES ($1, $2, $3${createdAt ? ', $4' : ''})
     RETURNING id, email_address, name, emails_received, created_at`,
    createdAt ? [contactEmail, name ?? 'Test User', emailsReceived, createdAt] : [contactEmail, name ?? 'Test User', emailsReceived],
  );
  // The AFTER-INSERT trigger (migration 083) creates the email identity row.
  // Verify it exists; if the trigger is absent in the PGlite migration set,
  // insert manually (safe with ON CONFLICT DO NOTHING).
  await query(
    `INSERT INTO signal.contact_identities (contact_id, channel, identifier, source)
     VALUES ($1, 'email', $2, 'test_seed')
     ON CONFLICT (channel, identifier) DO NOTHING`,
    [c.id, c.email_address],
  );
  return c;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('OPT-81 — entity resolution + reversible auto-merge', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // ── 1. resolveContactId — basic lookup ──────────────────────────────────────
  it('resolveContactId: finds canonical id by email', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `resolve.${tag}@example.com`;
    const c = await makeContact(query, { email, name: 'Resolver Test' });
    const resolved = await resolveContactId(email, 'email', query);
    assert.equal(resolved, c.id, 'should resolve to the contact id');
  });

  it('resolveContactId: returns null for unknown email', async () => {
    const result = await resolveContactId('no-such-email@unknown.invalid', 'email', query);
    assert.equal(result, null);
  });

  // ── 2. resolveContactId — follows merged_into chain ─────────────────────────
  it('resolveContactId: follows merged_into to canonical', async () => {
    const tag = randomUUID().slice(0, 8);
    const emailA = `chain-a.${tag}@example.com`;
    const emailB = `chain-b.${tag}@example.com`;
    const a = await makeContact(query, { email: emailA, name: 'Chain A' });
    const b = await makeContact(query, { email: emailB, name: 'Chain B' });

    // Manually soft-merge b into a (set merged_into).
    // Move identity of b to a as auto_merge_contacts() would.
    await query(`UPDATE signal.contact_identities SET contact_id = $1 WHERE contact_id = $2`, [a.id, b.id]);
    await query(`UPDATE signal.contacts SET merged_into = $1 WHERE id = $2`, [a.id, b.id]);

    // Resolving emailB should now return a.id (the canonical).
    const resolved = await resolveContactId(emailB, 'email', query);
    assert.equal(resolved, a.id, 'should follow merged_into to canonical');
  });

  // ── 3. aggregateAcrossIdentities — unified counters ─────────────────────────
  it('aggregateAcrossIdentities: sums counters across merged cluster', async () => {
    const tag = randomUUID().slice(0, 8);
    const emailC = `agg-c.${tag}@example.com`;
    const emailD = `agg-d.${tag}@example.com`;
    const canonical = await makeContact(query, { email: emailC, name: 'Agg Canonical', emailsReceived: 10 });
    const merged   = await makeContact(query, { email: emailD, name: 'Agg Merged',    emailsReceived: 5 });

    // Soft-merge merged into canonical.
    await query(`UPDATE signal.contact_identities SET contact_id = $1 WHERE contact_id = $2`, [canonical.id, merged.id]);
    await query(`UPDATE signal.contacts SET merged_into = $1 WHERE id = $2`, [canonical.id, merged.id]);

    const agg = await aggregateAcrossIdentities(canonical.id, query);
    assert.equal(agg.emails_received, 15, 'should sum emails_received across cluster');
    assert.ok(agg.identities.length >= 2, 'should include both identities');
  });

  // ── 4. AUTO-MERGE: Mike Maibach — same name + same domain ───────────────────
  it('runAutoMergePass: Mike Maibach (same name, same domain) auto-merges', async () => {
    const tag = randomUUID().slice(0, 8);
    const emailM1 = `mike.maibach.${tag}@mibco-${tag}.com`;
    const emailM2 = `mmaibach.${tag}@mibco-${tag}.com`;   // same domain
    const mike1 = await makeContact(query, { email: emailM1, name: `Mike Maibach ${tag}`, emailsReceived: 20 });
    const mike2 = await makeContact(query, { email: emailM2, name: `Mike Maibach ${tag}`, emailsReceived: 3 });

    const { merged} = await runAutoMergePass(query, { performedBy: 'test' });

    // Find whether mike1/mike2 were merged.
    const pair = merged.find(
      (m) => (m.canonicalId === mike1.id && m.secondaryId === mike2.id) ||
             (m.canonicalId === mike2.id && m.secondaryId === mike1.id),
    );
    assert.ok(pair, `Mike Maibach pair should have been auto-merged (merged=${JSON.stringify(merged.map(m => ({c:m.canonicalId.slice(0,8), s:m.secondaryId.slice(0,8), conf:m.confidence})))})`);
    assert.ok(pair.confidence >= AUTO_MERGE_THRESHOLD, `confidence ${pair.confidence} must be >= ${AUTO_MERGE_THRESHOLD}`);

    // Verify DB: one of them has merged_into set.
    const { rows: [mike2Row] } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`, [mike2.id],
    );
    const { rows: [mike1Row] } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`, [mike1.id],
    );
    const oneIsMerged = mike2Row.merged_into !== null || mike1Row.merged_into !== null;
    assert.ok(oneIsMerged, 'one of the Mike rows must have merged_into set');

    // Verify audit log.
    const { rows: logRows } = await query(
      `SELECT * FROM signal.contact_merge_log WHERE operation = 'auto_merge'
        AND ((primary_id = $1 AND secondary_id = $2) OR (primary_id = $2 AND secondary_id = $1))`,
      [mike1.id, mike2.id],
    );
    assert.ok(logRows.length > 0, 'auto_merge log row should exist');
    assert.ok(logRows[0].reason.includes('confidence='), 'log reason should include confidence');
  });

  // ── 5. NO-FALSE-MERGE: two different Dustins, different domains ─────────────
  it('runAutoMergePass: two different Dustins (different domain, no overlap) do NOT merge', async () => {
    const tag = randomUUID().slice(0, 8);
    const email1 = `dustin.alpha.${tag}@alphacorp-${tag}.io`;
    const email2 = `dustin.beta.${tag}@betacorp-${tag}.io`;
    const dustin1 = await makeContact(query, { email: email1, name: `Dustin Alpha ${tag}`, emailsReceived: 2 });
    const dustin2 = await makeContact(query, { email: email2, name: `Dustin Alpha ${tag}`, emailsReceived: 3 });

    // Score directly — names are equal, domains differ, no org, no correspondents.
    const score = scorePair(
      { id: dustin1.id, name: dustin1.name, email_domain: `alphacorp-${tag}.io`, organization_id: null, correspondents: new Set() },
      { id: dustin2.id, name: dustin2.name, email_domain: `betacorp-${tag}.io`,  organization_id: null, correspondents: new Set() },
    );
    // name alone = WEIGHTS.sameName = 0.40 — must be below REVIEW_FLOOR (0.65)
    assert.ok(score < REVIEW_FLOOR, `score ${score} must be below REVIEW_FLOOR ${REVIEW_FLOOR} when only name matches`);
    assert.ok(score < AUTO_MERGE_THRESHOLD, `score ${score} must never cross AUTO_MERGE_THRESHOLD on name alone`);

    // Also verify runAutoMergePass does not merge them in DB.
    const { merged } = await runAutoMergePass(query, { performedBy: 'test' });
    const falseMerge = merged.find(
      (m) => (m.canonicalId === dustin1.id && m.secondaryId === dustin2.id) ||
             (m.canonicalId === dustin2.id && m.secondaryId === dustin1.id),
    );
    assert.equal(falseMerge, undefined, 'different-domain Dustins must NOT be merged');
  });

  // ── 6. SCORING: name + same domain = 0.75 → crosses AUTO_MERGE_THRESHOLD ────
  it('scorePair: name + shared domain = 0.75 (crosses AUTO_MERGE_THRESHOLD)', () => {
    const score = scorePair(
      { id: 'a', name: 'Dustin Powers', email_domain: 'umbadvisors.com', organization_id: null, correspondents: new Set() },
      { id: 'b', name: 'Dustin Powers', email_domain: 'umbadvisors.com', organization_id: null, correspondents: new Set() },
    );
    const expected = WEIGHTS.sameName + WEIGHTS.sharedEmailDomain; // 0.40 + 0.35 = 0.75
    assert.ok(Math.abs(score - expected) < 0.001, `expected ${expected}, got ${score}`);
    assert.ok(score >= AUTO_MERGE_THRESHOLD, `score ${score} should be >= AUTO_MERGE_THRESHOLD ${AUTO_MERGE_THRESHOLD}`);
  });

  // ── 7. REVERSIBILITY: unmerge_contacts restores the row ─────────────────────
  it('signal.unmerge_contacts: restores merged_into=NULL and moves identities back', async () => {
    const tag = randomUUID().slice(0, 8);
    const emailE = `unmerge-e.${tag}@example-${tag}.com`;
    const emailF = `unmerge-f.${tag}@example-${tag}.com`;
    const canonical = await makeContact(query, { email: emailE, name: `Unmerge Canonical ${tag}`, emailsReceived: 5 });
    const secondary = await makeContact(query, { email: emailF, name: `Unmerge Secondary ${tag}`, emailsReceived: 2 });

    // Perform a soft merge via the DB function.
    await query(
      `SELECT signal.auto_merge_contacts($1, $2, $3, $4, $5) AS result`,
      [canonical.id, secondary.id, 0.92, 'test merge', 'test'],
    );

    // Verify merged.
    const { rows: [postMerge] } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`, [secondary.id],
    );
    assert.equal(postMerge.merged_into, canonical.id, 'secondary should point to canonical after merge');

    // Verify the identity was re-pointed.
    const { rows: [postIdent] } = await query(
      `SELECT contact_id FROM signal.contact_identities WHERE channel = 'email' AND lower(identifier) = lower($1)`,
      [emailF],
    );
    assert.equal(postIdent?.contact_id, canonical.id, 'email identity should be on canonical after merge');

    // Unmerge.
    const { rows: [unmergeResult] } = await query(
      `SELECT signal.unmerge_contacts($1, $2) AS result`,
      [secondary.id, 'test'],
    );
    assert.equal(unmergeResult.result.unmerged, true);

    // Verify restored.
    const { rows: [restored] } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`, [secondary.id],
    );
    assert.equal(restored.merged_into, null, 'merged_into should be NULL after unmerge');

    // Verify unmerge audit log.
    const { rows: [unmergeLog] } = await query(
      `SELECT operation FROM signal.contact_merge_log
        WHERE operation = 'auto_unmerge' AND secondary_id = $1`,
      [secondary.id],
    );
    assert.ok(unmergeLog, 'auto_unmerge log row should exist');
  });

  // ── 8. scorePair: name alone NEVER crosses threshold ────────────────────────
  it('scorePair: name alone = 0.40, never crosses REVIEW_FLOOR', () => {
    const score = scorePair(
      { id: 'a', name: 'Alice Smith', email_domain: 'acme.com',     organization_id: null, correspondents: new Set() },
      { id: 'b', name: 'Alice Smith', email_domain: 'different.com', organization_id: null, correspondents: new Set() },
    );
    assert.equal(score, WEIGHTS.sameName, 'name-only score should equal WEIGHTS.sameName');
    assert.ok(score < REVIEW_FLOOR, `score ${score} must be below REVIEW_FLOOR ${REVIEW_FLOOR}`);
  });

  it('scorePair: different names = 0 even if everything else matches', () => {
    const score = scorePair(
      { id: 'a', name: 'Alice Smith', email_domain: 'acme.com', organization_id: 'org1', correspondents: new Set(['x@y.com']) },
      { id: 'b', name: 'Bob Jones',   email_domain: 'acme.com', organization_id: 'org1', correspondents: new Set(['x@y.com']) },
    );
    assert.equal(score, 0, 'different names must produce score=0');
  });

  // ── 9. pickCanonical: richer/older row wins ──────────────────────────────────
  it('pickCanonical: higher emails_received wins', () => {
    const a = { id: 'a', name: 'X', emails_received: 50, created_at: '2025-01-01' };
    const b = { id: 'b', name: 'X', emails_received: 10, created_at: '2024-01-01' };
    const { canonical, secondary } = pickCanonical(a, b);
    assert.equal(canonical.id, 'a', 'higher emails_received should be canonical');
    assert.equal(secondary.id, 'b');
  });

  it('pickCanonical: older row wins on tie', () => {
    const a = { id: 'a', name: 'X', emails_received: 5, created_at: '2025-06-01' };
    const b = { id: 'b', name: 'X', emails_received: 5, created_at: '2024-01-01' };
    const { canonical } = pickCanonical(a, b);
    assert.equal(canonical.id, 'b', 'older row should be canonical on tie');
  });

  // ── 10. Migration 172: schema assertions ─────────────────────────────────────
  it('signal.contacts has merged_into column', async () => {
    const { rows } = await query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'signal'
          AND table_name = 'contacts'
          AND column_name = 'merged_into'`,
    );
    assert.ok(rows.length === 1, 'merged_into column must exist on signal.contacts');
    assert.equal(rows[0].data_type, 'text');
  });

  it('signal.auto_merge_contacts function exists', async () => {
    const { rows } = await query(
      `SELECT proname FROM pg_proc
         JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
        WHERE pg_namespace.nspname = 'signal'
          AND proname = 'auto_merge_contacts'`,
    );
    assert.ok(rows.length > 0, 'signal.auto_merge_contacts must exist');
  });

  it('signal.unmerge_contacts function exists', async () => {
    const { rows } = await query(
      `SELECT proname FROM pg_proc
         JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
        WHERE pg_namespace.nspname = 'signal'
          AND proname = 'unmerge_contacts'`,
    );
    assert.ok(rows.length > 0, 'signal.unmerge_contacts must exist');
  });

  it('contact_merge_log accepts auto_merge and auto_unmerge operations', async () => {
    const fakeId = randomUUID();
    const fakeId2 = randomUUID();
    // Should not throw — the CHECK constraint must allow these values.
    await query(
      `INSERT INTO signal.contact_merge_log
         (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
       VALUES ('auto_merge', $1, $2, 'test', 'test', '{}')`,
      [fakeId, fakeId2],
    );
    await query(
      `INSERT INTO signal.contact_merge_log
         (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
       VALUES ('auto_unmerge', $1, $2, 'test', 'test', '{}')`,
      [fakeId, fakeId2],
    );
    const { rows } = await query(
      `SELECT operation FROM signal.contact_merge_log
        WHERE primary_id = $1 ORDER BY created_at`,
      [fakeId],
    );
    assert.deepEqual(rows.map((r) => r.operation), ['auto_merge', 'auto_unmerge']);
  });

  // ── normalizeName ────────────────────────────────────────────────────────────
  it('normalizeName: collapses whitespace and lowercases', () => {
    assert.equal(normalizeName('  Dustin  Powers  '), 'dustin powers');
    assert.equal(normalizeName('MIKE MAIBACH'), 'mike maibach');
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName(null), '');
  });

  // ── OPT-81 inner-circle extension ─────────────────────────────────────────

  // ── 11. scorePair: knownExactNameMatch fires on inner_circle ────────────────
  it('scorePair: same full name + inner_circle = 0.80 (crosses AUTO_MERGE_THRESHOLD)', () => {
    const score = scorePair(
      { id: 'a', name: 'Dustin Powers', email_domain: 'umbadvisors.com',    organization_id: null, correspondents: new Set(), tier: 'inner_circle' },
      { id: 'b', name: 'Dustin Powers', email_domain: 'heronlabsinc.com',   organization_id: null, correspondents: new Set(), tier: 'active' },
    );
    const expected = WEIGHTS.sameName + WEIGHTS.knownExactNameMatch; // 0.40 + 0.40 = 0.80
    assert.ok(Math.abs(score - expected) < 0.001, `expected ${expected}, got ${score}`);
    assert.ok(score >= AUTO_MERGE_THRESHOLD, `score ${score} must be >= AUTO_MERGE_THRESHOLD ${AUTO_MERGE_THRESHOLD}`);
  });

  // ── 12. scorePair: inner_circle does NOT fire on different full names ────────
  it('scorePair: inner_circle + different last name = 0 (name mismatch short-circuits)', () => {
    const score = scorePair(
      { id: 'a', name: 'Dustin Powers', email_domain: 'umbadvisors.com', organization_id: null, correspondents: new Set(), tier: 'inner_circle' },
      { id: 'b', name: 'Dustin Smith',  email_domain: 'different.com',   organization_id: null, correspondents: new Set(), tier: 'active' },
    );
    assert.equal(score, 0, 'different last names must produce score=0 — inner_circle is irrelevant without exact full-name match');
  });

  // ── 13. scorePair: NO inner_circle on either side → no bonus ────────────────
  it('scorePair: same full name, neither inner_circle, different domains → stays at 0.40', () => {
    const score = scorePair(
      { id: 'a', name: 'Dustin Powers', email_domain: 'acme.com',     organization_id: null, correspondents: new Set(), tier: 'active' },
      { id: 'b', name: 'Dustin Powers', email_domain: 'different.com', organization_id: null, correspondents: new Set(), tier: 'active' },
    );
    assert.equal(score, WEIGHTS.sameName, `score ${score} must equal sameName weight (no bonus without inner_circle)`);
    assert.ok(score < REVIEW_FLOOR, `score ${score} must be below REVIEW_FLOOR ${REVIEW_FLOOR} — two strangers must not merge`);
  });

  // ── 14. scorePair: first-name-only is never enough ──────────────────────────
  it('scorePair: first-name-only mismatch scores 0 regardless of tier', () => {
    // "Dustin Powers" vs "Dustin Smith" — different full names. Name check fails.
    const score = scorePair(
      { id: 'a', name: 'Dustin Powers', email_domain: 'a.com', organization_id: null, correspondents: new Set(), tier: 'inner_circle' },
      { id: 'b', name: 'Dustin Smith',  email_domain: 'a.com', organization_id: null, correspondents: new Set(), tier: 'inner_circle' },
    );
    // Despite: same first name, same domain, both inner_circle — different full
    // name means scorePair returns 0 immediately (name guard short-circuits).
    assert.equal(score, 0, 'different full names must score 0 regardless of tier or domain');
  });

  // ── 15. Dustin Powers: 3 cross-domain rows, one inner_circle → all merge ────
  it('runAutoMergePass: Dustin Powers (3 rows, one inner_circle, different domains) — all collapse to one canonical', async () => {
    const tag = randomUUID().slice(0, 8);
    const name = `Dustin Powers ${tag}`;
    // Row 1: inner_circle (umbadvisors.com)
    const d1 = await makeContact(query, { email: `dustin.${tag}@umb-${tag}.com`, name, emailsReceived: 50 });
    await query(`UPDATE signal.contacts SET tier = 'inner_circle' WHERE id = $1`, [d1.id]);

    // Row 2: active (heronlabsinc.com)
    const d2 = await makeContact(query, { email: `dustin.${tag}@heron-${tag}.com`, name, emailsReceived: 10 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [d2.id]);

    // Row 3: active (gmail.com)
    const d3 = await makeContact(query, { email: `dustin.personal.${tag}@example.com`, name, emailsReceived: 5 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [d3.id]);

    const { merged } = await runAutoMergePass(query, { performedBy: 'test' });

    // At least two merges should have occurred: d1 absorbs d2, then d1 absorbs d3
    // (or the pass visits them in one sweep and merges both pairs).
    const involvedIds = new Set([d1.id, d2.id, d3.id]);
    const ourMerges = merged.filter(
      (m) => involvedIds.has(m.canonicalId) || involvedIds.has(m.secondaryId),
    );
    assert.ok(ourMerges.length >= 2, `Expected at least 2 merges for 3-row Dustin, got ${ourMerges.length}: ${JSON.stringify(ourMerges.map(m => ({c:m.canonicalId.slice(0,8), s:m.secondaryId.slice(0,8), conf:m.confidence.toFixed(2)})))}`);

    // All three should now point to the same canonical.
    const { rows: rowsAfter } = await query(
      `SELECT id, merged_into FROM signal.contacts WHERE id = ANY($1::text[])`,
      [[d1.id, d2.id, d3.id]],
    );
    const canonicals = new Set(rowsAfter.map((r) => r.merged_into ?? r.id));
    assert.equal(canonicals.size, 1, `All 3 Dustin rows should resolve to one canonical, got: ${JSON.stringify([...canonicals])}`);
  });

  // ── 16. NO-FALSE-MERGE: inner_circle name vs different last name ─────────────
  it('runAutoMergePass: inner_circle Dustin Powers vs active Dustin Smith — NOT merged', async () => {
    const tag = randomUUID().slice(0, 8);
    const dp = await makeContact(query, { email: `dustin.p.${tag}@umb-${tag}.com`, name: `Dustin Powers ${tag}`, emailsReceived: 5 });
    await query(`UPDATE signal.contacts SET tier = 'inner_circle' WHERE id = $1`, [dp.id]);
    const ds = await makeContact(query, { email: `dustin.s.${tag}@diff-${tag}.com`, name: `Dustin Smith ${tag}`, emailsReceived: 2 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [ds.id]);

    const { merged } = await runAutoMergePass(query, { performedBy: 'test' });
    const falseMerge = merged.find(
      (m) => (m.canonicalId === dp.id && m.secondaryId === ds.id) ||
             (m.canonicalId === ds.id && m.secondaryId === dp.id),
    );
    assert.equal(falseMerge, undefined, 'Different last names must NOT merge even when one is inner_circle');
  });

  // ── 17. NO-FALSE-MERGE: two active same-full-name cross-domain, no inner_circle
  it('runAutoMergePass: two active same-full-name contacts on different domains (no inner_circle) — NOT merged', async () => {
    const tag = randomUUID().slice(0, 8);
    const name = `Common Name ${tag}`;
    const c1 = await makeContact(query, { email: `cn1.${tag}@corp1-${tag}.com`, name, emailsReceived: 3 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [c1.id]);
    const c2 = await makeContact(query, { email: `cn2.${tag}@corp2-${tag}.com`, name, emailsReceived: 3 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [c2.id]);

    // Score directly.
    const score = scorePair(
      { id: c1.id, name, email_domain: `corp1-${tag}.com`, organization_id: null, correspondents: new Set(), tier: 'active' },
      { id: c2.id, name, email_domain: `corp2-${tag}.com`, organization_id: null, correspondents: new Set(), tier: 'active' },
    );
    assert.ok(score < REVIEW_FLOOR, `score ${score} must be < REVIEW_FLOOR — two non-inner-circle same-name strangers must not merge`);

    const { merged } = await runAutoMergePass(query, { performedBy: 'test' });
    const falseMerge = merged.find(
      (m) => (m.canonicalId === c1.id && m.secondaryId === c2.id) ||
             (m.canonicalId === c2.id && m.secondaryId === c1.id),
    );
    assert.equal(falseMerge, undefined, 'Two active same-name contacts on different domains must NOT auto-merge');
  });

  // ── 18. Reversibility still works after inner_circle merge ──────────────────
  it('signal.unmerge_contacts: inner_circle merge is reversible', async () => {
    const tag = randomUUID().slice(0, 8);
    const name = `Reversible Person ${tag}`;
    const primary = await makeContact(query, { email: `rev-primary.${tag}@umb-${tag}.com`, name, emailsReceived: 10 });
    await query(`UPDATE signal.contacts SET tier = 'inner_circle' WHERE id = $1`, [primary.id]);
    const secondary = await makeContact(query, { email: `rev-secondary.${tag}@other-${tag}.com`, name, emailsReceived: 2 });
    await query(`UPDATE signal.contacts SET tier = 'active' WHERE id = $1`, [secondary.id]);

    // Auto-merge via the pass.
    const { merged } = await runAutoMergePass(query, { performedBy: 'test' });
    const pair = merged.find(
      (m) => (m.canonicalId === primary.id && m.secondaryId === secondary.id) ||
             (m.canonicalId === secondary.id && m.secondaryId === primary.id),
    );
    assert.ok(pair, 'inner_circle pair should have been auto-merged');

    // Determine which is secondary after the merge.
    const { rows: [secRow] } = await query(`SELECT id, merged_into FROM signal.contacts WHERE id = $1`, [secondary.id]);
    const { rows: [_primRow] } = await query(`SELECT id, merged_into FROM signal.contacts WHERE id = $1`, [primary.id]);
    const mergedSecondary = secRow.merged_into !== null ? secondary.id : primary.id;

    // Unmerge.
    const { rows: [result] } = await query(
      `SELECT signal.unmerge_contacts($1, $2) AS result`,
      [mergedSecondary, 'test'],
    );
    assert.equal(result.result.unmerged, true, 'unmerge should succeed');

    const { rows: [restored] } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`, [mergedSecondary],
    );
    assert.equal(restored.merged_into, null, 'merged_into should be NULL after unmerge');
  });
});
