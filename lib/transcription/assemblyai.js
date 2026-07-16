/**
 * AssemblyAI client wrapper.
 *
 * Used by the voice-memo ingest pipeline:
 *   1. uploadAudio(buffer) -> upload_url
 *   2. requestTranscript({ audioUrl, webhookUrl, webhookAuthHeader }) -> transcript_id
 *   3. AssemblyAI calls our webhook with status='completed'
 *   4. fetchTranscript(transcript_id) -> { text, utterances }
 *   5. formatWithSpeakers(utterances, null, voiceprintOverrides) -> labeled transcript
 *
 * P4 boring infra: native fetch, no extra deps.
 */

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';

function apiKey() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('ASSEMBLYAI_API_KEY not set');
  return key;
}

/**
 * Upload raw audio bytes. Returns the AssemblyAI-hosted upload_url
 * which is valid for a single transcript request and expires in ~24h.
 */
export async function uploadAudio(buffer) {
  const res = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
    method: 'POST',
    headers: {
      authorization: apiKey(),
      'content-type': 'application/octet-stream',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`AssemblyAI upload failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.upload_url) throw new Error('AssemblyAI upload returned no upload_url');
  return data.upload_url;
}

/**
 * Kick off async transcription with diarization.
 * AssemblyAI will POST { transcript_id, status } to webhookUrl when done.
 *
 * webhookAuthHeader: { name, value } — AssemblyAI echoes this header on the callback,
 * which our handler verifies (timing-safe equality) as the auth check.
 */
export async function requestTranscript({ audioUrl, webhookUrl, webhookAuthHeader, speakerLabels = true, languageCode = 'en' }) {
  if (!audioUrl) throw new Error('audioUrl is required');
  const body = {
    audio_url: audioUrl,
    speaker_labels: speakerLabels,
    language_code: languageCode,
    // AssemblyAI API requires explicit speech model selection from the
    // current accepted set (e.g. 'universal-3-pro'). 'universal-2' was
    // retired and now returns 400 on submit.
    speech_models: ['universal-3-pro'],
  };
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (webhookAuthHeader?.name && webhookAuthHeader?.value) {
    body.webhook_auth_header_name = webhookAuthHeader.name;
    body.webhook_auth_header_value = webhookAuthHeader.value;
  }
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`AssemblyAI transcript request failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error('AssemblyAI transcript request returned no id');
  return data.id;
}

/**
 * Fetch a completed (or in-progress) transcript by id.
 * Returns the raw AssemblyAI transcript object: { id, status, text, utterances, audio_duration, ... }.
 */
export async function fetchTranscript(transcriptId) {
  if (!transcriptId) throw new Error('transcriptId is required');
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${transcriptId}`, {
    method: 'GET',
    headers: { authorization: apiKey() },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`AssemblyAI fetch failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Render utterances as speaker-attributed text.
 *
 * AssemblyAI returns utterances tagged with speaker labels 'A', 'B', 'C', ...
 * The most-talkative speaker (by utterance count) is renamed to primarySpeaker;
 * the rest become "Speaker B", "Speaker C", ...
 *
 * If primarySpeaker is null/empty, all speakers stay as "Speaker A", "Speaker B", ...
 *
 * If labelOverrides is provided (typically from voiceprint matching), it
 * wins for whatever AssemblyAI labels it covers. Labels missing from the
 * override map fall through to the count-based "Speaker A/B/C" scheme.
 * primarySpeaker is treated as a lower-priority hint than labelOverrides.
 *
 * Returns:
 *   - { text: "[Eric Gang]: ...\n[Speaker B]: ...", speakers: { A: "Eric Gang", B: "Speaker B" } }
 *   - For a missing or empty utterances array, returns { text: "", speakers: {} }.
 */
export function formatWithSpeakers(utterances, _legacyPrimarySpeaker = null, labelOverrides = null) {
  if (!Array.isArray(utterances) || utterances.length === 0) {
    return { text: '', speakers: {} };
  }

  const overrides = labelOverrides instanceof Map
    ? labelOverrides
    : labelOverrides && typeof labelOverrides === 'object'
      ? new Map(Object.entries(labelOverrides))
      : new Map();

  // Count utterances per speaker label
  const counts = new Map();
  for (const u of utterances) {
    const label = u.speaker || 'A';
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  // Sort labels by count desc; ties broken by label asc (stable order)
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);

  // Build label -> display-name map. Voiceprint overrides win; everything
  // else gets "Speaker A/B/C…" keyed off count-sorted position. We never
  // attribute a real name to an unmatched speaker — that would mislabel
  // any case where the uploader isn't the dominant or first speaker.
  const speakers = {};
  ordered.forEach((label, idx) => {
    if (overrides.has(label)) {
      const v = overrides.get(label);
      speakers[label] = typeof v === 'string' ? v : v?.displayName || v?.name || `Speaker ${label}`;
      return;
    }
    const letter = String.fromCharCode('A'.charCodeAt(0) + idx);
    speakers[label] = `Speaker ${letter}`;
  });

  const text = utterances
    .map(u => {
      const name = speakers[u.speaker || 'A'] || `Speaker ${u.speaker || 'A'}`;
      return `[${name}]: ${(u.text || '').trim()}`;
    })
    .join('\n');

  return { text, speakers };
}
