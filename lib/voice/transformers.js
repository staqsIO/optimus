/**
 * Transformers.js speaker embedder.
 *
 * Runs the WavLM-Base+ Speaker-Verification head locally via ONNX
 * (no API account, no rate limit, no waiting on Picovoice approval).
 * Returns a 512-dim Float32 d-vector per audio clip; cosine similarity
 * is computed against enrolled vectors at match time (pgvector handles
 * the heavy lifting in SQL).
 *
 * Same interface as lib/voice/eagle.js so the embedder facade can swap
 * engines without rippling into the API routes.
 */

import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const MODEL_ID = 'Xenova/wavlm-base-plus-sv';
const SAMPLE_RATE = 16000;
const MIN_SAMPLES = SAMPLE_RATE * 5;       // <5s of audio is too noisy to embed
const MIN_OK_SAMPLES = SAMPLE_RATE * 20;   // need ≥20s of clean speech to mark "complete"
const TARGET_SAMPLES = SAMPLE_RATE * 30;   // longer is fine but stop reporting progress past 30s

let _modelPromise = null;
let _Tensor = null;

async function getModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const T = await import('@huggingface/transformers');
      _Tensor = T.Tensor;
      // env tweaks: no telemetry, no remote progress noise
      try { T.env.allowLocalModels = false; } catch { /* ignore */ }
      const model = await T.AutoModel.from_pretrained(MODEL_ID, { quantized: true });
      return model;
    })();
  }
  return _modelPromise;
}

/**
 * Convert any-format audio bytes to 16 kHz mono Float32 PCM via ffmpeg.
 * (Eagle wants Int16Array, transformers wants Float32 in [-1, 1] — same
 * conversion, different output dtype.)
 *
 * iPhone Voice Memo m4a files put the MP4 `moov` atom at the END of the
 * file, so ffmpeg can't decode them via stdin (no seek). Write to a temp
 * file first; ffmpeg can seek in a real file just fine. ffmpeg also
 * sometimes exits 0 with empty output when the demuxer fails, so treat
 * zero-byte stdout as a hard error too.
 */
export async function decodeToFloat32(audioBuffer) {
  const tmpFile = join(tmpdir(), `voice-${randomUUID()}.audio`);
  await writeFile(tmpFile, audioBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', tmpFile,
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 'f32le',
        'pipe:1',
      ]);
      const out = [];
      const errChunks = [];
      ff.stdout.on('data', (c) => out.push(c));
      ff.stderr.on('data', (c) => errChunks.push(c));
      ff.on('error', reject);
      ff.on('close', (code) => {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        if (code !== 0) {
          return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        }
        const buf = Buffer.concat(out);
        if (buf.length === 0) {
          return reject(new Error(`ffmpeg produced no PCM output: ${stderr || '(no stderr)'}`));
        }
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
        // Copy to detach from underlying Buffer (which may be reused/pooled)
        resolve(new Float32Array(f32));
      });
    });
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Compute the speaker embedding for an audio buffer. Returns a Float32Array
 * of length 512, plus enrollment metadata in the shape eagle.js produces.
 *
 * The "percentage" semantics here are heuristic — Eagle has a real signal
 * (it tracks how many clean voiced frames it's seen). For Transformers.js
 * we estimate based on raw clip length: <5s → 0%, ≥20s → 100%, linear in
 * between. The matcher is more forgiving than Eagle so this is a reasonable
 * proxy until we add VAD-based clean-speech accounting.
 */
export async function enroll(audioBuffer) {
  const pcm = await decodeToFloat32(audioBuffer);
  const sampleSeconds = pcm.length / SAMPLE_RATE;

  if (pcm.length < MIN_SAMPLES) {
    return {
      profile: null,
      embedding: null,
      percentage: Math.floor((pcm.length / MIN_OK_SAMPLES) * 100),
      sampleSeconds,
      version: MODEL_ID,
      sampleRate: SAMPLE_RATE,
    };
  }

  const model = await getModel();
  const tensor = new _Tensor('float32', pcm, [1, pcm.length]);
  const out = await model({ input_values: tensor });
  const raw = out.embeddings?.data || out.logits?.data;
  if (!raw || raw.length !== 512) {
    throw new Error(`unexpected embedding shape (got ${raw?.length})`);
  }

  // L2 normalize so cosine similarity is just a dot product downstream.
  const embedding = new Float32Array(512);
  let norm = 0;
  for (let i = 0; i < 512; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 512; i++) embedding[i] = raw[i] / norm;

  const percentage = Math.min(100, Math.floor((pcm.length / MIN_OK_SAMPLES) * 100));

  return {
    profile: null,                  // transformers engine doesn't use the BYTEA path
    embedding: percentage >= 100 ? embedding : null,
    percentage,
    sampleSeconds,
    version: MODEL_ID,
    sampleRate: SAMPLE_RATE,
  };
}

/**
 * Score an audio buffer against a list of enrolled embeddings. Returns the
 * same { scores: [...] } shape eagle.js does. Scores are cosine similarity
 * in [-1, 1]; a threshold around 0.7 typically separates same/different
 * speaker but the caller should tune for their data.
 *
 * profiles: Array<{ id, displayName, embedding: Float32Array }>
 */
export async function matchSpeakers(audioBuffer, profiles) {
  if (!profiles || profiles.length === 0) return { scores: [] };

  const result = await enroll(audioBuffer);
  // Force-embed even if percentage didn't hit 100 — match-time clips can
  // be short utterances; the enrollment threshold doesn't apply.
  let queryEmbedding = result.embedding;
  if (!queryEmbedding) {
    // Re-run without the percentage gate
    const pcm = await decodeToFloat32(audioBuffer);
    const model = await getModel();
    const tensor = new _Tensor('float32', pcm, [1, pcm.length]);
    const out = await model({ input_values: tensor });
    const raw = out.embeddings?.data;
    queryEmbedding = new Float32Array(512);
    let norm = 0;
    for (let i = 0; i < 512; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 512; i++) queryEmbedding[i] = raw[i] / norm;
  }

  const scores = profiles.map((p) => {
    let dot = 0;
    for (let i = 0; i < 512; i++) dot += queryEmbedding[i] * p.embedding[i];
    return {
      id: p.id,
      displayName: p.displayName,
      mean: dot,
      peak: dot,
      samples: 1,
    };
  });

  return { scores };
}
