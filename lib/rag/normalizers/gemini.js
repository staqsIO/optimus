/**
 * Gemini transcript normalizer.
 *
 * A Gemini meeting export from Google Meet has two tabs that the user can
 * paste either separately or concatenated:
 *
 *   1. Notes tab — date, title, "Invited <names>", optional Attachments/Meeting
 *      records lines, then sections labelled "Summary", "Next steps", and
 *      "Details". Details paragraphs are "Topic Heading: body... (HH:MM:SS)."
 *      Next steps look like "[Owner, Owner] Title: body sentence(s)."
 *
 *   2. Transcript tab — same date + a "<title> - Transcript" line, followed
 *      by repeating blocks of:
 *
 *          HH:MM:SS              <- bare timestamp on its own line
 *
 *          Speaker Name: utterance
 *          Speaker Name: ...
 *
 *      Ends with "Transcription ended after HH:MM:SS" + boilerplate notice.
 *
 * Output: NormalizedSegment[] where each segment carries enough metadata
 * (section / topic / speaker / timestamp / assignees) for the chunker to
 * preserve topic/speaker boundaries and for citation back-references.
 */

const SECTION_HEADERS = new Set(['Summary', 'Next steps', 'Details']);

const FOOTER_PATTERNS = [
  /^you should review gemini'?s notes/i,
  /^get tips and learn how gemini takes notes/i,
  /^how is the quality of these specific notes/i,
  /^take a short survey/i,
  /^this editable transcript/i,
  /^transcription ended/i,
];

const HEADER_NOISE_PATTERNS = [
  /^attachments\b/i,
  /^meeting records\b/i,
  /^invited\b/i,
];

const TIMESTAMP_REGEX = /\(\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\)/g;
const BARE_TIMESTAMP_REGEX = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const NEXT_STEP_REGEX = /^\s*\[([^\]]+)\]\s*([^:]+?):\s*(.*)$/;
const SPEAKER_LINE_REGEX = /^([^:]{1,60}?):\s*(.*)$/;

/**
 * @typedef {Object} GeminiHeader
 * @property {string} [date]      - Raw date line as found in the doc
 * @property {string} [title]     - Meeting title line (with any "- Transcript" suffix stripped)
 * @property {string[]} invitees  - Names extracted from the "Invited" line
 */

/**
 * Parse the leading header block. Stops at the first section keyword, the
 * first bare timestamp, or a clearly non-header paragraph.
 *
 * @param {string[]} lines
 * @returns {{ header: GeminiHeader, bodyStart: number }}
 */
export function parseGeminiHeader(lines) {
  const header = { invitees: [] };
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (SECTION_HEADERS.has(line)) break;
    if (BARE_TIMESTAMP_REGEX.test(line)) break;

    if (/^Invited\b/i.test(line)) {
      header.invitees = parseInvitedLine(line.replace(/^Invited\s*/i, '').trim());
      continue;
    }
    if (/^Attachments\b/i.test(line) || /^Meeting records\b/i.test(line)) {
      continue;
    }
    if (!header.date && looksLikeDate(line)) {
      header.date = line;
      continue;
    }
    if (!header.title) {
      header.title = stripTranscriptSuffix(line);
      continue;
    }
    // Anything else this early — assume body has started.
    break;
  }

  return { header, bodyStart: i };
}

/**
 * Gemini's "Invited" line has no delimiters — names are concatenated like
 *   "Invited Michael Maibach Patrick King Dustin Powers"
 * Heuristic: split on whitespace, then greedily pair tokens into First+Last.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseInvitedLine(raw) {
  if (!raw) return [];
  const tokens = raw.split(/\s+/).filter(Boolean);
  const names = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    names.push(buffer.join(' '));
    buffer = [];
  };

  for (const tok of tokens) {
    const isWordCapital = /^[A-Z][\w'’.-]*$/.test(tok);
    if (!isWordCapital) {
      flush();
      continue;
    }
    buffer.push(tok);
    if (buffer.length >= 2) flush();
  }
  flush();

  const seen = new Set();
  return names.filter(n => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {string} input - Raw Gemini transcript text
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalizeGemini(input) {
  if (!input || typeof input !== 'string') return [];
  const lines = input.split(/\r?\n/);
  const { header, bodyStart } = parseGeminiHeader(lines);

  const segments = [];

  if (header.date || header.title || header.invitees.length > 0) {
    const headerParts = [];
    if (header.date) headerParts.push(header.date);
    if (header.title) headerParts.push(header.title);
    if (header.invitees.length > 0) {
      headerParts.push(`Invited: ${header.invitees.join(', ')}`);
    }
    segments.push({
      content: headerParts.join(' — '),
      metadata: {
        section: 'header',
        invitees: header.invitees,
      },
    });
  }

  let mode = 'notes';        // 'notes' | 'transcript'
  let section = null;        // 'summary' | 'next_steps' | 'details' | null
  let currentTimestamp;
  let pending = [];

  const flushParagraph = () => {
    if (pending.length === 0) return;
    const joined = pending.join(' ').replace(/\s+/g, ' ').trim();
    pending = [];
    if (!joined || isFooter(joined)) return;

    if (section === 'next_steps') {
      const seg = parseNextStepLine(joined);
      if (seg) segments.push(seg);
      return;
    }
    if (section === 'details') {
      segments.push(parseDetailsParagraph(joined));
      return;
    }
    if (section === 'summary') {
      segments.push({ content: joined, metadata: { section: 'summary' } });
      return;
    }
    // Outside any known section — keep as plain context only if it looks like
    // real content (not duplicated header noise from a second tab).
    if (looksLikeNoise(joined)) return;
    segments.push({ content: joined, metadata: { section: 'body' } });
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (isFooter(trimmed)) {
      flushParagraph();
      // "Transcription ended..." marks the end of the transcript tab — fall
      // back to notes mode in case more content follows. The footer text
      // itself is dropped by isFooter.
      if (/^transcription ended/i.test(trimmed)) {
        mode = 'notes';
        section = null;
        currentTimestamp = undefined;
      }
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (BARE_TIMESTAMP_REGEX.test(trimmed)) {
      flushParagraph();
      mode = 'transcript';
      section = null;
      currentTimestamp = trimmed;
      continue;
    }

    if (mode === 'transcript') {
      const m = trimmed.match(SPEAKER_LINE_REGEX);
      if (m && looksLikeSpeaker(m[1])) {
        const speaker = m[1].trim();
        const text = m[2].trim();
        if (text) {
          segments.push({
            content: text,
            metadata: {
              section: 'transcript',
              speaker,
              timestamp: currentTimestamp,
            },
          });
        }
      } else if (segments.length > 0 && segments[segments.length - 1].metadata?.section === 'transcript') {
        // Continuation of the previous utterance.
        segments[segments.length - 1].content += ' ' + trimmed;
      }
      continue;
    }

    if (SECTION_HEADERS.has(trimmed)) {
      flushParagraph();
      section = trimmed === 'Summary'
        ? 'summary'
        : trimmed === 'Next steps'
          ? 'next_steps'
          : 'details';
      continue;
    }

    if (HEADER_NOISE_PATTERNS.some(rx => rx.test(trimmed))) {
      // Duplicated "Invited / Attachments / Meeting records" lines from a
      // second tab in a combined paste.
      continue;
    }

    if (section === 'next_steps') {
      pending.push(trimmed);
      flushParagraph();
      continue;
    }

    if (section === 'details') {
      if (/^[^:]{1,120}:\s/.test(trimmed)) {
        flushParagraph();
        pending.push(trimmed);
        flushParagraph();
      } else if (
        segments.length > 0 &&
        segments[segments.length - 1]?.metadata?.section === 'details' &&
        !isFooter(trimmed) &&
        !looksLikeNoise(trimmed)
      ) {
        segments[segments.length - 1].content += ' ' + trimmed;
      } else if (!isFooter(trimmed) && !looksLikeNoise(trimmed)) {
        pending.push(trimmed);
      }
      continue;
    }

    pending.push(trimmed);
  }
  flushParagraph();

  return segments.filter(s => s.content && s.content.trim().length > 0);
}

function parseNextStepLine(line) {
  const m = line.match(NEXT_STEP_REGEX);
  if (!m) {
    return { content: line, metadata: { section: 'next_steps' } };
  }
  const [, ownerBlock, title, body] = m;
  const owners = ownerBlock.split(',').map(s => s.trim()).filter(Boolean);
  const titleTrim = title.trim();
  const bodyTrim = body.trim();
  return {
    content: `${titleTrim}: ${bodyTrim}`,
    metadata: {
      section: 'next_steps',
      assignees: owners,
      topic: titleTrim,
    },
  };
}

function parseDetailsParagraph(line) {
  const colonIdx = line.indexOf(':');
  let topic;
  let body = line;
  if (colonIdx > 0 && colonIdx < 120) {
    topic = line.slice(0, colonIdx).trim();
    body = line.slice(colonIdx + 1).trim();
  }
  const timestamps = [];
  let m;
  TIMESTAMP_REGEX.lastIndex = 0;
  while ((m = TIMESTAMP_REGEX.exec(body)) !== null) {
    timestamps.push(m[1]);
  }
  const cleanedBody = body.replace(TIMESTAMP_REGEX, '').replace(/\s{2,}/g, ' ').trim();
  const content = topic ? `${topic}: ${cleanedBody}` : cleanedBody;
  const metadata = { section: 'details' };
  if (topic) metadata.topic = topic;
  if (timestamps.length > 0) {
    metadata.timestamp = timestamps[0];
    if (timestamps.length > 1) metadata.timestamps = timestamps;
  }
  return { content, metadata };
}

function isFooter(text) {
  if (!text) return false;
  return FOOTER_PATTERNS.some(rx => rx.test(text));
}

/**
 * Drop the "<Title> - Transcript" suffix that Gemini adds to the transcript
 * tab so the resulting title matches the notes tab.
 */
function stripTranscriptSuffix(line) {
  return line.replace(/\s*-\s*Transcript\s*$/i, '').trim() || line.trim();
}

/**
 * Recognise lines that aren't speakers — e.g. a topic-style line like
 *   "Lawyer and Warehouse Call Lineups: Regarding the call..."
 * that happens to have a colon. Real Gemini speaker labels are short
 * (one or two capitalised words, sometimes with a phone-redacted suffix).
 */
function looksLikeSpeaker(label) {
  const t = String(label || '').trim();
  if (!t || t.length > 60) return false;
  // Reject sentence fragments — speakers don't contain trailing periods or
  // multiple sentences before the colon.
  if (/[.!?]/.test(t)) return false;
  // Must look like a name: "First Last", "First", or a redacted phone label.
  if (/^\+?\d[\d\s\-*().]{4,}$/.test(t)) return true;
  if (!/^[A-Z]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  return words.every(w => /^[A-Z][\w'’.-]*$/.test(w) || /^[a-z]+$/.test(w));
}

/**
 * Filter for stray header/footer-noise lines that slip into the body when
 * a combined notes+transcript document is pasted as one. Anything that
 * matches a date, "<title> - Transcript", or the URL Google Docs appends.
 */
function looksLikeNoise(text) {
  if (!text) return true;
  if (looksLikeDate(text)) return true;
  if (/-\s*Transcript\s*$/i.test(text)) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (HEADER_NOISE_PATTERNS.some(rx => rx.test(text))) return true;
  return false;
}

function looksLikeDate(line) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(line)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) return true;
  if (/^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/.test(line)) return true;
  return false;
}
