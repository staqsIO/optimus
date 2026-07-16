/**
 * slack/channel-digest.js — Daily per-channel "what moved" digest assembler.
 *
 * OPT-46. Assembles a per-channel digest summarising completed/in-progress
 * work items for each entity (project or engagement) mapped to a Slack channel.
 *
 * Pattern mirrors the existing board daily-digest in index.js:
 *   - Assembles from DB queries (no LLM in the hot path)
 *   - Called once per UTC day (scheduler gate in caller; this file is pure logic)
 *   - Posts via the existing sendMessage in slack/client.js
 *   - Gated by isProjectDigestEnabled() — default OFF
 *
 * Wire-up: Add to ServiceScheduler in autobot-inbox/src/index.js:
 *
 *   scheduler.register('slack-channel-digest', async () => {
 *     const { runSlackChannelDigests } = await import('./slack/channel-digest.js');
 *     await runSlackChannelDigests();
 *   }, 60 * 60_000, { delayMs: 10 * 60_000 });
 *
 * And wrap in the same UTC-day memo pattern used by the existing daily-digest
 * (see the lastDigestDate variable in index.js) so it only fires once per day.
 */

import { query } from '../db.js';

import { isProjectDigestEnabled, formatProgressMessage } from './progress-poster.js';

/**
 * Query work items that moved in the last 24h for an entity.
 * "Moved" = status changed or completed in the last 24h.
 *
 * @param {'project'|'engagement'} entityType
 * @param {string} entityId
 * @returns {Promise<{completed: string[], inProgress: string[], blocked: string[]}>}
 */
async function fetchEntityProgress(entityType, entityId) {
  const completed = [];
  const inProgress = [];
  const blocked = [];

  if (entityType === 'project') {
    // agent_graph.projects + project_memberships + work_items
    // tenancy:allow-unscoped — entityId is a project_id read from an org-bound
    // inbox.slack_project_map row (the digest only ever runs over that org's
    // mappings); work_items are reached solely via that project's memberships.
    const result = await query(
      `SELECT w.title, w.status, w.updated_at
         FROM agent_graph.work_items w
         JOIN agent_graph.project_memberships pm
           ON pm.entity_type = 'work_item' AND pm.entity_id = w.id
        WHERE pm.project_id = $1
          AND w.updated_at >= now() - interval '24 hours'
        ORDER BY w.updated_at DESC
        LIMIT 20`,
      [entityId],
    );
    for (const row of result.rows) {
      const label = `${row.title} (${row.status})`;
      if (row.status === 'completed') completed.push(row.title);
      else if (row.status === 'in_progress') inProgress.push(row.title);
      else if (row.status === 'failed') blocked.push(label);
    }
  } else if (entityType === 'engagement') {
    // engagements: proposals ingested + spec updated in last 24h
    const propResult = await query(
      `SELECT title, created_at
         FROM engagements.proposals
        WHERE engagement_id = $1::uuid
          AND created_at >= now() - interval '24 hours'
        ORDER BY created_at DESC
        LIMIT 10`,
      [entityId],
    );
    for (const row of propResult.rows) {
      inProgress.push(`Proposal ingested: ${row.title || 'untitled'}`);
    }

    const specResult = await query(
      `SELECT ss.title, ss.updated_at
         FROM engagements.spec_sections ss
         JOIN engagements.specs s ON s.id = ss.spec_id
        WHERE s.engagement_id = $1::uuid
          AND ss.updated_at >= now() - interval '24 hours'
        ORDER BY ss.updated_at DESC
        LIMIT 10`,
      [entityId],
    );
    for (const row of specResult.rows) {
      completed.push(`Spec section updated: ${row.title}`);
    }
  }

  return { completed, inProgress, blocked };
}

/**
 * Assemble a per-channel digest for a single mapping row.
 *
 * @param {object} mapping  - row from inbox.slack_project_map
 * @returns {Promise<string|null>} formatted message, or null if nothing moved
 */
export async function assembleChannelDigest(mapping) {
  const { entityType, entityId } = mapping;

  // Fetch entity name
  let entityName = entityId; // fallback
  try {
    if (entityType === 'project') {
      // tenancy:allow-unscoped — name-only display lookup; entityId comes from an
      // org-bound inbox.slack_project_map row (already tenant-scoped at the mapping).
      const r = await query(
        `SELECT name FROM agent_graph.projects WHERE id = $1 LIMIT 1`,
        [entityId],
      );
      if (r.rows[0]) entityName = r.rows[0].name;
    } else {
      const r = await query(
        `SELECT name FROM engagements.engagements WHERE id = $1::uuid LIMIT 1`,
        [entityId],
      );
      if (r.rows[0]) entityName = r.rows[0].name;
    }
  } catch {
    // non-fatal — use entityId as fallback name
  }

  const { completed, inProgress, blocked } = await fetchEntityProgress(entityType, entityId);

  // Nothing moved → skip (no noisy empty pings)
  if (completed.length === 0 && inProgress.length === 0 && blocked.length === 0) {
    return null;
  }

  const reviewUrl = `board.staqs.io/${entityType === 'engagement' ? 'engagements' : 'pipeline'}`;

  return formatProgressMessage({
    entityType,
    entityName,
    completed,
    moved: inProgress,
    blocked,
    reviewUrl,
  });
}

/**
 * Run digests for ALL mapped channels across ALL orgs.
 * Call this once per UTC day from the scheduler.
 *
 * @returns {Promise<{sent: number, skipped: number, errors: string[]}>}
 */
export async function runSlackChannelDigests() {
  if (!isProjectDigestEnabled()) {
    console.log('[slack/channel-digest] Skipped: SLACK_PROJECT_DIGEST_ENABLED not true or SLACK_BOT_TOKEN not set');
    return { sent: 0, skipped: 0, errors: [] };
  }

  // Gather all active mappings across all orgs
  let allMappings;
  try {
    const result = await query(
      `SELECT id, org_id, slack_channel_id, slack_channel_name, entity_type, entity_id
         FROM inbox.slack_project_map
        ORDER BY org_id, slack_channel_id`,
    );
    allMappings = result.rows;
  } catch (err) {
    console.error(`[slack/channel-digest] Failed to load mappings: ${err.message}`);
    return { sent: 0, skipped: 0, errors: [err.message] };
  }

  if (allMappings.length === 0) {
    console.log('[slack/channel-digest] No channel mappings — nothing to digest');
    return { sent: 0, skipped: 0, errors: [] };
  }

  // Dynamic import: only load @slack/bolt when needed
  const { initSlackApp, sendMessage } = await import('./client.js');
  await initSlackApp();

  const errors = [];
  let sent = 0;
  let skipped = 0;

  for (const mapping of allMappings) {
    try {
      const text = await assembleChannelDigest(mapping);
      if (!text) {
        skipped++;
        console.log(`[slack/channel-digest] Nothing moved for ${mapping.entity_type}:${mapping.entity_id} → skip`);
        continue;
      }
      await sendMessage(mapping.slack_channel_id, text);
      sent++;
      console.log(`[slack/channel-digest] Digest sent to #${mapping.slack_channel_name || mapping.slack_channel_id}`);
    } catch (err) {
      const msg = `channel ${mapping.slack_channel_id}: ${err.message}`;
      console.error(`[slack/channel-digest] Error — ${msg}`);
      errors.push(msg);
    }
  }

  console.log(`[slack/channel-digest] Done: sent=${sent} skipped=${skipped} errors=${errors.length}`);
  return { sent, skipped, errors };
}
