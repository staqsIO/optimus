# OWNERSHIP — Who owns deal / entity types

**Version:** 1.0.0 · **Last updated:** 2026-05-30 · **Issue:** STAQPRO-579

## Decision

**`lib/graph/schema.js` is the canonical entity-type registry.** It is the
single source of truth for the *names* of the CRM entity types Optimus models —
`Person`, `Organization`, `Project`, `Identity`. Any subsystem that needs to
refer to a deal/entity type must import the registry from `lib/graph/schema.js`
rather than defining its own string literals.

```js
// schema.js is the documented owner/entry point and re-exports the registry:
import { ENTITY_TYPES, ENTITY_TYPE_VALUES, isEntityType } from '../graph/schema.js';
// The definitions live in the dependency-free ./entity-types.js module, so
// importing the registry never pulls in the Neo4j driver chain. Subsystems that
// don't otherwise touch the graph (e.g. lib/engagements/) import from there:
import { ENTITY_TYPES } from '../graph/entity-types.js';

ENTITY_TYPES.ORGANIZATION; // 'Organization'
isEntityType('Person');    // true
```

## Why schema.js, and not lib/engagements

The boundary between `lib/graph/` and `lib/engagements/` was ambiguous: both
deal with "entities" (people, organizations, projects), and it wasn't obvious
which one *owns* the definition of those types. Resolving it:

- **`lib/graph/` is the entity store.** `schema.js` already declares
  `Person`, `Organization`, `Project`, and `Identity` as UNIQUE constraints on
  the Neo4j CRM graph, and `lib/graph/sync.js` MERGEs exactly those labels from
  Postgres (`signal.contacts → :Person`, `signal.organizations → :Organization`,
  `signal.contact_projects → :Project`, `signal.contact_identities → :Identity`).
  The vocabulary of entity types *already lived here* — it was just implicit
  (string literals inside Cypher) rather than an exported constant.

- **`lib/engagements/` is a deal builder, not an entity authority.** It assembles
  proposals/contracts against Postgres (`inbox.*`, `content.*`, `signal.*`,
  `engagements.*`) using free-text client matching (`client-search.js`) and
  recipient discovery (`recipient-discovery.js`). It *references* entities
  (a client Organization, signer People) but has no business defining the
  canonical set of entity types. Notably, before this change `lib/engagements/`
  imported nothing from `lib/graph/` — the two subsystems were fully decoupled,
  which is exactly why the ownership question had no answer.

Putting the registry in `schema.js` co-locates the *names* of entity types with
the *constraints* that enforce their uniqueness — they can no longer drift apart.

## What changed (STAQPRO-579)

This issue lands the **note + the smallest concrete consuming step**, keeping the
behavior change minimal and safe (per the issue's own guidance):

1. **`lib/graph/entity-types.js`** (new, dependency-free) defines `ENTITY_TYPES`
   (frozen), `ENTITY_TYPE_VALUES`, and `isEntityType()`, derived from the labels
   `schema.js` already declares. **`lib/graph/schema.js`** re-exports them and
   remains the documented owner/entry point. No new labels, no Cypher change.
   The split keeps the registry importable without the Neo4j driver.
2. **`lib/engagements/recipient-discovery.js`** now imports `ENTITY_TYPES` and
   tags each suggested recipient with `entityType: ENTITY_TYPES.PERSON`. This is
   **additive** — existing consumers reading `name/email/source/note` are
   unaffected — and demonstrates engagements *consuming* the registry instead of
   minting its own type string.

## Deliberately NOT changed (flagged for follow-up)

Full consolidation would be risky and is **not** done here:

- **`recipient-discovery.js` bucket keys** (`primary`/`proposal`/`signal`/
  `internal`) are recipient *source* labels, **not** entity types. They were
  correctly left alone — collapsing them into the entity registry would conflate
  two different vocabularies.
- **`client-search.js`** resolves a free-text client name to candidate
  domains/aliases. It refers to an `Organization` conceptually but does not yet
  import `ENTITY_TYPES` because it produces fuzzy candidates, not typed entities.
  A future pass can tag its grouped results once the candidate→entity resolution
  is formalized.
- **Cypher string literals** inside `sync.js` / `queries.js` still inline
  `:Person`, `:Organization`, etc. Converting those to interpolate
  `ENTITY_TYPES` is a mechanical follow-up (label names can't be parameterized in
  Cypher, so it would be template interpolation of a trusted constant) and is
  out of scope for this minimal-and-safe step.

## Rule going forward

- **Adding a new entity type?** Add it to `ENTITY_TYPES` in `schema.js`, add its
  UNIQUE constraint and `origin_org` index in the same file, and add its MERGE in
  `sync.js`. Nowhere else mints entity-type names.
- **Need to name an entity type elsewhere?** `import { ENTITY_TYPES } from
  '.../graph/schema.js'`. Never hard-code the string.

## See also

- `SEAMS.md` (repo root) — Seam 3 (entities → projects) and the graph data flow.
- `lib/graph/schema.js` — the registry + constraints.
- `lib/graph/sync.js` — where the labels are MERGE'd from Postgres.
