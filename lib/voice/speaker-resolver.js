/**
 * AssemblyAI speaker → enrolled contact resolution.
 *
 * Given the original meeting audio + AssemblyAI utterances (each tagged
 * with a speaker label like 'A', 'B', 'C'), build an embedding per speaker
 * label and cosine-match against voice.voice_prints to recover real names.
 *
 * Returns a Map<assemblyaiLabel, { contactId, displayName, score }>. Labels
 * with no confident match are absent — callers fall back to "Speaker A/B/C".
 *
 * Engine choice flows through lib/voice/embedder.js so the same pipeline
 * works on Transformers.js (default) or Picovoice Eagle.
 */

import { decodeToFloat32 } from './transformers.js';
import { activeEngine } from './embedder.js';

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SECONDS = 3;     // skip speakers with < 3s of clean audio
const MATCH_THRESHOLD = 0.55;      // cosine similarity floor (WavLM-SV space)
const HF_MODEL_ID = 'Xenova/wavlm-base-plus-sv';

/**
 * Slice and concatenate Float32 PCM segments by start_ms / end_ms, then
 * embed once. Returns a 512-dim L2-normed Float32Array, or null if there
 * isn't enough audio.
 */
async function embedConcatenatedUtterances(pcmFloat32, utterances) {
  if (utterances.length === 0) return null;
  const total = utterances.reduce(
    (acc, u) => acc + Math.max(0, (u.end - u.start) / 1000),
    0,
  );
  if (total < MIN_SEGMENT_SECONDS) return null;

  // Concatenate per-utterance slices into one Float32Array.
  let totalSamples = 0;
  const slices = [];
  for (const u of utterances) {
    const startIdx = Math.max(0, Math.floor((u.start / 1000) * SAMPLE_RATE));
    const endIdx = Math.min(pcmFloat32.length, Math.floor((u.end / 1000) * SAMPLE_RATE));
    if (endIdx > startIdx) {
      slices.push(pcmFloat32.subarray(startIdx, endIdx));
      totalSamples += endIdx - startIdx;
    }
  }
  if (totalSamples < SAMPLE_RATE * MIN_SEGMENT_SECONDS) return null;

  const concat = new Float32Array(totalSamples);
  let offset = 0;
  for (const slice of slices) {
    concat.set(slice, offset);
    offset += slice.length;
  }

  const T = await import('@huggingface/transformers');
  // Reuse the cached model — getModel in transformers.js memoizes it.
  const model = await T.AutoModel.from_pretrained(HF_MODEL_ID, { quantized: true });
  const tensor = new T.Tensor('float32', concat, [1, concat.length]);
  const out = await model({ input_values: tensor });
  const raw = out.embeddings?.data;
  if (!raw || raw.length !== 512) return null;

  // L2 normalize
  const embed = new Float32Array(512);
  let norm = 0;
  for (let i = 0; i < 512; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 512; i++) embed[i] = raw[i] / norm;
  return embed;
}

function vectorLiteral(float32) {
  return `[${Array.from(float32).map((x) => x.toFixed(7)).join(',')}]`;
}

/**
 * Resolve AssemblyAI speaker labels to enrolled contacts.
 *
 *   queryFn        — db.query function (signature query(sql, params)).
 *   audioBuffer    — original audio bytes (any format ffmpeg understands).
 *   utterances     — AssemblyAI utterances [{ speaker, start, end, text }].
 *   opts.memoId    — optional memo id; when present, unmatched speakers
 *                    get captured into voice.unenrolled_speakers and
 *                    this memo id is appended to their source_memo_ids.
 *   opts.captureUnmatched
 *                  — default true; set false in tests or backfill paths
 *                    that only want the match map without side effects.
 *
 * Returns a Map<string, { contactId, displayName, score }>. Empty map if
 * no voiceprints are enrolled (fast path) or no speaker reaches the
 * confidence threshold.
 */
export async function resolveAssemblyAISpeakers(queryFn, audioBuffer, utterances, opts = {}) {
  const { memoId = null, captureUnmatched = true } = opts;
  const result = new Map();
  if (!Array.isArray(utterances) || utterances.length === 0) return result;
  if (activeEngine() !== 'transformers') {
    // Eagle path uses a different scoring API; not yet wired here. Falling
    // back to "no match" is safe — callers keep their existing label scheme.
    return result;
  }

  // Whether or not anyone is enrolled, we may still need to embed unmatched
  // speakers for the unenrolled_speakers candidate pool. The original fast
  // path is preserved when capture is also off.
  const enrolled = await queryFn(
    `SELECT id, contact_id, display_name
       FROM voice.voice_prints
      WHERE embedding IS NOT NULL AND embedder = 'transformers'`,
  );
  if (enrolled.rows.length === 0 && !captureUnmatched) return result;

  let pcm;
  try {
    pcm = await decodeToFloat32(audioBuffer);
  } catch (e) {
    console.warn(`[speaker-resolver] decode failed: ${e.message}`);
    return result;
  }

  // Group utterances by AssemblyAI speaker label.
  const byLabel = new Map();
  for (const u of utterances) {
    const label = u.speaker || 'A';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(u);
  }

  for (const [label, group] of byLabel.entries()) {
    let embedding;
    try {
      embedding = await embedConcatenatedUtterances(pcm, group);
    } catch (e) {
      console.warn(`[speaker-resolver] embed label=${label} failed: ${e.message}`);
      continue;
    }
    if (!embedding) continue;

    const lit = vectorLiteral(embedding);
    // Cosine distance in pgvector is `<=>`; similarity = 1 - distance.
    let matched = false;
    if (enrolled.rows.length > 0) {
      const match = await queryFn(
        `SELECT vp.id, vp.contact_id, vp.display_name,
                1 - (vp.embedding <=> $1::vector) AS similarity
           FROM voice.voice_prints vp
          WHERE vp.embedding IS NOT NULL AND vp.embedder = 'transformers'
          ORDER BY vp.embedding <=> $1::vector
          LIMIT 1`,
        [lit],
      );
      const best = match.rows[0];
      if (best && best.similarity >= MATCH_THRESHOLD) {
        result.set(label, {
          contactId: best.contact_id,
          displayName: best.display_name,
          score: Number(best.similarity.toFixed(3)),
        });
        matched = true;
      }
    }

    // Unmatched speaker — persist as a candidate so the board can name
    // them later. We collapse to existing candidates via cosine match
    // within voice.unenrolled_speakers so the same person across many
    // memos shows up as one row with an occurrence_count, not N rows.
    if (!matched && captureUnmatched) {
      try {
        const sample = pickSampleUtterance(group);
        await captureUnenrolledSpeaker(queryFn, {
          embedding: lit,
          memoId,
          candidateLabel: label,
          sampleUtterance: sample,
        });
      } catch (e) {
        // Non-fatal — never block memo ingestion if the candidate write fails.
        console.warn(`[speaker-resolver] capture label=${label} failed: ${e.message}`);
      }
    }
  }

  return result;
}

function pickSampleUtterance(group) {
  let longest = '';
  for (const u of group) {
    const t = String(u?.text || '').trim();
    if (t.length > longest.length) longest = t;
  }
  return longest.slice(0, 500) || null;
}

/**
 * Persist an unmatched speaker embedding. Cosine-matches against existing
 * candidates first; if a near-duplicate exists, increments the occurrence
 * count and appends the memo id. Otherwise inserts a new row.
 */
async function captureUnenrolledSpeaker(queryFn, { embedding, memoId, candidateLabel, sampleUtterance }) {
  // Cap source_memo_ids growth: keep the most recent ~50 entries to bound
  // row size while still leaving an audit trail.
  const SOURCE_MEMO_CAP = 50;

  const memoArrayLiteral = memoId ? [String(memoId)] : [];

  // Try to find an existing candidate.
  const dupe = await queryFn(
    `SELECT id, occurrence_count, source_memo_ids,
            1 - (embedding <=> $1::vector) AS similarity
       FROM voice.unenrolled_speakers
      WHERE embedder = 'transformers'
      ORDER BY embedding <=> $1::vector
      LIMIT 1`,
    [embedding],
  );

  const existing = dupe.rows[0];
  if (existing && existing.similarity >= MATCH_THRESHOLD) {
    // Compute the new memo-id array in JS to keep the UPDATE simple and
    // avoid the SQL gymnastics of conditional slicing.
    const current = Array.isArray(existing.source_memo_ids) ? existing.source_memo_ids : [];
    let updatedIds = current;
    if (memoId && !current.includes(memoId)) {
      updatedIds = [...current, memoId];
      if (updatedIds.length > SOURCE_MEMO_CAP) {
        updatedIds = updatedIds.slice(updatedIds.length - SOURCE_MEMO_CAP);
      }
    }
    await queryFn(
      `UPDATE voice.unenrolled_speakers
          SET occurrence_count = occurrence_count + 1,
              last_heard_at    = now(),
              candidate_label  = COALESCE($2, candidate_label),
              sample_utterance = COALESCE($3, sample_utterance),
              source_memo_ids  = $4::text[]
        WHERE id = $1`,
      [existing.id, candidateLabel, sampleUtterance, updatedIds],
    );
    return existing.id;
  }

  // No candidate matches — insert new.
  const inserted = await queryFn(
    `INSERT INTO voice.unenrolled_speakers
        (embedding, embedder, candidate_label, sample_utterance, source_memo_ids)
     VALUES ($1::vector, 'transformers', $2, $3, $4::text[])
     RETURNING id`,
    [embedding, candidateLabel, sampleUtterance, memoArrayLiteral],
  );
  return inserted.rows[0]?.id ?? null;
}
