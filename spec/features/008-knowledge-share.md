# 008 — Knowledge Share: granular user/group/org sharing with org-to-org as first-class

> Feature spec for a knowledge-sharing layer that lets a user (or org admin)
> grant retrieval access to a target user, group, or org. Scope evolves across
> three versions: v0 ships "share all" with the per-target grant table designed
> from day one so v1 (per-document/collection) and vN (per-topic) are
> additive — no schema migrations across versions, only `scope_type` widening.
> Builds on `tenancy.orgs` + `tenancy.memberships` (migration 133). New
> `tenancy.share_grants` table sits **alongside** the existing federation
> primitives: `tenancy.federation_grants` (mig 133, org→org, dormant) and
> `agent_graph.federation_grants` (mig 169, OPT-78 capability receipts). The
> generic `tenancy.visible()` predicate is **unchanged** — share-grant
> visibility is opt-in per resource kind at the retriever layer, narrowed by
> `share_grants.applies_to`, so signals/briefings/contracts never auto-share
> when a document grant is issued. Status: **SHIPPED — all three versions
> live: v0 (share-all, mig 181), v1 (collection/document/group, mig 185–186),
> vN (topic, mig 187/189). Per-retrieval audit shipped (mig 188) with
> /governance panel. Wiki pages share-aware (resolves
> FOLLOWUP-WIKI-OWNER-STAQPRO-591).**

## Context

The system already enforces a clean two-tier visibility model:

- **Private** — `content.documents.owner_id = <user_id>` → only that user sees it.
- **Org-wide** — `content.documents.owner_id IS NULL` → everyone in `owner_org_id` sees it.

Retrieval enforces this in two places:

- `content.match_chunks(...)` SQL function (migration 135) — vector search.
- `lib/rag/retriever.js` `lexicalChunkSearch()` — lexical/FTS search.

Both filter on `filter_org_ids` (cross-org barrier, hard) then `filter_owner_id`
(intra-org barrier, the binary private/org-wide gate above).

There is **no granular sharing**. A user cannot:

- Share *all* their knowledge with a specific peer (Carlos → Jane).
- Share *all* their personal knowledge with another org (Carlos → UMB Advisors).
- Have their org share *all* its org-wide knowledge with another org (Staqs → UMB).
- Share a specific document, collection, or topic.

The `tenancy.federation_grants` table (migration 133) was designed for the third
case (org→org) but is dormant per ADR-007 ("do not build yet"). Now that org-to-org
sharing is a stated priority, that decision is revisited here.

Voice, signal, and briefing data are **explicitly out of scope** for sharing
in this feature — they are too personal. But the grant schema is designed
to extend to them later without refactor (see §Scope evolution).

## Design decisions (locked by board 2026-06-09)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Org→org sharing is bilateral with acceptance.** Granter creates `pending` grant; target-org admin accepts (→`active`) or declines (→`declined`). Either side revokes at any time. | B2B trust norms; matches federation_grants spirit; audit-friendly. |
| D2 | **Per-target grant is the unit of sharing.** One row per (granter, target, scope). v0 uses `scope_type='all'`; v1 adds `'collection'` and `'document'`; vN adds `'topic'`. | One table evolves across versions; no migration per version. |
| D3 | **Groups schema designed in v0, UI ships in v1.** `tenancy.groups` + `group_memberships` exist with the rest of the v0 schema; `share_grants.target_type` includes `'group'` from day one. v0 UI hides the group picker behind a feature flag. | Avoids a v1 schema migration; group activation is a flag flip. |
| D4 | **User→user grants are immediate.** No acceptance required for in-org user→user grants — read-only access, low blast radius, matches "share a link with a teammate" mental model. | Reduce friction; acceptance flow reserved for cross-org and org-level. |
| D5 | **User→org grants require acceptance.** A user dumping all their personal knowledge into another org is a meaningful trust event for the receiving org — its admin accepts. | Receiving org should not silently inherit one user's entire personal corpus. |
| D6 | **Replace `tenancy.federation_grants` with `tenancy.share_grants`.** federation_grants is dormant; the new unified table covers the same shape and 8 more (user/group/org granter × user/group/org target). ADR-007 superseded by ADR for this feature. | One sharing table; one retrieval join; consistent audit. |
| D7 | **Voice/signal/briefing are out of scope for sharing.** Their retrievers do not consult `share_grants`. The schema can be extended later by adding new `scope_type` values without table changes. | Avoid leaking personal voice/signal data; preserve future option. |
| D8 | **Revoke is instant.** Status flips to `revoked` and the per-user retrieval cache is invalidated within the same transaction; the target's next retrieval excludes the docs. No grace period. | Matches user intent; predictable; revisit if in-flight-conversation gaps prove painful. |
| D9 | **Membership removal cascade-revokes grants tied to that org.** Trigger on `tenancy.memberships` delete: every `share_grants` row where `granter_id = removed_user` AND `granter_org_id = removed_org` flips to `revoked` (with `revoked_by = NULL`, metadata flag `cascaded_from_membership = true`). Grants tied to the user's other org memberships stay active. | "Access follows employment"; per-org separation; surgical. |
| D10 | **Expired status is a distinct enum value, not a flavor of `revoked`.** A background sweep flips `active → expired` when `expires_at` passes. | Clean audit ("ended naturally" vs. "someone cancelled it"); cheap enum extension. |
| D11 | **No block list in v0.** Decline is per-grant; granters can re-share. Add a block table later if cross-org abuse appears. | Smallest v0 surface; reversible decision. |
| D12 | **No per-retrieval audit in v0.** Lifecycle audit (create/accept/decline/revoke/expire) is hash-chained; per-query "which retrieval used which shared doc" is deferred. Additive later — a `shared_doc_retrievals` table + retriever hook — if cross-org billing or compliance requires it. | Cheap, focused; can layer on without schema upheaval. |

## User stories

- **As Carlos**, I can share *all* my personal knowledge with Jane (same org), and
  Jane sees Carlos's docs in her RAG retrieval immediately — no acceptance step.
- **As Carlos**, I can share *all* my personal knowledge with UMB Advisors (another
  org); UMB's admin sees a pending share, accepts it, and UMB members see Carlos's
  docs from that point on.
- **As an org admin (Staqs)**, I can establish a knowledge partnership with UMB
  Advisors — both orgs' org-wide knowledge becomes mutually visible, after UMB's
  admin accepts.
- **As Jane**, I can see who has shared knowledge with me, what scope each grant
  covers, and decline an unwanted incoming share.
- **As any user**, I can revoke any outgoing grant at any time, and the target
  loses access immediately on the next retrieval.
- **As a retrieval consumer**, when a result comes from a shared document, the
  provenance is preserved (`shared by Carlos`, `from UMB Advisors`) so the agent
  and UI can attribute correctly.
- **(Designed, not shipped in v0) As Carlos**, I can share a specific collection
  or single document with a specific user — without sharing my whole corpus.

## What to build

### Schema (all in v0)

A single migration introduces every table needed for v0 through vN. Adding granularity
later is a `scope_type` enum extension and retriever logic change — no new tables.

```sql
-- New schema: groups (designed in v0, UI in v1)
CREATE TABLE tenancy.groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES tenancy.board_members(id),
  UNIQUE (org_id, slug)
);

CREATE TABLE tenancy.group_memberships (
  group_id   UUID NOT NULL REFERENCES tenancy.groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES tenancy.board_members(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by   UUID REFERENCES tenancy.board_members(id),
  PRIMARY KEY (group_id, user_id)
);

-- Core sharing table — replaces dormant tenancy.federation_grants
CREATE TYPE tenancy.share_principal_type AS ENUM ('user', 'group', 'org');
CREATE TYPE tenancy.share_scope_type     AS ENUM ('all', 'collection', 'document', 'topic');
CREATE TYPE tenancy.share_status         AS ENUM ('pending', 'active', 'revoked', 'declined', 'expired');

CREATE TABLE tenancy.share_grants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who grants
  granter_type        tenancy.share_principal_type NOT NULL,  -- 'user' or 'org' (v0); 'group' reserved
  granter_id          UUID NOT NULL,                          -- board_members.id OR orgs.id
  granter_org_id      UUID NOT NULL REFERENCES tenancy.orgs(id),  -- for indexing/audit

  -- Who receives
  target_type         tenancy.share_principal_type NOT NULL,  -- 'user' | 'group' | 'org'
  target_id           UUID NOT NULL,
  target_org_id       UUID NOT NULL REFERENCES tenancy.orgs(id),  -- resolved target org

  -- What is shared
  scope_type          tenancy.share_scope_type NOT NULL DEFAULT 'all',
  scope_ref           TEXT,  -- NULL for 'all'; 'doc:<uuid>' / 'col:<uuid>' / 'topic:<id>' later

  -- Lifecycle
  status              tenancy.share_status NOT NULL DEFAULT 'active',
  requires_acceptance BOOLEAN NOT NULL,    -- true for cross-org, user→org, org→org
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID NOT NULL REFERENCES tenancy.board_members(id),
  accepted_at         TIMESTAMPTZ,
  accepted_by         UUID REFERENCES tenancy.board_members(id),
  declined_at         TIMESTAMPTZ,
  declined_by         UUID REFERENCES tenancy.board_members(id),
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES tenancy.board_members(id),
  expires_at          TIMESTAMPTZ,         -- optional time-bounded shares

  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Guards
  CHECK (granter_type IN ('user', 'org')),                       -- v0: no group granters
  CHECK (NOT (granter_type = 'user' AND target_type = 'user' AND target_org_id = granter_org_id AND requires_acceptance = true)),  -- D4: in-org user→user is immediate
  CHECK ((status = 'active' AND accepted_at IS NOT NULL) OR (status != 'active' OR NOT requires_acceptance)),
  UNIQUE (granter_type, granter_id, target_type, target_id, scope_type, COALESCE(scope_ref, ''))
);

CREATE INDEX share_grants_target_active_idx
  ON tenancy.share_grants (target_type, target_id) WHERE status = 'active';
CREATE INDEX share_grants_granter_idx
  ON tenancy.share_grants (granter_type, granter_id, status);
CREATE INDEX share_grants_expires_idx
  ON tenancy.share_grants (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

-- D9: cascade-revoke grants when a user is removed from the org they granted as
CREATE OR REPLACE FUNCTION tenancy.cascade_revoke_on_membership_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tenancy.share_grants
     SET status = 'revoked',
         revoked_at = now(),
         revoked_by = NULL,
         metadata = metadata || jsonb_build_object('cascaded_from_membership', true,
                                                    'cascaded_org_id', OLD.org_id)
   WHERE granter_type = 'user'
     AND granter_id = OLD.user_id
     AND granter_org_id = OLD.org_id
     AND status IN ('pending', 'active');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER share_grants_cascade_on_membership_delete
  AFTER DELETE ON tenancy.memberships
  FOR EACH ROW
  EXECUTE FUNCTION tenancy.cascade_revoke_on_membership_delete();

-- Drop dormant federation_grants (no rows, never wired into retrieval)
DROP TABLE IF EXISTS tenancy.federation_grants;
```

### Retrieval changes (v0)

`content.match_chunks(...)` (migration 135) gains a fourth visibility arm: docs visible
via an active `share_grants` row. The grant filter resolves the calling user to a set
of `(target_type, target_id)` tuples — `('user', <user_id>)`, one `('group', <gid>)`
per group, one `('org', <org_id>)` per org membership — and joins to
`share_grants` with `status = 'active'`.

For v0, the join is on grant `granter_type/granter_id` matching the document's
`owner_id` (user-owned docs) or `owner_org_id` with `owner_id IS NULL` (org-wide docs).
The `scope_type = 'all'` predicate keeps the join cheap; v1 adds per-doc/collection
predicates.

Same change in `lib/rag/retriever.js`:

- `searchChunks()` — passes the caller's principal set to `match_chunks`.
- `lexicalChunkSearch()` — adds the share-grant join.
- `wikiPageSearch()` — same (also resolves the long-pending FOLLOWUP-WIKI-OWNER).

A new helper `lib/rag/share-resolver.js` produces the principal set for a user once
per request and caches it.

### v0 — "share all my knowledge"

**Functionality**

- `POST /api/sharing/grants` — create a grant. Body: `{target_type, target_id, scope_type: 'all'}`. Server computes `requires_acceptance` per D4/D5.
- `POST /api/sharing/grants/:id/accept` — accept a pending grant (target-org admin or target user).
- `POST /api/sharing/grants/:id/decline` — decline.
- `POST /api/sharing/grants/:id/revoke` — revoke (granter only, plus target-org admin for their incoming).
- `GET /api/sharing/grants` — list grants visible to caller (incoming + outgoing).
- Retrieval changes wired in `match_chunks` + `retriever.js` + `wikiPageSearch`.
- Every grant lifecycle event hash-chained to `state_transitions` (P3).

**UI** — new page `board/src/app/sharing/page.tsx`:

- **"Sharing with you"** — incoming active grants, with revoke button.
- **"You are sharing"** — outgoing active grants, with revoke button.
- **"Pending invitations"** — pending grants in either direction, accept/decline buttons on the appropriate side.
- **"Share knowledge"** button — opens a target picker (user / org; group hidden behind feature flag) with a single "share all my knowledge" option. Cross-org and org-level selections surface "this requires the target org's admin to accept" callout.
- Each grant row shows scope (`all knowledge` for v0), created date, lifecycle status, and provenance icon.

**Org-admin federation panel** — embed pending org-level grants on `board/src/app/organizations/[id]/page.tsx` so org admins see invitations in the context of the org they administer.

**Retrieval result provenance** — RAG result objects gain a `shared_via` field: `null` (own/org-wide) or `{granter_type, granter_id, granter_name}`. Board's RAG result components show a small "shared by Carlos" / "from UMB Advisors" chip.

### v1 — "share documents and collections that I choose"

**Schema additions** (additive — no migration needed for tables):

- A `content.collections` table emerges as the grouping unit for flat documents (wiki already has `parent_id`).
- `share_grants.scope_type = 'collection'` and `'document'` activate. `scope_ref` carries the FK as text.
- Retrieval extends the join: when `scope_type != 'all'`, restrict the doc match to the specific collection or document.

**UI additions**:

- "Share this document" button on document detail pages.
- "Share this collection" button on the knowledge base page.
- Multi-doc selection → "Share selected" bulk action.
- Group picker activates (feature-flag flip — schema already exists).

### vN — "topics" (granularity ceiling)

- New `scope_type = 'topic'`. `scope_ref` = `topic:<id>`.
- Retrieval joins to a topic index (TBD — probably `signal.topics` extended, or a new `content.topic_assignments` table).
- UI: "Share by topic" picker (e.g., "share everything I know about Q3 planning").

### Scope evolution beyond knowledge documents (designed, not shipped)

The same `share_grants` table can carry future shares of other data types by adding
new `scope_type` values: `'voice'`, `'signal'`, `'briefing'`. Their respective
retrievers would need to consult `share_grants` the same way RAG does. This is **not**
in v0/v1/vN scope — but the table shape supports it without refactor (D7).

## Out of scope (explicit non-goals)

- Editing or commenting on shared documents — sharing is read-only.
- Re-sharing — a recipient of a share cannot re-share onward.
- Voice/signal/briefing sharing (D7 — designed for extensibility, not enabled).
- Cross-tenant search aggregation UIs (e.g., "search across all orgs that share with me").
- Granular permissions beyond read — no "share with edit" in v0/v1/vN.
- Quotas / billing implications of cross-org sharing.

## Acceptance criteria

### v0

- A user can create an active grant to a peer in the same org; the peer sees the granter's docs in retrieval within 5 seconds.
- A user can create a `pending` cross-org grant; the target org's admin sees it in `/organizations/[id]`; on accept, retrieval includes the granter's docs.
- Revoking a grant removes access on the next retrieval (cache invalidated in the same transaction as the status flip — D8).
- Removing a user from `tenancy.memberships` for org X cascade-revokes their `share_grants` where `granter_org_id = X` (D9, trigger-enforced); grants under their other org affiliations remain active.
- A background sweep transitions `active` grants with past `expires_at` to `expired` status (D10).
- Every lifecycle event (create / accept / decline / revoke) is hash-chained to `state_transitions` and visible in `/governance`.
- Retrieval result includes `shared_via` provenance for shared hits; own / org-wide hits have `shared_via = null`.
- `match_chunks`, `lexicalChunkSearch`, and `wikiPageSearch` all honor share grants identically.
- Unit + integration tests: cross-org pending→accept→revoke flow; same-org immediate flow; revocation propagation; provenance correctness; group reservation (existing schema, no UI path).
- `federation_grants` removed; ADR-007 superseded by an ADR for this feature.

### v1

- A user can share a single document or collection with a target; non-targeted docs remain hidden.
- Group target picker is live; grants targeting groups resolve to all current and future members.

### vN

- A user can share by topic; topic membership changes propagate to share visibility without manual re-share.

## Resolved questions (2026-06-09)

All five open questions resolved with Carlos. Resolutions folded into D8–D12 above and the schema. Kept here for traceability.

- **Q1 → D8.** Revoke is **instant**. Status flip + retrieval cache invalidation in the same transaction. No grace period.
- **Q2 → D11.** **No block list in v0.** Decline-per-grant is sufficient; granters can re-share. Revisit if abuse appears.
- **Q3 → D12.** **No per-retrieval audit in v0.** Lifecycle audit only; per-query usage logging is additive later if cross-org billing or compliance needs it.
- **Q4 → D9.** Membership removal **cascade-revokes grants tied to that org** (via trigger on `tenancy.memberships` delete). Grants from the user's other org affiliations stay active.
- **Q5 → D10.** Add **`expired`** as a distinct status. Background sweep flips `active → expired` when `expires_at` passes.

## Implementation order

1. **Spec + ADR** (this doc + new ADR superseding ADR-007).
2. **Migration** — `tenancy.groups`, `tenancy.group_memberships`, `tenancy.share_grants` enums + table, cascade trigger on `tenancy.memberships` (D9), expired-sweep index, drop `federation_grants`.
3. **Retrieval** — `match_chunks` update + `retriever.js` + `wikiPageSearch` + `share-resolver.js` helper + cache invalidation hook (D8).
4. **Sweep job** — background process that flips `active → expired` past `expires_at` (D10); runs every 5 min.
5. **API** — `/api/sharing/*` routes (create / accept / decline / revoke / list).
6. **UI** — `board/src/app/sharing/page.tsx` + org-admin federation panel + provenance chips.
7. **Tests** — integration tests for the four lifecycle paths + revocation timing (D8) + membership-cascade (D9) + expiry sweep (D10) + provenance.
8. **Docs** — Scribe updates `agent-pipeline.md` (new retrieval visibility path), `database-architecture.md` (new schema); Herald notes the v0 capability in external changelog when shipped.

## Self-review checklist

- [x] User stories cover all three target types (user, group, org) and the cross-org case.
- [x] Schema is single-migration and forward-compatible to v1/vN without table changes.
- [x] Acceptance flow specified per granter/target combination (D4/D5).
- [x] Retrieval changes name every file/function touched.
- [x] Out-of-scope items are explicit (voice/signal/briefing; edit; re-share).
- [x] Open questions surface decisions deferred to implementation, not avoided.
- [x] Supersedes ADR-007 (federation_grants dormancy) — flagged for ADR work.
