/**
 * Progressive Intent Front Door — serve-by-match corpus lookup.
 *
 * Feature 008 (spec/features/008-progressive-intent-front-door.md), Phase 1, §1 / §7.
 *
 * The intent-fidelity ladder routes EVERY visitor through one backend:
 *
 *     intent (however acquired)
 *       -> intent-matcher
 *            -> corpus HIT  -> serve pre-generated static page  (~$0, instant)
 *            -> COLD TAIL   -> live generation (existing /submit path, gated)
 *
 * This module is the corpus-HIT branch. It runs BEFORE live generation and,
 * when a pre-generated entry exists for the (site, intent), returns it so
 * /submit can serve it instantly instead of enqueuing a ~$2.31 Sonnet job.
 *
 * The corpus store is content.front_door_corpus (sql/162) — pre-generated
 * offline by tools/front-door/seed-corpus.js (Model-Armor screened, sanitized,
 * board-approved intents; payload carries Shopify handles only). Matching:
 *   1. embedding cosine against intent_embedding (threshold EMBED_THRESHOLD)
 *      when the embedder is available and rows carry embeddings;
 *   2. token-overlap (Jaccard) against intent_text + intent_variants as the
 *      no-embedder fallback (threshold KEYWORD_THRESHOLD).
 * Only `published` rows with the CURRENT safety version are candidates —
 * mirrors the redesign dedup invariant (re-screen on safety bump).
 *
 * The branch stays gated behind FRONT_DOOR_SERVE_BY_MATCH (default OFF) so the
 * rollout is an env flip, not a deploy.
 */

import { query } from '../db.js';
import { embedOne } from '../../../lib/rag/embedder.js';
import { REDESIGN_SAFETY_VERSION } from '../../../lib/runtime/redesign-safety.js';

// Cosine floor for an embedding match. Head intents are short marketing
// phrases; 0.78 keeps "best beginner acoustic guitar" ≈ "good starter acoustic"
// while rejecting cross-category drift. Tunable constant, not env — change it
// in code where the rationale lives.
export const EMBED_THRESHOLD = 0.78;

// Jaccard floor for the keyword fallback (no embedder). Stricter relative bar:
// token overlap is a much coarser signal than cosine.
export const KEYWORD_THRESHOLD = 0.5;

/**
 * Whether the serve-by-match branch is enabled.
 * Default OFF. Read at call time (not module load) so tests / ops can toggle
 * it per request without a process restart.
 *
 * @returns {boolean}
 */
export function serveByMatchEnabled() {
  const v = (process.env.FRONT_DOOR_SERVE_BY_MATCH || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Hostname for corpus scoping: lowercase, strip a single leading 'www.'.
 * Returns null when the URL is unparseable (caller misses, never throws).
 */
export function siteHostFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// pg returns pgvector columns as their text form '[0.1,0.2,…]' (valid JSON).
function parseVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
  );
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

/** Best keyword score for a row across intent_text + intent_variants. */
function keywordScore(intentTokens, row) {
  const variants = Array.isArray(row.intent_variants) ? row.intent_variants : [];
  let best = jaccard(intentTokens, tokenize(row.intent_text));
  for (const v of variants) {
    const s = jaccard(intentTokens, tokenize(v));
    if (s > best) best = s;
  }
  return best;
}

/**
 * Look up a pre-generated corpus page for a (url, intent) given the visitor
 * classification, BEFORE live generation is triggered.
 *
 * @param {object} args
 * @param {string} args.url            - normalized target URL
 * @param {string} args.intent         - visitor intent (may be '')
 * @param {object} args.classification - { tier, platform, visitor_kind } from
 *                                       visitor-classifier.js (advisory here)
 * @param {object} [deps]              - injectable for offline tests
 * @returns {Promise<{ hit: boolean, artifactId?: string, html?: string|null,
 *                     payload?: object, intentSlug?: string, score?: number,
 *                     reason: string }>}
 *
 * When `hit` is false the caller MUST fall through to existing generation.
 * Never throws — any failure is a miss (the cold-tail path is always safe).
 */
export async function findCorpusMatch(
  { url, intent, classification } = {},
  { _query = query, _embedOne = embedOne } = {}
) {
  void classification; // tier/platform routing defaults live client-side in Phase 1
  const trimmed = typeof intent === 'string' ? intent.trim() : '';
  if (!trimmed) return { hit: false, reason: 'no-intent' };

  const siteHost = siteHostFromUrl(url);
  if (!siteHost) return { hit: false, reason: 'bad-url' };

  let rows;
  try {
    const res = await _query(
      `SELECT id, intent_slug, intent_text, intent_variants, intent_embedding,
              payload, html
         FROM content.front_door_corpus
        WHERE site_host = $1
          AND publish_status = 'published'
          AND safety_version = $2`,
      [siteHost, REDESIGN_SAFETY_VERSION]
    );
    rows = res.rows || [];
  } catch (err) {
    // Corpus unavailable (e.g. migration not applied) must never block /submit.
    return { hit: false, reason: `corpus-error:${err.code || 'query'}` };
  }
  if (rows.length === 0) return { hit: false, reason: 'corpus-empty' };

  // 1. Embedding cosine when both sides have vectors.
  let intentVec = null;
  try {
    intentVec = await _embedOne(trimmed); // null when key/provider unavailable
  } catch {
    intentVec = null;
  }
  if (intentVec) {
    let best = null;
    let bestScore = -1;
    for (const row of rows) {
      const rowVec = parseVector(row.intent_embedding);
      if (!rowVec) continue;
      const s = cosine(intentVec, rowVec);
      if (s > bestScore) {
        bestScore = s;
        best = row;
      }
    }
    if (best && bestScore >= EMBED_THRESHOLD) {
      return {
        hit: true,
        artifactId: best.id,
        html: best.html ?? null,
        payload: best.payload,
        intentSlug: best.intent_slug,
        score: bestScore,
        reason: 'corpus-hit',
      };
    }
    // Embedder spoke: trust its below-threshold verdict; do NOT fall through to
    // the coarser keyword match, which would only re-admit weaker matches.
    return { hit: false, reason: 'below-threshold' };
  }

  // 2. Keyword (Jaccard) fallback — embedder unavailable.
  const intentTokens = tokenize(trimmed);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const s = keywordScore(intentTokens, row);
    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }
  if (best && bestScore >= KEYWORD_THRESHOLD) {
    return {
      hit: true,
      artifactId: best.id,
      html: best.html ?? null,
      payload: best.payload,
      intentSlug: best.intent_slug,
      score: bestScore,
      reason: 'corpus-hit',
    };
  }
  return { hit: false, reason: 'below-threshold' };
}

/**
 * Resolve the serve-by-match branch for /submit.
 *
 * Single decision point the submit handler calls before enqueuing generation.
 * Returns a directive the handler acts on:
 *   - { serve: false, reason } when the flag is off OR no corpus match — the
 *     handler proceeds with its existing live-generation path UNCHANGED.
 *   - { serve: true, artifactId, html, payload, intentSlug, reason } when a
 *     pre-generated entry matched. html may be null in Phase 1 — the payload
 *     (structured JSON) is the servable artifact for the agent path.
 *
 * @param {object} args - forwarded to findCorpusMatch (url, intent, classification)
 * @param {object} [deps] - forwarded to findCorpusMatch (tests)
 * @returns {Promise<{ serve: boolean, artifactId?: string, html?: string|null,
 *                     payload?: object, intentSlug?: string, reason: string }>}
 */
export async function resolveServeByMatch(args = {}, deps = undefined) {
  if (!serveByMatchEnabled()) {
    return { serve: false, reason: 'flag-off' };
  }
  const match = await findCorpusMatch(args, deps);
  if (!match.hit) {
    return { serve: false, reason: match.reason || 'no-match' };
  }
  return {
    serve: true,
    artifactId: match.artifactId,
    html: match.html ?? null,
    payload: match.payload,
    intentSlug: match.intentSlug,
    reason: 'corpus-hit',
  };
}
