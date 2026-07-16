/**
 * Shared context-assembly helpers for flow-invoked agent wrappers.
 *
 * The existing pipeline agents expect a rich `context` object pre-assembled
 * by the orchestrator (work_item row, email metadata, voice profile, contact,
 * signals, few-shots). When a flow dispatches to one of these agents, none of
 * that exists — only a flat payload from the flow step. These helpers bridge
 * the two by creating minimal synthetic shapes.
 *
 * Design rules:
 *   - Synthetic work_items carry metadata.source='flow' so dashboards can filter.
 *   - Never modify or import from the handlers themselves.
 *   - Missing data → documented defaults, never a crash.
 *   - One path to the DB: lib/db.js (respects Docker Postgres vs PGlite).
 */

import { query } from '../../../lib/db.js';
import { openAgentScope } from '../runtime/agent-scope.js';

const NOREPLY_PATTERNS = /^(noreply|no-reply|no_reply|donotreply|notifications?|mailer-daemon|postmaster)@/i;

/**
 * Create a synthetic work_item for a flow-driven agent invocation.
 * Inserts with status='in_progress' and metadata.source='flow' so it can be
 * filtered out of dashboards while still satisfying FK constraints on
 * action_proposals / strategic_decisions / state_transitions.
 *
 * @param {object} opts
 * @param {string} opts.type                - work_items.type (e.g. 'draft_reply')
 * @param {string} opts.title               - short description
 * @param {string} opts.assignedTo          - agent id (for audit)
 * @param {object} [opts.metadata]          - merged over { source:'flow', ... }
 * @returns {Promise<object>} inserted work_item row
 */
export async function createSyntheticWorkItem({ type, title, assignedTo, metadata = {} }) {
  // work_items.type CHECK constraint restricts to: directive | workstream |
  // task | subtask | campaign. We always use 'task' and stash the semantic
  // wrapper type (draft_reply, priority_score, etc.) under metadata.flow_type
  // so dashboards can still distinguish.
  const merged = { source: 'flow', flow_type: type, ...metadata };
  // created_by = assignedTo: two constraints force this pattern.
  //   1. fk_work_items_created_by: created_by must exist in agent_configs
  //      (so it can't be 'flow-engine' or 'human:flow' without a migration).
  //   2. enforce_assignment_rules trigger: exempts rows where
  //      NEW.created_by = NEW.assigned_to, which matches the semantics here
  //      ("the agent is working on its own flow-scoped item").
  // metadata.source='flow' preserves the flow-origin lineage for dashboards.
  //
  // STAQPRO-524 follow-up: agent_graph.work_items is FORCE'd by migration 126.
  // Flow wrappers run inside FlowEngine.onSignal — driven by gmail/slack/
  // webhook signals, not authenticated HTTP requests. There is no req.auth
  // and no agent JWT in this call path. The natural identity for the row
  // is the wrapper's targeted agent (assignedTo: executor-intake, strategist,
  // executor-ticket, etc.) — that agent is the one doing the work and the
  // one that will read the row back via SELECT under its own scope.
  //
  // OPT-166: openAgentScope mints (and caches) a real per-agent JWT so this
  // works under REQUIRE_AGENT_JWT=true; it falls back to the plain-id path
  // only when JWT key material is unavailable (tests/CLI).
  const scopedQuery = await openAgentScope(assignedTo);
  let result;
  try {
    result = await scopedQuery(
      `INSERT INTO agent_graph.work_items
         (type, title, description, created_by, assigned_to, priority, status, metadata)
       VALUES ('task', $1, $2, $3, $3, 0, 'in_progress', $4)
       RETURNING *`,
      [title, null, assignedTo, JSON.stringify(merged)],
    );
  } finally {
    await scopedQuery.release();
  }
  return result.rows[0];
}

/**
 * Resolve a contact record by email address.
 * Default when no row exists: null (caller treats as external non-VIP).
 */
export async function resolveContact(fromAddress) {
  if (!fromAddress) return null;
  try {
    const result = await query(
      `SELECT * FROM signal.contacts WHERE lower(email_address) = lower($1) LIMIT 1`,
      [fromAddress],
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Fetch extracted signals for a given message id. Returns [] on failure or
 * when no email_id is known — callers can still invoke the strategist, they
 * just won't get signal-informed enrichment.
 */
export async function loadSignalsForMessage(emailId) {
  if (!emailId) return [];
  try {
    const result = await query(
      `SELECT * FROM inbox.signals WHERE message_id = $1 ORDER BY created_at`,
      [emailId],
    );
    return result.rows;
  } catch {
    return [];
  }
}

/**
 * Fabricate the shape of an `inbox.messages` row from flow inputs. The
 * existing handlers read from this shape (email.from_address, email.subject,
 * email.received_at, email.channel, email.triage_category, email.id,
 * email.account_id, email.snippet, email.labels). Missing fields get safe
 * defaults.
 *
 * @param {object} input
 * @param {string} input.from      - sender address
 * @param {string} [input.fromName]
 * @param {string} [input.subject]
 * @param {string} [input.emailBody]
 * @param {string} [input.channel='email']
 * @param {string} [input.triageCategory]
 * @param {string} [input.emailId]   - real inbox.messages.id if caller has one
 * @returns {object} synthetic email row
 */
export function buildSyntheticEmail(input) {
  const {
    from = null,
    fromName = null,
    subject = '',
    emailBody = '',
    channel = 'email',
    triageCategory = null,
    emailId = null,
  } = input;

  return {
    id: emailId,
    provider: channel === 'email' ? 'gmail' : channel,
    provider_msg_id: null,
    thread_id: null,
    message_id: null,
    from_address: from,
    from_name: fromName || from,
    to_addresses: [],
    cc_addresses: [],
    subject,
    snippet: emailBody ? emailBody.slice(0, 200) : '',
    received_at: new Date(),
    labels: [],
    has_attachments: false,
    channel,
    account_id: null,
    triage_category: triageCategory,
    priority_score: null,
  };
}

/**
 * Build a promptContext object matching what adapters normally produce for
 * context-loader consumers (see lib/adapters/*.js — sender/threading/channel
 * fields). Agents prefer promptContext over the raw email row, so we populate
 * both.
 */
export function buildPromptContext({ from, fromName, subject, emailBody, channel = 'email' }) {
  return {
    sender: { address: from, name: fromName || from },
    threading: { subject: subject || '' },
    channel,
    body: emailBody || '',
    contentLabel: channel === 'email' ? 'untrusted_email' : 'untrusted_message',
    contentType: channel,
  };
}

/**
 * Tag indicating a sender whose address looks automated (e.g. noreply@).
 * Exposed so wrappers can short-circuit before creating work items /
 * calling LLMs — matches the agent handlers' own guards.
 */
export function isNoreplySender(fromAddress) {
  return !!(fromAddress && NOREPLY_PATTERNS.test(fromAddress));
}

/**
 * Mark a synthetic work item as completed after a successful wrapper run.
 * Best-effort — failure here does not change what the caller returns.
 *
 * STAQPRO-524: agent_graph.work_items is FORCE'd, so UPDATE WHERE id=$1 is
 * RLS-gated by current_agent_id(). Caller passes the same `assignedTo` used
 * at create time so the row is visible to the UPDATE. If omitted, falls back
 * to the bare `query()` path for backward compatibility (will silently no-op
 * under FORCE — flagged in the try/catch).
 */
export async function markSyntheticComplete(workItemId, assignedTo = null) {
  if (!workItemId) return;
  try {
    if (assignedTo) {
      const scopedQuery = await openAgentScope(assignedTo);
      try {
        await scopedQuery(
          `UPDATE agent_graph.work_items SET status = 'completed', updated_at = now() WHERE id = $1`,
          [workItemId],
        );
      } finally {
        await scopedQuery.release();
      }
    } else {
      await query(
        `UPDATE agent_graph.work_items SET status = 'completed', updated_at = now() WHERE id = $1`,
        [workItemId],
      );
    }
  } catch {
    // non-fatal
  }
}

/**
 * Mark a synthetic work item as failed. Same contract as markSyntheticComplete.
 *
 * See markSyntheticComplete for the assignedTo / RLS rationale (STAQPRO-524).
 */
export async function markSyntheticFailed(workItemId, reason = null, assignedTo = null) {
  if (!workItemId) return;
  try {
    if (assignedTo) {
      const scopedQuery = await openAgentScope(assignedTo);
      try {
        await scopedQuery(
          `UPDATE agent_graph.work_items SET status = 'failed', updated_at = now(),
             metadata = metadata || $2
           WHERE id = $1`,
          [workItemId, JSON.stringify({ failure_reason: reason ? String(reason).slice(0, 500) : null })],
        );
      } finally {
        await scopedQuery.release();
      }
    } else {
      await query(
        `UPDATE agent_graph.work_items SET status = 'failed', updated_at = now(),
           metadata = metadata || $2
         WHERE id = $1`,
        [workItemId, JSON.stringify({ failure_reason: reason ? String(reason).slice(0, 500) : null })],
      );
    }
  } catch {
    // non-fatal
  }
}
