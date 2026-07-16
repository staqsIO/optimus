/**
 * Participant extractors.
 *
 * Pure functions — no DB access. Each extractor converts a source-specific
 * payload into a uniform RawParticipant[] shape that the resolver can turn
 * into contact records.
 *
 * RawParticipant = {
 *   name?:  string,   // display name if available
 *   email?: string,   // lowercased email if available
 *   role:   'speaker' | 'sender' | 'recipient' | 'cc' | 'bcc' | 'owner' | 'collaborator' | 'modifier',
 *   turns?: number,   // tl;dv speaker turn count (used as a weak signal for inner-circle inference later)
 * }
 */

const EMAIL_REGEX = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

/**
 * Parse a header value like `"Eric Gang" <eric@staqs.io>` or just `eric@staqs.io`
 * into a structured record. Returns null if unparseable.
 *
 * @param {string} raw
 * @returns {{ name?: string, email?: string } | null}
 */
export function parseAddressHeader(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angleMatch = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    const name = angleMatch[1].replace(/^["']|["']$/g, '').trim();
    const email = angleMatch[2].trim().toLowerCase();
    if (!email.includes('@')) return null;
    return { name: name || undefined, email };
  }

  const bareEmail = trimmed.match(EMAIL_REGEX);
  if (bareEmail) {
    return { email: bareEmail[1].toLowerCase() };
  }

  // Name-only (no email) — rare in email headers but common in tl;dv
  return { name: trimmed };
}

/**
 * Split a comma-separated header like `"A" <a@x>, b@y, "C" <c@z>`.
 * Handles commas inside quoted names.
 */
export function splitAddressList(raw) {
  if (!raw) return [];
  const parts = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<') inAngle = true;
    else if (ch === '>') inAngle = false;
    if (ch === ',' && !inQuote && !inAngle) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Turn an email local-part into a display name when tl;dv doesn't provide one.
 * "glenn.fell" → "Glenn Fell", "mike_h" → "Mike H", "kevin" → "Kevin".
 */
function deriveNameFromEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  const local = email.split('@')[0] || '';
  if (!local) return undefined;
  const parts = local.split(/[._\-+]/).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

/**
 * tl;dv: walk normalized segments produced by lib/rag/normalizers/tldv.js.
 * Returns one record per unique speaker with a turn count.
 *
 * @param {Array<{ metadata?: { speaker?: string } }>} segments
 * @returns {Array<{ name: string, role: 'speaker', turns: number }>}
 */
export function extractFromTldvSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const turns = new Map();
  for (const seg of segments) {
    const name = seg?.metadata?.speaker?.trim();
    if (!name) continue;
    turns.set(name, (turns.get(name) || 0) + 1);
  }
  return [...turns.entries()].map(([name, count]) => ({
    name,
    role: 'speaker',
    turns: count,
  }));
}

/**
 * tl;dv: extract participants from the full meeting object (invitees + organizer)
 * and optionally merge with speaker turns from the transcript.
 *
 * This is the preferred path because tl;dv's speaker diarization can label a
 * turn with a redacted phone number (e.g., "+1 678-***-**47") when a participant
 * joined via phone. Those phone-labelled speakers are invisible to name-based
 * queries like "meeting with Glenn". The meeting object exposes the true
 * attendee roster via `invitees: [{name, email}]`, which we merge here.
 *
 * @param {Object} opts
 * @param {Array} [opts.segments]   - normalized tl;dv segments (optional; merges turn counts when provided)
 * @param {Array<{name?: string, email?: string}>} [opts.invitees]
 * @param {{name?: string, email?: string}} [opts.organizer]
 * @returns {RawParticipant[]}
 */
export function extractFromTldvMeeting({ segments, invitees, organizer } = {}) {
  const byKey = new Map(); // key = lowercase email, fallback = normalized name
  const ROLE_RANK = { organizer: 3, speaker: 2, attendee: 1 };

  const upsert = (raw, role) => {
    if (!raw) return;
    const email = raw.email ? String(raw.email).toLowerCase() : undefined;
    let name = raw.name ? String(raw.name).trim() : undefined;
    if (!name && email) name = deriveNameFromEmail(email);
    const key = email || (name ? name.toLowerCase() : '');
    if (!key) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { name, email, role });
      return;
    }
    if (!existing.name && name) existing.name = name;
    if (!existing.email && email) existing.email = email;
    if (ROLE_RANK[role] > ROLE_RANK[existing.role]) existing.role = role;
  };

  if (Array.isArray(invitees)) {
    for (const inv of invitees) upsert(inv, 'attendee');
  }
  if (organizer) upsert(organizer, 'organizer');

  // Merge transcript speakers. Speaker labels that correspond to a known
  // invitee (by fuzzy name match against the invitee list) get upgraded from
  // "attendee" to "speaker". Speaker labels that don't match any invitee
  // (e.g. phone-number labels like "+1 678-***-**47") still get added so we
  // retain that signal.
  if (Array.isArray(segments)) {
    const turns = new Map();
    for (const seg of segments) {
      const sp = seg?.metadata?.speaker?.trim();
      if (!sp) continue;
      turns.set(sp, (turns.get(sp) || 0) + 1);
    }
    for (const [spName, count] of turns) {
      const spNorm = spName.toLowerCase();
      let matched = null;
      for (const p of byKey.values()) {
        if (!p.name) continue;
        const pNorm = p.name.toLowerCase();
        if (pNorm === spNorm || pNorm.includes(spNorm) || spNorm.includes(pNorm)) {
          matched = p;
          break;
        }
      }
      if (matched) {
        if (ROLE_RANK.speaker > ROLE_RANK[matched.role]) matched.role = 'speaker';
        matched.turns = (matched.turns || 0) + count;
      } else {
        const key = spNorm;
        if (!byKey.has(key)) {
          byKey.set(key, { name: spName, role: 'speaker', turns: count });
        }
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Gemini transcript: pull names from the header's `Invited` line, from
 * Next-step assignee brackets, and from per-utterance speakers when the
 * document includes the transcript tab.
 *
 * Promotion: anyone with a transcript turn becomes role 'speaker'; everyone
 * else from the invitee list / next-step assignees stays as 'attendee'.
 *
 * @param {Array<{ content?: string, metadata?: Object }>} segments
 * @returns {Array<{ name: string, role: 'attendee' | 'speaker', turns: number }>}
 */
export function extractFromGeminiSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const ROLE_RANK = { speaker: 2, attendee: 1 };
  const byKey = new Map();

  const upsert = (rawName, role, count) => {
    if (!rawName) return;
    const name = String(rawName).trim();
    if (!name) return;
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { name, role, turns: count });
      return;
    }
    if (ROLE_RANK[role] > ROLE_RANK[existing.role]) existing.role = role;
    existing.turns += count;
  };

  for (const seg of segments) {
    const meta = seg?.metadata;
    if (!meta) continue;
    if (meta.section === 'header' && Array.isArray(meta.invitees)) {
      for (const name of meta.invitees) upsert(name, 'attendee', 0);
    }
    if (meta.section === 'next_steps' && Array.isArray(meta.assignees)) {
      for (const name of meta.assignees) upsert(name, 'attendee', 1);
    }
    if (meta.section === 'transcript' && meta.speaker) {
      upsert(meta.speaker, 'speaker', 1);
    }
  }

  return [...byKey.values()];
}

/**
 * Email thread: walk every message's From/To/Cc headers.
 * Merges duplicates (same email across messages) and promotes role where
 * sender > recipient > cc.
 *
 * @param {Array<{ headers: { from?: string, to?: string, cc?: string, bcc?: string } }>} messages
 * @returns {RawParticipant[]}
 */
export function extractFromEmailThread(messages) {
  if (!Array.isArray(messages)) return [];
  const byKey = new Map(); // key = lowercased email || lowercased name
  const ROLE_RANK = { sender: 4, recipient: 3, cc: 2, bcc: 1 };

  const add = (raw, role) => {
    const parsed = parseAddressHeader(raw);
    if (!parsed) return;
    const key = (parsed.email || parsed.name || '').toLowerCase();
    if (!key) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...parsed, role });
      return;
    }
    // Upgrade role if stronger; merge name/email if previously missing
    if (ROLE_RANK[role] > ROLE_RANK[existing.role]) existing.role = role;
    if (!existing.name && parsed.name) existing.name = parsed.name;
    if (!existing.email && parsed.email) existing.email = parsed.email;
  };

  for (const msg of messages) {
    const h = msg?.headers || {};
    add(h.from, 'sender');
    for (const t of splitAddressList(h.to)) add(t, 'recipient');
    for (const c of splitAddressList(h.cc)) add(c, 'cc');
    for (const b of splitAddressList(h.bcc)) add(b, 'bcc');
  }

  return [...byKey.values()];
}

/**
 * Email (backfill path): the only participant data left in existing
 * content.documents.metadata is an array of strings like `'"Eric" <eric@x>'`.
 * Parse each and return with role='sender' (we've lost per-message roles).
 *
 * @param {string[]} participantStrings
 * @returns {RawParticipant[]}
 */
export function extractFromEmailParticipantStrings(participantStrings) {
  if (!Array.isArray(participantStrings)) return [];
  const out = [];
  const seen = new Set();
  for (const s of participantStrings) {
    const parsed = parseAddressHeader(s);
    if (!parsed) continue;
    const key = (parsed.email || parsed.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, role: 'recipient' });
  }
  return out;
}

/**
 * Drive: pull from the richer files.list field mask
 * (owners + lastModifyingUser + sharingUser).
 *
 * @param {Object} driveFile
 * @returns {RawParticipant[]}
 */
export function extractFromDriveFile(driveFile) {
  if (!driveFile) return [];
  const byKey = new Map();
  const add = (person, role) => {
    if (!person) return;
    const email = person.emailAddress ? person.emailAddress.toLowerCase() : undefined;
    const name = person.displayName || undefined;
    if (!email && !name) return;
    const key = (email || name).toLowerCase();
    const existing = byKey.get(key);
    // owner trumps modifier trumps collaborator
    const rank = { owner: 3, modifier: 2, collaborator: 1 };
    if (!existing || rank[role] > rank[existing.role]) {
      byKey.set(key, { name, email, role });
    }
  };

  for (const owner of driveFile.owners || []) add(owner, 'owner');
  if (driveFile.lastModifyingUser) add(driveFile.lastModifyingUser, 'modifier');
  if (driveFile.sharingUser) add(driveFile.sharingUser, 'collaborator');
  // permissions[] available via files.get with the right field mask; callers pass
  // them through separately if they've been fetched.
  for (const perm of driveFile.permissions || []) {
    if (perm.type === 'user' && (perm.emailAddress || perm.displayName)) {
      add({ emailAddress: perm.emailAddress, displayName: perm.displayName }, 'collaborator');
    }
  }

  return [...byKey.values()];
}

/**
 * Dispatch helper — pick the right extractor based on source/format.
 *
 * @param {Object} opts
 * @param {string} opts.source
 * @param {string} [opts.format]
 * @param {Array} [opts.segments]     - normalized segments (tl;dv)
 * @param {Array} [opts.messages]     - email thread messages
 * @param {string[]} [opts.participantStrings] - email backfill
 * @param {Object} [opts.driveFile]   - Drive files.list result
 * @returns {RawParticipant[]}
 */
export function extractParticipants({ source, format, segments, messages, participantStrings, driveFile, tldvMeeting }) {
  if (format === 'gemini' || source === 'gemini') {
    return extractFromGeminiSegments(segments || []);
  }
  if (format === 'tldv' || source === 'tldv' || source === 'transcript') {
    // If caller supplied the tl;dv meeting object, use the richer merge path
    // that covers silent attendees and phone-labelled speakers.
    if (tldvMeeting && (Array.isArray(tldvMeeting.invitees) || tldvMeeting.organizer)) {
      return extractFromTldvMeeting({
        segments: segments || [],
        invitees: tldvMeeting.invitees,
        organizer: tldvMeeting.organizer,
      });
    }
    return extractFromTldvSegments(segments || []);
  }
  if (source === 'email') {
    if (Array.isArray(messages) && messages.length > 0) {
      return extractFromEmailThread(messages);
    }
    if (Array.isArray(participantStrings) && participantStrings.length > 0) {
      return extractFromEmailParticipantStrings(participantStrings);
    }
    return [];
  }
  if (source === 'drive') {
    return extractFromDriveFile(driveFile);
  }
  return [];
}
