# ADR-026 — Contacts ARE Persons; Identities Are Channels

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-05-04 |
| **Deciders** | Eric, Dustin |
| **Phase** | CRM upgrade — Phase 1 |
| **Supersedes** | (extends 009-entity-resolution.sql) |

## Context

The Optimus contacts model started as one row per email address (`signal.contacts.email_address UNIQUE`). Users in the wild have many addresses (`eric@staqs.io`, `eric.personal@example.com`, `eric@umbadvisors.com`, `eric.gang@oldclient.example.com`) and the existing schema collapses them only when a Merge button gets clicked — which itself was silently broken until 079.

We need a person-centric CRM where:

1. Eric is **one entity** with many channel identities.
2. Provenance is visible — "this identity came in via Linear / Gmail / Google Contacts".
3. Relationships across people, projects, and orgs are first-class (graph-projected).
4. Organizations roll up — "everyone at UMB Advisors" should be a single query.

We considered two routes to the person abstraction:

### Option A — `signal.contacts` IS the person (chosen)

Keep one row per *human*. Multiple addresses for the same person live in `signal.contact_identities (channel, identifier, source, verified_at)` (already exists from migration 009). Merge collapses dupes; identities preserve the audit trail of "she also writes from this address". `signal.organizations` becomes first-class with a nullable FK from `contacts.organization_id`.

### Option B — Add a new `signal.persons` table on top

`contacts` becomes a per-channel record, each with `person_id`. Cleaner conceptually but requires migrating ~40 `contact_id` FK call sites across `agent_graph`, `inbox`, `voice`, `content` schemas to also know about `person_id`.

## Decision

**Chose Option A.**

`signal.contacts` IS the person record. We do not add a `signal.persons` table.

Rationale:

- Migration 009 already defined `signal.contact_identities` with channel, identifier, source, verified_at. The plumbing existed; only the UI and ingestion paths needed catching up.
- Every existing `contact_id` FK already represents "the human" in practice — we'd be renaming a concept, not actually adding indirection. The cost of touching ~40 callers (action_proposals, signals, work_items, voice_prints, contracts, contact_projects, contact_accounts) outweighs the conceptual cleanup.
- Merge is the consolidation primitive: when two contacts turn out to be the same person, `signal.merge_contacts()` (079, extended in 082) re-points all identities, accounts, project memberships, and organization_id, then deletes the secondary. The merge log gives a clean audit trail.

## Consequences

### Positive

- **Zero churn on downstream tables.** All `contact_id` FKs already mean what we want them to mean.
- **`contact_identities` stops being a curiosity** and becomes the canonical lookup table when finding "who sent this email" — including across email aliases.
- **Backfill is mechanical** (migration 081 added the trigger + one-shot pass; every contact now has ≥1 identity row).
- **Organizations become rollup-able** without breaking anything (migration 080 — `organization_id` nullable column, free-text `organization` retained as label).

### Negative

- The model leaves a small ambiguity: a contact's *primary* email lives in two places — `contacts.email_address` (denormalized for legacy queries) and `contact_identities` (canonical). The trigger added in 081 keeps them in sync on insert/update; we accept this redundancy in exchange for not rewriting every legacy query that joins on `email_address`.
- A "person" with no email (e.g. a Slack-only contact) has to use `email_address = '<channel>:<identifier>@inbox.local'` as a placeholder until we relax the NOT NULL on the legacy column. Acceptable for now — none of our contacts are email-less today.

## Implementation

- **080-organizations.sql** — new tables (`signal.organizations`, `organization_aliases`, `organization_review_log`), `contacts.organization_id` FK
- **081-contacts-identity-backfill.sql** — trigger to keep email identity in sync, one-shot backfill of missing identities
- **082-merge-contacts-with-org.sql** — extends `signal.merge_contacts()` to reconcile `organization_id`, logs merge conflicts
- **scripts/backfill-organizations.js** — promotes existing `contacts.organization` text to `signal.organizations` rows + alias seeding
- **`/api/contacts/duplicates`** — replaced naive name-only/org-text query with three-signal heuristic (strong name, shared org_id, shared email domain across identities)

## Future work (tracked under the CRM roadmap, not in this ADR)

- Phase 2: project `signal.contacts` → Neo4j `:Person` nodes, `contact_identities` → `:Identity`, `organizations` → `:Organization`. Infer `:Person-[:THREADED_WITH]-:Person` from `inbox.messages` co-participation.
- Phase 3: surface `contact_identities.source` and `verified_at` on the contact detail page; group identities under a single person card.
- Phase 4: deals/pipeline/saved views.
- Phase 5: agents (strategist, responder, architect) read graph relationship strength.

## References

- 009-entity-resolution.sql — original `contact_identities` + `contact_merge_log` definition
- 079-fix-merge-contacts.sql — repaired the dead `contact_account_interactions` reference
- 080-organizations.sql / 081-contacts-identity-backfill.sql / 082-merge-contacts-with-org.sql — this phase
- ADR-018 — schema isolation by role (the "no cross-schema FK" rule we honor here)
