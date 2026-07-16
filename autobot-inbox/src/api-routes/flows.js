import { query, withBoardScope, withAgentScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { FlowEngine } from '../../../lib/runtime/flow-engine.js';
import { FlowToolRegistry } from '../../../lib/runtime/tool-registry.js';
import { tools as toolRegistry } from '../../tools/registry.js';
import { attachFlowWrappers } from '../flow-wrappers/index.js';

// ---------------------------------------------------------------------------
// Signal type catalog — hardcoded known types + DB-discovered types
// ---------------------------------------------------------------------------

const KNOWN_SIGNALS = [
  { signal_type: 'email.received',      source_adapter: 'gmail',    label: 'When a new email arrives',         category: 'Input',    description: 'Triggered when a new email is received via Gmail',
    payload_schema: { provider_msg_id: 'string', from: 'string', subject: 'string', snippet: 'string' } },
  { signal_type: 'email.classified',    source_adapter: 'internal', label: 'When an email is classified',      category: 'Internal', description: 'Triggered after intake classifies an email',
    payload_schema: { email_id: 'string', provider_msg_id: 'string', classification: 'string', priority: 'string', from: 'string', subject: 'string' } },
  { signal_type: 'slack.message',       source_adapter: 'slack',    label: 'When a Slack message arrives',     category: 'Input',    description: 'Triggered when a new message is posted in a watched Slack channel',
    payload_schema: { channel: 'string', user: 'string', text: 'string', thread_ts: 'string' } },
  { signal_type: 'webhook.payload',     source_adapter: 'webhook',  label: 'When a webhook fires',             category: 'Input',    description: 'Triggered when an external webhook payload is received',
    payload_schema: { source: 'string', event: 'string', data: 'object' } },
  { signal_type: 'telegram.message',    source_adapter: 'telegram', label: 'When a Telegram message arrives',  category: 'Input',    description: 'Triggered when a Telegram bot receives a message',
    payload_schema: { chat_id: 'string', from_user: 'string', text: 'string' } },
  { signal_type: 'campaign.completed',  source_adapter: 'internal', label: 'When a campaign finishes',         category: 'Internal', description: 'Triggered when a multi-step campaign completes all iterations',
    payload_schema: { campaign_id: 'string', iterations: 'number', status: 'string' } },
  { signal_type: 'campaign.step',       source_adapter: 'internal', label: 'When a campaign step completes',   category: 'Internal', description: 'Triggered after each step of a campaign finishes',
    payload_schema: { campaign_id: 'string', step_index: 'number', status: 'string', output: 'object' } },
  { signal_type: 'task.completed',      source_adapter: 'internal', label: 'When a task completes',            category: 'Internal', description: 'Triggered when a work item reaches completed state',
    payload_schema: { work_item_id: 'string', agent_id: 'string', result: 'string' } },
  { signal_type: 'task.failed',         source_adapter: 'internal', label: 'When a task fails',                category: 'Internal', description: 'Triggered when a work item fails after retries',
    payload_schema: { work_item_id: 'string', agent_id: 'string', error: 'string', retries: 'number' } },
  { signal_type: 'draft.approved',      source_adapter: 'internal', label: 'When a draft is approved',         category: 'Internal', description: 'Triggered when an action proposal is approved by the board',
    payload_schema: { draft_id: 'string', approved_by: 'string', action_type: 'string' } },
  { signal_type: 'gate.failed',         source_adapter: 'internal', label: 'When a gate check fails',          category: 'Internal', description: 'Triggered when a constitutional gate rejects an action',
    payload_schema: { gate_id: 'string', draft_id: 'string', reason: 'string', score: 'number' } },
  { signal_type: 'schedule.fired',      source_adapter: 'internal', label: 'When a scheduled trigger fires',   category: 'Internal', description: 'Triggered on a cron schedule',
    payload_schema: { schedule_id: 'string', cron_expression: 'string', fired_at: 'string' } },
  { signal_type: 'meeting.received',     source_adapter: 'transcript_ingester', label: 'When a meeting transcript is ingested', category: 'Input', description: 'Triggered after a meeting transcript (tldv/gemini) finishes ingestion — drives the meeting→work classifier (STAQPRO-612)',
    payload_schema: { document_id: 'string', source_meeting_id: 'string', transcript_source: 'string', title: 'string' } },
];

// ---------------------------------------------------------------------------
// Core functions (testable — accept a `queryFn` parameter)
// ---------------------------------------------------------------------------

/**
 * POST /api/flows — Create a flow definition.
 *
 * SECURITY (STAQPRO-615 M2):
 *   - owner_org_id is stamped from the verified WRITER principal (writerOrgId),
 *     never from the body. A null org (adminBypass / unresolved) omits the column
 *     so the migration-152 DEFAULT (Staqs, single-org-correct today) applies.
 *   - created_by is derived from the principal identity, never from body.created_by
 *     (which the route rejects at 400 before reaching here).
 *   - The DAG cycle check runs in ONE transaction with the insert: existing active
 *     flows + the candidate are validated BEFORE the row commits, so a cycle can
 *     never leave an orphan is_active=true row (the old code inserted first then
 *     deleted on cycle — a crash between the two left the orphan).
 *
 * @param {Function} queryFn  db query (real `query` or a test stub)
 * @param {object} body       { name, trigger_signal_type, steps, description?, max_depth?, timeout_ms?, retry_policy? }
 * @param {object|null} principal  verified writer principal (withViewer → resolvePrincipal)
 */
export async function createFlowCore(queryFn, body, principal) {
  if (!body?.name) return { error: 'name is required' };
  if (!body?.trigger_signal_type) return { error: 'trigger_signal_type is required' };
  if (!body?.steps) return { error: 'steps is required' };

  const ownerOrgId = writerOrgId(principal);
  // Identity is the verified writer, never body.created_by. Prefer the resolved
  // board user id; verified agents (adminBypass, no userId) record 'agent'.
  const createdBy = principal?.userId || (principal?.adminBypass ? 'agent' : 'api');

  // The candidate row as validateFlowDAG sees it (steps is an object/array here;
  // the persisted column is jsonb — same shape once parsed).
  const candidate = {
    trigger_signal_type: body.trigger_signal_type,
    steps: body.steps,
    is_active: true,
  };

  await queryFn('BEGIN');
  try {
    // Validate-then-insert: assemble the would-be active set (existing + candidate)
    // and reject a cycle BEFORE writing, so no orphan row is ever created.
    const { rows: activeFlows } = await queryFn(
      `SELECT * FROM agent_graph.flow_definitions WHERE is_active = true`,
    );
    try {
      FlowEngine.validateFlowDAG([...activeFlows, candidate]);
    } catch (err) {
      await queryFn('ROLLBACK');
      return { error: `Flow creates a cycle: ${err.message}` };
    }

    // Base positional params shared by both INSERT shapes. max_depth/timeout_ms
    // are NOT NULL with a schema DEFAULT (sql/037: 8 / 30000) — coalesce to those
    // defaults rather than sending explicit NULL (which would violate NOT NULL).
    const baseCols = '(name, trigger_signal_type, steps, description, max_depth, timeout_ms, retry_policy, created_by';
    const baseParams = [
      body.name,
      body.trigger_signal_type,
      JSON.stringify(body.steps),
      body.description || null,
      body.max_depth || 8,
      body.timeout_ms || 30000,
      body.retry_policy ? JSON.stringify(body.retry_policy) : null,
      createdBy,
    ];

    // Stamp owner_org_id from the writer; omit the column when null so the
    // migration-152 DEFAULT applies (single-org-correct today).
    const { rows } = ownerOrgId
      ? await queryFn(
          `INSERT INTO agent_graph.flow_definitions
             ${baseCols}, owner_org_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [...baseParams, ownerOrgId],
        )
      : await queryFn(
          `INSERT INTO agent_graph.flow_definitions
             ${baseCols})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          baseParams,
        );

    await queryFn('COMMIT');
    return { flow: rows[0] };
  } catch (err) {
    try { await queryFn('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  }
}

/**
 * GET /api/flows — List flow definitions (tenant-scoped).
 *
 * STAQPRO-615 M2: scoped by owner_org_id via visibleClause (fail-closed), same
 * pattern as GET /api/signals. An unresolved principal → 'FALSE' → zero rows; a
 * verified agent (adminBypass) → 'TRUE' → org-wide. Never an unscoped read.
 *
 * @param {object} params - { active?: 'true'|'false' }
 * @param {object} principal - from withViewer(req); null/undefined → fail-closed.
 */
export async function listFlowsCore(queryFn, params, principal) {
  const conditions = [];
  const values = [];

  if (params.active !== undefined) {
    values.push(params.active === 'true');
    conditions.push(`is_active = $${values.length}`);
  }

  // Tenant scope (fail-closed). Placeholders continue after the filters above.
  const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: values.length + 1 });
  conditions.push(v.sql);
  values.push(...v.params);

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows } = await queryFn(
    `SELECT * FROM agent_graph.flow_definitions ${where} ORDER BY created_at DESC`,
    values,
  );

  return { flows: rows };
}

/**
 * GET /api/flows/:id — Get flow with recent execution history.
 */
export async function getFlowCore(queryFn, id) {
  if (!id) return { error: 'flow id is required' };

  const { rows } = await queryFn(
    `SELECT * FROM agent_graph.flow_definitions WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return { error: 'Flow not found' };

  const { rows: execRows } = await queryFn(
    `SELECT * FROM agent_graph.flow_executions
     WHERE flow_definition_id = $1
     ORDER BY started_at DESC LIMIT 20`,
    [id],
  );

  return { flow: rows[0], executions: execRows };
}

/**
 * DELETE /api/flows/:id — Deactivate a flow definition (tenant-scoped).
 *
 * STAQPRO-615 M2: soft delete (is_active=false), NOT a hard DELETE — because
 * agent_graph.flow_executions.flow_definition_id is a NOT NULL FK with no ON
 * DELETE CASCADE (sql/037), so dropping a flow with execution history would
 * violate the FK. Soft delete preserves the audit trail and is reversible.
 *
 * Org-scoped: the UPDATE is AND-ed with visibleClause(owner_org_id), so a
 * principal can only delete a flow it can see. A flow outside the principal's
 * scope matches zero rows → 404 (indistinguishable from "does not exist", which
 * is the correct fail-closed behavior — no existence oracle across orgs).
 *
 * @param {object|null} principal - from withViewer(req); null → fail-closed (404).
 */
export async function deleteFlowCore(queryFn, id, principal) {
  if (!id) return { error: 'flow id is required' };

  // id is $1; the visible-clause params start at $2.
  const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
  const { rows } = await queryFn(
    `UPDATE agent_graph.flow_definitions
        SET is_active = false, updated_at = now()
      WHERE id = $1 AND ${v.sql}
      RETURNING id, name, is_active`,
    [id, ...v.params],
  );

  if (rows.length === 0) return { statusCode: 404, error: 'Flow not found' };
  return { deleted: true, flow: rows[0] };
}

/**
 * Build a FlowEngine for API-triggered runs. Includes the MCP tool catalog
 * (function-dispatch tools) plus flow-wrapper-backed agent-dispatch routing,
 * so POST /api/flows/:id/run exercises the same code path as the live
 * signal-driven flow engine.
 */
function buildApiFlowEngine(queryFn) {
  const registry = new FlowToolRegistry(toolRegistry);
  attachFlowWrappers(registry);
  return new FlowEngine({ db: { query: queryFn }, toolRegistry: registry });
}

/**
 * POST /api/flows/:id/run — Trigger a flow with a payload.
 */
export async function runFlowCore(queryFn, id, payload, { dryRun = false, flowEngine, ownerOrgId = null } = {}) {
  if (!id) return { error: 'flow id is required' };

  const { rows } = await queryFn(
    `SELECT * FROM agent_graph.flow_definitions WHERE id = $1 AND is_active = true`,
    [id],
  );

  if (rows.length === 0) return { error: 'Flow not found or inactive' };

  const flowDef = rows[0];

  // Create synthetic signal — owner-stamped from the caller's org (STAQPRO-593).
  // A null ownerOrgId (unresolved/multi-org/admin) falls through to the migration
  // -134 column DEFAULT, which is single-org-correct today.
  const { rows: sigRows } = await queryFn(
    `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by, owner_org_id)
     VALUES ($1, 'api', $2, 'api', $3) RETURNING *`,
    [flowDef.trigger_signal_type, payload || {}, ownerOrgId],
  );
  const signal = sigRows[0];

  const engine = flowEngine || buildApiFlowEngine(queryFn);
  const results = await engine.onSignal(signal, { dryRun });

  return {
    flow_id: flowDef.id,
    signal_id: signal.id,
    dry_run: dryRun,
    execution_count: results.length,
    results,
  };
}

/**
 * GET /api/flows/executions/:id — Full execution trace.
 */
export async function getExecutionCore(queryFn, id) {
  if (!id) return { error: 'execution id is required' };

  const { rows } = await queryFn(
    `SELECT fe.*, fd.name AS flow_name
     FROM agent_graph.flow_executions fe
     JOIN agent_graph.flow_definitions fd ON fd.id = fe.flow_definition_id
     WHERE fe.id = $1`,
    [id],
  );

  if (rows.length === 0) return { error: 'Execution not found' };

  const { rows: stepRows } = await queryFn(
    `SELECT * FROM agent_graph.step_executions
     WHERE flow_execution_id = $1
     ORDER BY step_index`,
    [id],
  );

  return { execution: rows[0], steps: stepRows };
}

/**
 * POST /api/signals — Emit a signal.
 *
 * Owner-stamps the emitting org (ADR-012 M-C / STAQPRO-588). Deterministic
 * single-org rule: a board member who belongs to exactly one org stamps that
 * org; verified agents (adminBypass) and multi-org members fall through to NULL
 * → the column DEFAULT. The full multi-org write policy is TODO(STAQPRO-593).
 * This never widens reads — GET /api/signals is org-scoped below — so a mislabel
 * fails closed (the row becomes invisible to its emitter), never open.
 */
export async function emitSignalCore(queryFn, body, principal) {
  // Accept `type` as a legacy alias for `signal_type` (OPT-22: board modal used `type`).
  const signalType = body?.signal_type ?? body?.type;
  if (!signalType) return { error: 'signal_type is required' };
  if (!body.signal_type) body = { ...body, signal_type: signalType };

  const ownerOrgId =
    principal && !principal.adminBypass && principal.readOrgIds?.length === 1
      ? principal.readOrgIds[0]
      : null;

  const { rows } = ownerOrgId
    ? await queryFn(
        `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by, owner_org_id)
         VALUES ($1, $2, $3, 'api', $4) RETURNING *`,
        [body.signal_type, body.source_adapter || 'api', body.payload || {}, ownerOrgId],
      )
    : await queryFn(
        `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by)
         VALUES ($1, $2, $3, 'api') RETURNING *`,
        [body.signal_type, body.source_adapter || 'api', body.payload || {}],
      );

  return { signal: rows[0] };
}

/**
 * GET /api/signals — Query signal history (tenant-scoped).
 *
 * ADR-012 M-C / STAQPRO-588: this is the live `/api/signals` route (it shadows
 * the inbox.signals handler in api.js via last-writer-wins on the routes Map).
 * It was the actual cross-tenant read leak — an unscoped `SELECT * FROM
 * agent_graph.signals`. Now fail-closed on owner_org_id: an unidentified/
 * unresolved principal → visibleClause 'FALSE' → zero rows; a verified agent
 * (adminBypass) → 'TRUE' → org-wide.
 *
 * @param {object} params - { type?, since?, limit? }
 * @param {object} principal - from withViewer(req); null/undefined → fail-closed.
 */
export async function listSignalsCore(queryFn, params, principal) {
  const conditions = [];
  const values = [];

  if (params.type) {
    values.push(params.type);
    conditions.push(`signal_type = $${values.length}`);
  }

  if (params.since) {
    values.push(params.since);
    conditions.push(`created_at >= $${values.length}`);
  }

  // Tenant scope (fail-closed). owner_org_id exists on agent_graph.signals
  // (migration 134). Placeholders continue after the filters above.
  const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: values.length + 1 });
  conditions.push(v.sql);
  values.push(...v.params);

  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  values.push(limit);
  const limitIdx = values.length;

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows } = await queryFn(
    `SELECT * FROM agent_graph.signals ${where}
     ORDER BY created_at DESC LIMIT $${limitIdx}`,
    values,
  );

  return { signals: rows };
}

/**
 * GET /api/flows/catalog/signals — Signal type catalog for the flow builder.
 * Merges hardcoded known types with any additional types observed in production.
 */
export async function catalogSignalsCore(queryFn) {
  const catalog = new Map(KNOWN_SIGNALS.map(s => [s.signal_type, s]));

  try {
    const { rows } = await queryFn(
      `SELECT DISTINCT signal_type, source_adapter FROM agent_graph.signals`,
    );
    for (const row of rows) {
      if (!catalog.has(row.signal_type)) {
        catalog.set(row.signal_type, {
          signal_type: row.signal_type,
          source_adapter: row.source_adapter,
          label: row.signal_type.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          category: row.source_adapter === 'internal' || row.source_adapter === 'api' ? 'Internal' : 'Input',
          description: `Observed signal from ${row.source_adapter} adapter`,
        });
      }
    }
  } catch {
    // DB query failed — return hardcoded catalog only
  }

  return { signal_types: [...catalog.values()] };
}

/**
 * Normalize a tool's `parameters` block for the flow-builder UI.
 *
 * The registry accepts two shapes per field:
 *   - Shorthand: `'string'` / `'number'` / ... — bare type name, no constraints.
 *   - Rich: `{ type: 'string', enum: [...], default: ... }` — exposes constraints
 *     to the UI so it can render pickers or enforce values client-side.
 *
 * The catalog response preserves shorthand for simple fields (so existing UI
 * code that expects `typeof value === 'string'` keeps working) and promotes
 * rich fields to an object `{ type, enum?, default? }`.
 */
function normalizeParameters(params) {
  const out = {};
  for (const [name, descriptor] of Object.entries(params)) {
    if (typeof descriptor === 'string') {
      out[name] = descriptor;
      continue;
    }
    if (descriptor && typeof descriptor === 'object') {
      const entry = { type: descriptor.type || 'string' };
      if (Array.isArray(descriptor.enum)) entry.enum = descriptor.enum;
      if ('default' in descriptor) entry.default = descriptor.default;
      out[name] = entry;
      continue;
    }
    // Unknown descriptor — fall back to a safe bare-type label.
    out[name] = 'string';
  }
  return out;
}

/**
 * GET /api/flows/catalog/tools — Tool catalog for the flow builder.
 * Reads from the MCP tool registry, stripping handler functions.
 */
export function catalogToolsCore() {
  const catalog = [];

  for (const [toolId, tool] of Object.entries(toolRegistry)) {
    catalog.push({
      tool_id: toolId,
      name: tool.name || toolId,
      label: tool.description || toolId.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: tool.description || '',
      category: toolId.split('_')[0] || 'general',
      dispatch_mode: tool.dispatch_mode || 'function',
      parameters: normalizeParameters(tool.parameters || {}),
      output_schema: tool.output_schema || {},
      native: tool.native === true,
    });
  }

  return { tools: catalog };
}

/**
 * PATCH /api/flows/:id — Partial update for flow definitions.
 * Supports: name, description, is_active, max_depth, timeout_ms, retry_policy.
 */
export async function updateFlowCore(queryFn, id, body) {
  if (!id) return { error: 'flow id is required' };
  if (!body || Object.keys(body).length === 0) return { error: 'no fields to update' };

  const allowed = ['name', 'description', 'is_active', 'max_depth', 'timeout_ms', 'retry_policy'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      values.push(key === 'retry_policy' ? JSON.stringify(body[key]) : body[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }

  if (sets.length === 0) return { error: 'no valid fields to update' };

  values.push(id);
  sets.push(`updated_at = now()`);

  const { rows } = await queryFn(
    `UPDATE agent_graph.flow_definitions SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values,
  );

  if (rows.length === 0) return { error: 'Flow not found' };
  return { flow: rows[0] };
}

// ---------------------------------------------------------------------------
// Route registration (thin wrappers using real `query`)
// ---------------------------------------------------------------------------

/** Extract a path segment by index from a request URL. */
function pathSegment(req, index) {
  const parts = new URL(req.url, 'http://localhost').pathname.split('/');
  return parts[index] || null;
}

/** Extract query params from a request URL. */
function queryParams(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

export function registerFlowRoutes(routes, { withViewer } = {}) {
  // Resolve the tenancy principal for the signal routes. withViewer is injected
  // by api.js (it owns the board_members ↔ viewer ↔ principal bridge). When it is
  // absent (e.g. a unit test registering routes in isolation) — or if resolution
  // throws (e.g. a transient DB error reading memberships) — reads fail closed:
  // null principal → visibleClause 'FALSE' → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch (err) {
      // Linus: don't swallow infrastructure failures as a silent fail-closed 403.
      // A 5xx (DB down, misconfig) must surface; routine auth-class errors still
      // resolve to null → visibleClause FALSE (fail-closed), unchanged for the
      // signal routes that share this helper.
      if (err?.statusCode && err.statusCode >= 500) throw err;
      return null;
    }
  };

  // Privileged-writer gate for the flow WRITE surface (STAQPRO-615 M2 / Linus
  // M2 BLOCKER). Authoring or deleting a flow definition is a control-plane
  // action, not ordinary org-scoped data access — it must be a board human OR a
  // verified internal agent, never a plain viewer and never a bare api_secret.
  //
  // Predicate:  principal.adminBypass === true            (verified agent JWT)
  //          OR (req.auth.role === 'board' AND req.auth.github_username)  (real board human)
  //
  // The github_username check rejects a bare api_secret (which resolves to
  // role:'board' but carries no human viewer — same trap identityGate guards in
  // route-tiers.js). Throws 403 on failure (the dispatcher maps err.statusCode).
  const requirePrivilegedWriter = (req, principal) => {
    const auth = req.auth || null;
    const isAgent = !!principal?.adminBypass;
    const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
    if (!isAgent && !isBoardHuman) {
      throw Object.assign(
        new Error('Flow authoring requires a board member or a verified agent'),
        { statusCode: 403 },
      );
    }
  };

  // OPT-166 P3-B5: agent_graph.flow_definitions/flow_executions/signals/
  // step_executions are tenant-scoped tables (visibleClause), NOT the
  // system-writable operational set — system scope would bypass the tenant
  // GUCs entirely, defeating the org filter these routes already enforce at
  // the app layer. Split mirrors requirePrivilegedWriter's own predicate:
  // board principal → withBoardScope; verified agent (adminBypass) → withAgentScope.
  // Returns null when neither identity is present — callers fall back to the
  // bare `query` fn (unchanged pre-flip behavior; post-flip this fails closed).
  const withFlowsScope = async (req, principal) => {
    const auth = req.auth || null;
    if (auth?.role === 'board' && auth?.github_username) {
      return withBoardScope(auth);
    }
    if (principal?.adminBypass) {
      return withAgentScope(auth?.sub || 'flows-agent', { orgIds: principal?.readOrgIds ?? null });
    }
    return null;
  };

  // Reject caller-supplied ownership/identity on the flow write body — these are
  // ALWAYS derived from the verified principal, never trusted from input (400).
  const rejectOwnershipOverrides = (body) => {
    const forbidden = ['owner_org_id', 'owner_scope', 'owner_user_id', 'created_by'];
    const present = forbidden.filter((k) => body && body[k] !== undefined);
    if (present.length > 0) {
      throw Object.assign(
        new Error(`Fields not allowed (derived from caller identity): ${present.join(', ')}`),
        { statusCode: 400 },
      );
    }
  };

  // POST /api/flows — privileged writers only; owner/identity from principal.
  routes.set('POST /api/flows', async (req, body) => {
    const principal = await resolvePrincipalFor(req);
    requirePrivilegedWriter(req, principal);
    rejectOwnershipOverrides(body);
    const scoped = await withFlowsScope(req, principal);
    try {
      return await createFlowCore(scoped || query, body, principal);
    } finally {
      if (scoped) await scoped.release();
    }
  });

  // GET /api/flows — tenant-scoped list (fail-closed).
  routes.set('GET /api/flows', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const scoped = await withFlowsScope(req, principal);
    try {
      return await listFlowsCore(scoped || query, queryParams(req), principal);
    } finally {
      if (scoped) await scoped.release();
    }
  });

  // DELETE /api/flows/:id — privileged writers only; org-scoped soft delete.
  routes.set('DELETE /api/flows/:id', async (req) => {
    const principal = await resolvePrincipalFor(req);
    requirePrivilegedWriter(req, principal);
    const id = pathSegment(req, 3); // /api/flows/<id>
    const scoped = await withFlowsScope(req, principal);
    let result;
    try {
      result = await deleteFlowCore(scoped || query, id, principal);
    } finally {
      if (scoped) await scoped.release();
    }
    if (result?.statusCode) {
      throw Object.assign(new Error(result.error), { statusCode: result.statusCode });
    }
    return result;
  });

  // GET /api/flows/catalog/signals — must be registered before /api/flows/:id
  routes.set('GET /api/flows/catalog/signals', async () => {
    return catalogSignalsCore(query);
  });

  // GET /api/flows/catalog/tools — must be registered before /api/flows/:id
  routes.set('GET /api/flows/catalog/tools', async () => {
    return catalogToolsCore();
  });

  // GET /api/flows/executions/:id  (must be registered before /api/flows/:id to avoid conflict)
  routes.set('GET /api/flows/executions', async (req) => {
    const id = pathSegment(req, 4); // /api/flows/executions/<id>
    return getExecutionCore(query, id);
  });

  // GET /api/flows/:id
  routes.set('GET /api/flows/:id', async (req) => {
    const id = pathSegment(req, 3); // /api/flows/<id>
    return getFlowCore(query, id);
  });

  // PATCH /api/flows/:id
  routes.set('PATCH /api/flows/:id', async (req, body) => {
    const id = pathSegment(req, 3);
    return updateFlowCore(query, id, body);
  });

  // POST /api/flows/:id/run
  //
  // OPT-166 P3-B5: deliberately NOT wrapped in withFlowsScope. runFlowCore
  // threads its `queryFn` straight into FlowEngine.onSignal(), which
  // interleaves flow_executions/step_executions writes with real network
  // calls (tool dispatch, agent invocation) — holding a scoped transaction
  // open across that spans a network await (forbidden; risks exhausting the
  // pool under a stalled tool call). Scoping this route correctly requires
  // FlowEngine to open/close short-lived scope brackets per DB statement
  // internally, which is an engine-level change out of this batch's scope.
  // Left on bare `query` pending that follow-up (tracked as a gap below).
  routes.set('POST /api/flows/:id/run', async (req, body) => {
    const id = pathSegment(req, 3); // /api/flows/<id>/run
    const params = queryParams(req);
    const dryRun = params.dry_run === 'true';
    const principal = await resolvePrincipalFor(req);
    return runFlowCore(query, id, body?.payload, { dryRun, ownerOrgId: writerOrgId(principal) });
  });

  // POST /api/signals — emit (owner-stamped from the caller's principal)
  routes.set('POST /api/signals', async (req, body) => {
    const principal = await resolvePrincipalFor(req);
    const scoped = await withFlowsScope(req, principal);
    try {
      return await emitSignalCore(scoped || query, body, principal);
    } finally {
      if (scoped) await scoped.release();
    }
  });

  // GET /api/signals — tenant-scoped flow-signal feed (STAQPRO-588 leak fix).
  // NOTE: this intentionally shadows the inbox.signals handler in api.js; see
  // listSignalsCore. Keep this the single source of truth for GET /api/signals.
  routes.set('GET /api/signals', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const scoped = await withFlowsScope(req, principal);
    try {
      return await listSignalsCore(scoped || query, queryParams(req), principal);
    } finally {
      if (scoped) await scoped.release();
    }
  });
}
