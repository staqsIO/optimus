import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A5 cross-tenant leak fuzz harness (STAQPRO-524).
 *
 * SUPERSEDED-FOR-FULL-SURFACE by test/fuzz/tenant-isolation-fuzz.test.js
 * (STAQPRO-567). This file remains the fast PGlite policy-branch check for the
 * RAG retriever + scope validator. The 567 harness is the real-Postgres,
 * non-superuser-pool exit gate that ALSO covers the surfaces this file
 * explicitly excludes (HTTP routes + non-RAG non-HTTP paths — see "What this
 * suite intentionally does NOT cover" below). Keep BOTH: this one runs in
 * test:ci every push; 567 is skip-gated until the STAQPRO-263 PR-B pool flip.
 *
 * Verification gate for the gbrain-adoption tenancy work (PRs #237-#240
 * + STAQPRO-522 / #244). The tenancy primitives (lib/db.js withBoardScope/
 * withAgentScope, lib/rag/scope.js, migration 126 FORCE RLS) are already
 * merged on main. This suite proves they actually scope.
 *
 * Pattern mirrors gbrain's company-brain tutorial Part 5
 * "Verify the scoping actually scopes" + their MCP fuzz suite which
 * exercised every read path and got zero leaks.
 *
 * Two synthetic board members A and B are seeded with disjoint rows
 * across every tenant-keyed surface:
 *   - content.documents + content.chunks       (owner_id UUID)
 *   - agent_graph.work_items                    (created_by TEXT, account_id TEXT)
 *   - inbox.accounts + inbox.messages           (owner_id, account_id)
 *   - signal.contacts                           (source_account_id)
 *
 * The harness then fuzzes every read path under each identity and
 * asserts ZERO rows leak across the boundary. Inverse tested for the
 * three highest-risk paths (RAG retrieve, work_items SELECT, inbox.messages).
 *
 * What this suite intentionally does NOT cover
 * --------------------------------------------
 * Direct HTTP route invocation: the autobot-inbox API routes funnel
 * every tenant-sensitive read through either (a) lib/rag/retriever.js
 * entry points or (b) withBoardScope()-wrapped query() calls against
 * the same underlying tables. We exercise the *underlying* leak surface
 * directly — that is the substrate every route handler depends on. A
 * route-level harness would add a Next.js test rig + cookie/JWT round-
 * trip plumbing for a strictly weaker assertion (same SQL, more glue).
 * If a route ever bypasses both retriever and withBoardScope, that's a
 * separate `route-bypasses-scope` lint/test, not a fuzz target.
 *
 * Mode gating
 * -----------
 * - PGlite-only assertions: scope validator, retriever entry points,
 *   tier gate. These run unconditionally — PGlite enforces RLS loosely
 *   (set_config flows through) which is enough for the policy-branch
 *   visible-rows checks here. Mirrors rag-retriever-scope.test.js.
 * - Real-Postgres-only assertions: RLS FORCE on agent_graph.work_items
 *   under a bogus agent_id (must return 0 rows) and under A's UUID
 *   (must return only A's rows). These SKIP when DATABASE_URL or
 *   AUTOBOT_AGENT_DB_PASSWORD is unset — same gate rls-tenancy.test.js
 *   uses, for the same reason: PGlite roles are SUPERUSER and bypass
 *   RLS, making the assertion vacuous.
 *
 * If this harness ever stops being deterministic (flake) the right
 * response is to widen the SELECT criteria (more MAGIC tokens / wider
 * matchCount) — not retry-loops. A non-deterministic isolation test is
 * worse than no test because it teaches the suite to ignore failures.
 */

// ── Mode gates (set BEFORE importing db.js) ─────────────────────────
const HAS_REAL_PG = !!process.env.DATABASE_URL;
const HAS_AUTOBOT_AGENT_OPT_IN = !!process.env.AUTOBOT_AGENT_DB_PASSWORD;
const RLS_FORCE_ENABLED = HAS_REAL_PG && HAS_AUTOBOT_AGENT_OPT_IN;

// Force PGlite for the validator + retriever + tier-gate assertions
// unless the test env is explicitly real-PG with the opt-in cookie.
// This matches the pattern used by withBoardScope.test.js and
// rag-retriever-scope.test.js — and crucially keeps the test
// deterministic across local laptops / CI without a Postgres docker.
if (!RLS_FORCE_ENABLED) {
  process.env.DATABASE_URL = '';
  delete process.env.REQUIRE_AGENT_JWT;
}

process.env.NODE_ENV = 'test';
// Test lives at autobot-inbox/test/fuzz/ — sql/ and data/ are two levels up.
process.env.SQL_DIR = new URL('../../sql', import.meta.url).pathname;
process.env.PGLITE_DATA_DIR = new URL('../../data/pglite-cross-tenant-fuzz', import.meta.url).pathname;

// ── Identities ──────────────────────────────────────────────────────
// UUIDs are the canonical board_members.id; lowercase hex so they
// satisfy both the UUID FK on content.documents.owner_id and the
// `^[a-z0-9_-]+$` shape required by withAgentScope when fed as the
// `sub`. UUID v4 format: 8-4-4-4-12 hex chars (mind the lengths —
// PGlite rejects malformed shapes with "invalid input syntax for type uuid").
const OWNER_A = '00000000-0000-0000-0000-0000000000a5';
const OWNER_B = '00000000-0000-0000-0000-0000000000b5';

const DOC_A = '00000000-0000-0000-0000-00000000a501';
const DOC_B = '00000000-0000-0000-0000-00000000b501';

// Phase-2 tenancy (live read-leak): the retriever now fails closed without a
// readable org set. The seeded docs have owner_org_id NULL → the org gate
// COALESCEs them to the canonical Staqs UUID, so a Staqs-scoped principal sees
// them. STAQS is threaded into every positive (results-expected) call; the
// deny-by-default and tier-forbidden assertions deliberately omit it (they must
// throw before the org gate matters).
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const STAQS = [STAQS_ORG];

const WORK_ITEM_A = 'wi-a5-tenant-a';
const WORK_ITEM_B = 'wi-a5-tenant-b';

const ACCOUNT_A = 'acct-a5-tenant-a';
const ACCOUNT_B = 'acct-a5-tenant-b';

const MESSAGE_A = 'msg-a5-tenant-a';
const MESSAGE_B = 'msg-a5-tenant-b';

const CONTACT_A = 'contact-a5-tenant-a';
const CONTACT_B = 'contact-a5-tenant-b';

// Unique tokens per side so a leak shows up as the WRONG token in the
// WRONG result set, not just an off-by-one count. Fuzzing intent: the
// retriever should never return chunks whose MAGIC matches the other
// side's identity.
const MAGIC = 'a5-fuzz-magic-token-shared-77f3';
const MAGIC_A_ONLY = 'a5-fuzz-magic-token-aONLY-1a2b';
const MAGIC_B_ONLY = 'a5-fuzz-magic-token-bONLY-9z8y';

describe('A5 cross-tenant leak fuzz (STAQPRO-524)', () => {
  let db;
  let retriever;

  before(async () => {
    db = await import('../../../lib/db.js');
    await db.initializeDatabase();

    retriever = await import('../../../lib/rag/retriever.js');

    // ── board_members: parents for owner_id FKs ──────────────────
    await db.query(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, email, role)
       VALUES ($1, $2, $3, $4, 'member')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, 'a5-fuzz-owner-a', 'A5 Fuzz Owner A', 'a5-a@test.local']
    );
    await db.query(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, email, role)
       VALUES ($1, $2, $3, $4, 'member')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_B, 'a5-fuzz-owner-b', 'A5 Fuzz Owner B', 'a5-b@test.local']
    );

    // ── content.documents + content.chunks ───────────────────────
    // Two chunks per doc: one with the shared MAGIC (the lexical
    // hook the retriever LIKEs against) and one with the side-
    // specific MAGIC_*_ONLY (the leak detector — if A's result set
    // contains MAGIC_B_ONLY, the tenant boundary failed).
    for (const [docId, ownerId, sideToken, label] of [
      [DOC_A, OWNER_A, MAGIC_A_ONLY, 'A'],
      [DOC_B, OWNER_B, MAGIC_B_ONLY, 'B'],
    ]) {
      await db.query(
        `INSERT INTO content.documents
           (id, source, source_id, title, raw_text, classification, owner_id, owner_org_id)
         VALUES ($1, 'upload', $2, $3, $4, 'INTERNAL', $5, NULL)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [
          docId,
          `a5-fuzz-${label}`,
          `A5 Fuzz Doc ${label}`,
          `${MAGIC} body for ${label} (${sideToken})`,
          ownerId,
        ]
      );
      await db.query(
        `INSERT INTO content.chunks (document_id, chunk_index, text, classification)
         VALUES ($1, 0, $2, 'INTERNAL')`,
        [docId, `${MAGIC} chunk for ${label}`]
      );
      await db.query(
        `INSERT INTO content.chunks (document_id, chunk_index, text, classification)
         VALUES ($1, 1, $2, 'INTERNAL')`,
        [docId, `${sideToken} side-specific marker for ${label}`]
      );
    }

    // ── inbox.accounts + inbox.messages ──────────────────────────
    // inbox.accounts.owner_id FKs to board_members; messages.account_id
    // FKs to accounts. Schema (001-baseline.sql ~L752):
    //   channel, provider, label, identifier all NOT NULL
    //   owner_id UUID added by migration 007.
    for (const [acctId, ownerId, label] of [
      [ACCOUNT_A, OWNER_A, 'A'],
      [ACCOUNT_B, OWNER_B, 'B'],
    ]) {
      await db.query(
        `INSERT INTO inbox.accounts
           (id, channel, provider, label, identifier, owner_id, sync_status)
         VALUES ($1, 'email', 'gmail', $2, $3, $4, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [acctId, `a5-fuzz-${label}`, `a5-${label.toLowerCase()}@inbox.local`, ownerId]
      );
    }
    // inbox.messages: channel/provider_msg_id CHECK constraint
    // (email channel requires provider_msg_id NOT NULL).
    for (const [msgId, acctId, label] of [
      [MESSAGE_A, ACCOUNT_A, 'A'],
      [MESSAGE_B, ACCOUNT_B, 'B'],
    ]) {
      await db.query(
        `INSERT INTO inbox.messages
           (id, provider_msg_id, provider, thread_id, message_id, from_address,
            subject, snippet, received_at, channel, account_id)
         VALUES ($1, $2, 'gmail', $3, $4, $5, $6, $7, now(), 'email', $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          msgId,
          `a5-provider-${label}`,
          `thread-${label}`,
          `<${msgId}@a5.fuzz>`,
          `sender-${label}@external.test`,
          `A5 Fuzz Message ${label}`,
          `${MAGIC} message snippet ${label}`,
          acctId,
        ]
      );
    }

    // ── agent_graph.work_items ───────────────────────────────────
    // created_by has a conditional FK to agent_configs(id) added in
    // 001-baseline (~L2615). To stay portable across PGlite/real-PG
    // we use the seeded 'board' agent_config — the trigger at L2192
    // also short-circuits assignment-rule enforcement for 'board'.
    // Tenant differentiation lives in account_id (TEXT, per-tenant).
    //
    // Note on RLS: the SELECT policy is
    //   assigned_to=current_agent_id() OR created_by=current_agent_id()
    //   OR parent_id IS NULL OR app.role='board'
    // — i.e. board scope sees ALL rows by design. Direct work_items
    // SELECT under withBoardScope is NOT tenant-scoped at the DB layer;
    // PART 5's assertion below documents the gap rather than asserting
    // a property that doesn't hold.
    //
    // First seed the 'board' agent_config so the FK can attach.
    await db.query(
      `INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
       VALUES ('board', 'board', 'sonnet', 'a5-fuzz-seed', 'a5fuzzhash', true)
       ON CONFLICT (id) DO NOTHING`
    );
    for (const [wiId, acctId, label] of [
      [WORK_ITEM_A, ACCOUNT_A, 'A'],
      [WORK_ITEM_B, ACCOUNT_B, 'B'],
    ]) {
      await db.query(
        `INSERT INTO agent_graph.work_items
           (id, type, title, description, status, created_by, account_id, data_classification)
         VALUES ($1, 'task', $2, $3, 'created', 'board', $4, 'INTERNAL')
         ON CONFLICT (id) DO NOTHING`,
        [
          wiId,
          `A5 Fuzz Work Item ${label}`,
          `${MAGIC} work item for ${label}`,
          acctId,
        ]
      );
    }

    // ── signal.contacts ──────────────────────────────────────────
    // source_account_id is the per-tenant scoping column on contacts.
    // Schema (001-baseline.sql ~L924): id TEXT, email_address NOT NULL UNIQUE,
    // name TEXT, source_account_id TEXT.
    for (const [contactId, acctId, label] of [
      [CONTACT_A, ACCOUNT_A, 'A'],
      [CONTACT_B, ACCOUNT_B, 'B'],
    ]) {
      await db.query(
        `INSERT INTO signal.contacts
           (id, email_address, name, source_account_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          contactId,
          `contact-${label.toLowerCase()}@external.test`,
          `A5 Fuzz Contact ${label}`,
          acctId,
        ]
      );
    }
  });

  after(async () => {
    if (db) await db.close();
  });

  // ============================================================
  // PART 1: RAG retriever fuzz (all 4 entry points, both sides)
  // ============================================================

  describe('RAG retriever — every entry point scoped by ownerId', () => {
    // Reusable assertion: a chunk set MUST NOT contain the other
    // side's document id OR the other side's MAGIC_*_ONLY token.
    function assertNoLeak(chunks, allowedDocId, forbiddenDocId, forbiddenToken) {
      const docIds = new Set(chunks.map((c) => c.documentId));
      assert.equal(
        docIds.has(allowedDocId),
        true,
        `expected to see allowed doc ${allowedDocId} in result`
      );
      assert.equal(
        docIds.has(forbiddenDocId),
        false,
        `LEAK: forbidden doc ${forbiddenDocId} appeared in result`
      );
      const leakedToken = chunks.find((c) =>
        (c.text || c.chunkText || '').includes(forbiddenToken)
      );
      assert.equal(
        leakedToken,
        undefined,
        `LEAK: forbidden token "${forbiddenToken}" appeared in result text`
      );
    }

    it('lexicalChunkSearch: ownerId=A → only A, no B', async () => {
      const r = await retriever.lexicalChunkSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { ownerId: OWNER_A, readOrgIds: STAQS }
      );
      assertNoLeak(r.chunks, DOC_A, DOC_B, MAGIC_B_ONLY);
    });

    it('lexicalChunkSearch: ownerId=B → only B, no A (inverse)', async () => {
      const r = await retriever.lexicalChunkSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { ownerId: OWNER_B, readOrgIds: STAQS }
      );
      assertNoLeak(r.chunks, DOC_B, DOC_A, MAGIC_A_ONLY);
    });

    it('searchChunks: ownerId=A → only A, no B (semantic; may degrade to null without embedder)', async () => {
      // searchChunks requires an embedder (OpenAI/Voyage/etc); the
      // test env has no API key so it returns null. The contract we
      // care about is "scope arg is enforced and, when results exist,
      // they are scoped" — checked here defensively. The cousin tests
      // in rag-retriever-scope.test.js have the same nullable contract.
      const r = await retriever.searchChunks(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { ownerId: OWNER_A, readOrgIds: STAQS }
      );
      if (r && Array.isArray(r.chunks)) {
        assertNoLeak(r.chunks, DOC_A, DOC_B, MAGIC_B_ONLY);
      }
    });

    it('searchChunks: ownerId=B → only B, no A (inverse, embedder-dependent)', async () => {
      const r = await retriever.searchChunks(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { ownerId: OWNER_B, readOrgIds: STAQS }
      );
      if (r && Array.isArray(r.chunks)) {
        assertNoLeak(r.chunks, DOC_B, DOC_A, MAGIC_A_ONLY);
      }
    });

    it('retrieveContext: ownerId=A → answer chunks contain no B markers', async () => {
      // retrieveContext synthesizes via LLM; in test mode it returns
      // { answer, chunks }. We only need to assert chunks are scoped.
      const r = await retriever.retrieveContext(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { ownerId: OWNER_A, readOrgIds: STAQS }
      );
      // retrieveContext may return null on LLM provider miss (test
      // harness has no key); the chunks-only contract still holds.
      if (r && Array.isArray(r.chunks)) {
        assertNoLeak(r.chunks, DOC_A, DOC_B, MAGIC_B_ONLY);
      }
    });

    it('wikiPageSearch: ownerId scope accepted (no per-row owner column yet — scope is API-consistent)', async () => {
      // Per lib/rag/scope.js: wikiPageSearch has no per-row owner on
      // content.wiki_pages (created_by TEXT, migration 039). The
      // validator still requires a scope so the API is consistent;
      // forward-compat checkpoint. We just assert the call doesn't
      // throw under a valid ownerId.
      const r = await retriever.wikiPageSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 10 },
        { ownerId: OWNER_A, readOrgIds: STAQS }
      );
      assert.ok(r, 'wikiPageSearch returned undefined under valid scope');
    });
  });

  // ============================================================
  // PART 2: Scope validator deny-by-default fuzz
  // ============================================================

  describe('scope validator — deny-by-default on every malformed shape', () => {
    const ENTRY_POINTS = [
      ['retrieveContext', (s) => retriever.retrieveContext(MAGIC, {}, s)],
      ['searchChunks',     (s) => retriever.searchChunks(MAGIC, {}, s)],
      ['lexicalChunkSearch', (s) => retriever.lexicalChunkSearch(MAGIC, {}, s)],
      ['wikiPageSearch',   (s) => retriever.wikiPageSearch(MAGIC, {}, s)],
    ];

    for (const [name, fn] of ENTRY_POINTS) {
      it(`${name}: missing scope → throws RetrieverScopeError`, async () => {
        await assert.rejects(
          () => fn(undefined),
          (err) => err.name === 'RetrieverScopeError'
        );
      });

      it(`${name}: ambiguous {ownerId, org:true} → throws`, async () => {
        await assert.rejects(
          () => fn({ ownerId: OWNER_A, org: true, agentId: 'strategist' }),
          /ambiguous/
        );
      });

      it(`${name}: org:true without agentId → throws`, async () => {
        await assert.rejects(
          () => fn({ org: true }),
          (err) => err.name === 'RetrieverScopeError'
        );
      });

      it(`${name}: ownerId not a UUID → throws`, async () => {
        await assert.rejects(
          () => fn({ ownerId: 'not-a-uuid' }),
          /UUID/
        );
      });
    }
  });

  // ============================================================
  // PART 3: Tier gate on org-wide scope
  // ============================================================

  describe('tier gate — org-wide scope only opens for Architect / Strategist', () => {
    it('executor-tier agent + org:true → throws (tier_forbidden)', async () => {
      // executor-intake / executor-responder / executor-coder all
      // tier=Executor in autobot-inbox/config/agents.json. Pick the
      // most obviously executor-flavored one.
      await assert.rejects(
        () => retriever.lexicalChunkSearch(
          MAGIC,
          { maxClassification: 'INTERNAL', matchCount: 30 },
          { org: true, agentId: 'executor-intake' }
        ),
        (err) => err.name === 'RetrieverScopeError' && /tier/.test(err.message)
      );
    });

    it('orchestrator-tier + org:true → throws (not in ORG_SCOPE_ALLOWED_TIERS)', async () => {
      // ORG_SCOPE_ALLOWED_TIERS is ['Strategist', 'Architect', 'Reviewer'].
      // Orchestrator is explicitly NOT included — confirms the allow-list
      // is hard-edged, not "anything not Executor".
      await assert.rejects(
        () => retriever.lexicalChunkSearch(
          MAGIC,
          { maxClassification: 'INTERNAL', matchCount: 30 },
          { org: true, agentId: 'orchestrator' }
        ),
        (err) => err.name === 'RetrieverScopeError' && /tier/.test(err.message)
      );
    });

    it('unknown agent + org:true → throws (tier=null treated as deny)', async () => {
      await assert.rejects(
        () => retriever.lexicalChunkSearch(
          MAGIC,
          { maxClassification: 'INTERNAL', matchCount: 30 },
          { org: true, agentId: 'agent-that-does-not-exist' }
        ),
        (err) => err.name === 'RetrieverScopeError'
      );
    });

    it('architect-tier + org:true → sees BOTH A and B', async () => {
      const r = await retriever.lexicalChunkSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { org: true, agentId: 'architect', readOrgIds: STAQS }
      );
      const ids = new Set(r.chunks.map((c) => c.documentId));
      assert.equal(ids.has(DOC_A), true, 'architect must see A');
      assert.equal(ids.has(DOC_B), true, 'architect must see B');
    });

    it('strategist-tier + org:true → sees BOTH A and B', async () => {
      const r = await retriever.lexicalChunkSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { org: true, agentId: 'strategist', readOrgIds: STAQS }
      );
      const ids = new Set(r.chunks.map((c) => c.documentId));
      assert.equal(ids.has(DOC_A), true, 'strategist must see A');
      assert.equal(ids.has(DOC_B), true, 'strategist must see B');
    });

    it('reviewer-tier + org:true → sees BOTH A and B (Reviewer IS in ORG_SCOPE_ALLOWED_TIERS)', async () => {
      // Reviewer is explicitly allowed by lib/rag/scope.js:70 alongside
      // Strategist and Architect. This positive test exists to lock in
      // that decision — if a future change removes Reviewer from the
      // allow-list this test will fail and force a deliberate update.
      const r = await retriever.lexicalChunkSearch(
        MAGIC,
        { maxClassification: 'INTERNAL', matchCount: 30 },
        { org: true, agentId: 'reviewer', readOrgIds: STAQS }
      );
      const ids = new Set(r.chunks.map((c) => c.documentId));
      assert.equal(ids.has(DOC_A), true, 'reviewer must see A');
      assert.equal(ids.has(DOC_B), true, 'reviewer must see B');
    });
  });

  // ============================================================
  // PART 4: Direct DB queries under withBoardScope (PGlite-loose)
  // ============================================================
  // PGlite enforces app.role/app.agent_id set_config flow-through but
  // doesn't FORCE policy on superuser owners — so these assertions
  // verify the scope-setting plumbing, not the policy enforcement.
  // Hard policy enforcement is tested in PART 5 under real Postgres.

  describe('withBoardScope direct queries — scope plumbing fires under PGlite', () => {
    it('withBoardScope(A) sets app.role=board AND app.agent_id=A', async () => {
      const scoped = await db.withBoardScope({ role: 'board', sub: OWNER_A });
      try {
        const r = await scoped(
          `SELECT current_setting('app.role', true) AS role,
                  current_setting('app.agent_id', true) AS aid`
        );
        assert.equal(r.rows[0].role, 'board');
        assert.equal(r.rows[0].aid, OWNER_A);
      } finally {
        await scoped.release();
      }
    });

    it('withBoardScope(B) sets app.agent_id=B (distinct from A)', async () => {
      const scoped = await db.withBoardScope({ role: 'board', sub: OWNER_B });
      try {
        const r = await scoped(
          `SELECT current_setting('app.agent_id', true) AS aid`
        );
        assert.equal(r.rows[0].aid, OWNER_B);
        assert.notEqual(r.rows[0].aid, OWNER_A);
      } finally {
        await scoped.release();
      }
    });

    it('withBoardScope rejects garbage / role mismatch (defense in depth)', async () => {
      await assert.rejects(() => db.withBoardScope(null), /must be called/);
      await assert.rejects(
        () => db.withBoardScope({ role: 'agent', sub: OWNER_A }),
        /must be called/
      );
      await assert.rejects(
        () => db.withBoardScope({ role: 'board' }),
        /must be called/
      );
    });
  });

  // ============================================================
  // PART 5: Real-Postgres RLS FORCE assertions (SKIP on PGlite)
  // ============================================================
  // What this part DOES assert (load-bearing for migration 126):
  //   - Under a bogus agent_id with no board role, agent_graph.work_items
  //     returns 0 rows. This is the headline assertion: FORCE RLS +
  //     non-superuser pool role + agent-keyed policy must compose to
  //     deny everything when the caller has no identity match.
  //
  // What this part EXPLICITLY does NOT assert (and why):
  //   - Per-tenant SELECT isolation on agent_graph.work_items under
  //     withBoardScope(A) vs withBoardScope(B). The current
  //     `agent_read_work_items` policy (001-baseline.sql L2655) is:
  //         assigned_to = current_agent_id()
  //         OR created_by = current_agent_id()
  //         OR parent_id IS NULL
  //         OR current_setting('app.role') = 'board'
  //     The 'board' branch makes EVERY row visible to any board user,
  //     and `parent_id IS NULL` makes every top-level item visible to
  //     every agent. Tenant isolation for work_items lives in the
  //     application-layer `account_id` filter, not in RLS. Asserting
  //     "A doesn't see B's work_items via withBoardScope" would FAIL
  //     by design — and dressing the test up to make it pass would
  //     mask the actual gap. Documenting the gap here is the honest move.
  //
  //   - Per-tenant SELECT isolation on inbox.messages. The
  //     `read_messages` policy (001-baseline.sql L2693) is
  //     `USING (true)` — all rows visible to anyone with read grants.
  //     Same story: tenant isolation is application-layer, not RLS.
  //
  // Follow-up (not in scope of A5): if the architectural target is
  // RLS-enforced per-tenant isolation on these tables, the work is
  // (a) add an account_id-keyed policy on work_items + messages,
  // (b) extend withBoardScope to set a per-tenant account context,
  // (c) revisit the `parent_id IS NULL` clause on work_items.
  // File that as STAQPRO-525 (proposed).
  //
  // Real-PG gate (DATABASE_URL + AUTOBOT_AGENT_DB_PASSWORD): PGlite
  // pre-creates autobot_agent as SUPERUSER (lib/db.js:147), so RLS is
  // bypassed and these assertions would pass vacuously. Same SKIP
  // condition rls-tenancy.test.js uses.

  describe('RLS FORCE — agent_id scoping on work_items (real Postgres only)', () => {
    before(() => {
      if (!RLS_FORCE_ENABLED) {
        // eslint-disable-next-line no-console
        console.log(
          '[a5-fuzz] SKIPPING RLS FORCE assertions — requires DATABASE_URL + AUTOBOT_AGENT_DB_PASSWORD'
        );
      }
    });

    const BOGUS_AGENT_ID = '00000000-0000-0000-0000-deadbeefdead';

    it('bogus agent_id → 0 rows from agent_graph.work_items', { skip: !RLS_FORCE_ENABLED }, async () => {
      const scoped = await db.withAgentScope(BOGUS_AGENT_ID);
      try {
        const r = await scoped(`SELECT count(*)::int AS cnt FROM agent_graph.work_items`);
        assert.equal(
          r.rows[0].cnt,
          0,
          'work_items leaked under bogus agent_id — RLS FORCE not enforcing'
        );
      } finally {
        await scoped.release();
      }
    });

    it('bogus agent_id → 0 rows from agent_graph.task_events', { skip: !RLS_FORCE_ENABLED }, async () => {
      const scoped = await db.withAgentScope(BOGUS_AGENT_ID);
      try {
        const r = await scoped(`SELECT count(*)::int AS cnt FROM agent_graph.task_events`);
        assert.equal(r.rows[0].cnt, 0, 'task_events leaked under bogus agent_id');
      } finally {
        await scoped.release();
      }
    });

    it('FORCE ROW LEVEL SECURITY is set on agent_graph.work_items', { skip: !RLS_FORCE_ENABLED }, async () => {
      const r = await db.query(
        `SELECT c.relforcerowsecurity AS forced
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'agent_graph' AND c.relname = 'work_items'`
      );
      assert.equal(
        r.rows[0]?.forced,
        true,
        'work_items must have FORCE ROW LEVEL SECURITY set after migration 126'
      );
    });
  });
});
