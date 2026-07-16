/**
 * Phase 2 — relationship inference.
 *
 * Hourly job (registered via ServiceScheduler) that materializes
 * Person-to-Person edges from Postgres signal/inbox/content data and
 * MERGEs them into Neo4j. Read-only against Postgres; idempotent against
 * Neo4j (every edge has a deterministic key so reruns just refresh
 * counters).
 *
 * Three edge types today:
 *
 *   (:Person)-[:THREADED_WITH {threadCount, lastAt}]->(:Person)
 *     Co-participants on inbox.messages with the same thread_id.
 *
 *   (:Person)-[:PARTICIPATED_WITH {docCount, lastAt}]->(:Person)
 *     Co-listed in content.documents.participants.
 *
 *   (:Person)-[:COLLABORATED_ON]->(:Project)<-[:COLLABORATED_ON]-(:Person)
 *     Implicit via MEMBER_OF edges already maintained by the sync handler;
 *     materialized here as a denormalized peer edge with shared project
 *     count for ranking.
 *
 * Edge weights are simple (count + lastAt). Strategist / responder agents
 * read these to score relationship strength in Phase 5.
 */

import { runCypher, isGraphAvailable } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('graph/relationship-inferrer');

const TOP_K_PER_PERSON = 20;          // cap how many edges we materialize per source
const STALE_AFTER_DAYS = 365;         // skip pairs whose last interaction is > 1 year old

/**
 * Pull thread-co-participant pairs from Postgres. Joins inbox.messages on
 * thread_id within the past N days; aggregates per (sender_id, recipient_id).
 *
 * Heuristic: a "participant" of a thread is the from_address sender plus
 * each to_addresses entry. We resolve them to contact_ids via
 * signal.contact_identities.
 */
async function fetchThreadPairs(queryFn) {
  const { rows } = await queryFn(`
    WITH thread_participants AS (
      SELECT
        m.thread_id,
        ci.contact_id,
        m.received_at
      FROM inbox.messages m
      JOIN signal.contact_identities ci
        ON ci.channel = 'email'
       AND ci.identifier = lower(m.from_address)
      WHERE m.thread_id IS NOT NULL
        AND m.received_at > now() - ($1 || ' days')::interval
      UNION ALL
      SELECT
        m.thread_id,
        ci.contact_id,
        m.received_at
      FROM inbox.messages m
      CROSS JOIN LATERAL unnest(m.to_addresses) AS recipient(addr)
      JOIN signal.contact_identities ci
        ON ci.channel = 'email'
       AND ci.identifier = lower(recipient.addr)
      WHERE m.thread_id IS NOT NULL
        AND m.received_at > now() - ($1 || ' days')::interval
    ),
    pairs AS (
      SELECT
        a.contact_id AS person_a,
        b.contact_id AS person_b,
        count(DISTINCT a.thread_id) AS thread_count,
        max(a.received_at) AS last_at
      FROM thread_participants a
      JOIN thread_participants b
        ON a.thread_id = b.thread_id
       AND a.contact_id < b.contact_id
      JOIN signal.contacts ca ON ca.id = a.contact_id
      JOIN signal.contacts cb ON cb.id = b.contact_id
      WHERE ca.contact_type NOT IN ('service', 'newsletter')
        AND cb.contact_type NOT IN ('service', 'newsletter')
      GROUP BY 1, 2
    )
    SELECT person_a, person_b, thread_count, last_at
      FROM pairs
     WHERE thread_count >= 1
     ORDER BY last_at DESC
  `, [STALE_AFTER_DAYS]);
  return rows;
}

/**
 * Pull document-participant pairs from content.documents.participants
 * (JSONB array with { contact_id, name, email }).
 */
async function fetchDocumentPairs(queryFn) {
  const { rows } = await queryFn(`
    WITH doc_participants AS (
      SELECT
        d.id AS doc_id,
        (p->>'contact_id') AS contact_id,
        d.created_at
      FROM content.documents d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) AS p
      WHERE p ? 'contact_id'
        AND p->>'contact_id' IS NOT NULL
        AND d.created_at > now() - ($1 || ' days')::interval
    ),
    pairs AS (
      SELECT
        a.contact_id AS person_a,
        b.contact_id AS person_b,
        count(DISTINCT a.doc_id) AS doc_count,
        max(a.created_at) AS last_at
      FROM doc_participants a
      JOIN doc_participants b
        ON a.doc_id = b.doc_id
       AND a.contact_id < b.contact_id
      JOIN signal.contacts ca ON ca.id = a.contact_id
      JOIN signal.contacts cb ON cb.id = b.contact_id
      WHERE ca.contact_type NOT IN ('service', 'newsletter')
        AND cb.contact_type NOT IN ('service', 'newsletter')
      GROUP BY 1, 2
    )
    SELECT person_a, person_b, doc_count, last_at
      FROM pairs
     ORDER BY last_at DESC
  `, [STALE_AFTER_DAYS]);
  return rows;
}

async function fetchProjectPairs(queryFn) {
  const { rows } = await queryFn(`
    WITH pairs AS (
      SELECT
        a.contact_id AS person_a,
        b.contact_id AS person_b,
        count(DISTINCT a.project_name) AS project_count,
        max(GREATEST(a.updated_at, b.updated_at)) AS last_at
      FROM signal.contact_projects a
      JOIN signal.contact_projects b
        ON a.locator = b.locator
       AND a.platform = b.platform
       AND a.contact_id < b.contact_id
      JOIN signal.contacts ca ON ca.id = a.contact_id
      JOIN signal.contacts cb ON cb.id = b.contact_id
      WHERE a.is_active AND b.is_active
        AND ca.contact_type NOT IN ('service', 'newsletter')
        AND cb.contact_type NOT IN ('service', 'newsletter')
      GROUP BY 1, 2
    )
    SELECT person_a, person_b, project_count, last_at
      FROM pairs
     ORDER BY last_at DESC
  `);
  return rows;
}

// STAQPRO-326: write & prune helpers replace the prior DELETE-all-then-MERGE
// approach which left readers seeing an empty graph for minutes at a time
// (one Cypher round-trip per pair × 1000+ pairs). Two changes:
//
//   1. MERGE every edge first (idempotent — same key set), stamping
//      r.updated_at = datetime() so anything refreshed this pass has a fresh
//      timestamp.
//   2. After all MERGEs land, DELETE relationships of that type whose
//      r.updated_at < runStartedAt (i.e. weren't touched). Readers between
//      the two phases see the *new* edges plus any stale ones — never an
//      empty graph, which is the correctness gain.
//
// Network round-trips are still one per pair; batching to UNWIND is a
// follow-up perf improvement that's not in scope here.

async function writeThreadEdges(pairs, runStartedAt) {
  for (const p of pairs.slice(0, TOP_K_PER_PERSON * 100)) {
    await runCypher(
      `MATCH (a:Person {id: $a}), (b:Person {id: $b})
       MERGE (a)-[r:THREADED_WITH]-(b)
       SET r.threadCount = $count,
           r.lastAt = $lastAt,
           r.updated_at = datetime()`,
      { a: p.person_a, b: p.person_b, count: Number(p.thread_count), lastAt: p.last_at?.toISOString?.() || String(p.last_at) },
    );
  }
  await runCypher(
    `MATCH ()-[r:THREADED_WITH]-()
     WHERE r.updated_at < datetime($cutoff) OR r.updated_at IS NULL
     DELETE r`,
    { cutoff: runStartedAt },
  );
}

async function writeDocumentEdges(pairs, runStartedAt) {
  for (const p of pairs.slice(0, TOP_K_PER_PERSON * 100)) {
    await runCypher(
      `MATCH (a:Person {id: $a}), (b:Person {id: $b})
       MERGE (a)-[r:PARTICIPATED_WITH]-(b)
       SET r.docCount = $count,
           r.lastAt = $lastAt,
           r.updated_at = datetime()`,
      { a: p.person_a, b: p.person_b, count: Number(p.doc_count), lastAt: p.last_at?.toISOString?.() || String(p.last_at) },
    );
  }
  await runCypher(
    `MATCH ()-[r:PARTICIPATED_WITH]-()
     WHERE r.updated_at < datetime($cutoff) OR r.updated_at IS NULL
     DELETE r`,
    { cutoff: runStartedAt },
  );
}

async function writeProjectEdges(pairs, runStartedAt) {
  for (const p of pairs) {
    await runCypher(
      `MATCH (a:Person {id: $a}), (b:Person {id: $b})
       MERGE (a)-[r:COLLABORATED_ON_PROJECT]-(b)
       SET r.projectCount = $count,
           r.lastAt = $lastAt,
           r.updated_at = datetime()`,
      { a: p.person_a, b: p.person_b, count: Number(p.project_count), lastAt: p.last_at?.toISOString?.() || String(p.last_at) },
    );
  }
  await runCypher(
    `MATCH ()-[r:COLLABORATED_ON_PROJECT]-()
     WHERE r.updated_at < datetime($cutoff) OR r.updated_at IS NULL
     DELETE r`,
    { cutoff: runStartedAt },
  );
}

// STAQPRO-326: re-entrancy guard. The ServiceScheduler fires hourly with a
// 4-min stagger; a slow Neo4j (or a backfill in progress) can stretch a run
// past 60 minutes and have the next tick collide with the prune phase.
let inferrerRunning = false;

/**
 * Run a full inference pass. Wired into ServiceScheduler at product entry point.
 */
export async function runRelationshipInferrer({ query }) {
  if (!isGraphAvailable()) {
    log.info('Neo4j unavailable — skipping relationship inferrer');
    return { skipped: true };
  }
  if (inferrerRunning) {
    log.warn('Inferrer already running — skipping overlapping tick');
    return { skipped: true, reason: 'already_running' };
  }
  inferrerRunning = true;
  const t0 = Date.now();
  // ISO with millisecond precision. All MERGEs below will land with
  // r.updated_at >= this value; everything older is stale and gets pruned.
  const runStartedAt = new Date(t0).toISOString();

  try {
    const [threadPairs, docPairs, projectPairs] = await Promise.all([
      fetchThreadPairs(query),
      fetchDocumentPairs(query),
      fetchProjectPairs(query),
    ]);

    await writeThreadEdges(threadPairs, runStartedAt);
    await writeDocumentEdges(docPairs, runStartedAt);
    await writeProjectEdges(projectPairs, runStartedAt);

    const duration = Date.now() - t0;
    log.info(`Inferrer pass complete in ${duration}ms — threads=${threadPairs.length} docs=${docPairs.length} projects=${projectPairs.length}`);
    return {
      durationMs: duration,
      threadEdges: threadPairs.length,
      docEdges: docPairs.length,
      projectEdges: projectPairs.length,
    };
  } finally {
    inferrerRunning = false;
  }
}

// Exported for tests; production callers should use runRelationshipInferrer.
export function _isInferrerRunningForTest() {
  return inferrerRunning;
}
