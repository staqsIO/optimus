# ADR-017: Knowledge Share Grants — User-Tier Sharing Primitive

**Date**: 2026-06-09 (revised 2026-06-16 after federation-tier shipped under OPT-77/78)
**Status**: Accepted
**Issue**: Optimus has a 2-tier visibility model (own / org-wide) and no way for a user (or org admin) to share knowledge with a specific peer, team, or other org at the **document-retrieval layer**. We need a granular sharing primitive that complements — does not replace — the existing federation work (ADR-007 thesis, OPT-77/78 capability receipts).

This ADR does **not** supersede ADR-007. ADR-007's federation thesis is being implemented at the agent-tier under OPT-77/78 (`agent_graph.federation_grants` — signed JWS capability envelopes for cross-org agent calls). ADR-017 is the **user-tier** counterpart: per-board-member grants over document retrieval, with no involvement in agent capability invocation.

---

## Context

Three pieces of state are in play:

1. **`tenancy.federation_grants`** (migration 133) — org→org grants consulted by `tenancy.visible()` and `lib/tenancy/scope.js` `visibleClause()` as the Tier-3 arm. Dormant in prod (zero rows) but live in code. **Untouched by this ADR.**

2. **`agent_graph.federation_grants`** (migration 169, OPT-78) — capability-receipt envelope for cross-org agent calls. Different schema, different layer (signed JWS, contract_hash, scope_filter, max_results). **Untouched by this ADR.**

3. **No granular user-tier sharing primitive exists.** A board member cannot share their personal knowledge with a peer, a team, or another org. The only granularity today is the binary `owner_id IS NULL` (org-wide) vs `owner_id = <uuid>` (private) gate on `content.documents`.

The board has approved a knowledge-share feature with three iteration tiers (v0 "share all", v1 "share doc/collection", vN "share by topic") and three target types (user, group, org). Feature spec: [`spec/features/008-knowledge-share.md`](../features/008-knowledge-share.md). This ADR records the architectural decision the spec depends on.

---

## Decision

### (a) New table: `tenancy.share_grants`

A user-tier sharing table that covers the full granter × target × scope matrix:

```
granter:  user | org                   (group as granter is reserved, not v0)
target:   user | group | org
scope:    all  | collection | document | topic
status:   pending | active | revoked | declined | expired
applies_to: text[]                     ({documents, wiki_pages} default)
```

Sits alongside the federation primitives, doesn't replace them. The two federation tables remain the system-of-record for agent-tier cross-org work; `share_grants` is the document-retrieval primitive for board members.

### (b) Leave `tenancy.visible()` and `tenancy.federation_grants` unchanged

The generic visibility predicate is consulted by every tenant-scoped table (signals, briefings, contracts, deals, meetings, etc.). Wiring `share_grants` into it would auto-expand every share grant beyond document retrieval — explicitly out of scope per §D7 (voice/signal/briefing are NOT shareable in v0/v1/vN).

Share-grant visibility is opt-in **per resource kind** at the retriever layer. `content.match_chunks` (mig 182 + 184 + 186 + 189), `lexicalChunkSearch`, and `wikiPageSearch` each check `share_grants` narrowed by `applies_to` (mig 183: default `{documents, wiki_pages}`). Future kinds (voice, signal, briefing) opt in by adding their identifier to `applies_to` AND by their retriever consulting `share_grants` — not automatic.

### (c) Groups schema lives in v0; group UI lives in v1

`tenancy.groups` + `tenancy.group_memberships` are created in migration 181. v0 UI hides the group target picker behind a feature flag. v1 activates it without a further migration. The `share_grants.target_type` enum carries `'group'` from day one.

### (d) Cascade-revoke grants on membership delete

A trigger on `tenancy.memberships` DELETE flips `share_grants.status` to `'revoked'` for any grant where the deleted user was the granter under the deleted org (`granter_type='user'` AND `granter_id=user_id` AND `granter_org_id=org_id`). Grants from the user's other org affiliations stay active. Matches "access follows employment."

### (e) Per-retrieval audit

Every RAG retrieval that surfaces a chunk made visible via an active `share_grant` writes one row to `audit.shared_doc_retrievals` (mig 188). Fire-and-forget — never blocks retrieval. Powers cross-org usage reporting and any future per-query billing without requiring schema upheaval later. Lifecycle events on grants themselves (create / accept / decline / revoke / expire) live on the row via status + timestamped columns.

---

## Consequences

### What this enables

- **User-tier sharing without touching the security spine.** The generic `tenancy.visible()` predicate keeps its existing 3-tier shape (own + org-shared + federation_grants). Share-aware tables get a fourth opt-in arm via their retrievers.
- **Per-user knowledge graphs become composable.** A user's personal corpus can be shared with a peer, a team, or another org without dumping it org-wide.
- **Iteration to per-doc / per-collection / per-topic granularity has no migration cost.** Adding new `scope_type` values is a CHECK widening + retriever logic change, not a schema rewrite.
- **`agent_graph.federation_grants` (OPT-78) and `tenancy.share_grants` (this ADR) coexist** at different layers — agent capabilities vs document retrieval — without competing.

### What this changes

- New tables only. **No change to `tenancy.visible()`. No change to `lib/tenancy/scope.js` `visibleClause()`.** No change to `tenancy.federation_grants`.
- `resolvePrincipal()` (in `lib/tenancy/scope.js`) is extended to fetch `readGroupIds` for share-grant target matching, but does not change the existing visibility predicate output.
- Share-aware retrievers (`match_chunks`, `lexicalChunkSearch`, `wikiPageSearch`) gain a share-grant arm gated by `applies_to`. Other tables are unchanged.

### Risks accepted

- **Per-retrieval audit volume.** One row per share-driven hit. Daily aggregate view (`audit.shared_doc_retrievals_daily`) covers dashboard queries cheaply; raw rows are partitionable when volume warrants.
- **`applies_to` is the safety boundary.** Future voice/signal/briefing inclusion is gated on the retriever explicitly opting in, not on schema. The mistake mode is "I added voice to applies_to but didn't update the retriever" — caught by the retriever simply not surfacing voice grants.

### Risks declined

- **Modifying `tenancy.visible()`.** Would auto-expand share visibility into signals/briefings/contracts. Out of scope per §D7.
- **Dropping or rewriting `tenancy.federation_grants`.** Still wired into `tenancy.visible()` and `lib/tenancy/scope.js`. Even though prod has zero rows, removing it is a security-spine change unrelated to user-tier sharing.
- **Per-retrieval audit for billing readiness in v0+.** Deferred earlier — restored in §(e) since the volume is bounded and the alternative is a retroactive schema add.
- **Block lists** — declined ≠ blocked is enough for v0 (D11).
- **24h grace period on revoke** — revoke is instant (D8); revisit if conversation gaps prove painful.

---

## Alternatives considered

**A. Drop `tenancy.federation_grants` and unify everything into `share_grants`.** Initially considered. Rejected because `tenancy.federation_grants` is still in the security predicate, and OPT-77/78 may yet wire org→org sharing into it under the federation tier. Two grant tables with clearly-distinct scope (agent capability vs user document retrieval) is the correct partition.

**B. Extend `tenancy.federation_grants` with user-granter columns.** Make `grantor_org_id` optional, add target type/id, etc. Rejected because the existing column names bake org→org assumptions into the schema, and the table is part of the security spine.

**C. Polymorphic ACL on `content.documents` (e.g. `acl JSONB`).** Per-row ACL. Rejected because (a) it doesn't generalize to wiki pages, signals, voice without per-table ACL columns; (b) it inverts the model — "who can read this row?" is fine for documents but doesn't fit collections or topics; (c) it bypasses the tenancy predicate so the security spine has to grow a second axis.

---

## Affected files

- New: `autobot-inbox/sql/181-knowledge-share-grants.sql` through `189-match-chunks-topic-scope.sql` (9 migrations)
- Changed: `lib/tenancy/scope.js` — `resolvePrincipal()` adds `readGroupIds`; `visibleClause()` and federation_grants reads are untouched
- Changed: `lib/rag/retriever.js` — share-grant arm in `lexicalChunkSearch` + `wikiPageSearch`
- Changed: `lib/rag/scope.js` — propagates `readGroupIds` through `validateScope`
- New: `lib/rag/share-resolver.js` (caller principal cache)
- New: `lib/rag/share-retrieval-audit.js` (fire-and-forget audit hook)
- New: `lib/sharing/grants.js` (lifecycle helpers)
- New: `autobot-inbox/src/api-routes/sharing.js` (HTTP API)
- New: `lib/runtime/share-grants-sweep.js` (background expiry sweep)
- New: `board/src/app/sharing/page.tsx` + `board/src/app/sharing/{collections,groups,topics}/page.tsx`
- New: `board/src/components/{ShareThisButton,SharedViaChip}.tsx`, `board/src/components/governance/SharingMetrics.tsx`
- New: `board/src/lib/usePrincipalNames.ts`
- Test: `autobot-inbox/test/share-grants.test.js`

---

## Relationship to ADR-007 / OPT-77 / OPT-78

ADR-007 ("Federation Thesis") set the long-arc product motion: inter-organizational governance infrastructure via portable, verifiable capability receipts. That thesis has been **implemented**, not superseded, by:

- **OPT-77** — capability-receipt sign/verify JWS primitive
- **OPT-78** — `agent_graph.federation_grants` (mig 169) backing the receipt envelope
- **OPT-54** — thin-slice receipt round-trip across two org IDs (the mind-meld demo)

That work is **agent-tier** — capability tokens for cross-org agent calls (RAG queries, KG reads, task assignment), signed and audit-chained.

ADR-017 is the **user-tier** counterpart — board members granting peer/group/org access to their own document corpus. The two systems share no schema (separate tables, separate audit trails) and are complementary, not overlapping. A future feature could mint federation receipts on behalf of share grants, but that integration is out of scope for v0/v1/vN.
