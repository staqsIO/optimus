// graph/client.js — Neo4j driver singleton (P4: boring infrastructure)
import neo4j from 'neo4j-driver';
import { createLogger } from '../logger.js';
const log = createLogger('graph/client');

let driver = null;
let available = false;

export async function initGraph() {
  const uri = process.env.NEO4J_URI;
  const password = process.env.NEO4J_PASSWORD;

  if (!uri) {
    log.info('NEO4J_URI not set — knowledge graph disabled');
    return;
  }

  const user = process.env.NEO4J_USER || 'neo4j';
  if (!password) {
    log.warn('NEO4J_PASSWORD not set — connecting with empty password (NOT safe for production)');
  }

  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password || ''), {
      maxConnectionPoolSize: 10,
      connectionAcquisitionTimeout: 5000,
    });
    await driver.verifyConnectivity();
    available = true;
    log.info('Neo4j connected');

    // Ensure fulltext indexes exist for graph-retriever RAG queries
    await ensureIndexes();
  } catch (err) {
    log.warn({ err: err.message }, 'Neo4j unavailable — learning features disabled');
    driver = null;
    available = false;
  }
}

/**
 * Create required Neo4j indexes if they don't exist.
 * Called once at startup after connection is verified.
 */
async function ensureIndexes() {
  if (!driver) return;
  const session = driver.session();
  try {
    // Fulltext index for entity search — used by graph-retriever.js
    // Covers all node labels that might have a 'name' property
    await session.run(
      `CREATE FULLTEXT INDEX entity_search IF NOT EXISTS
       FOR (n:Agent|Person|Organization|Project|Topic|Decision|Tool|Concept)
       ON EACH [n.name, n.id, n.description]`
    );
    log.info('Neo4j fulltext index entity_search ensured');

    // STAQPRO-359 cleanup: the per-label origin_org index loop that used to
    // live here (creating origin_org_<label>_idx) was consolidated into
    // lib/graph/schema.js as the single source of truth (origin_org_<label>).
    // ensureSchema() runs immediately after this in startup and also drops
    // the legacy _idx-suffixed duplicates this loop had created.
  } catch (err) {
    // Index may already exist or labels may not exist yet — non-fatal
    if (!err.message?.includes('already exists')) {
      log.warn({ err: err.message }, 'Failed to create fulltext index');
    }
  } finally {
    await session.close();
  }
}

export function isGraphAvailable() {
  return available;
}

/**
 * STAQPRO-356 / ADR-007 §2: federation-ready org tagging.
 * Returns the issuing org's identifier — every Neo4j CREATE should carry this
 * as `origin_org` so the graph can be partitioned per-org without a backfill.
 * Single-org installs default to "self".
 */
export function getOriginOrg() {
  return process.env.OPTIMUS_ORG_ID || 'self';
}

// Used by runCypher to detect un-tagged CREATEs at runtime — cheaper than
// wiring an ESLint rule with no project-level config to attach it to.
// Matches `CREATE (alias:Label ...)` patterns; ignores fulltext / constraint
// CREATEs (those are schema DDL, not node writes).
const CYPHER_NODE_CREATE = /\bCREATE\s+\(\s*[A-Za-z_][\w]*\s*:/i;
const CYPHER_DDL_CREATE = /\bCREATE\s+(FULLTEXT|VECTOR|RANGE|TEXT|POINT|LOOKUP)?\s*(INDEX|CONSTRAINT)\b/i;
let _missingOriginOrgWarned = new Set();

function warnMissingOriginOrg(query, callerHint) {
  // Best-effort warning, throttled per unique callerHint to avoid log spam.
  const key = callerHint || query.slice(0, 120);
  if (_missingOriginOrgWarned.has(key)) return;
  _missingOriginOrgWarned.add(key);
  log.warn(`[STAQPRO-356] Cypher CREATE missing origin_org tag — use runCypherCreate() instead. caller=${callerHint || 'unknown'}`);
}

/**
 * Execute a Cypher query against Neo4j.
 * @param {string} query - Parameterized Cypher query
 * @param {Object} params - Query parameters (never interpolate strings)
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.readOnly] - Use READ session mode (for queries that don't mutate)
 * @param {string} [opts.caller] - Free-form caller label for the missing-origin_org diagnostic
 * @returns {Promise<Array|null>} Records or null if unavailable/error
 */
export async function runCypher(query, params = {}, opts = {}) {
  if (!available || !driver) return null;
  // STAQPRO-356: flag raw CREATE statements that haven't been migrated to
  // runCypherCreate() yet. Skip DDL (CREATE INDEX / CONSTRAINT) and skip
  // queries that already pass origin_org explicitly.
  if (
    CYPHER_NODE_CREATE.test(query) &&
    !CYPHER_DDL_CREATE.test(query) &&
    !('origin_org' in params) &&
    !/\borigin_org\s*:/.test(query)
  ) {
    warnMissingOriginOrg(query, opts.caller);
  }
  const session = driver.session({
    defaultAccessMode: opts.readOnly ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    log.error({ err: err.message }, 'Cypher error');
    return null;
  } finally {
    await session.close();
  }
}

/**
 * STAQPRO-356 / ADR-007 §2: federation-aware CREATE helper.
 *
 * Always injects `origin_org` into the params so the Cypher author just has
 * to reference `$origin_org` in their CREATE clause. Example:
 *
 *   await runCypherCreate(
 *     `CREATE (a:Agent { id: $id, name: $name, origin_org: $origin_org })`,
 *     { id, name }
 *   );
 *
 * In single-org installs (OPTIMUS_ORG_ID unset) this still writes
 * `origin_org: "self"`, which is the documented sentinel value. The graph
 * can be safely partitioned later — every node carries the property.
 */
export async function runCypherCreate(query, params = {}, opts = {}) {
  return runCypher(query, { ...params, origin_org: getOriginOrg() }, opts);
}

/** Test-only — reset the throttled-warning memo. */
export function _resetOriginOrgWarningsForTest() {
  _missingOriginOrgWarned = new Set();
}

export async function closeGraph() {
  if (driver) {
    await driver.close();
    driver = null;
    available = false;
  }
}
