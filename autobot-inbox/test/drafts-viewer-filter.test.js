import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-317 regression — /api/drafts must not leak drafts across viewers.
 *
 * Validates the recipient-based viewer filter used by GET /api/drafts:
 *   1. `resolveViewerEmails` returns the union of board_members.email and
 *      inbox.accounts.identifier (channel='email') for the caller.
 *   2. The SQL filter excludes drafts whose underlying message has neither
 *      to_addresses nor cc_addresses overlap with the viewer's identifiers.
 *   3. Different viewers get disjoint draft sets when the underlying
 *      message_id is the same (ingestion path doesn't determine visibility).
 */
describe('GET /api/drafts viewer filter (STAQPRO-317)', () => {
  let queryFn;

  const ERIC_BM_ID = '00000000-0000-0000-0000-0000000ee001';
  const DUSTIN_BM_ID = '00000000-0000-0000-0000-0000000dd002';

  const ACCT_ERIC = 'acct-eric-staqs';
  const ACCT_DUSTIN = 'acct-dustin-umb';

  const MSG_TO_ERIC_ONLY = 'msg-eric-only';
  const MSG_TO_DUSTIN_ONLY = 'msg-dustin-only';
  const MSG_TO_BOTH = 'msg-shared-cc';

  const PROP_TO_ERIC_ONLY = '00000000-0000-0000-0000-000000031701';
  const PROP_TO_DUSTIN_ONLY = '00000000-0000-0000-0000-000000031702';
  const PROP_TO_BOTH = '00000000-0000-0000-0000-000000031703';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-drafts-viewer-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    // Two board members. Note: Dustin is ingested through `dustin@umbadvisors.com`
    // (the shared mailbox in the STAQPRO-317 bug report).
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, email, role, is_active)
       VALUES
         ($1, 'test-eric-317',  'Eric Test',    'eric-317@staqs.io',           'admin',  true),
         ($2, 'test-dustin-317', 'Dustin Test', 'dustin-317@umbadvisors.com', 'member', true)
       ON CONFLICT (id) DO NOTHING`,
      [ERIC_BM_ID, DUSTIN_BM_ID]
    );

    // One connected email account per board member.
    await queryFn(
      `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, is_active, sync_status, owner, owner_id)
       VALUES
         ($1, 'email', 'gmail', 'Eric Staqs',    'eric-317@staqs.io',          true, 'active', 'test-eric-317',  $3),
         ($2, 'email', 'gmail', 'Dustin UMB',    'dustin-317@umbadvisors.com', true, 'active', 'test-dustin-317', $4)
       ON CONFLICT (id) DO NOTHING`,
      [ACCT_ERIC, ACCT_DUSTIN, ERIC_BM_ID, DUSTIN_BM_ID]
    );

    // Three messages. Critically, ALL are ingested through Dustin's account
    // (account_id = ACCT_DUSTIN) to mirror the production bug where shared
    // mailbox polling stamps ingestion path, not recipient ownership.
    await queryFn(
      `INSERT INTO inbox.messages (
         id, provider_msg_id, provider, thread_id, message_id,
         from_address, to_addresses, cc_addresses,
         subject, received_at, channel, account_id
       ) VALUES
         ($1, 'pmid-eric', 'gmail', 'thr-1', 'rfc-1',
          'partner@example.com', ARRAY['eric-317@staqs.io'], ARRAY[]::text[],
          'For Eric only', now(), 'email', $4),
         ($2, 'pmid-dustin', 'gmail', 'thr-2', 'rfc-2',
          'partner@example.com', ARRAY['dustin-317@umbadvisors.com'], ARRAY[]::text[],
          'For Dustin only', now(), 'email', $4),
         ($3, 'pmid-shared', 'gmail', 'thr-3', 'rfc-3',
          'partner@example.com', ARRAY['dustin-317@umbadvisors.com'], ARRAY['eric-317@staqs.io'],
          'Shared partnership thread', now(), 'email', $4)
       ON CONFLICT (id) DO NOTHING`,
      [MSG_TO_ERIC_ONLY, MSG_TO_DUSTIN_ONLY, MSG_TO_BOTH, ACCT_DUSTIN]
    );

    // Three pending drafts, one per message. board_action IS NULL means each
    // would surface in the unfiltered legacy query.
    await queryFn(
      `INSERT INTO agent_graph.action_proposals (
         id, action_type, body, message_id, subject, to_addresses, channel, send_state
       ) VALUES
         ($1, 'email_draft', 'reply body 1', $4, 'Re: For Eric only',     ARRAY['partner@example.com'], 'email', 'pending'),
         ($2, 'email_draft', 'reply body 2', $5, 'Re: For Dustin only',   ARRAY['partner@example.com'], 'email', 'pending'),
         ($3, 'email_draft', 'reply body 3', $6, 'Re: Shared partnership', ARRAY['partner@example.com'], 'email', 'pending')
       ON CONFLICT (id) DO NOTHING`,
      [PROP_TO_ERIC_ONLY, PROP_TO_DUSTIN_ONLY, PROP_TO_BOTH,
       MSG_TO_ERIC_ONLY, MSG_TO_DUSTIN_ONLY, MSG_TO_BOTH]
    );
  });

  // Mirrors the resolveViewerEmails() SQL in src/api.js
  async function viewerEmails(githubUsername) {
    const r = await queryFn(
      `SELECT ARRAY(
         SELECT DISTINCT lower(e) FROM (
           SELECT bm.email AS e WHERE bm.email IS NOT NULL
           UNION ALL
           SELECT a.identifier AS e
             FROM inbox.accounts a
            WHERE a.owner_id = bm.id AND a.channel = 'email' AND a.identifier IS NOT NULL
         ) ids
         WHERE e IS NOT NULL
       ) AS emails
       FROM agent_graph.board_members bm
       WHERE bm.github_username = $1 AND bm.is_active = true LIMIT 1`,
      [githubUsername]
    );
    return r.rows[0]?.emails || [];
  }

  // Mirrors the filtered draft SQL in src/api.js
  async function draftsForEmails(emails) {
    const r = await queryFn(
      `SELECT d.id
         FROM agent_graph.action_proposals d
         JOIN inbox.messages m ON m.id = d.message_id
        WHERE d.action_type = 'email_draft' AND d.board_action IS NULL
          AND EXISTS (
            SELECT 1 FROM unnest(
              COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
            ) AS addr
            WHERE lower(addr) = ANY($1::text[])
          )
        ORDER BY d.id`,
      [emails]
    );
    return r.rows.map((row) => row.id);
  }

  it('resolves viewer emails from board_members.email + connected accounts', async () => {
    const eric = await viewerEmails('test-eric-317');
    assert.deepEqual(eric.sort(), ['eric-317@staqs.io']);

    const dustin = await viewerEmails('test-dustin-317');
    assert.deepEqual(dustin.sort(), ['dustin-317@umbadvisors.com']);
  });

  it('Eric sees drafts addressed to him (to or cc), not Dustin-only drafts', async () => {
    const emails = await viewerEmails('test-eric-317');
    const ids = await draftsForEmails(emails);
    assert.ok(ids.includes(PROP_TO_ERIC_ONLY), 'should include draft to Eric');
    assert.ok(ids.includes(PROP_TO_BOTH), 'should include draft cc-ing Eric');
    assert.ok(!ids.includes(PROP_TO_DUSTIN_ONLY), 'must NOT include draft addressed only to Dustin');
  });

  it('Dustin sees drafts addressed to him, not Eric-only drafts', async () => {
    const emails = await viewerEmails('test-dustin-317');
    const ids = await draftsForEmails(emails);
    assert.ok(ids.includes(PROP_TO_DUSTIN_ONLY), 'should include draft to Dustin');
    assert.ok(ids.includes(PROP_TO_BOTH), 'should include shared thread');
    assert.ok(!ids.includes(PROP_TO_ERIC_ONLY), 'must NOT include draft addressed only to Eric');
  });

  it('account_id does not determine visibility — ingestion path is irrelevant', async () => {
    // All three messages were ingested via ACCT_DUSTIN. If filtering were
    // ingestion-based, Eric would see 0 drafts (no message has account_id
    // = ACCT_ERIC). Confirm the recipient-based filter still surfaces 2.
    const ericEmails = await viewerEmails('test-eric-317');
    const ericIds = await draftsForEmails(ericEmails);
    assert.equal(ericIds.length, 2, 'Eric sees both drafts he is a recipient on');

    const owners = await queryFn(
      `SELECT DISTINCT m.account_id
         FROM inbox.messages m
        WHERE m.id IN ($1, $2, $3)`,
      [MSG_TO_ERIC_ONLY, MSG_TO_DUSTIN_ONLY, MSG_TO_BOTH]
    );
    assert.equal(owners.rows.length, 1, 'all 3 fixtures share one ingestion account');
    assert.equal(owners.rows[0].account_id, ACCT_DUSTIN);
  });

  it('viewer with no resolvable emails sees nothing (empty-array safety)', async () => {
    const ids = await draftsForEmails([]);
    assert.equal(ids.length, 0, 'empty viewer identifiers must yield zero drafts');
  });

  it('cross-user leak: viewer B never gets a draft addressed only to viewer A', async () => {
    // Direct expression of the acceptance criterion.
    const dustinEmails = await viewerEmails('test-dustin-317');
    const dustinDrafts = await draftsForEmails(dustinEmails);
    assert.ok(
      !dustinDrafts.includes(PROP_TO_ERIC_ONLY),
      'Dustin must not see a draft whose only recipient is eric@staqs.io'
    );
  });
});
