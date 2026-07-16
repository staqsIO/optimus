/**
 * slack/project-mapping.js — CRUD for the slack_channel ↔ project/engagement join table.
 *
 * OPT-46. Org-scoped: every read/write is gated on org_id derived from the
 * caller's principal (writerOrgId / visibleClause pattern) — never from an
 * untrusted request body. No cross-schema FKs (SPEC §12); entity existence is
 * validated in the handler before insert.
 *
 * The Slack send path is intentionally kept separate (slack/sender.js) so this
 * module is purely a data layer — easy to unit-test without a Slack app instance.
 */

import { query } from '../db.js';

/**
 * Link a Slack channel to a project or engagement.
 *
 * @param {object} opts
 * @param {string} opts.orgId            - tenancy.orgs.id (UUID); must come from validated principal
 * @param {string} opts.slackChannelId   - Slack channel ID (e.g. C01ABC123)
 * @param {string} [opts.slackChannelName] - display label (best-effort)
 * @param {'project'|'engagement'} opts.entityType
 * @param {string} opts.entityId         - agent_graph.projects.id or engagements.engagements.id
 * @param {string} [opts.createdBy]      - board member handle or agent id
 * @returns {Promise<object>} The inserted/updated row
 */
export async function linkChannel({ orgId, slackChannelId, slackChannelName, entityType, entityId, createdBy }) {
  if (!orgId) throw new Error('linkChannel: orgId required');
  if (!slackChannelId) throw new Error('linkChannel: slackChannelId required');
  if (!['project', 'engagement'].includes(entityType)) {
    throw new Error(`linkChannel: entityType must be 'project' or 'engagement', got: ${entityType}`);
  }
  if (!entityId) throw new Error('linkChannel: entityId required');

  // Upsert: if a mapping for this (org, channel) already exists, update it.
  const result = await query(
    `INSERT INTO inbox.slack_project_map
       (org_id, slack_channel_id, slack_channel_name, entity_type, entity_id, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, slack_channel_id)
     DO UPDATE SET
       slack_channel_name = EXCLUDED.slack_channel_name,
       entity_type        = EXCLUDED.entity_type,
       entity_id          = EXCLUDED.entity_id,
       updated_at         = now()
     RETURNING *`,
    [orgId, slackChannelId, slackChannelName || null, entityType, entityId, createdBy || null],
  );
  return result.rows[0];
}

/**
 * Remove a Slack channel ↔ entity mapping.
 *
 * @param {object} opts
 * @param {string} opts.orgId          - must match the row's org_id (tenant gate)
 * @param {string} opts.slackChannelId
 * @returns {Promise<boolean>} true if a row was deleted
 */
export async function unlinkChannel({ orgId, slackChannelId }) {
  if (!orgId) throw new Error('unlinkChannel: orgId required');
  if (!slackChannelId) throw new Error('unlinkChannel: slackChannelId required');

  const result = await query(
    `DELETE FROM inbox.slack_project_map
      WHERE org_id = $1::uuid AND slack_channel_id = $2
      RETURNING id`,
    [orgId, slackChannelId],
  );
  return result.rows.length > 0;
}

/**
 * List all channel mappings for an org (or filter by entity).
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} [opts.entityType]  - filter to 'project' or 'engagement'
 * @param {string} [opts.entityId]    - filter to a specific entity
 * @returns {Promise<object[]>}
 */
export async function listMappings({ orgId, entityType, entityId }) {
  if (!orgId) throw new Error('listMappings: orgId required');

  const params = [orgId];
  const conditions = ['org_id = $1::uuid'];

  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    conditions.push(`entity_id = $${params.length}`);
  }

  const result = await query(
    `SELECT id, org_id, slack_channel_id, slack_channel_name, entity_type, entity_id,
            created_by, created_at, updated_at
       FROM inbox.slack_project_map
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC`,
    params,
  );
  return result.rows;
}

/**
 * Get the mapping for a specific Slack channel in an org.
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.slackChannelId
 * @returns {Promise<object|null>}
 */
export async function getMappingForChannel({ orgId, slackChannelId }) {
  if (!orgId) throw new Error('getMappingForChannel: orgId required');
  if (!slackChannelId) throw new Error('getMappingForChannel: slackChannelId required');

  const result = await query(
    `SELECT id, org_id, slack_channel_id, slack_channel_name, entity_type, entity_id,
            created_by, created_at, updated_at
       FROM inbox.slack_project_map
      WHERE org_id = $1::uuid AND slack_channel_id = $2`,
    [orgId, slackChannelId],
  );
  return result.rows[0] || null;
}

/**
 * Get all channel mappings for a specific entity (project or engagement).
 * Used by the progress poster to find where to post.
 *
 * @param {object} opts
 * @param {'project'|'engagement'} opts.entityType
 * @param {string} opts.entityId
 * @returns {Promise<object[]>}
 */
export async function getMappingsForEntity({ entityType, entityId }) {
  if (!entityType || !entityId) throw new Error('getMappingsForEntity: entityType and entityId required');

  const result = await query(
    `SELECT id, org_id, slack_channel_id, slack_channel_name, entity_type, entity_id,
            created_by, created_at, updated_at
       FROM inbox.slack_project_map
      WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId],
  );
  return result.rows;
}
