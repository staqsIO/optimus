import { query, withTransaction } from '../db.js';
import { isPhase3Active } from '../runtime/phase-manager.js';

/**
 * Communication Gateway (spec §7)
 * Highest-risk component. Agents submit structured intents.
 * Gateway classifies, sanitizes, scans, and routes.
 * Agents NEVER hold communication credentials.
 *
 * Risk-tiered release:
 * Tier 0: Transactional (auto-send, <200ms) — payment receipts, API confirmations
 * Tier 1: Operational (auto-send, <200ms) — changelog, status updates
 * Tier 2: Relational (quorum review 3 agents, 2/3 approval) — support replies, vendor outreach
 * Tier 3: Reputational (human-in-the-loop, <24h SLA) — marketing, public statements
 * Tier 4: Legal/Regulatory (human + counsel, <72h SLA) — regulatory responses, contracts
 *
 * Phase 3 activation:
 *   - Tier 2 auto-processes via quorum review (3 agents, 2/3 approval)
 *   - Tier 3-4 remain human-in-the-loop (no change)
 */

const TIER_CONFIG = {
  0: { name: 'Transactional', autoSend: true, coolDownMinutes: 0, requiresApproval: false },
  1: { name: 'Operational', autoSend: true, coolDownMinutes: 0, requiresApproval: false },
  2: { name: 'Relational', autoSend: false, coolDownMinutes: 5, requiresApproval: true, quorumSize: 3, quorumThreshold: 2 },
  3: { name: 'Reputational', autoSend: false, coolDownMinutes: 5, requiresApproval: true, humanRequired: true },
  4: { name: 'Legal/Regulatory', autoSend: false, coolDownMinutes: 5, requiresApproval: true, humanRequired: true, counselRequired: true },
};

// Submit a communication intent (called by agents)
export async function submitIntent({ channel, recipient, subject, body, intentType, sourceAgent, sourceTask, riskTier }) {
  // Risk tier is a FLOOR, not a ceiling (P1 deny-by-default): a caller may only
  // RAISE the tier above what classification determined, never lower it. An agent
  // labelling a Tier-4 (legal/contract) body as Tier 0 still gets Tier 4.
  const classified = classifyRiskTier(body, recipient, intentType);
  const tier = Math.max(classified, riskTier ?? classified);
  const config = TIER_CONFIG[tier];

  // Check rate limits
  const rateLimited = await checkRateLimit(sourceAgent, recipient);
  if (rateLimited) {
    return { id: null, status: 'rate_limited', reason: rateLimited };
  }

  // Check consent
  const hasConsent = await checkConsent(recipient, channel);

  // Add AI disclosure
  const disclosure = await getAiDisclosure(channel);
  const bodyWithDisclosure = disclosure ? `${body}\n\n---\n${disclosure}` : body;

  // Compute cool-down expiry
  const coolDownExpires = config.coolDownMinutes > 0
    ? new Date(Date.now() + config.coolDownMinutes * 60000).toISOString()
    : null;

  // Determine initial status
  let status = 'logged';
  const phase3 = await isPhase3Active();
  if (config.autoSend && hasConsent) {
    if (tier <= 1) {
      status = 'approved'; // Tier 0-1: auto-approve in all phases
    } else if (tier === 2 && phase3) {
      status = 'pending_quorum'; // Phase 3: Tier 2 auto-processes via quorum review
    }
    // Tier 3-4: remain 'logged' (human-in-the-loop)
  }

  try {
    const result = await query(
      `INSERT INTO autobot_comms.outbound_intents
       (channel, recipient, subject, body, intent_type, status, source_agent, source_task,
        risk_tier, category, ai_disclosure_added, cool_down_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [channel, recipient, subject, bodyWithDisclosure, intentType, status,
       sourceAgent, sourceTask, tier, tierToCategory(tier), !!disclosure, coolDownExpires]
    );

    const intentId = result.rows[0]?.id;

    // Phase 3: Tier 2 intents automatically enter quorum review
    if (status === 'pending_quorum' && intentId) {
      // Fire-and-forget quorum initiation -- errors are non-fatal
      requestQuorumReview(intentId, config.quorumSize || 3, config.quorumThreshold || 2).catch(() => {});
    }

    return {
      id: intentId,
      status,
      riskTier: tier,
      tierName: config.name,
      autoSend: config.autoSend && (tier <= 1 || (tier === 2 && phase3)),
      coolDownExpires,
      aiDisclosureAdded: !!disclosure,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { id: null, status: 'schema_not_ready' };
    }
    throw err;
  }
}

// Process inbound message through deterministic pipeline
export async function processInbound({ channel, sender, rawContentHash, structuredExtraction }) {
  try {
    const result = await query(
      `INSERT INTO autobot_comms.inbound_messages
       (channel, sender, sender_verified, raw_content_hash, structured_extraction)
       VALUES ($1, $2, false, $3, $4)
       RETURNING id`,
      [channel, sender, rawContentHash, JSON.stringify(structuredExtraction)]
    );
    return { id: result.rows[0]?.id, processed: true };
  } catch (err) {
    if (err.message?.includes('does not exist')) return { id: null, processed: false };
    throw err;
  }
}

// Classify risk tier based on content analysis
function classifyRiskTier(body, recipient, intentType) {
  const lower = (body || '').toLowerCase();

  // Tier 4: legal/regulatory keywords
  if (/\b(contract|agreement|binding|regulatory|compliance|subpoena|litigation)\b/i.test(lower)) return 4;

  // Tier 3: reputational/public-facing
  if (/\b(press release|announcement|public statement|marketing|campaign)\b/i.test(lower)) return 3;

  // Tier 2: relational (replies to people)
  if (intentType === 'send' || /\b(thank you|follow up|meeting|schedule|proposal)\b/i.test(lower)) return 2;

  // Tier 1: operational (notifications)
  if (intentType === 'notification') return 1;

  // Tier 0: transactional (receipts, confirmations)
  if (/\b(receipt|confirmation|invoice|payment)\b/i.test(lower)) return 0;

  return 2; // Default to relational (conservative)
}

function tierToCategory(tier) {
  const map = { 0: 'transactional', 1: 'operational', 2: 'relational', 3: 'reputational', 4: 'legal_regulatory' };
  return map[tier] || 'operational';
}

async function checkRateLimit(agentId, recipient) {
  try {
    // Check per-recipient rate
    const recipientCheck = await query(
      `SELECT current_count, max_messages, window_start
       FROM autobot_comms.rate_limits
       WHERE scope = 'recipient' AND scope_id = $1`,
      [recipient]
    );

    if (recipientCheck.rows[0]) {
      const { current_count, max_messages, window_start } = recipientCheck.rows[0];
      const windowExpired = new Date(window_start) < new Date(Date.now() - 24 * 60 * 60000);

      if (!windowExpired && parseInt(current_count) >= parseInt(max_messages)) {
        return `Rate limit exceeded for recipient ${recipient}: ${current_count}/${max_messages} in window`;
      }
    }
    return null;
  } catch {
    // Fail CLOSED (P1): a DB error must not silently disable rate limiting.
    // Mirrors guard-check.js's G6 limiter, which also denies on error.
    return 'Rate limit check failed (fail-closed): could not verify recipient limits';
  }
}

async function checkConsent(recipient, channel) {
  try {
    const result = await query(
      `SELECT consent_given FROM autobot_comms.consent_registry cr
       JOIN autobot_comms.contact_registry c ON cr.contact_id = c.id
       WHERE c.email = $1 AND cr.channel = $2 AND cr.opt_out_date IS NULL`,
      [recipient, channel]
    );
    // If no consent record exists, default to true (existing business relationship)
    return result.rows.length === 0 || result.rows[0]?.consent_given;
  } catch {
    // Fail CLOSED (P1): a DB error must not be treated as consent granted.
    return false;
  }
}

// Safe default disclosure appended when the channel-specific lookup fails (see
// catch below). Unlike checkRateLimit/checkConsent -- which deny the action --
// disclosure text has no safe "absent" value, so a DB error falls back to this
// generic text rather than to null.
const AI_DISCLOSURE_FALLBACK = 'This message was generated with the assistance of an AI system.';

async function getAiDisclosure(channel) {
  try {
    const result = await query(
      `SELECT disclosure_text FROM autobot_comms.ai_disclosures
       WHERE channel = $1 AND is_active = true LIMIT 1`,
      [channel]
    );
    return result.rows[0]?.disclosure_text || null;
  } catch {
    // Fail CLOSED (P1): a DB error must never silently release a message
    // without AI-disclosure text appended (legally-relevant field). Mirrors
    // the fail-closed posture checkRateLimit/checkConsent established in #497.
    return AI_DISCLOSURE_FALLBACK;
  }
}

/**
 * Request quorum review for a Tier 2 intent.
 * Creates a quorum record and waits for agent votes.
 * 3 agents, 2/3 approval required (configurable).
 *
 * @param {string} intentId - Outbound intent ID.
 * @param {number} quorumSize - Number of agents in the quorum (default 3).
 * @param {number} quorumThreshold - Minimum approvals needed (default 2).
 * @returns {Promise<{requested: boolean, intentId: string}>}
 */
export async function requestQuorumReview(intentId, quorumSize = 3, quorumThreshold = 2) {
  try {
    // Record quorum request in intent metadata
    await query(
      `UPDATE autobot_comms.outbound_intents
       SET quorum_approvals = $1
       WHERE id = $2`,
      [JSON.stringify({ requested: true, quorumSize, quorumThreshold, votes: [], status: 'pending' }), intentId]
    );

    return { requested: true, intentId };
  } catch (err) {
    if (err.message?.includes('does not exist')) return { requested: false, intentId };
    throw err;
  }
}

/**
 * Submit a quorum vote for a Tier 2 intent.
 * When threshold is met, auto-approves the intent.
 *
 * @param {string} intentId - Outbound intent ID.
 * @param {string} agentId - Voting agent.
 * @param {'approve'|'reject'} vote - The vote.
 * @param {string} [reason] - Optional rationale.
 * @returns {Promise<{voted: boolean, approved: boolean|null, votes: Array}>}
 */
export async function submitQuorumVote(intentId, agentId, vote, reason) {
  try {
    // Use transaction with SELECT FOR UPDATE to prevent TOCTOU race condition
    return await withTransaction(async (client) => {
      // Lock the row to prevent concurrent vote modifications
      const result = await client.query(
        `SELECT quorum_approvals FROM autobot_comms.outbound_intents WHERE id = $1 FOR UPDATE`,
        [intentId]
      );

      if (result.rows.length === 0) return { voted: false, approved: null, votes: [] };

      const quorum = result.rows[0].quorum_approvals || {};
      if (quorum.status !== 'pending') return { voted: false, approved: null, votes: quorum.votes || [] };

      const votes = quorum.votes || [];

      // Prevent duplicate votes
      if (votes.some(v => v.agentId === agentId)) {
        return { voted: false, approved: null, votes, reason: 'Already voted' };
      }

      votes.push({ agentId, vote, reason: reason || null, votedAt: new Date().toISOString() });

      const approvals = votes.filter(v => v.vote === 'approve').length;
      const rejections = votes.filter(v => v.vote === 'reject').length;
      const threshold = quorum.quorumThreshold || 2;
      const quorumSize = quorum.quorumSize || 3;

      let approved = null;
      let newStatus = 'pending';
      let intentStatus = null;

      if (approvals >= threshold) {
        approved = true;
        newStatus = 'approved';
        intentStatus = 'approved';
      } else if (rejections > quorumSize - threshold) {
        approved = false;
        newStatus = 'rejected';
        intentStatus = 'rejected';
      }

      // Update quorum state + intent status atomically
      const updateFields = intentStatus
        ? `quorum_approvals = $1, status = $3`
        : `quorum_approvals = $1`;
      const updateParams = intentStatus
        ? [JSON.stringify({ ...quorum, votes, status: newStatus }), intentId, intentStatus]
        : [JSON.stringify({ ...quorum, votes, status: newStatus }), intentId];

      await client.query(
        `UPDATE autobot_comms.outbound_intents SET ${updateFields} WHERE id = $2`,
        updateParams
      );

      return { voted: true, approved, votes };
    });
  } catch (err) {
    if (err.message?.includes('does not exist')) return { voted: false, approved: null, votes: [] };
    throw err;
  }
}

// Get gateway status summary
export async function getGatewayStatus() {
  try {
    const [intents, rateStatus] = await Promise.all([
      query(`SELECT status, risk_tier, COUNT(*) as count
             FROM autobot_comms.outbound_intents
             WHERE created_at > now() - interval '24 hours'
             GROUP BY status, risk_tier`),
      query(`SELECT scope, scope_id, current_count, max_messages
             FROM autobot_comms.rate_limits
             WHERE current_count > 0`),
    ]);

    return {
      last24h: intents.rows,
      activeLimits: rateStatus.rows,
    };
  } catch { return { last24h: [], activeLimits: [] }; }
}
