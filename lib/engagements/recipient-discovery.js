/**
 * Suggest recipients for a contract draft.
 *
 * Pulls candidate signers from four sources so the send-for-signature form
 * doesn't start empty:
 *
 *  - primary  → the counterparty's primary signer (from content.counterparties)
 *  - proposal → emails extracted from the engagement's ingested proposals + the
 *               source generated proposal's markdown (skipping role addresses
 *               and our own domain)
 *  - signal   → signal.contacts whose email shares the counterparty's domain;
 *               ordered by recent activity, capped to keep the list scannable
 *  - internal → active board_members for the UMB countersign step
 *
 * Empty arrays where a source isn't applicable (e.g., no counterparty linked,
 * counterparty has no domain). The endpoint always returns the four keys so
 * the UI can render fixed sections without nullish-guards everywhere.
 */

import { query } from '../db.js';
// STAQPRO-579: consume the canonical entity-type registry instead of
// inventing engagement-local type strings. lib/graph/schema.js owns these
// names; the dependency-free ./entity-types.js module holds the definitions so
// importing them here adds no Neo4j-driver coupling. See lib/graph/OWNERSHIP.md.
import { ENTITY_TYPES } from '../graph/entity-types.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const ROLE_PREFIXES = new Set([
  'noreply', 'no-reply', 'do-not-reply', 'donotreply',
  'mailer-daemon', 'postmaster', 'bounce', 'bounces',
  'info', 'support', 'help', 'contact', 'hello', 'team',
  'notifications', 'notification', 'alert', 'alerts',
  'admin', 'webmaster', 'sales',
]);

// Own-domain filter — we don't want to suggest staqs.io people as
// "client recipients". They land in the internal section instead.
const OWN_DOMAINS = new Set(['staqs.io', 'staqsio.com']);

function looksLikeRoleAddress(email) {
  const local = email.split('@')[0]?.toLowerCase() || '';
  if (!local) return true;
  if (ROLE_PREFIXES.has(local)) return true;
  // Numeric-only prefixes are almost always ticket-system bounces.
  if (/^\d+$/.test(local)) return true;
  return false;
}

function emailDomain(email) {
  return (email.split('@')[1] || '').toLowerCase();
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function extractEmailsFromMarkdown(md) {
  if (!md) return [];
  const matches = md.match(EMAIL_RE) || [];
  return matches.map((m) => m.trim()).filter(Boolean);
}

/**
 * Given a contract draft id, returns 4 lists of suggested recipients.
 */
export async function suggestRecipientsForContract(draftId) {
  if (!draftId) throw new Error('draftId is required');

  // Pull the draft + counterparty + engagement linkage in one shot.
  const draftRow = await query(
    `SELECT d.id, d.engagement_id, d.source_generated_proposal_id,
            d.counterparty_id, d.seo_metadata,
            cp.name AS cp_name, cp.domain AS cp_domain,
            cp.primary_signer_name, cp.primary_signer_email, cp.primary_signer_title
       FROM content.drafts d
       LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
      WHERE d.id = $1
      LIMIT 1`,
    [draftId]
  );
  const draft = draftRow.rows[0];
  if (!draft) {
    const err = new Error('contract draft not found');
    err.statusCode = 404;
    throw err;
  }

  const cpDomain = (draft.cp_domain || '').toLowerCase().trim() || null;

  // -------- PRIMARY ----------
  // Prefer the counterparty's primary signer. Fall back to seo_metadata for
  // contracts created before counterparties were extracted (migration 065).
  const meta = typeof draft.seo_metadata === 'string'
    ? JSON.parse(draft.seo_metadata || '{}')
    : (draft.seo_metadata || {});

  const primaryEmail = (draft.primary_signer_email || meta.signer_email || '').toLowerCase().trim();
  const primaryName = draft.primary_signer_name || meta.signer_name || '';
  const primary = primaryEmail
    ? [{
        name: primaryName || primaryEmail.split('@')[0],
        email: primaryEmail,
        source: 'primary',
        note: draft.primary_signer_title || null,
        default_selected: true,
      }]
    : [];

  const excluded = new Set([primaryEmail].filter(Boolean));

  // -------- PROPOSAL-EXTRACTED ----------
  // Scan every ingested proposal markdown + the source generated proposal
  // markdown for email addresses. Dedupe, drop role addresses + own domain
  // + the primary we already have.
  let proposal = [];
  if (draft.engagement_id) {
    const proposalBodiesRow = await query(
      `SELECT parsed_markdown FROM engagements.proposals
        WHERE engagement_id = $1`,
      [draft.engagement_id]
    );
    const bodies = proposalBodiesRow.rows.map((r) => r.parsed_markdown);
    if (draft.source_generated_proposal_id) {
      const gp = await query(
        `SELECT markdown FROM engagements.generated_proposals WHERE id = $1`,
        [draft.source_generated_proposal_id]
      );
      if (gp.rows[0]?.markdown) bodies.push(gp.rows[0].markdown);
    }
    const found = [];
    for (const md of bodies) {
      for (const raw of extractEmailsFromMarkdown(md)) {
        const email = raw.toLowerCase();
        if (excluded.has(email)) continue;
        if (looksLikeRoleAddress(email)) continue;
        const domain = emailDomain(email);
        if (OWN_DOMAINS.has(domain)) continue;
        found.push({
          name: email.split('@')[0],
          email,
          source: 'proposal',
          note: 'extracted from engagement documents',
          default_selected: false,
        });
      }
    }
    proposal = dedupeBy(found, (r) => r.email);
  }
  // Mark proposal emails as excluded so signal lookup doesn't double-list them.
  for (const r of proposal) excluded.add(r.email);

  // -------- SIGNAL CONTACTS ----------
  // Only meaningful if we know the counterparty's domain. Pull the most
  // recently active contacts at that domain; the inner_circle / active tier
  // get priority.
  let signal = [];
  if (cpDomain) {
    const sigRow = await query(
      `SELECT email_address, name, tier, last_received_at, last_sent_at
         FROM signal.contacts
        WHERE lower(split_part(email_address, '@', 2)) = $1
        ORDER BY
          CASE tier WHEN 'inner_circle' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
          GREATEST(
            COALESCE(last_received_at, 'epoch'::timestamptz),
            COALESCE(last_sent_at, 'epoch'::timestamptz)
          ) DESC
        LIMIT 20`,
      [cpDomain]
    );
    signal = sigRow.rows
      .map((r) => ({
        name: r.name || r.email_address.split('@')[0],
        email: r.email_address.toLowerCase(),
        source: 'signal',
        note: r.tier && r.tier !== 'unknown' ? r.tier.replace('_', ' ') : null,
        default_selected: false,
      }))
      .filter((r) => !excluded.has(r.email) && !looksLikeRoleAddress(r.email));
  }

  // -------- INTERNAL (board) ----------
  const internalRow = await query(
    `SELECT github_username, display_name, email
       FROM agent_graph.board_members
      WHERE is_active = true
      ORDER BY created_at`
  );
  const internal = internalRow.rows.map((r) => ({
    name: r.display_name || r.github_username,
    email: r.email || `${r.github_username}@staqs.io`,
    source: 'internal',
    note: r.github_username,
    default_selected: true, // UMB countersigns by default
    github_username: r.github_username,
  }));

  // Tag every suggested recipient with its canonical entity type from the
  // registry owned by lib/graph/schema.js (STAQPRO-579). All four buckets are
  // people (Person); they differ by org affiliation, not entity type. This is
  // an additive field — existing consumers that read name/email/source/note
  // are unaffected. It gives downstream callers (and the graph) a single
  // vocabulary for "what kind of thing is this" instead of an engagement-local
  // ad-hoc string.
  const withType = (r) => ({ ...r, entityType: ENTITY_TYPES.PERSON });
  const tag = (list) => list.map(withType);
  return {
    // `primary` is a single object or null; the other three are arrays.
    primary: primary ? withType(primary) : null,
    proposal: tag(proposal),
    signal: tag(signal),
    internal: tag(internal),
  };
}
