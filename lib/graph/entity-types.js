// graph/entity-types.js — Canonical entity-type registry (STAQPRO-579).
//
// Pure data + predicates, ZERO runtime dependencies (no neo4j-driver, no DB).
// This is the single source of truth for the *names* of the CRM entity types
// Optimus models. `lib/graph/schema.js` re-exports these and is the documented
// owner/entry point; this file exists so any subsystem can import the registry
// without pulling in the Neo4j driver chain. See `lib/graph/OWNERSHIP.md`.
//
// The values match the Neo4j node labels declared as UNIQUE constraints in
// `schema.js` and MERGE'd from Postgres in `sync.js`. Keep them in sync:
// adding a new entity type means adding it here, plus its constraint/index in
// schema.js and its MERGE in sync.js — nowhere else mints entity-type names.

/** Canonical entity-type label registry. Frozen so the shared map can't drift. */
export const ENTITY_TYPES = Object.freeze({
  PERSON: 'Person',
  ORGANIZATION: 'Organization',
  PROJECT: 'Project',
  IDENTITY: 'Identity',
});

/** All canonical entity-type label strings, for iteration/validation. */
export const ENTITY_TYPE_VALUES = Object.freeze(Object.values(ENTITY_TYPES));

/**
 * @param {string} type
 * @returns {boolean} true if `type` is a canonical entity-type label.
 */
export function isEntityType(type) {
  return ENTITY_TYPE_VALUES.includes(type);
}
