/**
 * Shared participant normalization for meeting identity (Feature 007 item 3b).
 *
 * The capture sources represent participants differently (TLDv invitee emails,
 * calendar attendee objects, Gemini doc-header names, Drive file owners). Before
 * participants feed the meeting fingerprint or the calendar reconciler's
 * attendee-overlap score, note-taker BOTS must be stripped — `tldv@`, Gemini's
 * notetaker, Fireflies etc. attend the meeting as far as the roster is concerned,
 * and their presence would skew identity hashes and overlap scores.
 *
 * Pure + offline. Works on the RawParticipant shape used across lib/rag
 * ({ name?, email?, role?, turns? }) and on calendar attendee objects
 * ({ email, displayName, ... }).
 */

// Known note-taker / recorder bots. Matched against the email LOCAL PART and the
// display name (never the domain — a human at fireflies.ai's company is matched
// only if their local part/name also looks like the bot). Extend on real evidence.
export const NOTE_TAKER_PATTERNS = [
  /\btl;?dv\b/i,
  /\bfireflies\b/i,
  /\botter\b/i,
  /note[\s-]?taker/i,
  /notes?\s+by\s+gemini/i,
  /\bread\.?ai\b/i,
  /\bfathom\b/i,
  /\bgrain\b/i,
  /meet[\s-]?notes/i,
  /\brecorder\b/i,
];

/** True when a participant looks like a note-taker bot (by email local part or name). */
export function isNoteTakerBot(participant) {
  if (!participant || typeof participant !== 'object') return false;
  const email = String(participant.email || '').toLowerCase();
  const localPart = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
  const name = String(participant.name || participant.displayName || '');
  return NOTE_TAKER_PATTERNS.some((re) => re.test(localPart) || re.test(name));
}

/** Drop note-taker bots from a participant list (identity/overlap input only —
 *  the stored artifact/transcript keeps the full roster). */
export function stripNoteTakerBots(participants) {
  return (Array.isArray(participants) ? participants : []).filter((p) => !isNoteTakerBot(p));
}

/**
 * The fingerprint/overlap input: unique, lowercased, sorted HUMAN attendee emails.
 * Accepts both RawParticipant ({email}) and calendar attendee ({email}) shapes;
 * entries without an email (Gemini name-only) contribute nothing here.
 */
export function attendeeEmailsOf(participants) {
  const emails = new Set();
  for (const p of stripNoteTakerBots(participants)) {
    const email = String(p?.email || '').toLowerCase().trim();
    if (email && email.includes('@')) emails.add(email);
  }
  return [...emails].sort();
}
