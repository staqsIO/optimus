/**
 * Priority scorer: heuristic pre-scoring before strategist LLM analysis.
 * Cheap scoring for routing decisions. Strategist does the real analysis.
 */

/**
 * Quick priority score based on heuristics (0-100).
 * Used to order work queue before strategist analysis.
 */
export function quickScore(email, contact = null) {
  let score = 50; // Base score

  // VIP boost
  if (contact?.is_vip) score += 30;

  // Contact type boost (ADR-014: 15 types)
  const typeBoosts = {
    cofounder: 35,
    board: 30,
    investor: 25,
    customer: 20,
    team: 15,
    advisor: 15,
    prospect: 12,
    partner: 10,
    legal: 10,
    accountant: 8,
    vendor: 5,
    recruiter: -10,
    service: -15,
    newsletter: -20,
    unknown: 0,
  };
  score += typeBoosts[contact?.contact_type] || 0;

  // Tier boost (ADR-014: computed from interaction patterns)
  const tierBoosts = { inner_circle: 15, active: 5, inbound_only: 0, automated: -15, unknown: 0 };
  score += tierBoosts[contact?.tier] || 0;

  // Recency boost (emails from frequent contacts are higher priority)
  if (contact?.emails_received > 20) score += 5;
  if (contact?.emails_received > 50) score += 5;

  // Subject keywords
  const subject = (email.subject || '').toLowerCase();
  if (/urgent|asap|critical|emergency/i.test(subject)) score += 20;
  if (/invoice|payment|contract/i.test(subject)) score += 15;
  if (/meeting|call|schedule/i.test(subject)) score += 10;
  if (/re:|fwd:/i.test(subject)) score += 5; // Part of ongoing thread

  // Label-based adjustments
  if ((email.labels || []).includes('IMPORTANT')) score += 10;
  if ((email.labels || []).includes('CATEGORY_PROMOTIONS')) score -= 20;
  if ((email.labels || []).includes('CATEGORY_SOCIAL')) score -= 15;

  return Math.max(0, Math.min(100, score));
}
