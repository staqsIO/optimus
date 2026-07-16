/**
 * Guardrail bootstrap — auto-seed push/pull LLM guardrails on first run.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      (§FR-25, §3.2)
 *
 * Contract:
 *   bootstrapGuardrails({ query, linearClient, teamId, force? })
 *     → { pushCreated, pullCreated, mapping }
 *
 * Semantics:
 *   - Push: seed if no current OR force=true. Re-bootstrap follows
 *     saveGuardrail's flip-then-insert pattern (prior current →
 *     is_current=false; insert new revision = max+1).
 *   - Pull: seed if no current. force NEVER re-bootstraps pull (no
 *     state mapping to detect — empty by definition).
 *   - Linear client is invoked ONLY when push needs seeding. On idempotent
 *     re-run with both kinds current, the client is never called.
 *   - On Linear API error the function throws and NO rows are inserted —
 *     pull insertion is gated behind successful push fetch.
 *
 * P2 — query is injected (no module-level db import). Parameterised SQL.
 * P3 — append-only: prior revisions' content fields are never modified.
 */

import { refreshCache, bootstrapDefaultMapping } from './team-cache.js';

const SEED_PROMPT_TEXT = '';
const SEED_CREATED_BY = 'system-bootstrap';
const SEED_NOTE = 'Auto-detected via FR-25';

/**
 * @param {Object}   opts
 * @param {Function} opts.query        — pg-style query fn
 * @param {Function} opts.linearClient — async (gqlQuery, vars) => data
 * @param {string}   opts.teamId       — Linear team UUID
 * @param {boolean}  [opts.force]      — force push re-bootstrap (NOT pull)
 * @returns {Promise<{pushCreated:boolean, pullCreated:boolean, mapping:Object}>}
 */
export async function bootstrapGuardrails({ query, linearClient, teamId, force = false }) {
  if (typeof query !== 'function') {
    throw new Error('bootstrapGuardrails requires { query } function');
  }
  if (typeof linearClient !== 'function') {
    throw new Error('bootstrapGuardrails requires { linearClient } function');
  }
  if (!teamId) {
    throw new Error('bootstrapGuardrails requires { teamId }');
  }

  // 1. Inspect existing current rows for both kinds.
  const existing = await query(
    `SELECT kind, id, mapping
       FROM inbox.llm_guardrails
      WHERE is_current = true AND kind IN ('push','pull')`,
  );

  let currentPush = null;
  let currentPull = null;
  for (const row of existing.rows) {
    if (row.kind === 'push') currentPush = row;
    else if (row.kind === 'pull') currentPull = row;
  }

  const pushNeeded = !currentPush || force === true;
  const pullNeeded = !currentPull; // force never triggers pull re-bootstrap

  // 2. Full idempotent short-circuit — never call linearClient.
  if (!pushNeeded && !pullNeeded) {
    return {
      pushCreated: false,
      pullCreated: false,
      mapping: parseMapping(currentPush.mapping),
    };
  }

  // 3. Push branch: fetch from Linear, compute mapping, insert (with optional flip).
  let mapping;
  let pushCreated = false;

  if (pushNeeded) {
    // refreshCache throws on Linear API error BEFORE any DB write of guardrails.
    // The cache UPSERT is a separate write — but no guardrail rows are touched
    // until the client call returns successfully.
    const cache = await refreshCache({ teamId, client: linearClient, query });
    const result = bootstrapDefaultMapping(cache.workflow_states);
    mapping = result.mapping;
    const mappingJson = JSON.stringify(mapping);

    // Concurrency: the force-rebootstrap path is flip → SELECT MAX → INSERT,
    // which races with itself under concurrent force=true calls. Wrap the
    // whole sequence in a transaction so two callers cannot interleave their
    // SELECT-MAX between each other's UPDATE/INSERT and produce duplicate
    // revisions. The schema-level partial unique index
    // (llm_guardrails_current_per_kind, migration 120) is the backstop;
    // the transaction is the primary correctness mechanism.
    //
    // The module is fully DI'd (no db.js import), so we use raw BEGIN/COMMIT
    // through the injected query function rather than withTransaction.
    // This matches the existing PGlite transaction pattern in lib/db.js.
    await query('BEGIN');
    try {
      if (force === true && currentPush) {
        // Flip prior current → false, insert revision = max + 1.
        await query(
          `UPDATE inbox.llm_guardrails
              SET is_current = false
            WHERE kind = 'push' AND is_current = true`,
        );
        const maxRev = await query(
          `SELECT COALESCE(MAX(revision), 0) AS max_rev
             FROM inbox.llm_guardrails
            WHERE kind = 'push'`,
        );
        const revision = Number(maxRev.rows[0]?.max_rev || 0) + 1;
        await query(
          `INSERT INTO inbox.llm_guardrails
              (kind, prompt_text, mapping, revision, created_by, is_current, note)
            VALUES ('push', $1, $2::jsonb, $3, $4, true, $5)`,
          [SEED_PROMPT_TEXT, mappingJson, revision, SEED_CREATED_BY, SEED_NOTE],
        );
      } else {
        // First seed: revision 1. Single INSERT, but kept inside the same
        // transaction for symmetry and so the partial unique index aborts
        // the txn cleanly under a concurrent first-seed race.
        await query(
          `INSERT INTO inbox.llm_guardrails
              (kind, prompt_text, mapping, revision, created_by, is_current, note)
            VALUES ('push', $1, $2::jsonb, 1, $3, true, $4)`,
          [SEED_PROMPT_TEXT, mappingJson, SEED_CREATED_BY, SEED_NOTE],
        );
      }
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
    pushCreated = true;
  } else {
    // Push not needed — echo existing mapping for the caller.
    mapping = parseMapping(currentPush.mapping);
  }

  // 4. Pull branch: seed empty mapping at revision 1 if absent.
  let pullCreated = false;
  if (pullNeeded) {
    await query(
      `INSERT INTO inbox.llm_guardrails
          (kind, prompt_text, mapping, revision, created_by, is_current, note)
        VALUES ('pull', $1, $2::jsonb, 1, $3, true, $4)`,
      [SEED_PROMPT_TEXT, JSON.stringify({}), SEED_CREATED_BY, SEED_NOTE],
    );
    pullCreated = true;
  }

  return { pushCreated, pullCreated, mapping };
}

function parseMapping(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return value;
}
