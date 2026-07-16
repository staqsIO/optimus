import { query } from '../db.js';

/**
 * Relationship graph: contacts with interaction metrics and VIP status.
 */

/**
 * Get all contacts sorted by interaction frequency.
 */
export async function getContacts({ vipOnly = false, limit = 50 } = {}) {
  let sql = `SELECT * FROM signal.contacts`;
  const params = [];

  if (vipOnly) {
    sql += ` WHERE is_vip = true`;
  }

  sql += ` ORDER BY (emails_received + emails_sent) DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Set a contact as VIP.
 */
export async function setVip(emailAddress, isVip, reason = null) {
  await query(
    `UPDATE signal.contacts SET is_vip = $1, vip_reason = $2, updated_at = now()
     WHERE email_address = $3`,
    [isVip, reason, emailAddress]
  );
}

/**
 * Update contact type classification.
 */
export async function classifyContact(emailAddress, contactType) {
  await query(
    `UPDATE signal.contacts SET contact_type = $1, updated_at = now()
     WHERE email_address = $2`,
    [contactType, emailAddress]
  );
}

/**
 * Compute and update the tier for a contact based on interaction patterns.
 * Canonical rules are documented in sql/030-contact-classification.sql.
 * Called after upsertContact on every triage (ADR-014).
 */
export async function computeTier(emailAddress) {
  const result = await query(
    `SELECT email_address, emails_received, emails_sent, avg_response_time_hours
     FROM signal.contacts WHERE email_address = $1`,
    [emailAddress]
  );
  const c = result.rows[0];
  if (!c) return;

  const addr = c.email_address.toLowerCase();

  let tier;
  if (/noreply|no-reply|notifications@|automated@|mailer-daemon/i.test(addr)) {
    tier = 'automated';
  } else if ((c.emails_received || 0) > 3 && (c.emails_sent || 0) === 0) {
    tier = 'newsletter';
  } else if ((c.emails_received || 0) > 0 && (c.emails_sent || 0) === 0) {
    tier = 'inbound_only';
  } else if ((c.emails_received || 0) > 0 && (c.emails_sent || 0) > 0) {
    const total = (c.emails_received || 0) + (c.emails_sent || 0);
    const fastResponse = c.avg_response_time_hours != null && c.avg_response_time_hours < 24;
    tier = (total > 10 && fastResponse) ? 'inner_circle' : 'active';
  } else {
    tier = 'unknown';
  }

  await query(
    `UPDATE signal.contacts SET tier = $1, updated_at = now() WHERE email_address = $2`,
    [tier, emailAddress]
  );
}

/**
 * Get interaction summary for a contact.
 */
export async function getContactSummary(emailAddress) {
  const contact = await query(
    `SELECT * FROM signal.contacts WHERE email_address = $1`,
    [emailAddress]
  );

  const recentEmails = await query(
    `SELECT id, subject, received_at, triage_category
     FROM inbox.messages
     WHERE from_address = $1
     ORDER BY received_at DESC LIMIT 10`,
    [emailAddress]
  );

  const signals = await query(
    `SELECT s.* FROM inbox.signals s
     JOIN inbox.messages m ON s.message_id = m.id
     WHERE m.from_address = $1
     ORDER BY s.created_at DESC LIMIT 20`,
    [emailAddress]
  );

  return {
    contact: contact.rows[0] || null,
    recentEmails: recentEmails.rows,
    signals: signals.rows,
  };
}
