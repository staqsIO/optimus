/**
 * Email Signature Parser — Enrichment Provider 1 (OPT-71)
 *
 * First-party, zero-cost, no API key required.
 * Highest ROI: immediately fills empty profiles using signatures already in
 * inbox.messages (snippet) or raw body text passed in.
 *
 * What it extracts:
 *   - title     : job title / role (e.g. "VP of Sales", "Software Engineer")
 *   - phone     : E.164-normalised phone number
 *   - company   : company / organisation name
 *   - linkedin  : LinkedIn profile URL
 *
 * Implements the EnrichmentProvider interface from lib/enrichment/provider.js.
 *
 * Heuristic approach:
 *   Signatures usually appear after "--", "—", "Regards," etc.
 *   We look for structural cues then apply targeted regexes per field.
 *   Confidence is intentionally conservative — a heuristic match on
 *   ambiguous text gets 0.6; a clearly-structured field gets 0.85.
 *
 * Basis for processing: legitimate interests (Optimus inbox-management service).
 * Data sourced from email bodies the user has already received — no external
 * calls, no data egress.
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'enrichment/email-signature-parser' });

export const PROVIDER_NAME = 'email_signature_parser';

// ── Signature-block boundary patterns ───────────────────────────────────────

const SIGNATURE_DELIMITERS = [
  /^--\s*$/m,                           // RFC 3676 "-- "
  /^—+\s*$/m,                           // em-dash rule
  /^\s*(best(?: regards)?|regards|thanks|thank you|cheers|sincerely|warm(ly)?|yours truly)[,.]?\s*$/im,
  /^\s*(sent from (?:my )?(?:iphone|ipad|android|samsung))/im,
];

// Title keywords that raise confidence a line is a job title.
const TITLE_KEYWORDS = [
  'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cso', 'vp', 'svp', 'evp',
  'president', 'founder', 'co-founder', 'director', 'manager', 'lead',
  'engineer', 'architect', 'analyst', 'consultant', 'advisor', 'partner',
  'associate', 'specialist', 'coordinator', 'officer', 'principal',
  'head of', 'chief', 'senior', 'junior', 'staff', 'intern',
];

// ── Regexes ─────────────────────────────────────────────────────────────────

// Phone: matches common formats (US and international +CC ...).
// Two patterns tried in order:
//   1. International: +<country-code> followed by 6-14 digits / separators
//   2. US domestic: (NNN) NNN-NNNN or NNN.NNN.NNNN etc.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?:\s*(?:x|ext)\.?\s*\d+)?/g;

// LinkedIn
const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i;

// Title heuristic: a short line (≤60 chars) that contains a title keyword
// and does NOT look like a phone number or URL.
const TITLE_LINE_RE = /^.{3,60}$/;

// ── Normalizers ──────────────────────────────────────────────────────────────

/**
 * Best-effort normalise a raw phone string to E.164 (US-centric).
 * Returns null if it cannot be normalised to 10+ digits.
 */
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length > 11) return `+${digits}`; // international
  return null;
}

// ── Signature extraction ─────────────────────────────────────────────────────

/**
 * Extract the signature block from a plain-text email body.
 * Returns the lines after the first delimiter, or the last N lines as fallback.
 *
 * @param {string} text
 * @returns {string[]} lines of the (candidate) signature block
 */
export function extractSignatureBlock(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    for (const re of SIGNATURE_DELIMITERS) {
      if (re.test(lines[i])) {
        // Skip the delimiter line itself; return the rest
        return lines.slice(i + 1).filter((l) => l.trim().length > 0);
      }
    }
  }

  // Fallback: last 8 non-empty lines (common email client behaviour)
  return lines.filter((l) => l.trim().length > 0).slice(-8);
}

/**
 * Parse structured fields out of signature lines.
 *
 * @param {string[]} sigLines - Lines from extractSignatureBlock
 * @returns {{ title?, phone?, company?, linkedin? }} raw extracted values
 */
export function parseSignatureFields(sigLines) {
  const result = {};
  const joined = sigLines.join('\n');

  // LinkedIn — easy, very specific pattern
  const linkedinMatch = joined.match(LINKEDIN_RE);
  if (linkedinMatch) {
    result.linkedin = linkedinMatch[0].replace(/\/$/, '');
  }

  // Phone — first E.164-normalisable number found
  const phoneMatches = joined.matchAll(PHONE_RE);
  for (const m of phoneMatches) {
    const normalised = normalizePhone(m[0]);
    if (normalised) {
      result.phone = normalised;
      break;
    }
  }

  // Title + company — heuristic scan over short lines
  const candidateLines = sigLines.filter(
    (l) => TITLE_LINE_RE.test(l.trim()) && !/^https?:\/\//.test(l.trim()),
  );

  for (const line of candidateLines) {
    const lower = line.toLowerCase();

    // Skip lines that look like phone/email/url
    if (/\d{3}[\s.-]\d{3}/.test(line)) continue;
    if (/@/.test(line)) continue;

    const hasKeyword = TITLE_KEYWORDS.some((kw) => lower.includes(kw));

    if (hasKeyword && !result.title) {
      // If line has " at " or " | " it might be "Title | Company" or "Title at Company"
      const atSplit = line.split(/\s+at\s+/i);
      const pipeSplit = line.split(/\s*[|·•]\s*/);

      if (atSplit.length === 2) {
        result.title = atSplit[0].trim();
        if (!result.company) result.company = atSplit[1].trim();
      } else if (pipeSplit.length >= 2) {
        result.title = pipeSplit[0].trim();
        if (!result.company && pipeSplit[1].trim().length > 1) {
          result.company = pipeSplit[1].trim();
        }
      } else {
        result.title = line.trim();
      }
    } else if (!hasKeyword && !result.company && candidateLines.indexOf(line) > 0) {
      // A non-title-keyword short line after the name line → likely company
      result.company = line.trim();
    }
  }

  return result;
}

// ── EnrichmentProvider implementation ───────────────────────────────────────

/**
 * Create the email-signature-parser enrichment provider.
 *
 * @param {Function} [fetchSnippets] - async (emailAddress) => string[]
 *   Injected fetcher for signatures. In production, queries inbox.messages.
 *   In tests, supply a stub that returns fixture snippets.
 *
 * @returns {EnrichmentProvider}
 */
export function createEmailSignatureProvider(fetchSnippets) {
  return {
    name: PROVIDER_NAME,

    // No external API key required — always available
    isAvailable() {
      return true;
    },

    /**
     * Enrich an entity using email-signature heuristics.
     *
     * @param {object} entity   - { id, email_address, ... }
     * @param {object} opts     - { fields: string[] }
     * @returns {Promise<EnrichResult>}
     */
    async enrich(entity, { fields }) {
      const email = entity.email_address;
      if (!email) {
        log.debug({ entityId: entity.id }, 'no email_address on entity — skipping signature parse');
        return { fields: {} };
      }

      // Fetch message snippets for this sender
      let snippets = [];
      try {
        snippets = await fetchSnippets(email);
      } catch (err) {
        log.warn({ email, err }, 'fetchSnippets failed');
        return { fields: {} };
      }

      if (!snippets || snippets.length === 0) {
        return { fields: {} };
      }

      // Parse all snippets and pick the richest result per field
      const candidates = {};
      for (const snippet of snippets) {
        const sigBlock = extractSignatureBlock(snippet);
        const parsed = parseSignatureFields(sigBlock);
        for (const [k, v] of Object.entries(parsed)) {
          if (!candidates[k]) candidates[k] = [];
          candidates[k].push(v);
        }
      }

      // Majority-vote: pick the most common value per field
      const now = new Date().toISOString();
      const enriched = {};

      for (const field of fields) {
        const vals = candidates[field];
        if (!vals || vals.length === 0) continue;

        // Count occurrences
        const counts = {};
        for (const v of vals) {
          counts[v] = (counts[v] || 0) + 1;
        }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        const [value, count] = best;

        // Confidence scales with consensus: 1 snippet = 0.6, majority = 0.85
        const confidence = count === 1
          ? 0.60
          : count / snippets.length >= 0.6 ? 0.85 : 0.72;

        enriched[field] = {
          value,
          source: PROVIDER_NAME,
          confidence,
          fetched_at: now,
        };
      }

      log.debug({ entityId: entity.id, extracted: Object.keys(enriched) }, 'signature parse complete');
      return { fields: enriched };
    },
  };
}

/**
 * Build the production fetchSnippets function backed by the real DB.
 * Queries inbox.messages snippets for emails FROM the given address.
 *
 * @param {Function} query - DB query function (parameterised)
 * @returns {Function} async (emailAddress) => string[]
 */
export function buildDbFetchSnippets(query) {
  return async function fetchSnippets(emailAddress) {
    const res = await query(
      `SELECT snippet
         FROM inbox.messages
        WHERE sender_email = $1
          AND snippet IS NOT NULL
          AND snippet <> ''
        ORDER BY received_at DESC
        LIMIT 20`,
      [emailAddress],
    );
    return res.rows.map((r) => r.snippet).filter(Boolean);
  };
}
