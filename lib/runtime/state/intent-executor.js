import { query } from '../../db.js';
import { createWorkItem } from '../state-machine.js';
import { publishEvent } from '../infrastructure.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/intent-executor');

/**
 * Intent executor: polls for approved intents and fires them as work items.
 * Runs every 30s on the primary instance. Handles one-shot and recurring intents.
 *
 * Flow:
 *   1. Query approved intents whose next_fire_at has passed (or is null)
 *   2. Create a work item from the intent
 *   3. Transition intent to 'executed'
 *   4. For recurring intents, reset next_fire_at and keep status 'approved'
 *   5. Record in Neo4j if available
 */

let executorTimer = null;

export function startIntentExecutor() {
  if (executorTimer) return; // already running

  log.info('Starting (30s poll)');

  const poll = async () => {
    try {
      const ready = await query(`
        SELECT * FROM agent_graph.agent_intents
        WHERE status = 'approved'
          AND (next_fire_at IS NULL OR next_fire_at <= now())
        LIMIT 5
      `);

      for (const intent of ready.rows) {
        try {
          await executeIntent(intent);
        } catch (err) {
          log.error(`Failed to execute intent ${intent.id}: ${err.message}`);
        }
      }
    } catch (err) {
      log.error('Poll error:', err.message);
    }
  };

  // Initial poll after 5s delay, then every 30s
  setTimeout(() => {
    poll();
    executorTimer = setInterval(poll, 30_000);
  }, 5_000);
}

export function stopIntentExecutor() {
  if (executorTimer) {
    clearInterval(executorTimer);
    executorTimer = null;
    log.info('Stopped');
  }
}

async function executeIntent(intent) {
  // Determine target agent from proposed_action payload
  const proposedAction = typeof intent.proposed_action === 'string'
    ? JSON.parse(intent.proposed_action)
    : intent.proposed_action || {};

  // ADR-021: Handle campaign creation from intents
  if (proposedAction.type === 'campaign') {
    await executeCampaignIntent(intent, proposedAction);
    return;
  }

  const assignTo = proposedAction.payload?.assign_to || 'orchestrator';

  // Map decision tier to priority
  const priorityMap = { existential: 1, strategic: 2, operational: 3, tactical: 4 };
  const priority = priorityMap[intent.decision_tier] || 3;

  // Create work item from intent
  const item = await createWorkItem({
    type: 'task',
    title: intent.title,
    description: intent.reasoning || intent.title,
    createdBy: intent.agent_id,
    assignedTo: assignTo,
    priority,
    metadata: {
      source: 'intent_executor',
      intent_id: intent.id,
      intent_type: intent.intent_type,
      trigger_type: intent.trigger_type,
    },
  });

  log.info(`Executed intent ${intent.id} → work_item ${item.id} → ${assignTo}`);

  // Transition intent status
  if (intent.trigger_type === 'interval') {
    // Recurring: reset next_fire_at, keep approved
    const interval = intent.trigger_config?.interval || '1 hour';
    await query(
      `UPDATE agent_graph.agent_intents
       SET next_fire_at = now() + $1::interval, updated_at = now()
       WHERE id = $2`,
      [interval, intent.id]
    );
    log.info(`Recurring intent ${intent.id} — next fire in ${interval}`);
  } else {
    // One-shot: transition to executed
    try {
      await query(
        `INSERT INTO agent_graph.agent_intent_transitions (intent_id, from_status, to_status, decided_by, notes)
         VALUES ($1, 'approved', 'executed', 'intent_executor', $2)`,
        [intent.id, `Created work_item ${item.id}`]
      );
      await query(
        `UPDATE agent_graph.agent_intents SET status = 'executed', updated_at = now() WHERE id = $1`,
        [intent.id]
      );
    } catch (err) {
      log.warn(`Intent transition failed for ${intent.id}: ${err.message}`);
    }
  }

  // Record in Neo4j (non-blocking)
  // P2: No PII in graph — use type+ID reference, not raw title (Linus review)
  try {
    const { runCypher, isGraphAvailable } = await import('../../graph/client.js');
    if (isGraphAvailable()) {
      await runCypher(`
        MATCH (a:Agent {id: $agentId})
        MERGE (d:Decision {id: $intentId})
        SET d.type = $type, d.intent_type = $intentType, d.created_at = datetime()
        MERGE (a)-[:PROPOSED_DECISION]->(d)
      `, {
        agentId: intent.agent_id,
        intentId: intent.id,
        type: intent.intent_type,
        intentType: intent.decision_tier || 'tactical',
      });
    }
  } catch {
    // Neo4j unavailable — non-fatal
  }

  // Publish event for governance feed visibility
  await publishEvent(
    'intent_executed',
    `Intent executed: ${intent.title} → ${assignTo}`,
    intent.agent_id,
    item.id,
    { intent_id: intent.id, assigned_to: assignTo },
  ).catch(() => {}); // non-critical
}

/**
 * ADR-021: Create a campaign from an approved intent.
 * Creates a work_item (type='campaign') and a campaigns row.
 * Campaign remains in 'pending_approval' — board must approve the campaign
 * envelope separately (two-gate: intent + campaign).
 */
async function executeCampaignIntent(intent, proposedAction) {
  const payload = proposedAction.payload || {};

  // Create the campaign work_item
  const item = await createWorkItem({
    type: 'campaign',
    title: `Campaign: ${payload.goal?.slice(0, 80) || intent.title}`,
    description: payload.goal || intent.reasoning || intent.title,
    createdBy: intent.agent_id,
    assignedTo: 'claw-campaigner',
    priority: 2,
    metadata: {
      source: 'intent_executor',
      intent_id: intent.id,
      campaign_origin: 'intent',
    },
  });

  // Build metadata JSONB (include promotion config if provided)
  const campaignMetadata = {};
  if (payload.promotion) campaignMetadata.promotion = payload.promotion;
  if (payload.metadata) Object.assign(campaignMetadata, payload.metadata);

  // Create the campaign envelope (pending_approval)
  await query(
    `INSERT INTO agent_graph.campaigns
     (work_item_id, goal_description, success_criteria, constraints,
      budget_envelope_usd, max_iterations, iteration_time_budget,
      max_cost_per_iteration, source_intent_id, created_by, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::interval, $8, $9, $10, $11::jsonb)`,
    [
      item.id,
      payload.goal || intent.title,
      JSON.stringify(payload.success_criteria || []),
      JSON.stringify({
        tool_allowlist: payload.tool_allowlist || [],
        content_policy: payload.content_policy || {},
      }),
      payload.budget_envelope_usd || 10.00,
      payload.max_iterations || 50,
      payload.iteration_time_budget || '5 minutes',
      payload.max_cost_per_iteration || null,
      intent.id,
      intent.agent_id,
      JSON.stringify(campaignMetadata),
    ]
  );

  // Auto-approve tactical campaigns (budget < $5, max_iterations < 10)
  const budgetUsd = payload.budget_envelope_usd || 10.00;
  const maxIter = payload.max_iterations || 50;
  const isTactical = intent.decision_tier === 'tactical' && budgetUsd <= 5.0 && maxIter <= 10;

  if (isTactical) {
    await query(
      `UPDATE agent_graph.campaigns SET campaign_status = 'approved', updated_at = now()
       WHERE work_item_id = $1`,
      [item.id]
    );
    log.info(`Tactical campaign auto-approved: budget $${budgetUsd}, max ${maxIter} iterations`);
  }

  // Transition intent to executed
  try {
    await query(
      `INSERT INTO agent_graph.agent_intent_transitions (intent_id, from_status, to_status, decided_by, notes)
       VALUES ($1, 'approved', 'executed', 'intent_executor', $2)`,
      [intent.id, `Created campaign work_item ${item.id}${isTactical ? ' (auto-approved)' : ''}`]
    );
    await query(
      `UPDATE agent_graph.agent_intents SET status = 'executed', updated_at = now() WHERE id = $1`,
      [intent.id]
    );
  } catch (err) {
    log.warn(`Intent transition failed for ${intent.id}: ${err.message}`);
  }

  log.info(`Campaign created from intent ${intent.id} → work_item ${item.id} (${isTactical ? 'auto-approved' : 'pending_approval'})`);

  await publishEvent(
    'intent_executed',
    `Campaign created: ${payload.goal?.slice(0, 80) || intent.title}`,
    intent.agent_id,
    item.id,
    { intent_id: intent.id, campaign_origin: 'intent', auto_approved: isTactical },
  ).catch(() => {});
}
