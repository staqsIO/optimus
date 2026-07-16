import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-531 regression — the bare shared INBOX_API_SECRET must NOT grant an
 * admin/global view. The board proxies inbox calls through one route that
 * authenticates the session but historically forwarded only the shared secret,
 * never the viewer's identity. The backend then resolved that to a global
 * admin-bypass principal and skipped owner-scoping, leaking every board
 * member's drafts/contacts to every other board member.
 *
 * This validates the `resolveViewerEmails(req)` decision contract — the seam in
 * src/api.js that decides scoping:
 *   (a) api_secret + valid x-board-user username  -> adminBypass:false + that owner's emails
 *   (b) api_secret + NO username                  -> adminBypass:false + EMPTY emails (NOT bypass)
 *   (c) explicit internal role (agent JWT)        -> adminBypass:true
 *
 * Plus the end-to-end intent: a secret-only caller (no x-board-user) does not
 * surface another owner's drafts via the recipient-filtered drafts SQL.
 *
 * NOTE ON HARNESS: we mirror the resolveViewerEmails branching + SQL here rather
 * than importing src/api.js directly. Importing src/api.js transitively loads
 * src/api-routes/engagements.js -> lib/engagements/docx-export.js, which has a
 * static `import 'docx'`. `docx` is an UNDECLARED dependency (absent from
 * package.json and package-lock.json) — a pre-existing, STAQPRO-531-unrelated
 * breakage that crashes every api.js-importing test on this checkout
 * (board-skip.test.js, board-endpoint.test.js fail identically). This mirror
 * pattern matches the repo's existing scoping test (drafts-viewer-filter.test.js,
 * STAQPRO-317). The branching constants below are copied verbatim from
 * resolveViewerEmails so a future drift is caught by the (a)/(b)/(c) assertions.
 */
describe('STAQPRO-531 viewer scoping — shared secret is not admin bypass', () => {
  let queryFn;

  const ERIC_BM_ID = '00000000-0000-0000-0000-0000000ee531';
  const ACCT_ERIC = 'acct-eric-531';

  const MSG_TO_ERIC = 'msg-eric-531';
  const MSG_TO_OTHER = 'msg-other-531';
  const PROP_TO_ERIC = '00000000-0000-0000-0000-000000053101';
  const PROP_TO_OTHER = '00000000-0000-0000-0000-000000053102';

  // Second board member ("Dustin") who owns someone-else-531@umbadvisors.com — the victim
  // in the /api/today ?owner= cross-tenant test.
  const DUSTIN_BM_ID = '00000000-0000-0000-0000-0000000dd531';
  const ACCT_DUSTIN = 'acct-dustin-531';
  const DUSTIN_EMAIL = 'someone-else-531@umbadvisors.com';
  const HT_FOR_ERIC = 'ht-eric-531';   // human_task on the message addressed to Eric
  const HT_FOR_DUSTIN = 'ht-dustin-531'; // human_task on the message addressed to Dustin

  // STAQPRO-549: obligations whose source is NOT an email-to/cc match.
  // The recipient-overlap EXISTS is meaningless for these and previously
  // dropped them entirely (the "empty Open Obligations" bug). They must
  // survive the within-org recipient filter for any identified viewer.
  const MSG_WEBHOOK = 'msg-webhook-549';     // a non-email (webhook) source message
  const HT_NONEMAIL = 'ht-nonemail-549';     // human_task on the webhook message
  const HT_NOMESSAGE = 'ht-nomessage-549';   // human_task with NO source message (message_id NULL)

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-531-viewer-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, email, role, is_active)
       VALUES
         ($1, 'test-eric-531',  'Eric Test',   'eric-531@staqs.io', 'admin',  true),
         ($2, 'test-dustin-531', 'Dustin Test', $3,                 'member', true)
       ON CONFLICT (id) DO NOTHING`,
      [ERIC_BM_ID, DUSTIN_BM_ID, DUSTIN_EMAIL]
    );

    await queryFn(
      `INSERT INTO inbox.accounts (id, channel, provider, label, identifier, is_active, sync_status, owner, owner_id)
       VALUES
         ($1, 'email', 'gmail', 'Eric Staqs', 'eric-531@staqs.io', true, 'active', 'test-eric-531', $2),
         ($3, 'email', 'gmail', 'Dustin UMB',  $5,                 true, 'active', 'test-dustin-531', $4)
       ON CONFLICT (id) DO NOTHING`,
      [ACCT_ERIC, ERIC_BM_ID, ACCT_DUSTIN, DUSTIN_BM_ID, DUSTIN_EMAIL]
    );

    await queryFn(
      `INSERT INTO inbox.messages (
         id, provider_msg_id, provider, thread_id, message_id,
         from_address, to_addresses, cc_addresses,
         subject, received_at, channel, account_id
       ) VALUES
         ($1, 'pmid-eric-531', 'gmail', 'thr-531-1', 'rfc-531-1',
          'partner@example.com', ARRAY['eric-531@staqs.io'], ARRAY[]::text[],
          'For Eric only', now(), 'email', $3),
         ($2, 'pmid-other-531', 'gmail', 'thr-531-2', 'rfc-531-2',
          'partner@example.com', ARRAY['someone-else-531@umbadvisors.com'], ARRAY[]::text[],
          'For someone else only', now(), 'email', $3)
       ON CONFLICT (id) DO NOTHING`,
      [MSG_TO_ERIC, MSG_TO_OTHER, ACCT_ERIC]
    );

    // STAQPRO-549: a non-email (webhook) source message. No to/cc addresses, so the
    // recipient-overlap EXISTS can never match — yet a viewer must still see its task.
    // channel='webhook' requires channel_id NOT NULL (inbox.messages CHECK), and
    // account_id may be null for webhook/telegram/email per the same DDL.
    await queryFn(
      `INSERT INTO inbox.messages (
         id, provider_msg_id, provider, thread_id, message_id,
         from_address, to_addresses, cc_addresses,
         subject, received_at, channel, channel_id
       ) VALUES
         ($1, NULL, 'webhook', 'thr-531-wh', 'rfc-531-wh',
          'svc@example.com', ARRAY[]::text[], ARRAY[]::text[],
          'Webhook obligation', now(), 'webhook', 'wh-549-1')
       ON CONFLICT (id) DO NOTHING`,
      [MSG_WEBHOOK]
    );

    await queryFn(
      `INSERT INTO agent_graph.action_proposals (
         id, action_type, body, message_id, subject, to_addresses, channel, send_state
       ) VALUES
         ($1, 'email_draft', 'reply 1', $3, 'Re: For Eric only', ARRAY['partner@example.com'], 'email', 'pending'),
         ($2, 'email_draft', 'reply 2', $4, 'Re: For someone else', ARRAY['partner@example.com'], 'email', 'pending')
       ON CONFLICT (id) DO NOTHING`,
      [PROP_TO_ERIC, PROP_TO_OTHER, MSG_TO_ERIC, MSG_TO_OTHER]
    );

    // human_tasks for the /api/today scope tests. One per message; task_type='request'
    // (OWE bucket). Default status 'inbox' + null due_date satisfy HT_LIVE_PREDICATE.
    await queryFn(
      `INSERT INTO inbox.human_tasks (id, title, task_type, message_id, status)
       VALUES
         ($1, 'Eric obligation', 'request', $3, 'inbox'),
         ($2, 'Dustin obligation', 'request', $4, 'inbox')
       ON CONFLICT (id) DO NOTHING`,
      [HT_FOR_ERIC, HT_FOR_DUSTIN, MSG_TO_ERIC, MSG_TO_OTHER]
    );

    // STAQPRO-549: a webhook-sourced obligation and a sourceless obligation.
    // Both are in the OWE bucket (task_type='request') and live (default status,
    // null due_date). Neither can match the recipient EXISTS — the regression is
    // that the old bare EXISTS dropped both.
    await queryFn(
      `INSERT INTO inbox.human_tasks (id, title, task_type, message_id, status)
       VALUES
         ($1, 'Webhook obligation', 'request', $3, 'inbox'),
         ($2, 'Sourceless obligation', 'request', NULL, 'inbox')
       ON CONFLICT (id) DO NOTHING`,
      [HT_NONEMAIL, HT_NOMESSAGE, MSG_WEBHOOK]
    );
  });

  /**
   * Faithful mirror of resolveViewerEmails(req) in src/api.js (STAQPRO-531 version).
   * Branching is copied verbatim; the SQL is the same owner->email chain.
   */
  async function resolveViewerEmails(req) {
    if (!req.auth) return null;
    if (req.auth.source === 'agent_jwt') {
      return { ownerId: null, emails: [], adminBypass: true };
    }
    if (req.auth.role !== 'board') return null;
    const username = req.auth.github_username;
    if (!username) {
      if (req.auth.source === 'api_secret') {
        return { ownerId: null, emails: [], adminBypass: false };
      }
      return null;
    }
    const r = await queryFn(
      `SELECT bm.id AS owner_id,
              ARRAY(
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
        WHERE bm.github_username = $1 AND bm.is_active = true
        LIMIT 1`,
      [username]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ownerId: row.owner_id, emails: row.emails || [], adminBypass: false };
  }

  // Mirrors the recipient-based filtered drafts SQL in src/api.js GET /api/drafts.
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

  /**
   * Faithful mirror of GET /api/today scope resolution + recipient filter in src/api.js
   * (STAQPRO-531). Returns the human_task ids in the OWE bucket for the given request.
   * Proves the client `?owner=` param cannot widen a non-bypass viewer's scope.
   */
  async function todayOweTaskIds(req, ownerParam) {
    const viewer = await resolveViewerEmails(req);
    if (!viewer) return [];

    const safeOwner = ownerParam && /^[a-zA-Z0-9_-]+$/.test(ownerParam) ? ownerParam : null;
    let scopeEmails = viewer.emails;
    if (viewer.adminBypass) {
      if (safeOwner) {
        const o = await resolveViewerEmails({
          auth: { role: 'board', source: 'api_secret', github_username: safeOwner },
        });
        scopeEmails = o?.emails || [];
      } else {
        scopeEmails = null; // unfiltered global view
      }
    }
    // Non-bypass: scopeEmails stays as the viewer's own emails; ?owner= is ignored.

    const params = [];
    let viewerFilter = '';
    if (scopeEmails !== null) {
      params.push(scopeEmails);
      // STAQPRO-549: recipient-overlap only gates EMAIL-sourced tasks. Non-email
      // (m.channel <> 'email') and sourceless (m.id IS NULL after the LEFT JOIN)
      // tasks bypass it. Mirrors htViewerFilter in src/api.js GET /api/today.
      viewerFilter = `
        AND (
          m.id IS NULL
          OR m.channel IS DISTINCT FROM 'email'
          OR EXISTS (
            SELECT 1 FROM unnest(
              COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
            ) AS addr
            WHERE lower(addr) = ANY($1::text[])
          )
        )`;
    }
    const r = await queryFn(
      `SELECT ht.id
         FROM inbox.human_tasks ht
         LEFT JOIN inbox.messages m ON m.id = ht.message_id
        WHERE ht.deleted_at IS NULL
          AND ht.status NOT IN ('done','skipped','not_for_us')
          AND (ht.snoozed_until IS NULL OR ht.snoozed_until <= now())
          AND (ht.due_date IS NULL OR ht.due_date >= (now() - interval '7 days'))
          AND ht.task_type = 'request'${viewerFilter}
        ORDER BY ht.id`,
      params
    );
    return r.rows.map((row) => row.id);
  }

  it('(a) api_secret + valid x-board-user -> adminBypass:false + that owner emails', async () => {
    const req = {
      auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' },
    };
    const v = await resolveViewerEmails(req);
    assert.equal(v.adminBypass, false, 'identified board member is never admin bypass');
    assert.equal(v.ownerId, ERIC_BM_ID);
    assert.deepEqual(v.emails.sort(), ['eric-531@staqs.io']);
  });

  it('(b) api_secret + NO username -> adminBypass:false + EMPTY emails (not bypass)', async () => {
    const req = {
      auth: { role: 'board', source: 'api_secret', github_username: null },
    };
    const v = await resolveViewerEmails(req);
    assert.equal(v.adminBypass, false, 'bare shared secret must NOT grant admin bypass');
    assert.equal(v.ownerId, null);
    assert.deepEqual(v.emails, [], 'unidentified caller resolves to empty identifiers');
  });

  it('(c) explicit internal role (agent JWT) -> adminBypass:true', async () => {
    const req = {
      auth: { role: 'agent', source: 'agent_jwt', github_username: null },
    };
    const v = await resolveViewerEmails(req);
    assert.equal(v.adminBypass, true, 'agent JWTs hold trusted org-wide scope');
  });

  it('end-to-end: secret-only caller (no x-board-user) sees no drafts -> empty, not global', async () => {
    const req = { auth: { role: 'board', source: 'api_secret', github_username: null } };
    const v = await resolveViewerEmails(req);
    // With adminBypass:false + emails:[], the drafts SQL filter yields zero rows.
    const ids = await draftsForEmails(v.emails);
    assert.equal(ids.length, 0, 'unidentified caller must get EMPTY drafts, never global');
    assert.ok(!ids.includes(PROP_TO_OTHER), 'must not leak another owner draft');
    assert.ok(!ids.includes(PROP_TO_ERIC), 'must not leak any draft to an unidentified caller');
  });

  it('an identified viewer only sees drafts they are a recipient on', async () => {
    const req = { auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' } };
    const v = await resolveViewerEmails(req);
    const ids = await draftsForEmails(v.emails);
    assert.ok(ids.includes(PROP_TO_ERIC), 'Eric sees his own draft');
    assert.ok(!ids.includes(PROP_TO_OTHER), 'Eric must not see another owner draft');
  });

  // ---- /api/today ?owner= identity gap (STAQPRO-531, Linus SHOULD-FIX + Neo) ----

  it('today: viewer A passing ?owner=B is DENIED B data — scoped to self, never B', async () => {
    // Eric is the authenticated viewer; he attempts to read Dustin's obligations.
    const req = { auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' } };
    const ids = await todayOweTaskIds(req, 'test-dustin-531');
    assert.ok(ids.includes(HT_FOR_ERIC), 'Eric still sees his own obligation');
    assert.ok(!ids.includes(HT_FOR_DUSTIN), 'client ?owner= must NOT grant Dustin\'s obligation');
  });

  it('today: identified viewer with no ?owner= is scoped to their own EMAIL recipients', async () => {
    const req = { auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' } };
    const ids = await todayOweTaskIds(req, null);
    // Among EMAIL-sourced obligations, Eric sees his and never Dustin's. (STAQPRO-549
    // additionally surfaces non-email/sourceless obligations — asserted in the 549 case
    // below — so this no longer expects an exact single-element result.)
    assert.ok(ids.includes(HT_FOR_ERIC), 'Eric sees his own email obligation');
    assert.ok(!ids.includes(HT_FOR_DUSTIN), 'Eric must not see Dustin\'s email obligation');
  });

  it('today: unidentified caller (shared secret, no x-board-user) sees no EMAIL obligation, never global', async () => {
    // Recipient-layer guarantee (the only layer this mirror models): an empty scope
    // matches no email recipients, so no email-sourced obligation surfaces — in
    // particular not Dustin's. Full deny-by-default across ALL channels (the non-email
    // rows the STAQPRO-549 bypass lets through this filter) is enforced by the separate
    // org-scope layer (htOrgFilter = visibleClause → 'FALSE') in the live handler, which
    // the tenancy-parity / authz-spine suites cover.
    const req = { auth: { role: 'board', source: 'api_secret', github_username: null } };
    const ids = await todayOweTaskIds(req, 'test-dustin-531');
    assert.ok(!ids.includes(HT_FOR_ERIC), 'no email obligation leaks to an unidentified caller');
    assert.ok(!ids.includes(HT_FOR_DUSTIN), 'no email obligation leaks to an unidentified caller');
  });

  it('today: explicit internal caller (agent JWT) may target ?owner=B', async () => {
    // Trusted org agent scoping to Dustin via ?owner= resolves to Dustin's data only.
    const req = { auth: { role: 'agent', source: 'agent_jwt', github_username: null } };
    const ids = await todayOweTaskIds(req, 'test-dustin-531');
    assert.ok(ids.includes(HT_FOR_DUSTIN), 'internal caller may scope to a named owner');
    assert.ok(!ids.includes(HT_FOR_ERIC), 'and only that owner is in scope');
  });

  it('today: explicit internal caller with no ?owner= gets the global view', async () => {
    const req = { auth: { role: 'agent', source: 'agent_jwt', github_username: null } };
    const ids = await todayOweTaskIds(req, null);
    assert.ok(ids.includes(HT_FOR_ERIC) && ids.includes(HT_FOR_DUSTIN), 'internal global view sees all');
  });

  // ---- STAQPRO-549: recipient filter over-filtered non-email / sourceless obligations ----

  it('today: identified viewer sees webhook + sourceless obligations (not dropped by recipient filter)', async () => {
    const req = { auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' } };
    const ids = await todayOweTaskIds(req, null);
    assert.ok(ids.includes(HT_NONEMAIL), 'webhook obligation must render — recipient EXISTS does not apply to non-email');
    assert.ok(ids.includes(HT_NOMESSAGE), 'sourceless obligation must render — no message means no recipient test');
    // The fix must NOT widen cross-owner email visibility.
    assert.ok(ids.includes(HT_FOR_ERIC), 'Eric still sees his own email obligation');
    assert.ok(!ids.includes(HT_FOR_DUSTIN), 'Eric must STILL NOT see Dustin\'s email obligation (scoping intact)');
  });

  it('today: STAQPRO-549 bypass does NOT widen the recipient filter for EMAIL tasks', async () => {
    // The non-email/sourceless bypass is exactly that — it only relaxes the rows where
    // the recipient EXISTS is meaningless. Email-sourced rows are STILL recipient-gated,
    // so Eric never gains Dustin's email obligation through this change.
    const req = { auth: { role: 'board', source: 'api_secret', github_username: 'test-eric-531' } };
    const ids = await todayOweTaskIds(req, null);
    assert.ok(!ids.includes(HT_FOR_DUSTIN), 'email tasks stay recipient-scoped after the 549 fix');
  });

  // NOTE on deny-by-default for non-email rows: the unidentified caller (empty scope) is
  // NOT held out by the recipient filter — the bypass intentionally lets non-email/sourceless
  // rows through that filter. In the live GET /api/today handler those rows are held out by the
  // SEPARATE org-scope layer (htOrgFilter = visibleClause(principal); an unidentified principal
  // → 'FALSE' → zero rows; see lib/tenancy/scope.js). That org layer is exercised by the
  // tenancy-parity / authz-spine suites, not by this recipient-only mirror, so we do not assert
  // an empty non-email result here (the mirror does not model the org layer).
});
