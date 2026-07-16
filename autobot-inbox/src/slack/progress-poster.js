/**
 * slack/progress-poster.js — Post per-project progress updates to the mapped Slack channel.
 *
 * OPT-46. Given a project/engagement + a "what moved" payload, finds the mapped
 * Slack channel(s) via slack/project-mapping.js and posts to them using the
 * existing slack/client.js sendMessage.
 *
 * GATING: Only runs when SLACK_BOT_TOKEN is set AND SLACK_PROJECT_DIGEST_ENABLED=true.
 * Default is OFF (no env var = no Slack sends) to prevent spamming a live workspace
 * before the integration is fully configured. This mirrors the SLACK_DIGEST_CHANNEL
 * gate already in use for the board daily-digest.
 *
 * The caller is responsible for formatting the payload text. This module is purely
 * the delivery layer.
 */

import { getMappingsForEntity } from './project-mapping.js';

/**
 * Check whether per-project Slack posting is enabled.
 * Both SLACK_BOT_TOKEN and SLACK_PROJECT_DIGEST_ENABLED=true must be set.
 * @returns {boolean}
 */
export function isProjectDigestEnabled() {
  return !!(
    (process.env.SLACK_BOT_TOKEN || '').trim() &&
    (process.env.SLACK_PROJECT_DIGEST_ENABLED || '').trim().toLowerCase() === 'true'
  );
}

/**
 * Format a "what moved" payload into a Slack message.
 *
 * @param {object} opts
 * @param {string} opts.entityType     - 'project' or 'engagement'
 * @param {string} opts.entityName     - display name
 * @param {string[]} [opts.moved]      - list of items that moved (e.g. task titles)
 * @param {string[]} [opts.completed]  - list of items completed
 * @param {string[]} [opts.blocked]    - list of blocked items
 * @param {string} [opts.summary]      - optional free-text summary
 * @param {string} [opts.reviewUrl]    - link to board view
 * @returns {string}
 */
export function formatProgressMessage({ entityType, entityName, moved = [], completed = [], blocked = [], summary, reviewUrl }) {
  const lines = [];
  const label = entityType === 'engagement' ? 'Engagement' : 'Project';
  lines.push(`*${label}: ${entityName}* — progress update`);

  if (summary) {
    lines.push('');
    lines.push(summary);
  }

  if (completed.length > 0) {
    lines.push('');
    lines.push('*Completed:*');
    completed.forEach(item => lines.push(`  ✓ ${item}`));
  }

  if (moved.length > 0) {
    lines.push('');
    lines.push('*Moved:*');
    moved.forEach(item => lines.push(`  → ${item}`));
  }

  if (blocked.length > 0) {
    lines.push('');
    lines.push('*Blocked:*');
    blocked.forEach(item => lines.push(`  ⚠ ${item}`));
  }

  if (reviewUrl) {
    lines.push('');
    lines.push(`Review: ${reviewUrl}`);
  }

  return lines.join('\n');
}

/**
 * Post a progress update to all Slack channels mapped to a given entity.
 *
 * @param {object} opts
 * @param {'project'|'engagement'} opts.entityType
 * @param {string} opts.entityId       - agent_graph.projects.id or engagements.engagements.id
 * @param {string} opts.entityName     - display name for the entity
 * @param {string} opts.text           - pre-formatted message text (use formatProgressMessage)
 * @returns {Promise<{posted: number, skipped: number, errors: string[]}>}
 */
export async function postProjectProgress({ entityType, entityId, _entityName, text }) {
  if (!isProjectDigestEnabled()) {
    console.log('[slack/progress-poster] Skipped: SLACK_PROJECT_DIGEST_ENABLED not true or SLACK_BOT_TOKEN not set');
    return { posted: 0, skipped: 1, errors: [] };
  }

  const mappings = await getMappingsForEntity({ entityType, entityId });
  if (mappings.length === 0) {
    console.log(`[slack/progress-poster] No Slack channels mapped to ${entityType}:${entityId}`);
    return { posted: 0, skipped: 0, errors: [] };
  }

  // Dynamic import: only load @slack/bolt if Slack is configured.
  const { initSlackApp, sendMessage } = await import('./client.js');
  await initSlackApp();

  const errors = [];
  let posted = 0;

  for (const mapping of mappings) {
    try {
      await sendMessage(mapping.slack_channel_id, text);
      posted++;
      console.log(`[slack/progress-poster] Posted to ${mapping.slack_channel_id} (${mapping.slack_channel_name || mapping.slack_channel_id}) for ${entityType}:${entityId}`);
    } catch (err) {
      const msg = `Failed to post to ${mapping.slack_channel_id}: ${err.message}`;
      console.error(`[slack/progress-poster] ${msg}`);
      errors.push(msg);
    }
  }

  return { posted, skipped: 0, errors };
}
