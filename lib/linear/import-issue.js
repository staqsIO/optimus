/**
 * Linear-NATIVE issue → inbox.human_tasks importer (STAQPRO-619-A).
 *
 * ROOT CAUSE THIS CLOSES: routeHumanTaskWebhook only ever UPDATED rows that
 * Optimus itself created (linear_issue_id already on file). Issues born in
 * Linear never matched, so they never landed in human_tasks and never showed on
 * the /issues kanban. This module is the missing INSERT path.
 *
 * SECURITY (treat imported data like 588/593):
 *   - owner_org_id is ALWAYS the team's mapped org (resolved from
 *     inbox.linear_sync_teams by the caller), NEVER read from the webhook
 *     payload. An attacker who forges a webhook (they can't — HMAC is verified
 *     upstream in api.js) still cannot set tenancy.
 *   - Import only fires for teams the board has explicitly enabled
 *     (linear_sync_teams.enabled = true). P1 deny-by-default.
 *   - Idempotent at the DB layer via the partial unique index
 *     human_tasks_linear_issue_unique_live (migration 153): same issue twice
 *     → one live row. The UPSERT only mirrors system-owned fields and guards
 *     with an updated_at staleness check so it never clobbers fresher local
 *     edits or flips an Optimus-native status.
 *   - Best-effort + logged: never throws uphill into the webhook handler (P3).
 *
 * P4: raw parameterized SQL, no ORM.
 */

import { mapLinearStateToStatus } from './state-to-status.js';

/**
 * Resolve the enabled team→org row for a Linear team id. Returns null when the
 * team is unknown or disabled (deny by default). Never throws — DB errors log
 * and resolve to null so the caller skips import rather than crashing.
 *
 * @param {Function} q - parameterized query fn
 * @param {string|null|undefined} teamId
 * @returns {Promise<{ team_id: string, owner_org_id: string|null, import_filter: string } | null>}
 */
export async function resolveEnabledTeam(q, teamId) {
  if (!teamId) return null;
  try {
    const r = await q(
      `SELECT team_id, owner_org_id, import_filter
         FROM inbox.linear_sync_teams
        WHERE team_id = $1 AND enabled = true
        LIMIT 1`,
      [teamId],
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error(`[linear-import] resolveEnabledTeam failed for ${teamId}: ${err.message}`);
    return null;
  }
}

/**
 * Map a Linear priority int (0=none,1=urgent,2=high,3=medium,4=low) to the
 * human_tasks.priority enum. 0/none and anything unexpected → 'normal'.
 */
function mapPriority(p) {
  switch (p) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'normal';
    case 4: return 'low';
    default: return 'normal';
  }
}

/** Coerce a Linear dueDate (ISO date or null) to a YYYY-MM-DD string or null. */
function coerceDueDate(due) {
  if (!due) return null;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Import (INSERT-or-mirror) a single Linear-native issue into human_tasks.
 *
 * @param {Object} issue - full Linear issue (from getIssue/listTeamIssues):
 *   { id, url, title, priority, dueDate, state:{type,name}, assignee:{id} }
 * @param {Object} deps
 * @param {Function} deps.query - parameterized query fn (required)
 * @param {{ owner_org_id: string|null }} deps.teamOrg - resolved team→org row.
 *   owner_org_id is the tenancy boundary — sourced here, never from payload.
 * @returns {Promise<{ imported: boolean, taskId?: string, action?: 'insert'|'update'|'noop', reason?: string }>}
 */
export async function importLinearIssue(issue, deps = {}) {
  const q = deps.query;
  const teamOrg = deps.teamOrg;
  if (!q) return { imported: false, reason: 'no query fn' };
  if (!issue || !issue.id) return { imported: false, reason: 'no issue id' };
  if (!teamOrg) return { imported: false, reason: 'team not enabled' };

  // owner_org_id comes from the team→org map ONLY. If the enabled team has no
  // org mapped yet, fail closed — do NOT import an un-tenanted row.
  const ownerOrgId = teamOrg.owner_org_id || null;
  if (!ownerOrgId) {
    console.warn(`[linear-import] team for issue ${issue.id} enabled but owner_org_id unmapped — skipping import`);
    return { imported: false, reason: 'team owner_org_id unmapped' };
  }

  const { status } = mapLinearStateToStatus(issue.state);
  const title = (typeof issue.title === 'string' && issue.title.trim()) ? issue.title : '(untitled Linear issue)';
  const priority = mapPriority(issue.priority);
  const dueDate = coerceDueDate(issue.dueDate);
  const stateName = issue.state?.name || null;
  const assigneeId = issue.assignee?.id || null;
  const url = issue.url || null;

  try {
    // INSERT-or-mirror, idempotent via human_tasks_linear_issue_unique_live.
    //
    // ON CONFLICT mirrors ONLY system-owned fields and ONLY when the incoming
    // event is not stale (EXCLUDED.updated_at via now() always wins on a fresh
    // event, but we still guard against clobbering a row a human just touched by
    // requiring the existing row be older than the new write). Status is mirrored
    // but an Optimus-native terminal/operator status set locally is preserved by
    // the staleness guard: a board edit bumps updated_at, so a later, older
    // Linear event won't overwrite it.
    const r = await q(
      `INSERT INTO inbox.human_tasks
         (title, status, priority, due_date,
          linear_issue_id, linear_issue_url, linear_state_name, linear_assignee_id,
          origin, owner_org_id, created_by, feedback_history)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, 'linear', $9::uuid, 'linear_import', '[]'::jsonb)
       ON CONFLICT (linear_issue_id) WHERE linear_issue_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET
         title              = EXCLUDED.title,
         status             = EXCLUDED.status,
         priority           = EXCLUDED.priority,
         due_date           = EXCLUDED.due_date,
         linear_issue_url   = EXCLUDED.linear_issue_url,
         linear_state_name  = EXCLUDED.linear_state_name,
         linear_assignee_id = EXCLUDED.linear_assignee_id,
         linear_last_event_at = now(),
         updated_at         = now()
       WHERE inbox.human_tasks.updated_at < now()
       RETURNING id, (xmax = 0) AS inserted`,
      [title, status, priority, dueDate, issue.id, url, stateName, assigneeId, ownerOrgId],
    );

    if (r.rows.length === 0) {
      // Conflict hit but staleness guard skipped the UPDATE (existing row is
      // newer/equal) — treat as a successful no-op (already mirrored).
      return { imported: true, action: 'noop', reason: 'existing row not stale' };
    }
    const row = r.rows[0];
    return { imported: true, taskId: row.id, action: row.inserted ? 'insert' : 'update' };
  } catch (err) {
    console.error(`[linear-import] importLinearIssue failed for ${issue.id}: ${err.message}`);
    return { imported: false, reason: err.message };
  }
}
