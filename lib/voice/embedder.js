/**
 * Voice embedder facade.
 *
 * Picks the active speaker-recognition engine based on VOICE_EMBEDDER:
 *   - 'transformers' (default) — local WavLM via @huggingface/transformers,
 *                                 free, no account, ~36ms/clip on CPU.
 *   - 'eagle'                  — Picovoice Eagle, requires PICOVOICE_ACCESS_KEY.
 *
 * Both engines return the same shape from enroll() / matchSpeakers(), so the
 * routes and DB layer stay engine-agnostic. The DB column populated depends
 * on the engine: 'transformers' fills `embedding vector(512)`, 'eagle' fills
 * `profile bytea`. The `embedder` column on each row records which one ran
 * so match time can dispatch correctly.
 */

import * as transformers from './transformers.js';

let _eagle = null;
async function loadEagle() {
  if (!_eagle) _eagle = await import('./eagle.js');
  return _eagle;
}

export function activeEngine() {
  const env = (process.env.VOICE_EMBEDDER || 'transformers').toLowerCase();
  return env === 'eagle' ? 'eagle' : 'transformers';
}

export async function enroll(audioBuffer, opts = {}) {
  if (activeEngine() === 'eagle') {
    const eagle = await loadEagle();
    return eagle.enroll(audioBuffer, opts);
  }
  return transformers.enroll(audioBuffer, opts);
}

export async function matchSpeakers(audioBuffer, profiles) {
  if (activeEngine() === 'eagle') {
    const eagle = await loadEagle();
    return eagle.matchSpeakers(audioBuffer, profiles);
  }
  return transformers.matchSpeakers(audioBuffer, profiles);
}
