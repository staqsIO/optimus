/**
 * Linear team-metadata cache.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      (§1 FR-24..FR-26, §2 NFR-11, §6 AD-7, AD-8)
 *
 * Owns the inbox.linear_team_cache snapshot: one row per Linear team holding
 * workflow_states, projects, members, and labels as JSONB. Per-task sync
 * passes consult this cache instead of hitting the Linear GraphQL API on
 * every call (NFR-11: 60-min freshness budget).
 *
 * Design:
 *   - `loadCache` is pure DB read — no network.
 *   - `refreshCache` fires ONE GraphQL query (states + projects + members
 *     + labels in a single round-trip) then UPSERTs. Atomic on failure:
 *     a GraphQL error throws BEFORE any DB write, so the prior cache row
 *     survives. (AD-7)
 *   - `bootstrapDefaultMapping` is a pure helper that proposes a default
 *     Linear-state → human_tasks.status map from Linear's normalised
 *     `state.type`. Unknown types fall back to `inbox` and surface in a
 *     warnings array for operator review. (FR-25)
 *   - `startCacheRefresher` runs refreshCache on an interval; on stop()
 *     halts cleanly and lets at most one in-flight call settle. (AD-8)
 *
 * P2 — Client is injectable; no Linear SDK import here. The runtime wiring
 * decides which client to inject (real fetch wrapper, mock, recorded).
 * P4 — Parameterised SQL, ES modules, no new deps.
 */

import { createLogger } from '../logger.js';

const log = createLogger('linear/team-cache');

// ---------------------------------------------------------------------------
// GraphQL query — one round trip covers all four metadata sections (AD-7).
// ---------------------------------------------------------------------------

const TEAM_CACHE_QUERY = `
  query TeamCache($teamId: String!) {
    team(id: $teamId) {
      id
      states {
        nodes { id name type position }
      }
      projects {
        nodes { id name state }
      }
      members {
        nodes { id name email displayName }
      }
      labels {
        nodes { id name color }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Linear normalised state.type → human_tasks.status (FR-25)
// ---------------------------------------------------------------------------

const STATE_TYPE_TO_STATUS = {
  backlog:   'inbox',
  unstarted: 'todo',
  started:   'in_progress',
  completed: 'done',
  canceled:  'not_for_us',
};

// ---------------------------------------------------------------------------
// loadCache — pure DB read
// ---------------------------------------------------------------------------

/**
 * Read the cached Linear metadata for a team. No network calls.
 *
 * @param {Object}   opts
 * @param {string}   opts.teamId — Linear team UUID
 * @param {Function} opts.query  — pg-style query fn (required)
 * @returns {Promise<Object|null>} snapshot row with JSONB fields parsed, or null.
 */
export async function loadCache({ teamId, query }) {
  if (!teamId) throw new Error('loadCache requires { teamId }');
  if (typeof query !== 'function') {
    throw new Error('loadCache requires { query } function');
  }

  const result = await query(
    `SELECT team_id, workflow_states, projects, members, labels, refreshed_at
       FROM inbox.linear_team_cache
      WHERE team_id = $1`,
    [teamId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    team_id: row.team_id,
    workflow_states: parseJsonb(row.workflow_states),
    projects:        parseJsonb(row.projects),
    members:         parseJsonb(row.members),
    labels:          parseJsonb(row.labels),
    refreshed_at:    row.refreshed_at,
  };
}

// ---------------------------------------------------------------------------
// refreshCache — GraphQL → DB UPSERT
// ---------------------------------------------------------------------------

/**
 * Fetch fresh Linear team metadata via the injected client and UPSERT into
 * inbox.linear_team_cache. Atomic on failure — a GraphQL error throws
 * BEFORE the DB write, so the prior cache row is untouched.
 *
 * @param {Object}   opts
 * @param {string}   opts.teamId — Linear team UUID
 * @param {Function} opts.client — async (query, variables) => data
 * @param {Function} opts.query  — pg-style query fn (required)
 * @returns {Promise<Object>} the new cache snapshot row (post-write)
 */
export async function refreshCache({ teamId, client, query }) {
  if (!teamId) throw new Error('refreshCache requires { teamId }');
  if (typeof client !== 'function') {
    throw new Error('refreshCache requires { client } function');
  }
  if (typeof query !== 'function') {
    throw new Error('refreshCache requires { query } function');
  }

  // 1. Fetch fresh metadata. If this throws, we abort BEFORE touching the
  //    DB — the prior cache row survives intact (AD-7 atomicity contract).
  const data = await client(TEAM_CACHE_QUERY, { teamId });

  const team = data?.team;
  if (!team) {
    const err = new Error(
      `Linear refresh failed: team(${teamId}) returned no payload`,
    );
    err.code = 'LINEAR_REFRESH_EMPTY';
    throw err;
  }

  const workflowStates = team.states?.nodes ?? [];
  const projects       = team.projects?.nodes ?? [];
  const members        = team.members?.nodes ?? [];
  const labels         = team.labels?.nodes ?? [];

  // 2. UPSERT. PRIMARY KEY (team_id) → ON CONFLICT DO UPDATE bumps the
  //    snapshot + refreshed_at, never duplicates.
  await query(
    `INSERT INTO inbox.linear_team_cache
        (team_id, workflow_states, projects, members, labels, refreshed_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())
      ON CONFLICT (team_id) DO UPDATE
        SET workflow_states = EXCLUDED.workflow_states,
            projects        = EXCLUDED.projects,
            members         = EXCLUDED.members,
            labels          = EXCLUDED.labels,
            refreshed_at    = now()`,
    [
      teamId,
      JSON.stringify(workflowStates),
      JSON.stringify(projects),
      JSON.stringify(members),
      JSON.stringify(labels),
    ],
  );

  // 3. Read-back so callers receive the post-write snapshot (incl. server-
  //    side refreshed_at). One extra round-trip — cheap and worth the
  //    confidence that we never return a payload that diverges from disk.
  return loadCache({ teamId, query });
}

// ---------------------------------------------------------------------------
// bootstrapDefaultMapping — pure
// ---------------------------------------------------------------------------

/**
 * Propose a default Linear-state → human_tasks.status mapping from the
 * normalised `state.type` field. Unknown types (custom workflow categories
 * Linear hasn't normalised) fall back to `inbox` and surface in warnings.
 *
 * @param {Array<{id: string, type?: string|null}>} workflowStates
 * @returns {{ mapping: Record<string,string>, warnings: string[] }}
 */
export function bootstrapDefaultMapping(workflowStates) {
  const mapping = {};
  const warnings = [];

  if (!Array.isArray(workflowStates)) {
    return { mapping, warnings };
  }

  for (const state of workflowStates) {
    if (!state || typeof state.id !== 'string') continue;
    const type = state.type;
    const status = type && Object.prototype.hasOwnProperty.call(STATE_TYPE_TO_STATUS, type)
      ? STATE_TYPE_TO_STATUS[type]
      : null;

    if (status === null) {
      mapping[state.id] = 'inbox';
      warnings.push(state.id);
    } else {
      mapping[state.id] = status;
    }
  }

  return { mapping, warnings };
}

// ---------------------------------------------------------------------------
// startCacheRefresher — interval-driven refresh loop
// ---------------------------------------------------------------------------

/**
 * Run refreshCache every `intervalMs`. Errors are logged and swallowed so
 * a single transient failure never breaks the loop — the next interval
 * still fires (AD-8). stop() halts further refreshes and lets at most one
 * in-flight call settle.
 *
 * @param {Object}   opts
 * @param {string}   opts.teamId
 * @param {number}   opts.intervalMs
 * @param {Function} opts.client
 * @param {Function} opts.query
 * @returns {{ stop: () => Promise<void> }}
 */
export function startCacheRefresher({ teamId, intervalMs, client, query }) {
  if (!teamId) throw new Error('startCacheRefresher requires { teamId }');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('startCacheRefresher requires positive intervalMs');
  }
  if (typeof client !== 'function') {
    throw new Error('startCacheRefresher requires { client } function');
  }
  if (typeof query !== 'function') {
    throw new Error('startCacheRefresher requires { query } function');
  }

  let stopped = false;
  let inFlight = null;
  let timer = null;

  async function tick() {
    if (stopped) return;
    if (inFlight) return; // coalesce — never overlap refreshes
    inFlight = refreshCache({ teamId, client, query })
      .catch((err) => {
        // Log and continue — a transient failure must not kill the loop.
        log.error(
          `linear team-cache refresh failed for team ${teamId}: ${err.message}`,
        );
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  // Fire-and-forget the initial tick so the cache populates without
  // waiting a full interval. Errors inside tick() are already handled.
  tick();

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Let at most one in-flight call settle before returning, so callers
    // observe a quiescent state.
    if (inFlight) {
      try { await inFlight; } catch { /* already logged inside tick() */ }
    }
  }

  return { stop };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseJsonb(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  // Already an object/array from a driver that decodes JSONB natively.
  return value;
}
