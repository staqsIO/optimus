/**
 * Picovoice Eagle wrapper — speaker enrollment and matching.
 *
 *   enroll(audioBuffer, opts)            — feed an audio file (any format ffmpeg
 *                                          can read) into EagleProfiler. Returns
 *                                          { profile: Uint8Array, percentage,
 *                                          sampleSeconds, version } when complete,
 *                                          or { profile: null, percentage, ... }
 *                                          when more audio is needed.
 *
 *   matchSpeakers(audioBuffer, profiles) — run continuous audio through Eagle
 *                                          with all enrolled profiles, return
 *                                          per-profile mean confidence so the
 *                                          caller can map AssemblyAI speaker
 *                                          segments to known identities.
 *
 * Eagle requires 16 kHz, mono, 16-bit PCM. We shell out to ffmpeg (Alpine
 * package in the Dockerfile, /opt/homebrew on Mac dev) to convert browser
 * webm/opus or Apple Shortcut m4a/aac into the right shape.
 */

import { spawn } from 'child_process';
import { EagleProfiler, Eagle } from '@picovoice/eagle-node';

const SAMPLE_RATE = 16000;

function accessKey() {
  const k = process.env.PICOVOICE_ACCESS_KEY;
  if (!k) throw new Error('PICOVOICE_ACCESS_KEY not configured');
  return k;
}

/**
 * Convert any-format audio bytes to 16 kHz mono signed-16 PCM via ffmpeg.
 * Returns an Int16Array of samples.
 */
export function decodeToPcm16k(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1',
    ]);
    const out = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 500)}`));
      }
      const buf = Buffer.concat(out);
      // Buffer is little-endian s16; create Int16Array sharing memory.
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      resolve(pcm);
    });
    ff.stdin.on('error', () => { /* swallow EPIPE if ffmpeg fails fast */ });
    ff.stdin.end(audioBuffer);
  });
}

/**
 * Run a single-pass enrollment against a fresh EagleProfiler.
 *
 * One-shot v1: caller hands in a single audio buffer, we feed it in
 * frame-by-frame, then flush. If percentage hits 100, we export and
 * return the profile. If not, the caller asks the user to record more.
 */
export async function enroll(audioBuffer, { minEnrollmentChunks } = {}) {
  const pcm = await decodeToPcm16k(audioBuffer);
  const profiler = new EagleProfiler(accessKey(), {
    ...(minEnrollmentChunks ? { minEnrollmentChunks } : {}),
  });
  try {
    let percentage = 0;
    // EagleProfiler.enroll wants a single contiguous chunk per call (not a
    // single frame). Feed the whole pcm — the SDK chunks internally.
    if (pcm.length > 0) {
      percentage = profiler.enroll(pcm);
    }
    // Flush returns final percentage (rolls up any buffered audio).
    const finalPct = profiler.flush();
    percentage = Math.max(percentage, finalPct);
    let profile = null;
    if (percentage >= 100) {
      profile = profiler.export();
    }
    return {
      profile,
      percentage,
      sampleSeconds: pcm.length / SAMPLE_RATE,
      version: profiler.version,
      sampleRate: profiler.sampleRate,
    };
  } finally {
    profiler.release();
  }
}

/**
 * Run an Eagle inference pass over an audio buffer with the given profiles.
 *
 * profiles: Array<{ id, displayName, profile: Uint8Array }>
 *
 * Returns { scores: Array<{ id, displayName, mean, peak, samples }> }
 * where mean/peak are over the per-frame confidence values Eagle produced
 * for each profile across the whole audio.
 */
export async function matchSpeakers(audioBuffer, profiles) {
  if (!profiles || profiles.length === 0) {
    return { scores: [] };
  }
  const pcm = await decodeToPcm16k(audioBuffer);
  const eagle = new Eagle(accessKey(), profiles.map((p) => p.profile));
  try {
    const frameLen = eagle.minProcessSamples;
    const totals = profiles.map(() => 0);
    const peaks = profiles.map(() => 0);
    let frames = 0;
    for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
      const slice = pcm.subarray(i, i + frameLen);
      const scores = eagle.process(slice);
      for (let p = 0; p < scores.length; p++) {
        totals[p] += scores[p];
        if (scores[p] > peaks[p]) peaks[p] = scores[p];
      }
      frames += 1;
    }
    return {
      scores: profiles.map((p, idx) => ({
        id: p.id,
        displayName: p.displayName,
        mean: frames ? totals[idx] / frames : 0,
        peak: peaks[idx],
        samples: frames,
      })),
    };
  } finally {
    eagle.release();
  }
}
