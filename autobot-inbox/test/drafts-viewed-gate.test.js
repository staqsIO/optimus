import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression for the drafts viewed_at gate (sql/115-drafts-viewed-gate.sql).
 *
 * Two-stage gate in src/gmail/auto-archive-sweep.js:findCandidates:
 *   1. Unviewed drafts get UNVIEWED_GRACE_HOURS (24h) from creation before
 *      they're eligible.
 *   2. Viewed drafts get VIEWED_REAP_GRACE_HOURS (12h) from viewed_at before
 *      they're eligible. The original gate (f4d262f) treated any non-NULL
 *      viewed_at as immediate eligibility, which turned page-load into a
 *      self-destruct trigger — every fresh draft was reaped on the next
 *      sweep cycle after the user opened the drafts page.
 *
 * These tests pin the SQL-level invariant for findCandidates and the
 * UI-side stamping side effect.
 */
describe('drafts viewed_at gate', () => {
  let queryFn;

  const MSG_ID = 'msg-115-thread-1';
  const ACCT_ID = 'acct-115-eric';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-drafts-viewed-gate', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    await queryFn(
      `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, is_active, sync_status)
       VALUES ($1, 'email', 'gmail', 'Eric', 'eric-115@staqs.io', true, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ACCT_ID],
    );
    await queryFn(
      `INSERT INTO inbox.messages (
         id, provider_msg_id, provider, thread_id, message_id,
         from_address, to_addresses, subject, received_at, channel, account_id
       ) VALUES ($1, 'pmid-115', 'gmail', 'thread-115', 'rfc-115',
                 'partner@example.com', ARRAY['eric-115@staqs.io'],
                 'Hello', now(), 'email', $2)
       ON CONFLICT (id) DO NOTHING`,
      [MSG_ID, ACCT_ID],
    );
  });

  // createdAgo and viewedAgoMin are both expressed in minutes.
  async function insertDraft({ id, createdAgo, viewedAgoMin }) {
    const createdAt = new Date(Date.now() - createdAgo * 60_000).toISOString();
    const viewedAt = viewedAgoMin == null
      ? null
      : new Date(Date.now() - viewedAgoMin * 60_000).toISOString();
    await queryFn(
      `INSERT INTO agent_graph.action_proposals (
         id, action_type, body, message_id, subject, to_addresses, channel,
         send_state, created_at, viewed_at
       ) VALUES (
         $1, 'email_draft', 'body', $2, 'sub',
         ARRAY['x@example.com'], 'email', 'pending',
         $3::timestamptz, $4::timestamptz
       )
       ON CONFLICT (id) DO UPDATE SET
         created_at = EXCLUDED.created_at,
         viewed_at = EXCLUDED.viewed_at,
         board_action = NULL,
         acted_at = NULL`,
      [id, MSG_ID, createdAt, viewedAt],
    );
  }

  // Replicates the findCandidates WHERE clause in src/gmail/auto-archive-sweep.js
  async function eligibleForReap({
    skipMinutes = 10,
    unviewedGraceHours = 24,
    viewedReapGraceHours = 12,
  } = {}) {
    const r = await queryFn(
      `SELECT id
         FROM agent_graph.action_proposals p
        WHERE p.action_type = 'email_draft'
          AND p.board_action IS NULL
          AND p.acted_at IS NULL
          AND p.created_at < now() - ($1 || ' minutes')::interval
          AND (
            (p.viewed_at IS NOT NULL
               AND p.viewed_at < now() - ($3 || ' hours')::interval)
            OR p.created_at < now() - ($2 || ' hours')::interval
          )
        ORDER BY id`,
      [String(skipMinutes), String(unviewedGraceHours), String(viewedReapGraceHours)],
    );
    return r.rows.map((x) => x.id);
  }

  it('fresh unviewed draft (< 10 min) is NOT eligible — the existing freshness window', async () => {
    await insertDraft({ id: 'd-fresh-unviewed', createdAgo: 5, viewedAgoMin: null });
    const ids = await eligibleForReap();
    assert.ok(!ids.includes('d-fresh-unviewed'), 'fresh draft must be ineligible');
  });

  it('older unviewed draft (1 hour old, < 24h grace) is NOT eligible — gate blocks it', async () => {
    await insertDraft({ id: 'd-1h-unviewed', createdAgo: 60, viewedAgoMin: null });
    const ids = await eligibleForReap();
    assert.ok(!ids.includes('d-1h-unviewed'), 'unviewed draft inside grace window must be ineligible');
  });

  it('recently-viewed draft (viewed within 12h grace) is NOT eligible — page-load no longer self-destructs', async () => {
    // Page-load → stamp → reap-on-next-cycle was the regression. A draft
    // viewed seconds ago must survive at least VIEWED_REAP_GRACE_HOURS.
    await insertDraft({ id: 'd-just-viewed', createdAgo: 60, viewedAgoMin: 1 });
    const ids = await eligibleForReap();
    assert.ok(!ids.includes('d-just-viewed'), 'just-viewed draft must be ineligible inside the post-view grace');
  });

  it('viewed draft past VIEWED_REAP_GRACE_HOURS is eligible — grace eventually expires', async () => {
    // created 14h ago but viewed 13h ago → eligible only via the 12h post-view grace,
    // not via the 24h created_at fallback branch.
    await insertDraft({ id: 'd-viewed-13h-ago', createdAgo: 14 * 60, viewedAgoMin: 13 * 60 });
    const ids = await eligibleForReap();
    assert.ok(ids.includes('d-viewed-13h-ago'), 'draft viewed past the post-view grace must be reapable');
  });

  it('unviewed draft past 24h grace becomes eligible — safety net works', async () => {
    await insertDraft({ id: 'd-30h-unviewed', createdAgo: 30 * 60, viewedAgoMin: null });
    const ids = await eligibleForReap();
    assert.ok(ids.includes('d-30h-unviewed'), 'past-grace unviewed draft must be reapable');
  });

  it('viewed_at stamp is idempotent — second stamp does not overwrite', async () => {
    await insertDraft({ id: 'd-stamp-test', createdAgo: 60, viewedAgoMin: 10 });
    const before = await queryFn(
      `SELECT viewed_at FROM agent_graph.action_proposals WHERE id = $1`,
      ['d-stamp-test'],
    );
    // Mirrors GET /api/drafts post-query stamp: UPDATE ... WHERE viewed_at IS NULL
    await queryFn(
      `UPDATE agent_graph.action_proposals
          SET viewed_at = now()
        WHERE id = $1 AND viewed_at IS NULL`,
      ['d-stamp-test'],
    );
    const after = await queryFn(
      `SELECT viewed_at FROM agent_graph.action_proposals WHERE id = $1`,
      ['d-stamp-test'],
    );
    assert.equal(
      Number(new Date(after.rows[0].viewed_at)),
      Number(new Date(before.rows[0].viewed_at)),
      'viewed_at must not change on second stamp attempt',
    );
  });
});
