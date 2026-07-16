import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';

/**
 * Shared board commands — used by both Slack and Telegram listeners.
 * Deterministic command parsing — exact patterns only, no fuzzy matching.
 * P1: deny by default — unrecognized text falls through to ingest.
 */

export const COMMANDS = [
  { pattern: /^resolve\s+([a-f0-9]{4,})$/i, action: 'resolve' },
  { pattern: /^approve\s+([a-f0-9]{4,})$/i, action: 'approve' },
  { pattern: /^reject\s+([a-f0-9]{4,})$/i, action: 'reject' },
  { pattern: /^send\s+([a-f0-9]{4,})$/i, action: 'send' },
  { pattern: /^halt(?:\s+(.+))?$/i, action: 'halt' },
  { pattern: /^resume$/i, action: 'resume' },
  { pattern: /^directive\s+(.+)$/i, action: 'directive' },
  { pattern: /^status$/i, action: 'status' },
  { pattern: /^help$/i, action: 'help' },
];

/**
 * Parse text for a board command.
 * @param {string} text - Raw message text
 * @returns {{ action: string, id: string|null } | null}
 */
export function parseCommand(text) {
  const trimmed = text.trim();
  for (const { pattern, action } of COMMANDS) {
    const match = trimmed.match(pattern);
    if (match) return { action, id: match[1] || null };
  }
  return null;
}

/**
 * Execute a parsed board command.
 * @param {{ action: string, id: string|null }} cmd - Parsed command
 * @param {{ source: string }} options - Source channel ('slack' | 'telegram')
 * @returns {Promise<string>} Reply text
 */
export async function executeCommand(cmd, { source = 'slack' } = {}) {
  switch (cmd.action) {
    case 'resolve': return await cmdResolve(cmd.id, source);
    case 'approve': return await cmdApprove(cmd.id, source);
    case 'reject': return await cmdReject(cmd.id, source);
    case 'send': return await cmdSend(cmd.id, source);
    case 'halt': return await cmdHalt(cmd.id, source);
    case 'resume': return await cmdResume(source);
    case 'directive': return await cmdDirective(cmd.id, source);
    case 'status': return await cmdStatus();
    case 'help': return cmdHelp();
    default: return 'Unknown command. Type `help` for available commands.';
  }
}

async function cmdResolve(idPrefix, source) {
  const signals = await query(
    `SELECT id, content, signal_type FROM inbox.signals WHERE id::text LIKE $1 AND resolved = false LIMIT 5`,
    [`${idPrefix}%`]
  );
  if (signals.rows.length === 0) return `No unresolved signals matching \`${idPrefix}\`.`;
  if (signals.rows.length > 1) return `Multiple matches for \`${idPrefix}\` — be more specific:\n${signals.rows.map(s => `• \`${s.id.slice(0, 8)}\` ${s.signal_type}: ${(s.content || '').slice(0, 60)}`).join('\n')}`;

  const signal = signals.rows[0];
  await query(`UPDATE inbox.signals SET resolved = true, resolved_at = now() WHERE id = $1`, [signal.id]);
  await query(
    `INSERT INTO signal.feedback (signal_id, verdict, source) VALUES ($1, 'correct', $2)
     ON CONFLICT DO NOTHING`,
    [signal.id, source]
  ).catch(() => {}); // feedback table may not exist yet (migration 032)

  console.log(`[${source}-cmd] Resolved signal ${signal.id.slice(0, 8)} via ${source}`);
  return `Resolved: ${signal.signal_type} — ${(signal.content || '').slice(0, 80)}`;
}

async function cmdApprove(idPrefix, source) {
  const drafts = await query(
    `SELECT id, subject, channel FROM agent_graph.action_proposals WHERE id::text LIKE $1 AND board_action IS NULL LIMIT 5`,
    [`${idPrefix}%`]
  );
  if (drafts.rows.length === 0) return `No pending drafts matching \`${idPrefix}\`.`;
  if (drafts.rows.length > 1) return `Multiple matches for \`${idPrefix}\` — be more specific:\n${drafts.rows.map(d => `• \`${d.id.slice(0, 8)}\` ${(d.subject || '').slice(0, 60)}`).join('\n')}`;

  const draft = drafts.rows[0];
  await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), send_state = 'approved' WHERE id = $1`,
    [draft.id]
  );
  await publishEvent('draft_approved', `Draft ${draft.id} approved via ${source}`, null, null, { draft_id: draft.id });
  console.log(`[${source}-cmd] Approved draft ${draft.id.slice(0, 8)} via ${source}`);
  return `Approved: ${(draft.subject || 'Draft').slice(0, 80)} (${draft.channel || 'email'})`;
}

async function cmdReject(idPrefix, source) {
  const drafts = await query(
    `SELECT id, subject FROM agent_graph.action_proposals WHERE id::text LIKE $1 AND board_action IS NULL LIMIT 5`,
    [`${idPrefix}%`]
  );
  if (drafts.rows.length === 0) return `No pending drafts matching \`${idPrefix}\`.`;
  if (drafts.rows.length > 1) return `Multiple matches — be more specific:\n${drafts.rows.map(d => `• \`${d.id.slice(0, 8)}\` ${(d.subject || '').slice(0, 60)}`).join('\n')}`;

  const draft = drafts.rows[0];
  await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'rejected', acted_at = now() WHERE id = $1`,
    [draft.id]
  );
  await publishEvent('draft_rejected', `Draft ${draft.id} rejected via ${source}`, null, null, { draft_id: draft.id });
  console.log(`[${source}-cmd] Rejected draft ${draft.id.slice(0, 8)} via ${source}`);
  return `Rejected: ${(draft.subject || 'Draft').slice(0, 80)}`;
}

async function cmdSend(idPrefix, source) {
  const { sendDraft } = await import('../comms/sender.js');
  const drafts = await query(
    `SELECT id, subject FROM agent_graph.action_proposals WHERE id::text LIKE $1 AND board_action IS NULL LIMIT 5`,
    [`${idPrefix}%`]
  );
  if (drafts.rows.length === 0) return `No pending drafts matching \`${idPrefix}\`.`;
  if (drafts.rows.length > 1) return `Multiple matches — be more specific:\n${drafts.rows.map(d => `• \`${d.id.slice(0, 8)}\` ${(d.subject || '').slice(0, 60)}`).join('\n')}`;

  const draft = drafts.rows[0];
  await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), send_state = 'approved' WHERE id = $1`,
    [draft.id]
  );
  try {
    await sendDraft(draft.id);
    console.log(`[${source}-cmd] Sent draft ${draft.id.slice(0, 8)} via ${source}`);
    return `Approved and sent: ${(draft.subject || 'Draft').slice(0, 80)}`;
  } catch (err) {
    return `Approved but send failed: ${err.message}`;
  }
}

async function cmdHalt(reason, source) {
  const haltReason = reason || `Board halt via ${source}`;
  await query(
    `INSERT INTO agent_graph.halt_signals (reason, initiated_by)
     VALUES ($1, $2)`,
    [haltReason, `board:${source}`]
  );
  await publishEvent('halt_triggered', `System halted via ${source}: ${haltReason}`, null, null, { source, reason: haltReason });
  console.log(`[${source}-cmd] HALT triggered: ${haltReason}`);
  return `HALTED. Reason: ${haltReason}\nAll agents will stop processing. Use \`resume\` to clear.`;
}

async function cmdResume(source) {
  const result = await query(
    `UPDATE agent_graph.halt_signals SET cleared_at = now() WHERE cleared_at IS NULL RETURNING id`
  );
  if (result.rowCount === 0) return 'No active halt signals to clear.';
  await publishEvent('halt_cleared', `System resumed via ${source}`, null, null, { source, signals_cleared: result.rowCount });
  console.log(`[${source}-cmd] Resume: cleared ${result.rowCount} halt signal(s)`);
  return `Resumed. Cleared ${result.rowCount} halt signal(s). Agents will restart processing.`;
}

async function cmdDirective(title, source) {
  const { createWorkItem } = await import('../runtime/state-machine.js');
  const item = await createWorkItem({
    type: 'directive',
    title: title.trim(),
    description: `Board directive via ${source}: ${title.trim()}`,
    createdBy: 'board',
    assignedTo: 'orchestrator',
    priority: 1,
    metadata: { source },
  });
  await publishEvent('board_directive', `Board directive via ${source}: ${title.trim()}`, null, item.id, { source });
  console.log(`[${source}-cmd] Directive created: ${item.id}`);
  return `Directive created: \`${item.id.slice(0, 8)}\`\n${title.trim()}`;
}

async function cmdStatus() {
  const [signals, drafts, budget, emails, tasks, agents] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE NOT resolved) AS unresolved, COUNT(*) FILTER (WHERE resolved) AS resolved FROM inbox.signals WHERE created_at >= CURRENT_DATE - 7`),
    query(`SELECT COUNT(*) FILTER (WHERE board_action IS NULL) AS pending, COUNT(*) FILTER (WHERE board_action = 'approved') AS approved, COUNT(*) FILTER (WHERE board_action = 'rejected') AS rejected FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at >= CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(cost_usd), 0) AS cost_24h FROM agent_graph.state_transitions WHERE created_at > now() - interval '24 hours'`),
    query(`SELECT COUNT(*) AS received, COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived FROM inbox.messages WHERE received_at > now() - interval '24 hours'`),
    query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'completed') AS completed, COUNT(*) FILTER (WHERE status IN ('failed', 'timed_out')) AS failed FROM agent_graph.work_items WHERE created_at > now() - interval '24 hours'`),
    query(`SELECT COUNT(*) FILTER (WHERE heartbeat_at > now() - interval '30 seconds' AND status != 'stopped') AS online FROM agent_graph.agent_heartbeats`),
  ]);

  const s = signals.rows[0] || {};
  const d = drafts.rows[0] || {};
  const b = budget.rows[0] || {};
  const e = emails.rows[0] || {};
  const t = tasks.rows[0] || {};
  const a = agents.rows[0] || {};

  return [
    '📊 *System Status*',
    '',
    `🤖 Agents: ${a.online || 0} online`,
    `📧 Email (24h): ${e.received || 0} received, ${e.archived || 0} auto-archived`,
    `📝 Drafts: ${d.pending || 0} pending, ${d.approved || 0} approved, ${d.rejected || 0} rejected`,
    `📡 Signals (7d): ${s.unresolved || 0} unresolved`,
    `⚙️ Tasks (24h): ${t.completed || 0}/${t.total || 0} completed, ${t.failed || 0} failed`,
    `💰 Cost (24h): $${Number(b.cost_24h || 0).toFixed(2)}`,
    '',
    '🔗 board.staqs.io',
  ].join('\n');
}

function cmdHelp() {
  return [
    '*Board Commands*',
    '`resolve <id>` — resolve a signal (prefix match)',
    '`approve <id>` — approve a pending draft',
    '`reject <id>` — reject a pending draft',
    '`send <id>` — approve and send a draft',
    '`halt [reason]` — emergency stop all agents',
    '`resume` — clear halt and resume processing',
    '`directive <title>` — create a board directive',
    '`status` — pipeline summary',
    '`help` — this message',
    '',
    'IDs are UUID prefixes (first 4-8 chars). Any other message is answered conversationally.',
  ].join('\n');
}
