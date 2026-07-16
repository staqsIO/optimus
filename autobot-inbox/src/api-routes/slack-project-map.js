/**
 * api-routes/slack-project-map.js — Slack channel ↔ project/engagement mapping API.
 *
 * OPT-46. Board-managed per-org registry. Routes:
 *   POST   /api/slack/project-map            — link a channel to an entity
 *   GET    /api/slack/project-map            — list mappings for the caller's org
 *   DELETE /api/slack/project-map/:channelId — unlink a channel
 *
 * All classified 'org-shared' (identity=authed-any, scope=org) in route-tiers.js.
 * POST/DELETE additionally require requireBoardHuman (same pattern as capture-sources).
 * org_id is ALWAYS derived from the authenticated principal — never the request body.
 */

import { query } from '../db.js';
import { resolvePrincipal } from '../../../lib/tenancy/scope.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { linkChannel, unlinkChannel, listMappings } from '../slack/project-mapping.js';

const VALID_ENTITY_TYPES = new Set(['project', 'engagement']);

function httpError(msg, status = 400) {
  const err = new Error(msg);
  err.statusCode = status;
  return err;
}

function requireBoardHuman(req) {
  const auth = req.auth;
  if (!auth) throw httpError('Authentication required', 401);
  if (auth.source === 'agent_jwt') throw httpError('Board human required — agent JWT not permitted', 403);
  if (auth.source === 'api_secret') throw httpError('Board human required — bare API secret not permitted', 403);
}

async function resolvePrincipalFor(req) {
  try {
    return await resolvePrincipal(req);
  } catch {
    return null;
  }
}

/**
 * Validate that the referenced entity exists in the DB.
 * No cross-schema FKs (SPEC §12) — we validate in the handler.
 */
async function validateEntityExists(entityType, entityId) {
  if (entityType === 'project') {
    // tenancy:allow-unscoped — id-only existence probe (returns id or 404, leaks
    // no tenant content). Org-ownership enforcement on channel↔project linking is
    // a follow-up; the route is org-shared tier and the map row is owner-stamped.
    const r = await query(
      `SELECT id FROM agent_graph.projects WHERE id = $1 LIMIT 1`,
      [entityId],
    );
    if (r.rows.length === 0) throw httpError(`Project not found: ${entityId}`, 404);
  } else if (entityType === 'engagement') {
    const r = await query(
      `SELECT id FROM engagements.engagements WHERE id = $1::uuid LIMIT 1`,
      [entityId],
    );
    if (r.rows.length === 0) throw httpError(`Engagement not found: ${entityId}`, 404);
  }
}

/**
 * @param {Map} routes
 * @param {{ query: Function }} deps
 */
export function registerSlackProjectMapRoutes(routes, _deps) {
  // POST /api/slack/project-map — link a Slack channel to a project/engagement.
  // Board human only; org_id derived from principal.
  routes.set('POST /api/slack/project-map', async (req, body) => {
    requireBoardHuman(req);
    const principal = await resolvePrincipalFor(req);
    const orgId = writerOrgId(principal);
    if (!orgId) throw httpError('Cannot determine org from your credentials', 400);

    const payload = body && typeof body === 'object' ? body : {};
    const { slack_channel_id, slack_channel_name, entity_type, entity_id } = payload;

    if (!slack_channel_id || typeof slack_channel_id !== 'string') {
      throw httpError('slack_channel_id is required', 400);
    }
    if (!entity_type || !VALID_ENTITY_TYPES.has(entity_type)) {
      throw httpError(`entity_type must be 'project' or 'engagement'`, 400);
    }
    if (!entity_id || typeof entity_id !== 'string') {
      throw httpError('entity_id is required', 400);
    }

    // Validate entity exists before linking (handler-level FK substitute, SPEC §12)
    await validateEntityExists(entity_type, entity_id);

    const createdBy = req.auth?.sub || req.auth?.handle || null;
    const mapping = await linkChannel({
      orgId,
      slackChannelId: slack_channel_id.trim(),
      slackChannelName: slack_channel_name || null,
      entityType: entity_type,
      entityId: entity_id.trim(),
      createdBy,
    });

    return { ok: true, mapping };
  });

  // GET /api/slack/project-map — list mappings for the caller's org.
  // Optionally filter by ?entity_type=project&entity_id=<id>
  routes.set('GET /api/slack/project-map', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const orgId = writerOrgId(principal);
    if (!orgId) throw httpError('Cannot determine org from your credentials', 400);

    const url = new URL(req.url, 'http://localhost');
    const entityType = url.searchParams.get('entity_type') || undefined;
    const entityId = url.searchParams.get('entity_id') || undefined;

    if (entityType && !VALID_ENTITY_TYPES.has(entityType)) {
      throw httpError(`entity_type must be 'project' or 'engagement'`, 400);
    }

    const mappings = await listMappings({ orgId, entityType, entityId });
    return { ok: true, mappings };
  });

  // DELETE /api/slack/project-map/:channelId — unlink a channel.
  // Board human only; org_id derived from principal (tenant-scoped delete).
  routes.set('DELETE /api/slack/project-map/:channelId', async (req) => {
    requireBoardHuman(req);
    const principal = await resolvePrincipalFor(req);
    const orgId = writerOrgId(principal);
    if (!orgId) throw httpError('Cannot determine org from your credentials', 400);

    const url = new URL(req.url, 'http://localhost');
    const channelId = url.pathname.split('/').filter(Boolean).pop();
    if (!channelId) throw httpError('channelId required', 400);

    const deleted = await unlinkChannel({ orgId, slackChannelId: channelId });
    if (!deleted) throw httpError(`No mapping found for channel ${channelId} in your org`, 404);

    return { ok: true, deleted: true };
  });
}
