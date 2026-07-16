/**
 * Transcript Action Extractor: post-processing for tl;dv/transcript work items.
 *
 * Triggered when executor-triage completes on a transcript message
 * (detected via 'webhook:tldv' label in work_item metadata).
 *
 * Key insight: executor-triage + the tl;dv channelHint already extracts signals
 * (commitments, deadlines, action_items). This module promotes high-confidence
 * inbound signals to intents:
 *
 * - action_item/commitment with direction='inbound' → create intent (Tier 2)
 * - action_item with direction='outbound' → signal-only (briefing: "You asked X to do Y")
 * - Participant names → fuzzy-match to signal.contacts
 *
 * P1: Deny by default — only processes work items with webhook:tldv source.
 * P3: Transparency by structure — signals and intents are logged.
 * P4: Boring infrastructure — raw SQL.
 */

import { query, withAgentScope } from '../db.js';
import { createIntent } from '../runtime/intent-manager.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

const TRANSCRIPT_RESOLVE_AGENT_ID = 'transcript-extractor';

/**
 * OPT-166 P2f-A: bracket the org-keyed DB access below in an org scope so it survives
 * the Postgres pool flip (RLS enforced under the non-superuser `autobot_agent` role).
 * INERT today — the Supabase superuser bypasses RLS, so behavior is unchanged pre-flip.
 *
 * `inbox.signals` SELECT (sql/190) and `signal.contacts` writes (sql/200) are org-keyed
 * (`tenancy.visible(NULL, owner_org_id, ...)`) → a bare query black-holes reads to 0 rows
 * and 42501s contact writes post-flip. Scope to the transcript message's owning org.
 *
 * On scope-acquisition failure (e.g. a future REQUIRE_AGENT_JWT enforcement) fall back to
 * bare `query` — best-effort, preserving today's behavior. The warn is distinctively
 * marked so on-call can tell a JWT-enforce fallback apart from an RLS deny.
 *
 * NB: `createIntent` (the loop between the two bracketed reads) is intentionally NOT
 * scoped — it INSERTs into `agent_graph.agent_intents`, which has NO RLS (verified: only
 * a baseline CREATE TABLE, no ENABLE/FORCE/policy anywhere in sql/), on its own bare-`query`
 * connection, so it is flip-safe as-is.
 */
async function withTranscriptOrgScope(ownerOrgId, fn) {
  let scoped;
  try {
    scoped = await withAgentScope(TRANSCRIPT_RESOLVE_AGENT_ID, { orgIds: [ownerOrgId] });
  } catch (err) {
    console.warn(`[OPT-166 P2f-A SCOPE-UNAVAILABLE] withAgentScope(${TRANSCRIPT_RESOLVE_AGENT_ID}) threw: ${err.message} — resolving unscoped`);
    return fn(query);
  }
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Extract and promote action items from a completed transcript triage.
 *
 * @param {number} messageId - The inbox.messages ID of the transcript
 * @returns {{ intentsCreated: number, signalsFound: number }}
 */
export async function extractTranscriptActions(messageId) {
  if (!messageId) {
    console.warn('[action-extractor] No messageId provided');
    return { intentsCreated: 0, signalsFound: 0 };
  }

  // Resolve the owning org from the (bare-permissive) message row up front, so we can scope
  // the org-keyed inbox.signals reads / signal.contacts writes below. inbox.messages SELECT
  // is `read_messages USING (true)` (sql/001) → readable unscoped even post-flip.
  const orgResult = await query(
    `SELECT owner_org_id FROM inbox.messages WHERE id = $1`,
    [messageId]
  );
  const ownerOrgId = orgResult.rows[0]?.owner_org_id || CURRENT_ORG_ID;

  // Fetch signals extracted by executor-triage for this message. Org-scoped: inbox.signals is
  // org-keyed → a bare read black-holes to 0 rows post-flip, silently yielding 0 intents.
  const signalResult = await withTranscriptOrgScope(ownerOrgId, (exec) =>
    exec(
      `SELECT s.id, s.signal_type, s.content, s.direction, s.confidence, s.domain,
              m.from_name, m.subject, m.labels
       FROM inbox.signals s
       JOIN inbox.messages m ON m.id = s.message_id
       WHERE s.message_id = $1
         AND s.signal_type IN ('action_item', 'commitment', 'deadline', 'request')
       ORDER BY s.confidence DESC`,
      [messageId]
    )
  );

  const signals = signalResult.rows;
  if (signals.length === 0) {
    console.log(`[action-extractor] No actionable signals found for message ${messageId}`);
    return { intentsCreated: 0, signalsFound: 0 };
  }

  console.log(`[action-extractor] Found ${signals.length} actionable signal(s) for message ${messageId}`);

  let intentsCreated = 0;

  for (const signal of signals) {
    // Only promote high-confidence inbound signals to intents
    if (signal.direction === 'inbound' && signal.confidence >= 0.7) {
      const isUrgent = signal.signal_type === 'deadline' || signal.signal_type === 'commitment';

      const intent = await createIntent({
        agentId: 'orchestrator',
        intentType: 'task',
        decisionTier: isUrgent ? 'strategic' : 'tactical',
        title: `Transcript action: ${signal.content.slice(0, 100)}`,
        reasoning: `Extracted from transcript "${signal.subject || 'unknown'}". ` +
          `Signal type: ${signal.signal_type}, confidence: ${signal.confidence}. ` +
          `From: ${signal.from_name || 'unknown participant'}.`,
        proposedAction: {
          type: 'create_work_item',
          payload: {
            type: 'task',
            title: `Transcript: ${signal.content.slice(0, 200)}`,
            description: `Action item from transcript: ${signal.content}\n\nSource: ${signal.subject || 'Meeting transcript'}`,
            assigned_to: 'executor-triage',
            priority: isUrgent ? 2 : 1,
            metadata: {
              source_message_id: messageId,
              source_signal_id: signal.id,
              signal_type: signal.signal_type,
              source: 'transcript-action-extractor',
            },
          },
        },
        triggerContext: {
          pattern: `transcript_action_${messageId}_${signal.id}`,
          source: 'transcript-action-extractor',
          message_id: messageId,
          signal_id: signal.id,
          signal_type: signal.signal_type,
        },
        budgetPerFire: 0.10,
      });

      if (intent) {
        intentsCreated++;
        console.log(`[action-extractor] Created intent for: ${signal.content.slice(0, 80)}`);
      }
    } else if (signal.direction === 'outbound') {
      // Outbound = "You asked X to do Y" — already captured as signal, no intent needed
      console.log(`[action-extractor] Outbound action noted (signal-only): ${signal.content.slice(0, 80)}`);
    }
  }

  // Fuzzy-match participant names to signal.contacts (best-effort)
  try {
    await matchParticipantsToContacts(messageId, ownerOrgId);
  } catch (err) {
    console.warn(`[action-extractor] Contact matching failed (non-fatal): ${err.message}`);
  }

  console.log(`[action-extractor] Done: ${intentsCreated} intent(s) created from ${signals.length} signal(s)`);
  return { intentsCreated, signalsFound: signals.length };
}

/**
 * Resolve action-item mentions ("assigned to Sarah") to signal.contacts using
 * the shared participant resolver. Primary transcript participants are now
 * captured at ingest time via lib/rag/participants/resolver.js; this pass picks
 * up additional people mentioned inside action items.
 *
 * Note: resolver only creates contacts when an email is available. Name-only
 * mentions lookup existing contacts by fuzzy-match; unresolved ones are
 * intentionally not persisted to avoid polluting signal.contacts with
 * low-confidence entries.
 */
async function matchParticipantsToContacts(messageId, ownerOrgId = CURRENT_ORG_ID) {
  const { resolveAndUpsert } = await import('../rag/participants/resolver.js');

  // Org-scope the whole burst: the inbox.signals read plus resolveAndUpsert's internal
  // signal.contacts fuzzy-match reads and upserts are all org-keyed. No network await sits
  // inside, so a single scope bracket is V-9 compliant (no connection held across I/O).
  await withTranscriptOrgScope(ownerOrgId, async (exec) => {
    const signalResult = await exec(
      `SELECT content FROM inbox.signals
       WHERE message_id = $1 AND signal_type IN ('action_item', 'commitment')`,
      [messageId]
    );

    const namePatterns = /(?:assigned to|from|by|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
    const mentionedNames = new Set();
    for (const sig of signalResult.rows) {
      let m;
      while ((m = namePatterns.exec(sig.content)) !== null) {
        mentionedNames.add(m[1].trim());
      }
    }

    if (mentionedNames.size === 0) return;

    const raw = [...mentionedNames].map(name => ({ name, role: 'speaker' }));
    await resolveAndUpsert(raw, {}, exec);
  });
}
