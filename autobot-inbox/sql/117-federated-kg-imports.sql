-- STAQPRO-356 / ADR-007 §2: federated KG imports substrate.
--
-- Per the federation thesis, Neo4j is a local enrichment cache; the
-- authoritative cross-org substrate is a signed JSON-LD blob landed in
-- Postgres. This table is the landing zone — Phase 1 stays empty (no peers
-- exist yet) but having the schema in place means the first federation
-- import becomes "INSERT INTO" instead of "design a table + write a migration
-- + roll a release."
--
-- Schema-only: no callers yet, no triggers, no RLS policies. Those land with
-- the import pipeline when (and if) a federation peer onboards.

CREATE TABLE IF NOT EXISTS agent_graph.federated_kg_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_org    text NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  blob_jsonld   jsonb NOT NULL,
  signature     text NOT NULL,
  contract_hash text,
  CONSTRAINT federated_kg_imports_signature_format
    CHECK (signature ~ '^ed25519:')
);

CREATE INDEX IF NOT EXISTS federated_kg_imports_origin_imported_idx
  ON agent_graph.federated_kg_imports (origin_org, imported_at DESC);

COMMENT ON TABLE agent_graph.federated_kg_imports IS
  'STAQPRO-356 / ADR-007: authoritative substrate for cross-org KG imports. Signed JSON-LD blobs land here; Neo4j stays a local cache.';
COMMENT ON COLUMN agent_graph.federated_kg_imports.origin_org IS
  'Issuing org identifier (matches JWT iss/org claim).';
COMMENT ON COLUMN agent_graph.federated_kg_imports.signature IS
  'ed25519:<base64> — verified against the origin org JWKS at import time.';
COMMENT ON COLUMN agent_graph.federated_kg_imports.contract_hash IS
  'Optional reference to the grant/contract under which this import was authorized.';
