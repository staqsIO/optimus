import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { emit } from '../../lib/runtime/event-bus.js';
import { query } from '../../lib/db.js';
import { checkDraftGates } from '../../lib/runtime/guard-check.js';
import { getProfile } from '../../autobot-inbox/src/voice/profile-builder.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'reviewer' });

/**
 * Reviewer agent: automated gate checks on drafts before board review.
 * NO LLM call at L0 — gates are infrastructure-enforced (P2).
 * LLM review reinstated at L1+ when drafts auto-send.
 *
 * Gates checked:
 *   G2 (legal) — regex scan for commitment/contract language
 *   G3 (tone) — pgvector cosine similarity against voice profile
 *   G5 (reversibility) — reply-all detection
 *   G6 (stakeholder) — per-recipient-per-day rate limit
 *   G7 (precedent) — regex scan for pricing/timeline/policy
 *
 * Auto-send: Two independent opt-in lists control which drafts skip board approval
 * when ALL gates pass (verdict = 'approved'). Flagged/rejected drafts always
 * route to board regardless.
 *
 *   AUTO_SEND_RECIPIENTS — drafts TO these addresses auto-send (trusted recipients)
 *   AUTO_SEND_ACCOUNTS   — drafts FROM these accounts auto-send (trusted senders)
 *
 * Either match is sufficient. Both are comma-separated email addresses.
 */

// Trusted recipients whose messages auto-send when all gates pass.
const AUTO_SEND_RECIPIENTS = (process.env.AUTO_SEND_RECIPIENTS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

// Trusted sender accounts whose outbound drafts auto-send when all gates pass.
// Match is on inbox.accounts.identifier (the email address).
const AUTO_SEND_ACCOUNTS = (process.env.AUTO_SEND_ACCOUNTS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Check if a draft is eligible for auto-send.
 * Either all recipients are trusted OR the sending account is trusted.
 */
function isAutoSendEligible(draft, senderIdentifier) {
  // Check trusted sender account
  if (AUTO_SEND_ACCOUNTS.length > 0 && senderIdentifier) {
    if (AUTO_SEND_ACCOUNTS.includes(senderIdentifier.toLowerCase())) return true;
  }
  // Check trusted recipients
  if (AUTO_SEND_RECIPIENTS.length > 0) {
    const recipients = draft.to_addresses || [];
    if (recipients.length > 0 && recipients.every(addr => AUTO_SEND_RECIPIENTS.includes(addr.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

/**
 * Scope compliance check: detect diligence theater in executor output.
 * Advisory only — flags unsolicited scaffolding (execution reports,
 * self-assessment scores, step narration) but does not reject.
 *
 * This addresses the Figma findings where executors wrapped correct work
 * in theatrical scaffolding that added no value.
 */
function checkScopeCompliance(content) {
  if (!content || typeof content !== 'string') return { compliant: true, flags: [] };

  const flags = [];

  // Execution framing headers
  if (/^#{1,3}\s*(Campaign |Execution |Task )?(Report|Summary)/im.test(content)) {
    flags.push('execution-framing: contains report/summary header');
  }

  // Self-assessment scores
  if (/Quality Score:\s*\d/i.test(content) || /\d+(\.\d+)?%\s*(accuracy|quality|confidence)/i.test(content)) {
    flags.push('self-assessment: contains quality/confidence scores');
  }

  // Step narration
  const stepMatches = content.match(/Step \d+:/g);
  if (stepMatches && stepMatches.length >= 3) {
    flags.push(`step-narration: ${stepMatches.length} sequential steps narrated`);
  }

  // Tool call logs
  const toolLogMatches = content.match(/^(Calling|Invoked|Running|Executing)\s+\w+/gim);
  if (toolLogMatches && toolLogMatches.length >= 3) {
    flags.push(`tool-logs: ${toolLogMatches.length} tool invocation narrations`);
  }

  return { compliant: flags.length === 0, flags };
}

async function handler(task, context, agent) {
  const email = context.email;
  const message = context.promptContext || email; // channel-agnostic fallback

  // SPEC §5: "1 round of feedback then escalate"
  // Track review rounds to prevent infinite reject loops
  const reviewRound = context.workItem?.metadata?.review_round || 0;
  if (reviewRound >= 2) {
    log.warn(` Task ${task.work_item_id} has been rejected ${reviewRound} times — escalating to board`);
    return {
      success: true,
      escalate: true,
      reason: `Escalating after ${reviewRound} review rounds (SPEC §5: max 1 round of feedback before escalation)`,
      costUsd: 0,
    };
  }

  let draftId = context.workItem?.metadata?.draft_id || task.event_data?.draft_id;

  // Fallback: if no draft_id in metadata, look up the most recent draft for this email
  if (!draftId && context.workItem?.metadata?.email_id) {
    const fallback = await query(
      `SELECT id FROM agent_graph.action_proposals
       WHERE message_id = $1 AND action_type = 'email_draft' AND board_action IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [context.workItem.metadata.email_id]
    );
    draftId = fallback.rows[0]?.id || null;
    if (draftId) log.info(` Resolved draft_id via email fallback: ${draftId}`);
  }

  // No draft to review = nothing to do. Return success (not failure) so the
  // agent-loop doesn't auto-retry 3x and burn RAG + LLM cost on each retry.
  // The "right" fix is upstream — don't dispatch to reviewer for work items
  // that never got a draft. Tracked under Phase 6 (reviewer collapse into
  // responder self-review).
  if (!draftId) return { success: true, reason: 'Skipped: no draft to review' };

  // Load draft
  const draftResult = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = draftResult.rows[0];
  if (!draft) return { success: false, reason: `Draft ${draftId} not found` };

  // Run automated gate checks (no LLM — infrastructure enforces, P2)
  const voiceProfile = draft.action_type === 'email_draft' ? await getProfile(email?.from_address) : null;
  const senderRegister = context.workItem?.metadata?.sender_register || null;
  const actionType = draft.action_type || 'email_draft';
  const gateResults = await checkDraftGates(draft, voiceProfile, null, senderRegister, actionType);

  // Compute verdict from gate results
  const failedGates = Object.entries(gateResults.gates)
    .filter(([, v]) => !v.passed)
    .map(([k]) => k);

  // G3 tone score from automated pgvector check
  const toneScore = gateResults.gates.G3?.score;

  // Gates whose onViolation is "flag_for_board" in
  // autobot-inbox/config/gates.json (loaded via getConfig('gates')) — see
  // STAQPRO-278. Failing one of these surfaces the draft for human review
  // instead of destroying it. G3 was promoted from reject_draft on 2026-05-08
  // to close the Phase 1 loop where 100% of email drafts were dying at G3
  // and never reaching the human queue. Keep this list synced with the
  // onViolation field in autobot-inbox/config/gates.json.
  const FLAG_GATES = new Set(['G2', 'G3', 'G5', 'G7']);

  let verdict;
  if (failedGates.length === 0) {
    verdict = 'approved';
  } else if (failedGates.some(g => FLAG_GATES.has(g))) {
    // Any flag-worthy gate failure routes to the board (humans decide).
    // If a destroy-worthy gate (e.g., G6 rate limit) ALSO failed, the board
    // still sees the draft with all gate failures listed in reviewer_notes.
    verdict = 'flagged';
  } else {
    verdict = 'rejected';
  }

  // Scope compliance check (advisory — Figma findings defense)
  const scopeCheck = checkScopeCompliance(draft.proposed_text || draft.proposed_content || '');
  if (!scopeCheck.compliant) {
    log.warn(` Scope compliance flags on draft ${draftId}: ${scopeCheck.flags.join(', ')}`);
  }

  // Surface G3 threshold adjustment in notes for board transparency (P3)
  const g3Adjusted = gateResults.gates.G3?.adjustedThreshold != null;
  const g3Note = g3Adjusted
    ? ` [G3 threshold adjusted to ${gateResults.gates.G3.adjustedThreshold} due to sender formality shift]`
    : '';

  const scopeNote = scopeCheck.flags.length > 0
    ? ` [Scope: ${scopeCheck.flags.join('; ')}]`
    : '';

  const notes = failedGates.length === 0
    ? `All gates passed (automated check)${g3Note}${scopeNote}`
    : `Gates failed: ${failedGates.join(', ')} (automated check)${g3Note}${scopeNote}`;

  // Update draft with review results
  await query(
    `UPDATE agent_graph.action_proposals
     SET reviewer_verdict = $1, reviewer_notes = $2, gate_results = $3, tone_score = $4, updated_at = now()
     WHERE id = $5`,
    [verdict, notes, JSON.stringify(gateResults.gates), toneScore, draftId]
  );

  // Resolve sender account identifier for auto-send check
  let senderIdentifier = null;
  if (draft.account_id) {
    const acctResult = await query(`SELECT identifier FROM inbox.accounts WHERE id = $1`, [draft.account_id]);
    senderIdentifier = acctResult.rows[0]?.identifier || null;
  }

  // Auto-send path: if all gates passed AND (trusted sender OR trusted recipients), skip board
  if (verdict === 'approved' && isAutoSendEligible(draft, senderIdentifier)) {
    const autoReason = senderIdentifier && AUTO_SEND_ACCOUNTS.includes(senderIdentifier.toLowerCase())
      ? `trusted account (${senderIdentifier})`
      : 'trusted recipient';

    await query(
      `UPDATE agent_graph.action_proposals
       SET board_action = 'auto_approved', acted_at = now(), send_state = 'approved',
           board_notes = $2
       WHERE id = $1`,
      [draftId, `Auto-approved: ${autoReason}, all gates passed`]
    );

    await emit({
      eventType: 'draft_auto_approved',
      workItemId: task.work_item_id,
      targetAgentId: 'board',
      priority: 2, // informational
      eventData: {
        draft_id: draftId,
        email_id: email?.id,
        recipients: draft.to_addresses,
        sender_account: senderIdentifier,
        notes,
      },
    });

    return {
      success: true,
      reason: `Auto-approved (${autoReason}). Tone: ${toneScore ?? 'n/a'}. Cost: $0 (automated)`,
      costUsd: 0,
    };
  }

  // On rejection, increment review_round in work item metadata for next attempt
  if (verdict === 'rejected') {
    await query(
      `UPDATE agent_graph.work_items
       SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{review_round}', $2::jsonb)
       WHERE id = $1`,
      [task.work_item_id, JSON.stringify(reviewRound + 1)]
    );
  }

  // Standard path: route to board for final action
  if (verdict === 'rejected') {
    // P3: Rejected drafts must be visible to the board — update send_state and emit event
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'rejected' WHERE id = $1`,
      [draftId]
    );

    await emit({
      eventType: 'draft_rejected',
      workItemId: task.work_item_id,
      targetAgentId: 'board',
      priority: 1,
      eventData: {
        draft_id: draftId,
        email_id: email?.id,
        verdict,
        notes,
        flags: failedGates,
      },
    });
  } else {
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'reviewed' WHERE id = $1`,
      [draftId]
    );

    // Emit event for CLI/dashboard notification
    await emit({
      eventType: 'approval_needed',
      workItemId: task.work_item_id,
      targetAgentId: 'board',
      priority: verdict === 'flagged' ? 0 : 1,
      eventData: {
        draft_id: draftId,
        email_id: email?.id,
        verdict,
        notes,
        flags: failedGates,
      },
    });
  }

  return {
    success: true,
    reason: `Review verdict: ${verdict}. Tone: ${toneScore ?? 'n/a'}. Cost: $0 (automated)`,
    costUsd: 0,
  };
}

export const reviewerLoop = new AgentLoop('reviewer', handler);
