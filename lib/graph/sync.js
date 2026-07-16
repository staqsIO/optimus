// graph/sync.js — Event-driven Postgres→Neo4j sync listener
import { runCypher, runCypherCreate, isGraphAvailable } from './client.js';
import { query } from '../db.js';
import { subscribe } from '../runtime/pg-listener.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/sync');

// The 7 channels this subsystem mirrors into the Neo4j graph. Kept as a single
// list so the LISTEN set is unambiguous and can't drift from the dispatch
// switch in processNotification().
const SYNC_CHANNELS = [
  'task_completed',
  'intent_decided',
  'draft_reviewed',
  'contact_changed',
  'identity_changed',
  'organization_changed',
  'project_membership_changed',
];

// STAQPRO-326: when migration 112's notify trigger detects an over-sized
// payload (>7,900 bytes) it sends `{op, id, _truncated: true, _table}`
// instead of the full row. Re-fetch the full row here so the downstream
// handler sees the same shape as it would for a normal-sized payload.
async function rehydrateTruncatedPayload(payload, channel) {
  // Never trust `_table` from the NOTIFY payload. Select the re-fetch query
  // from a fixed channel allow-list so the SQL text is always constant.
  const channelQueryMap = {
    contact_changed:
      'SELECT to_jsonb(t.*) AS row FROM signal.contacts t WHERE t.id = $1 LIMIT 1',
    identity_changed:
      'SELECT to_jsonb(t.*) AS row FROM signal.contact_identities t WHERE t.id = $1 LIMIT 1',
    organization_changed:
      'SELECT to_jsonb(t.*) AS row FROM signal.organizations t WHERE t.id = $1 LIMIT 1',
    project_membership_changed:
      'SELECT to_jsonb(t.*) AS row FROM signal.contact_projects t WHERE t.id = $1 LIMIT 1',
  };
  const sql = channelQueryMap[channel];
  if (!sql) {
    log.warn(`Truncated payload on unknown channel ${channel}; cannot rehydrate.`);
    return payload;
  }
  try {
    const result = await query(sql, [payload.id]);
    if (result.rows.length === 0) {
      // Row was deleted between trigger fire and our re-fetch. Surface as
      // a delete op so the handler tears down the graph node.
      return { op: 'delete', id: payload.id };
    }
    return { ...result.rows[0].row, op: payload.op };
  } catch (err) {
    log.error(`Re-fetch failed for truncated payload on ${channel}: ${err.message}`);
    return payload;
  }
}

// Unsubscribe fns from the shared pg-listener (one per channel). Held so
// stopGraphSync() can detach without tearing down the shared client.
let _unsubscribers = [];

// STAQPRO-326: tail-chained promise queue. Every notification appends one
// `processNotification` call so they run strictly in series, never racing.
// Reassigned on every event — `.catch` makes the chain non-poisoning.
let syncQueue = Promise.resolve();

async function processNotification(payloadStr, channel) {
  let payload = JSON.parse(payloadStr);
  // Validate payload shape before processing (Linus review)
  if (!payload || typeof payload !== 'object') {
    log.warn('Invalid payload shape, skipping');
    return;
  }
  // STAQPRO-326: handle the >8 KB truncation marker emitted by migration 112.
  if (payload._truncated === true) {
    payload = await rehydrateTruncatedPayload(payload, channel);
  }
  switch (channel) {
    case 'task_completed':
      if (payload.work_item_id && payload.agent_id) {
        await handleTaskCompleted(payload);
      }
      break;
    case 'intent_decided':
      if (payload.intent_id && payload.agent_id) {
        await handleIntentDecided(payload);
      }
      break;
    case 'draft_reviewed':
      if (payload.proposal_id) {
        await handleDraftReviewed(payload);
      }
      break;
    case 'contact_changed':
      if (payload.id) {
        await handleContactChanged(payload);
      }
      break;
    case 'identity_changed':
      if (payload.id) {
        await handleIdentityChanged(payload);
      }
      break;
    case 'organization_changed':
      if (payload.id) {
        await handleOrganizationChanged(payload);
      }
      break;
    case 'project_membership_changed':
      if (payload.id) {
        await handleProjectMembershipChanged(payload);
      }
      break;
  }
}

// Exported for tests — lets a concurrency test await full drain before
// asserting state. Production code should not use this.
export function _drainSyncQueueForTest() {
  return syncQueue;
}

export function startGraphSync() {
  if (!isGraphAvailable()) {
    log.info('Neo4j unavailable — sync disabled');
    return;
  }

  if (!process.env.DATABASE_URL) {
    log.info('No DATABASE_URL — sync disabled (PGlite mode)');
    return;
  }

  // Idempotent: avoid stacking duplicate handlers on repeat calls.
  if (_unsubscribers.length > 0) return;

  // Phase 1 consolidation: register on the single shared pg-listener instead
  // of opening a dedicated pg.Client LISTEN connection. The shared client's
  // connect/reconnect/watchdog are owned by the boot sequence; subscribe() is
  // callable before start(), so registration order at boot does not matter.
  //
  // STAQPRO-326: serialize notification processing via a tail-chained promise.
  // Without this the next handler fires before the previous Cypher round-trip
  // resolves — during the historic TLDv backfill, thousands of contact_changed
  // payloads land within a minute and the unbounded concurrency drains the
  // 10-connection Neo4j pool, swallowing CONNECTION_ACQUISITION_TIMEOUT errors
  // silently at client.js:89. Trade-off: a slow handler blocks the chain.
  // That's the right call here because the work is naturally serial (Neo4j
  // MERGEs against a small bounded pool) and dropped writes are worse than
  // queue latency. The single shared queue is preserved across ALL channels,
  // matching the previous single-client behavior exactly.
  _unsubscribers = SYNC_CHANNELS.map((channel) =>
    subscribe(channel, (payloadStr) => {
      syncQueue = syncQueue
        .then(() => processNotification(payloadStr, channel))
        .catch((err) => {
          // Never let one bad notification poison the chain.
          log.error(`Error processing notification: ${err.message}`);
        });
    })
  );

  log.info(`Listening for ${SYNC_CHANNELS.join(', ')}`);
}

async function handleTaskCompleted(payload) {
  const { work_item_id, agent_id, duration_ms, tokens_used, task_type, success } = payload;

  // STAQPRO-359: ON CREATE SET origin_org so newly-created TaskOutcome nodes
  // are tagged for federation, without backfilling existing ones (which keep
  // their NULL origin_org per ADR-007's no-backfill stance).
  await runCypherCreate(
    `MATCH (a:Agent {id: $agentId})
     MERGE (t:TaskOutcome {id: $workItemId})
     ON CREATE SET t.origin_org = $origin_org
     SET t.task_type = $taskType, t.success = $success,
         t.duration_ms = $durationMs, t.tokens_used = $tokensUsed,
         t.created_at = datetime()
     MERGE (a)-[r:COMPLETED_TASK]->(t)
     SET r.role = $agentId, r.duration_ms = $durationMs`,
    { agentId: agent_id, workItemId: work_item_id, taskType: task_type || 'task',
      success: success !== false, durationMs: duration_ms || 0, tokensUsed: tokens_used || 0 }
  );
}

async function handleIntentDecided(payload) {
  const { intent_id, agent_id, decided_by, status, decision_tier } = payload;

  // Create/update Decision node and link proposing agent (STAQPRO-359)
  await runCypherCreate(
    `MATCH (a:Agent {id: $agentId})
     MERGE (d:Decision {id: $intentId})
     ON CREATE SET d.origin_org = $origin_org
     SET d.type = $tier, d.board_verdict = $status, d.created_at = datetime()
     MERGE (a)-[:PROPOSED_DECISION]->(d)`,
    { agentId: agent_id, intentId: intent_id, tier: decision_tier || 'tactical', status }
  );

  // Link the deciding agent (board member) via DECIDED_ON edge
  // This enables multi-hop decision chain queries (ADR-019)
  if (decided_by) {
    await runCypherCreate(
      `MERGE (decider:Agent {id: $deciderId})
       ON CREATE SET decider.origin_org = $origin_org
       WITH decider
       MATCH (d:Decision {id: $intentId})
       MERGE (decider)-[:DECIDED_ON]->(d)`,
      { deciderId: decided_by, intentId: intent_id }
    );
  }
}

async function handleDraftReviewed(payload) {
  const { proposal_id, reviewer_verdict, tone_score } = payload;

  await runCypherCreate(
    `MERGE (t:TaskOutcome {id: $proposalId})
     ON CREATE SET t.origin_org = $origin_org
     SET t.task_type = 'draft_review', t.success = $approved,
         t.tone_score = $toneScore, t.created_at = datetime()`,
    { proposalId: proposal_id, approved: reviewer_verdict === 'approved',
      toneScore: tone_score || 0 }
  );
}

// CRM graph projection (Phase 2 of contacts upgrade — see ADR-026).
// signal.contacts → :Person nodes, signal.contact_identities → :Identity
// (with HAS_IDENTITY edge), signal.organizations → :Organization (with
// WORKS_AT edge), signal.contact_projects → :Project (with MEMBER_OF edge).
// All idempotent; deletes detach the node so we don't leak orphan edges.

async function handleContactChanged(payload) {
  const { op, id, name, email_address, organization_id, contact_type, tier, is_vip } = payload;

  if (op === 'delete') {
    await runCypher('MATCH (p:Person {id: $id}) DETACH DELETE p', { id });
    return;
  }

  await runCypherCreate(
    `MERGE (p:Person {id: $id})
     ON CREATE SET p.origin_org = $origin_org
     SET p.name = $name,
         p.email = $email,
         p.contact_type = $contactType,
         p.tier = $tier,
         p.is_vip = $isVip,
         p.updated_at = datetime()`,
    {
      id,
      name: name || null,
      email: email_address || null,
      contactType: contact_type || 'unknown',
      tier: tier || 'unknown',
      isVip: is_vip === true,
    },
  );

  // Maintain WORKS_AT edge whenever organization_id is set/changed.
  if (organization_id) {
    await runCypher(
      `MATCH (p:Person {id: $personId})
       MATCH (o:Organization {id: $orgId})
       MERGE (p)-[r:WORKS_AT]->(o)
       SET r.updated_at = datetime()
       WITH p, o
       MATCH (p)-[old:WORKS_AT]->(otherOrg:Organization)
       WHERE otherOrg.id <> $orgId
       DELETE old`,
      { personId: id, orgId: organization_id },
    );
  } else {
    // org cleared — drop any WORKS_AT edge.
    await runCypher(
      `MATCH (p:Person {id: $personId})-[r:WORKS_AT]->(:Organization) DELETE r`,
      { personId: id },
    );
  }
}

async function handleIdentityChanged(payload) {
  const { op, id, contact_id, channel, identifier, source, verified_at } = payload;

  if (op === 'delete') {
    await runCypher('MATCH (i:Identity {id: $id}) DETACH DELETE i', { id });
    return;
  }

  // `key` is channel+identifier, used as the unique constraint so the same
  // identity merges across reinserts even if id rotates.
  const key = `${channel}:${identifier}`.toLowerCase();
  await runCypherCreate(
    `MERGE (i:Identity {key: $key})
     ON CREATE SET i.origin_org = $origin_org
     SET i.id = $id,
         i.channel = $channel,
         i.identifier = $identifier,
         i.source = $source,
         i.verified_at = $verifiedAt,
         i.updated_at = datetime()
     WITH i
     MATCH (p:Person {id: $contactId})
     MERGE (p)-[:HAS_IDENTITY]->(i)`,
    {
      id,
      key,
      channel,
      identifier: (identifier || '').toLowerCase(),
      contactId: contact_id,
      source: source || 'unknown',
      verifiedAt: verified_at ? verified_at.toString() : null,
    },
  );
}

async function handleOrganizationChanged(payload) {
  const { op, id, name, slug, primary_domain, org_type } = payload;

  if (op === 'delete') {
    await runCypher('MATCH (o:Organization {id: $id}) DETACH DELETE o', { id });
    return;
  }

  await runCypherCreate(
    `MERGE (o:Organization {id: $id})
     ON CREATE SET o.origin_org = $origin_org
     SET o.name = $name,
         o.slug = $slug,
         o.primary_domain = $domain,
         o.org_type = $orgType,
         o.updated_at = datetime()`,
    {
      id,
      name: name || null,
      slug: slug || null,
      domain: primary_domain || null,
      orgType: org_type || 'unknown',
    },
  );
}

async function handleProjectMembershipChanged(payload) {
  const { op, id, contact_id, project_name, platform, locator, is_primary, is_active } = payload;

  if (op === 'delete') {
    // Detach only the membership edge; keep the project node alive for
    // other contacts that may share it.
    await runCypher(
      `MATCH (:Person)-[r:MEMBER_OF {membership_id: $id}]->(:Project) DELETE r`,
      { id },
    );
    return;
  }

  // Use locator (e.g. github full_name) as the unique key so the same
  // project consolidates across multiple member rows.
  await runCypherCreate(
    `MERGE (proj:Project {locator: $locator})
     ON CREATE SET proj.origin_org = $origin_org
     SET proj.name = $name,
         proj.platform = $platform,
         proj.is_active = $isActive,
         proj.updated_at = datetime()
     WITH proj
     MATCH (p:Person {id: $personId})
     MERGE (p)-[r:MEMBER_OF]->(proj)
     SET r.membership_id = $id,
         r.is_primary = $isPrimary,
         r.is_active = $isActive,
         r.updated_at = datetime()`,
    {
      id,
      locator: (locator || project_name || '').toLowerCase(),
      name: project_name || null,
      platform: platform || 'other',
      personId: contact_id,
      isPrimary: is_primary === true,
      isActive: is_active !== false,
    },
  );
}

export function stopGraphSync() {
  // Detach our handlers from the shared pg-listener. Does NOT stop the shared
  // client — that is owned by the boot sequence (other subsystems share it).
  for (const unsub of _unsubscribers) {
    try { unsub(); } catch { /* already detached */ }
  }
  _unsubscribers = [];
}
