import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Worktree 1 (RAG tenancy hardening) + Phase-2 org fail-closed: retriever scope gate.
 *
 * Asserts that lib/rag/scope.js + lib/rag/retriever.js together enforce
 * "deny by default" on the four retriever entry points:
 *
 *   - retrieveContext
 *   - searchChunks
 *   - lexicalChunkSearch
 *   - wikiPageSearch
 *
 * Required behaviour (Worktree 1):
 *   1. Calling any entry point with NO scope and NO legacy opts throws
 *      RetrieverScopeError.
 *   2. scope with both ownerId and org:true → throws (ambiguous).
 *   3. scope.org=true without agentId → throws.
 *   4. scope.org=true with an Executor-tier agentId → throws (tier).
 *   5. Two synthetic board-members A and B with disjoint documents:
 *      A's ownerId returns 0 of B's chunks; B's returns 0 of A's.
 *   6. scope.org=true with an Architect-tier agentId → returns chunks
 *      from both A and B.
 *
 * Required behaviour (Phase-2 org fail-closed — live read-leak):
 *   7. scopeToFilterOpts emits `filterOrgIds` from `readOrgIds`.
 *   8. A scope with NO readOrgIds → empty filterOrgIds (fail-closed).
 *   9. A scope whose readOrgIds is a FOREIGN org → match_chunks returns 0 rows
 *      (the seeded docs COALESCE owner_org_id to Staqs, so a non-Staqs principal
 *      sees nothing). The Staqs principal still sees them.
 *
 * Runs against ephemeral PGlite, mirrors autobot-inbox/test/
 * rag-retriever-classification.test.js shape.
 */
describe('RAG retriever — scope tenancy gate (Worktree 1 + Phase-2 org)', () => {
  let queryFn;
  let retriever;
  let scope;

  const MAGIC = 'scope-test-token-987';

  const OWNER_A = '00000000-0000-0000-0000-0000000000a1';
  const OWNER_B = '00000000-0000-0000-0000-0000000000b2';

  const DOC_A = '00000000-0000-0000-0000-0000000000aa';
  const DOC_B = '00000000-0000-0000-0000-0000000000bb';

  // Staqs org — the seeded docs have owner_org_id NULL, which match_chunks
  // COALESCEs to Staqs. A principal scoped to Staqs sees them; a foreign-org
  // principal sees nothing (fail-closed).
  const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
  const FOREIGN_ORG = '11111111-1111-1111-1111-111111111111';
  const STAQS = [STAQS_ORG];

  before(async () => {
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-rag-scope-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    retriever = await import('../../lib/rag/retriever.js');
    scope = await import('../../lib/rag/scope.js');

    // Seed two board_members so the owner_id FK on content.documents is
    // satisfied. github_username doubles as a stable per-row token.
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, email, role)
       VALUES ($1, 'wt1-owner-a', 'Owner A', 'a@example.com', 'member'),
              ($2, 'wt1-owner-b', 'Owner B', 'b@example.com', 'member')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B]
    );

    // Seed two documents, one per owner, both classified INTERNAL.
    // owner_org_id explicitly NULL so the org gate's COALESCE(owner_org_id,
    // '<Staqs>') maps these to the canonical hardcoded Staqs UUID (= STAQS_ORG
    // below) — matching production legacy/un-stamped docs. Migration 134 sets a
    // non-NULL DEFAULT = the PGlite-random live staqs org id; leaving the column
    // to that default would fail the COALESCE = ANY([hardcoded-Staqs]) gate and
    // the lexical org filter would fail closed (0 rows).
    for (const [docId, ownerId, label] of [
      [DOC_A, OWNER_A, 'doc-A'],
      [DOC_B, OWNER_B, 'doc-B'],
    ]) {
      await queryFn(
        `INSERT INTO content.documents
           (id, source, source_id, title, raw_text, classification, owner_id, owner_org_id)
         VALUES ($1, 'upload', $2, $3, $4, 'INTERNAL', $5, NULL)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [docId, `scope-test-${label}`, `Test ${label}`, `${MAGIC} body ${label}`, ownerId]
      );
      await queryFn(
        `INSERT INTO content.chunks (document_id, chunk_index, text, classification)
         VALUES ($1, 0, $2, 'INTERNAL')`,
        [docId, `${MAGIC} chunk for ${label}`]
      );
    }
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  // ── Validator-only tests (don't touch DB) ───────────────────────

  it('validateScope: no scope and no legacy opts → throws RetrieverScopeError', () => {
    assert.throws(
      () => scope.validateScope({ entryPoint: 'test' }),
      /scope arg required/
    );
  });

  it('validateScope: empty opts object (no legacy flags) → throws', () => {
    assert.throws(
      () => scope.validateScope({ entryPoint: 'test', opts: {} }),
      /scope arg required/
    );
  });

  it('validateScope: non-scope opts only ({matchCount}) → throws Mode 3 (STAQPRO-570 regression guard)', () => {
    // Regression guard for the Linus BLOCKER: a non-scope query param like
    // matchCount/maxClassification must NOT influence mode selection. Mode
    // selection is purely about scope SHAPE — a caller passing only opts with
    // no scope arg, no legacy scope flag, and no __scopeValidatedByParent MUST
    // fall to Mode 3 and hard-throw (fail-closed). If a future edit lets
    // "any meaningful opts" re-enter Mode 2, the fail-closed throw becomes
    // unreachable for every real caller (they all pass matchCount).
    assert.throws(
      () => scope.validateScope({ entryPoint: 'test', opts: { matchCount: 30 } }),
      (err) => err instanceof scope.RetrieverScopeError
        && err.reason === 'missing'
        && /scope arg required/.test(err.message)
    );
    // Also with a couple of typical companions — still Mode 3, still throws.
    assert.throws(
      () => scope.validateScope({
        entryPoint: 'test',
        opts: { matchCount: 30, maxClassification: 'INTERNAL', minSimilarity: 0.05 },
      }),
      /scope arg required/
    );
  });

  it('validateScope: scope with both ownerId and org:true → throws (ambiguous)', () => {
    assert.throws(
      () => scope.validateScope({
        entryPoint: 'test',
        scope: { ownerId: OWNER_A, org: true, agentId: 'strategist', readOrgIds: STAQS },
      }),
      /ambiguous/
    );
  });

  it('validateScope: scope.org=true without agentId → throws', () => {
    assert.throws(
      () => scope.validateScope({ entryPoint: 'test', scope: { org: true, readOrgIds: STAQS } }),
      /requires agentId/
    );
  });

  it('validateScope: scope.org=true with Executor-tier agentId → throws (tier_forbidden)', () => {
    assert.throws(
      () => scope.validateScope({
        entryPoint: 'test',
        scope: { org: true, agentId: 'executor-responder', readOrgIds: STAQS },
      }),
      /not allowed org-wide/
    );
  });

  it('validateScope: scope.ownerId not a UUID → throws', () => {
    assert.throws(
      () => scope.validateScope({ entryPoint: 'test', scope: { ownerId: 'not-a-uuid', readOrgIds: STAQS } }),
      /must be a UUID/
    );
  });

  it('validateScope: valid ownerId returns normalized scope with readOrgIds', () => {
    const out = scope.validateScope({ entryPoint: 'test', scope: { ownerId: OWNER_A, readOrgIds: STAQS } });
    assert.equal(out.ownerId, OWNER_A);
    assert.equal(out.org, false);
    assert.deepEqual(out.readOrgIds, STAQS);
  });

  it('validateScope: valid org-tier agent returns normalized org scope with readOrgIds', () => {
    const out = scope.validateScope({
      entryPoint: 'test',
      scope: { org: true, agentId: 'strategist', readOrgIds: STAQS },
    });
    assert.equal(out.org, true);
    assert.equal(out.agentId, 'strategist');
    assert.equal(out.ownerId, null);
    assert.deepEqual(out.readOrgIds, STAQS);
  });

  it('validateScope: legacy opts (ownerId only) → throws (STAQPRO-570 hard-throw)', () => {
    // STAQPRO-570: the legacy opts triple is no longer a transitional escape
    // hatch. A bare legacy-shaped scope (no validated `scope` arg) is fail-open
    // with two orgs live, so it now hard-throws instead of soft-degrading.
    assert.throws(
      () => scope.validateScope({
        entryPoint: 'test',
        opts: { ownerId: OWNER_A, readOrgIds: STAQS },
      }),
      /legacy scope shape .* no longer accepted/
    );
  });

  it('validateScope: internal parent passthrough (Symbol sentinel) still accepted', () => {
    // The one path still allowed via `opts`: retrieveContext re-entering its
    // inner entry points after it already validated a real scope. The sentinel
    // is a Symbol (STAQPRO-594) so only an in-process caller holding the exact
    // binding can set it.
    const out = scope.validateScope({
      entryPoint: 'test',
      opts: { ownerId: OWNER_A, readOrgIds: STAQS, [scope.SCOPE_VALIDATED_BY_PARENT]: true },
    });
    assert.equal(out.ownerId, OWNER_A);
    assert.equal(out.__legacy, true);
    assert.deepEqual(out.readOrgIds, STAQS);
  });

  it('validateScope: a FORGED string __scopeValidatedByParent key does NOT enter passthrough (STAQPRO-594)', () => {
    // The whole point of the Symbol: serialized/external input carrying the old
    // string key can no longer forge an "internal validated" scope. With no real
    // scope arg and only the forged string flag, it must fail closed (throw),
    // not silently enter Mode-2 passthrough.
    assert.throws(
      () => scope.validateScope({
        entryPoint: 'test',
        opts: { ownerId: OWNER_A, readOrgIds: STAQS, __scopeValidatedByParent: true },
      }),
      /scope/i,
      'a forged string sentinel must be rejected, not accepted as validated',
    );
  });

  // ── Phase-2 org fail-closed (validator-only) ────────────────────

  it('validateScope: scope with NO readOrgIds → empty readOrgIds (fail-closed, no throw)', () => {
    const out = scope.validateScope({ entryPoint: 'test', scope: { ownerId: OWNER_A } });
    assert.deepEqual(out.readOrgIds, [], 'missing readOrgIds resolves to empty set');
  });

  it('validateScope: readOrgIds with invalid entries are dropped (fail-closed)', () => {
    const out = scope.validateScope({
      entryPoint: 'test',
      scope: { ownerId: OWNER_A, readOrgIds: ['not-a-uuid', STAQS_ORG] },
    });
    assert.deepEqual(out.readOrgIds, [STAQS_ORG], 'only valid UUIDs survive');
  });

  it('scopeToFilterOpts: emits filterOrgIds from readOrgIds', () => {
    const norm = scope.validateScope({ entryPoint: 'test', scope: { ownerId: OWNER_A, readOrgIds: STAQS } });
    const opts = scope.scopeToFilterOpts(norm);
    assert.deepEqual(opts.filterOrgIds, STAQS);
  });

  it('scopeToFilterOpts: empty readOrgIds → empty filterOrgIds (fail-closed)', () => {
    const norm = scope.validateScope({ entryPoint: 'test', scope: { ownerId: OWNER_A } });
    const opts = scope.scopeToFilterOpts(norm);
    assert.deepEqual(opts.filterOrgIds, [], 'no org → empty filter → 0 rows downstream');
  });

  // ── Integration tests with PGlite ───────────────────────────────

  it('lexicalChunkSearch: no scope and no legacy opts → throws RetrieverScopeError', async () => {
    await assert.rejects(
      () => retriever.lexicalChunkSearch(MAGIC, {}),
      /scope arg required/
    );
  });

  it('searchChunks: no scope and no legacy opts → throws RetrieverScopeError', async () => {
    await assert.rejects(
      () => retriever.searchChunks(MAGIC, {}),
      /scope arg required/
    );
  });

  it('wikiPageSearch: no scope and no legacy opts → throws RetrieverScopeError', async () => {
    await assert.rejects(
      () => retriever.wikiPageSearch(MAGIC, {}),
      /scope arg required/
    );
  });

  it('retrieveContext: no scope and no legacy opts → throws (validator outside try/catch)', async () => {
    // Critical: retrieveContext has a top-level try/catch that returns
    // null on any throw. The validateScope call MUST run outside that
    // try so a missing scope propagates instead of silently returning
    // null (which would mask the security gate).
    await assert.rejects(
      () => retriever.retrieveContext(MAGIC, {}),
      (err) => err.name === 'RetrieverScopeError'
    );
  });

  it('lexicalChunkSearch: ownerId=A returns only A\'s document', async () => {
    const result = await retriever.lexicalChunkSearch(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { ownerId: OWNER_A, readOrgIds: STAQS }
    );
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A), true, 'A sees A\'s doc');
    assert.equal(ids.has(DOC_B), false, 'A does NOT see B\'s doc');
  });

  it('lexicalChunkSearch: ownerId=B returns only B\'s document', async () => {
    const result = await retriever.lexicalChunkSearch(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { ownerId: OWNER_B, readOrgIds: STAQS }
    );
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_B), true, 'B sees B\'s doc');
    assert.equal(ids.has(DOC_A), false, 'B does NOT see A\'s doc');
  });

  it('lexicalChunkSearch: org-scope with Architect agentId sees both A and B', async () => {
    const result = await retriever.lexicalChunkSearch(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { org: true, agentId: 'architect', readOrgIds: STAQS }
    );
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A), true, 'org-scope includes A');
    assert.equal(ids.has(DOC_B), true, 'org-scope includes B');
  });

  it('lexicalChunkSearch: org-scope with Strategist agentId sees both A and B', async () => {
    const result = await retriever.lexicalChunkSearch(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { org: true, agentId: 'strategist', readOrgIds: STAQS }
    );
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A), true);
    assert.equal(ids.has(DOC_B), true);
  });

  it('lexicalChunkSearch: legacy opts triple (no scope arg) → throws (STAQPRO-570)', async () => {
    // STAQPRO-570: passing the legacy {ownerId, includeOrgWide,
    // sharedDocumentsOnly} triple as opts with NO scope arg now hard-throws
    // instead of soft-degrading. The fail-open transitional path is closed.
    await assert.rejects(
      () => retriever.lexicalChunkSearch(
        MAGIC,
        { ownerId: OWNER_A, includeOrgWide: true, sharedDocumentsOnly: false, matchCount: 30, readOrgIds: STAQS }
      ),
      /legacy scope shape .* no longer accepted/
    );
  });

  it('lexicalChunkSearch: modern scope (ownerId) is tenant-isolated', async () => {
    // The migrated form of the old legacy-isolation test: the ownerId filter
    // must still bound visibility, now expressed via the validated scope arg.
    const result = await retriever.lexicalChunkSearch(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { ownerId: OWNER_A, readOrgIds: STAQS }
    );
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A), true);
    assert.equal(ids.has(DOC_B), false);
  });

  // ── Phase-2 org fail-closed (DB-level via searchChunks → match_chunks) ──
  // NOTE: lexicalChunkSearch does NOT route through content.match_chunks (it is
  // a separate tsvector path), so the org gate is exercised here via
  // searchChunks, which calls match_chunks(filter_org_ids). These run only when
  // an embedding provider is configured; searchChunks returns null otherwise.

  it('searchChunks: Staqs principal sees the seeded (owner_org_id NULL→Staqs) docs', async () => {
    const result = await retriever.searchChunks(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { org: true, agentId: 'architect', readOrgIds: STAQS }
    );
    if (result === null) return; // no embedding provider in this env — skip
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A) || ids.has(DOC_B), true, 'Staqs principal sees seeded docs');
  });

  it('searchChunks: FOREIGN-org principal sees ZERO chunks (cross-tenant fail-closed)', async () => {
    const result = await retriever.searchChunks(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { org: true, agentId: 'architect', readOrgIds: [FOREIGN_ORG] }
    );
    if (result === null) return; // no embedding provider — skip
    const ids = new Set(result.chunks.map(c => c.documentId));
    assert.equal(ids.has(DOC_A), false, 'foreign org must NOT see Staqs doc A');
    assert.equal(ids.has(DOC_B), false, 'foreign org must NOT see Staqs doc B');
  });

  it('searchChunks: empty readOrgIds → ZERO chunks (fail-closed, no org)', async () => {
    const result = await retriever.searchChunks(
      MAGIC,
      { maxClassification: 'INTERNAL', matchCount: 30 },
      { ownerId: OWNER_A } // no readOrgIds → empty filterOrgIds
    );
    if (result === null) return; // no embedding provider — skip
    assert.equal(result.chunks.length, 0, 'no org scope → 0 rows');
  });
});
