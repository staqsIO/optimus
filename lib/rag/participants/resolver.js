/**
 * Participant resolver — turns RawParticipant[] into ParticipantRecord[]
 * and keeps signal.contacts + signal.contact_accounts in sync.
 *
 * ParticipantRecord = {
 *   contact_id: string|null,  // null = unresolved name-only entry
 *   name: string|null,
 *   email: string|null,
 *   role: string,
 *   confidence: 'exact' | 'fuzzy' | 'unresolved'
 * }
 *
 * Resolution order:
 *   1. Exact email match on signal.contacts.email_address (confidence='exact')
 *   2. Fuzzy name match when no email is available (confidence='fuzzy')
 *   3. Create new contact when we have an email (confidence='exact')
 *   4. Give up — return contact_id=null (confidence='unresolved')
 */

import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('rag/participants/resolver');

/**
 * Normalize a name for comparison: lowercase, strip punctuation, collapse whitespace.
 */
function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return the last whitespace-separated token of a normalized name as a rough
 * surname. "john r. smith" → "smith", "cher" → "cher".
 */
function surname(name) {
  const n = normalizeName(name);
  if (!n) return '';
  const parts = n.split(' ');
  return parts[parts.length - 1];
}

/**
 * Deduplicate a raw participant list in memory before hitting the DB.
 * Prefer the entry with the most info (email > name only).
 */
function dedupeRaw(raw) {
  const out = new Map();
  for (const r of raw || []) {
    const key = (r.email || normalizeName(r.name) || '').toLowerCase();
    if (!key) continue;
    const existing = out.get(key);
    if (!existing) { out.set(key, { ...r }); continue; }
    // Prefer entry with email; otherwise keep the one with a name
    if (!existing.email && r.email) existing.email = r.email;
    if (!existing.name && r.name) existing.name = r.name;
    if ((r.turns || 0) > (existing.turns || 0)) existing.turns = r.turns;
  }
  return [...out.values()];
}

/**
 * Resolve a list of raw participants into records with contact_id where possible.
 * Does NOT write anything — see upsertContactsAndAccounts for that.
 *
 * @param {RawParticipant[]} rawParticipants
 * @param {Function} [exec=query] OPT-166 P2e-E4: injected DB executor. Defaults
 *   to bare `query` (byte-identical/inert for every existing caller); the
 *   calendar poller / ingest writer path injects an org-scoped exec so these
 *   signal.contacts reads survive the RLS pool-flip (bare reads black-hole to 0
 *   rows post-flip → every participant would resolve as unresolved).
 * @returns {Promise<ParticipantRecord[]>}
 */
export async function resolveParticipants(rawParticipants, exec = query) {
  const deduped = dedupeRaw(rawParticipants);
  if (deduped.length === 0) return [];

  const withEmail = deduped.filter(r => r.email);
  const nameOnly = deduped.filter(r => !r.email && r.name);

  // Step 1: exact email lookups in a single round trip
  const emailToContact = new Map();
  if (withEmail.length > 0) {
    const emails = withEmail.map(r => r.email.toLowerCase());
    const result = await exec(
      `SELECT id, email_address, name FROM signal.contacts
       WHERE lower(email_address) = ANY($1::text[])`,
      [emails]
    );
    for (const row of result.rows) {
      emailToContact.set(row.email_address.toLowerCase(), row);
    }
  }

  // Step 2: fuzzy name lookup for name-only entries.
  // Strategy: ILIKE against the full name, else surname match. Single query,
  // returns candidates; pick best in JS.
  const nameCandidates = new Map();
  if (nameOnly.length > 0) {
    const normNames = nameOnly.map(r => normalizeName(r.name)).filter(Boolean);
    const surnames = nameOnly.map(r => surname(r.name)).filter(Boolean);
    const patterns = [
      ...normNames.map(n => `%${n}%`),
      ...surnames.map(s => `% ${s}`),
      ...surnames.map(s => `${s}`),
    ];
    if (patterns.length > 0) {
      const result = await exec(
        `SELECT id, name, email_address FROM signal.contacts
         WHERE name IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM unnest($1::text[]) pat
             WHERE lower(name) LIKE pat
           )`,
        [patterns]
      );
      for (const row of result.rows) {
        if (!row.name) continue;
        nameCandidates.set(normalizeName(row.name), row);
      }
    }
  }

  const records = [];

  for (const r of deduped) {
    if (r.email) {
      const hit = emailToContact.get(r.email.toLowerCase());
      if (hit) {
        records.push({
          contact_id: hit.id,
          name: r.name || hit.name || null,
          email: r.email,
          role: r.role,
          confidence: 'exact',
        });
      } else {
        // No existing contact — we'll create one in the upsert step.
        records.push({
          contact_id: null,
          name: r.name || null,
          email: r.email,
          role: r.role,
          confidence: 'exact',
        });
      }
      continue;
    }

    // Name-only: pick the best fuzzy match
    const norm = normalizeName(r.name);
    let matched = nameCandidates.get(norm);
    if (!matched) {
      // Look for a candidate whose surname matches and whose normalized name
      // is a prefix/suffix of ours (handles "John" → "John Smith")
      const ourSurname = surname(r.name);
      for (const [cNorm, cand] of nameCandidates) {
        if (!cNorm) continue;
        const cSurname = surname(cand.name);
        if (cSurname && cSurname === ourSurname) { matched = cand; break; }
        if (cNorm.startsWith(norm + ' ') || cNorm.endsWith(' ' + norm)) {
          matched = cand;
          break;
        }
      }
    }

    if (matched) {
      records.push({
        contact_id: matched.id,
        name: r.name || matched.name || null,
        email: matched.email_address,
        role: r.role,
        confidence: 'fuzzy',
      });
    } else {
      records.push({
        contact_id: null,
        name: r.name,
        email: null,
        role: r.role,
        confidence: 'unresolved',
      });
    }
  }

  return records;
}

/**
 * Upsert contacts and contact_accounts for the given resolved records.
 * Mutates `records` in place — fills contact_id for records that were previously
 * null when a contact now exists (or is newly created).
 *
 * @param {ParticipantRecord[]} records
 * @param {{ accountId?: string|null, at?: Date|null }} [opts]
 * @param {Function} [exec=query] OPT-166 P2e-E4: injected DB executor. Defaults
 *   to bare `query` (inert). The calendar poller / ingest writer path injects an
 *   org-scoped exec so these signal.contacts writes survive the flip (bare writes
 *   hard-fail 42501 post-flip: the write policy is `visible(NULL,owner_org_id,
 *   false)`, allow_system=FALSE — org scope required, not system).
 */
export async function upsertContactsAndAccounts(records, opts = {}, exec = query) {
  const accountId = opts.accountId || null;
  const at = opts.at ? new Date(opts.at) : new Date();

  // OPT-166 P2e-E4: isolate each write so a single post-flip RLS/constraint
  // denial cannot poison the shared transaction and silently drop the rest of
  // the batch. An injected org-scoped `exec` runs every statement in ONE txn on
  // ONE client — without SAVEPOINTs the first error would put the txn in the
  // aborted (25P02) state, and every subsequent statement (across all remaining
  // records) would throw "current transaction is aborted", eaten by the
  // fail-open catches → the whole batch after the first denial vanishes.
  // SAVEPOINT/ROLLBACK-TO brackets each of the 3 write blocks at the SAME
  // granularity as the existing per-block try/catch (collapsing to one savepoint
  // per record would roll back an already-succeeded contact insert when only the
  // counter bump failed, changing today's semantics). Under the bare-`query`
  // autocommit default there is no transaction, so `SAVEPOINT` is illegal and
  // throws — we detect that (`sp` stays false), skip isolation, and fall back to
  // today's independent-autocommit behaviour → byte-identical for every existing
  // caller. Reads (resolveParticipants) run once before this loop, so only the
  // writes need bracketing.
  async function isolatedWrite(name, fn, onErr) {
    let sp = false;
    try { await exec(`SAVEPOINT ${name}`); sp = true; } catch { /* no txn (bare autocommit) — nothing to isolate */ }
    try {
      await fn();
      if (sp) { try { await exec(`RELEASE SAVEPOINT ${name}`); } catch { /* best-effort */ } }
    } catch (err) {
      if (sp) {
        // ROLLBACK TO recovers the aborted txn; RELEASE then destroys the
        // savepoint so the same name is reusable next iteration without leaking.
        try { await exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* best-effort */ }
        try { await exec(`RELEASE SAVEPOINT ${name}`); } catch { /* best-effort */ }
      }
      onErr(err);
    }
  }

  for (const rec of records) {
    // If we already have a contact_id, we only bump interaction counts.
    // If we have an email but no contact_id, create one.
    // If we have only a name (unresolved), skip contact creation — nothing
    // to anchor on. Upstream "auto-create from tl;dv speakers" is intentionally
    // disabled here because the constraint `email_address NOT NULL UNIQUE`
    // would force us to synthesize fake emails, and the sub-optimal fuzzy
    // matches would compound over time. Unresolved entries still appear on
    // content.documents.participants so retrieval can fall back to name-text
    // matching.
    if (!rec.contact_id && !rec.email) continue;

    if (!rec.contact_id && rec.email) {
      await isolatedWrite('sp_contact_upsert', async () => {
        const insertResult = await exec(
          `INSERT INTO signal.contacts
             (email_address, name, contact_type, tier, source_account_id, metadata, created_at, updated_at)
           VALUES ($1, $2, 'participant', 'unknown', $3, $4, now(), now())
           ON CONFLICT (email_address) DO UPDATE
             SET name = COALESCE(signal.contacts.name, EXCLUDED.name),
                 updated_at = now()
           RETURNING id`,
          [
            rec.email.toLowerCase(),
            rec.name || null,
            accountId,
            JSON.stringify({ auto_created: 'rag.participants' }),
          ]
        );
        rec.contact_id = insertResult.rows[0]?.id || null;
      }, (err) => log.warn(`Contact upsert failed for ${rec.email}: ${err.message}`));
    }

    if (!rec.contact_id) continue;

    // Bump interaction counters. Role is from the contact's perspective:
    //   sender         → they emailed us          → emails_received++
    //   recipient/cc   → we emailed them          → emails_sent++
    //   speaker/owner  → last seen (transcript/doc)
    await isolatedWrite('sp_contact_counter', async () => {
      if (rec.role === 'sender') {
        await exec(
          `UPDATE signal.contacts
             SET emails_received = emails_received + 1,
                 last_received_at = GREATEST(COALESCE(last_received_at, $2), $2),
                 updated_at = now()
           WHERE id = $1`,
          [rec.contact_id, at]
        );
      } else if (rec.role === 'recipient' || rec.role === 'cc' || rec.role === 'bcc') {
        await exec(
          `UPDATE signal.contacts
             SET emails_sent = emails_sent + 1,
                 last_sent_at = GREATEST(COALESCE(last_sent_at, $2), $2),
                 updated_at = now()
           WHERE id = $1`,
          [rec.contact_id, at]
        );
      } else {
        await exec(
          `UPDATE signal.contacts
             SET last_received_at = GREATEST(COALESCE(last_received_at, $2), $2),
                 updated_at = now()
           WHERE id = $1`,
          [rec.contact_id, at]
        );
      }
    }, (err) => log.warn(`Contact counter bump failed for ${rec.contact_id}: ${err.message}`));

    // Populate the previously-dormant signal.contact_accounts junction
    if (accountId) {
      await isolatedWrite('sp_contact_account', async () => {
        await exec(
          `INSERT INTO signal.contact_accounts
             (contact_id, account_id, first_seen, interaction_count, last_interaction)
           VALUES ($1, $2, $3, 1, $3)
           ON CONFLICT (contact_id, account_id) DO UPDATE
             SET interaction_count = signal.contact_accounts.interaction_count + 1,
                 last_interaction = GREATEST(signal.contact_accounts.last_interaction, EXCLUDED.last_interaction)`,
          [rec.contact_id, accountId, at]
        );
      }, (err) => log.warn(`contact_accounts upsert failed for ${rec.contact_id}/${accountId}: ${err.message}`));
    }
  }
}

/**
 * Convenience: resolve + upsert in one call.
 *
 * @param {RawParticipant[]} rawParticipants
 * @param {{ accountId?: string|null, at?: Date|null }} [opts]
 * @param {Function} [exec=query] OPT-166 P2e-E4: injected DB executor threaded
 *   into BOTH the reads (resolveParticipants) and the writes
 *   (upsertContactsAndAccounts). Defaults to bare `query` → inert for every
 *   existing caller. An org-scoped exec makes the whole resolve+upsert survive
 *   the flip; because resolution is pure DB + JS (no network await), sharing one
 *   scoped txn is safe (no txn-across-I/O), and the per-write SAVEPOINTs isolate
 *   fail-open denials within that txn.
 */
export async function resolveAndUpsert(rawParticipants, opts = {}, exec = query) {
  const records = await resolveParticipants(rawParticipants, exec);
  await upsertContactsAndAccounts(records, opts, exec);
  return records;
}
