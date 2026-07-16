import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';

import { getDb } from './helpers/setup-db.js';
import { detectSignals } from '../../lib/runtime/signal-detector.js';

/**
 * Integration test for signal-detector against PGlite.
 *
 * Pins the contract that matters for gbrain B1:
 *   1. Phase 1 ideas land in inbox.signals with the correct message_id.
 *   2. Phase 2 entities land in signal.contacts and increment
 *      emails_received on conflict.
 *   3. Tenancy metadata (owner_id, agent_id) lands in inbox.signals.metadata
 *      so future tier-resolution / RLS work can consume it.
 *   4. The non-blocking guarantee: an entity-phase failure does not prevent
 *      idea-phase rows from persisting, and vice-versa (errors are accumulated
 *      in the result, not thrown).
 *   5. Programming-error guards (missing scopedQuery / messageId) DO throw —
 *      they're meant to surface bugs in dev.
 *
 * We do NOT use withAgentScope() here — we pass the raw `query` function as
 * the scopedQuery so the test stays focused on the detector logic without
 * coupling to the JWT plumbing. The unit / E2E test for agent-loop integration
 * lives in signal-detector-agent-loop.test.js and exercises the scope plumbing.
 */
describe('signal-detector — integration (PGlite)', () => {
  let query;
  const ACCT_ID = 'acct-sd-integration';
  const MSG_ID = `msg-sd-${randomUUID()}`;
  const OWNER_ID = '11111111-1111-1111-1111-111111111111';

  before(async () => {
    ({ query } = await getDb());

    await query(
      `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, is_active, sync_status)
       VALUES ($1, 'email', 'gmail', 'SD', 'sd-test@staqs.io', true, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ACCT_ID],
    );
    await query(
      `INSERT INTO inbox.messages (
         id, provider_msg_id, provider, thread_id, message_id,
         from_address, to_addresses, subject, received_at, channel, account_id
       ) VALUES ($1, 'pmid-sd', 'gmail', 'thread-sd', 'rfc-sd',
                 'partner@example.com', ARRAY['sd-test@staqs.io'],
                 'Test', now(), 'email', $2)
       ON CONFLICT (id) DO NOTHING`,
      [MSG_ID, ACCT_ID],
    );
  });

  it('writes ideas to inbox.signals and entities to signal.contacts', async () => {
    const message =
      "Quick one — can you review the new SOW by Friday? I'll send the redline to alice@example.com once it's in good shape. " +
      'TODO: confirm the rate with bob@example.com before signing.';

    const r = await detectSignals({
      message,
      workItem: { id: 'wi-sd-1' },
      messageId: MSG_ID,
      agentId: 'executor-responder',
      ownerId: OWNER_ID,
      scopedQuery: query, // raw query — integration test focuses on writes
    });

    assert.equal(r.skipped, false);
    assert.equal(r.errors.length, 0, `unexpected errors: ${JSON.stringify(r.errors)}`);
    assert.ok(r.ideas.length >= 2, `expected >=2 ideas, got ${r.ideas.length}`);
    assert.ok(r.entities.length >= 2, `expected >=2 entities, got ${r.entities.length}`);

    // Inspect rows
    const sigRows = await query(
      `SELECT signal_type, content, metadata FROM inbox.signals WHERE message_id = $1`,
      [MSG_ID],
    );
    assert.ok(sigRows.rows.length >= 2);
    const allTypes = sigRows.rows.map(row => row.signal_type);
    assert.ok(allTypes.includes('request') || allTypes.includes('action_item'));

    // Tenancy metadata is preserved (so future RLS / tier-resolution can consume it)
    const sample = sigRows.rows[0];
    const md = typeof sample.metadata === 'string' ? JSON.parse(sample.metadata) : sample.metadata;
    assert.equal(md.source, 'signal-detector');
    assert.equal(md.agent_id, 'executor-responder');
    assert.equal(md.owner_id, OWNER_ID);

    const aliceRow = await query(
      `SELECT email_address, emails_received FROM signal.contacts WHERE email_address = $1`,
      ['alice@example.com'],
    );
    assert.equal(aliceRow.rows.length, 1);
    assert.ok(aliceRow.rows[0].emails_received >= 0);
  });

  it('increments emails_received on subsequent detection (interaction count)', async () => {
    const before = await query(
      `SELECT emails_received FROM signal.contacts WHERE email_address = 'alice@example.com'`,
    );
    const beforeCount = before.rows[0]?.emails_received ?? 0;

    await detectSignals({
      message: 'follow-up note — please cc alice@example.com on the next round.',
      messageId: MSG_ID,
      agentId: 'executor-responder',
      ownerId: OWNER_ID,
      scopedQuery: query,
    });

    const after = await query(
      `SELECT emails_received FROM signal.contacts WHERE email_address = 'alice@example.com'`,
    );
    assert.ok(
      after.rows[0].emails_received > beforeCount,
      `expected interaction count to increment from ${beforeCount}, got ${after.rows[0].emails_received}`,
    );
  });

  it('skips short / stopword messages and writes nothing', async () => {
    const before = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.signals WHERE message_id = $1`,
      [MSG_ID],
    );
    const r = await detectSignals({
      message: 'thanks!',
      messageId: MSG_ID,
      agentId: 'executor-responder',
      ownerId: OWNER_ID,
      scopedQuery: query,
    });
    assert.equal(r.skipped, true);
    const after = await query(
      `SELECT COUNT(*)::int AS n FROM inbox.signals WHERE message_id = $1`,
      [MSG_ID],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'skip path must not write');
  });

  it('throws on missing scopedQuery (programming-error guard)', async () => {
    await assert.rejects(
      () => detectSignals({ message: 'long enough message about a TODO', messageId: MSG_ID, agentId: 'x' }),
      /scopedQuery is required/,
    );
  });

  it('throws on missing messageId (programming-error guard)', async () => {
    await assert.rejects(
      () => detectSignals({ message: 'long enough message about a TODO', agentId: 'x', scopedQuery: query }),
      /messageId is required/,
    );
  });

  it('accumulates errors instead of throwing on DB write failures', async () => {
    // Use a messageId that doesn't exist in inbox.messages — the FK on
    // inbox.signals(message_id) will reject every idea insert. Entities
    // should still proceed because signal.contacts has no FK to messages.
    const r = await detectSignals({
      message: 'Please review by Friday. TODO: ping carol@example.com.',
      messageId: 'nonexistent-message-id-xyz',
      agentId: 'executor-responder',
      ownerId: OWNER_ID,
      scopedQuery: query,
    });

    assert.equal(r.skipped, false);
    assert.ok(r.errors.length >= 1, 'expected at least one idea-phase error');
    assert.ok(r.errors.every(e => e.phase === 'idea'), 'expected only idea errors');
    // Entities still succeeded
    assert.ok(r.entities.length >= 1, 'entity phase should be independent of idea phase');
  });
});
