/**
 * Progressive Intent Front Door — Tier 0/1 visitor classifier.
 *
 * Feature 008 (spec/features/008-progressive-intent-front-door.md), Phase 1.
 *
 * Pure, dependency-free classification of an inbound /submit request from its
 * Referer + User-Agent into the intent-fidelity ladder's lowest rungs:
 *
 *   { visitor_kind: 'human' | 'agent',
 *     platform:     'chatgpt' | 'perplexity' | 'claude' | 'direct' | 'agent',
 *     tier:         0 | 1 }
 *
 * KEEP IN SYNC with the ag-webapp TS port (test-site edge classifier):
 *   ag-webapp/src/lib/frontDoor/classifyVisitor.ts
 *
 * This is INFERENCE only (intent_source = 'inferred'). It never reads or trusts
 * a declared intent — declared-intent tiers (2/3) are later phases. The classifier
 * is positioning + routing input, NOT a security control (spec §0, §6): a raw GET
 * can spoof any header, so nothing here gates safety. Downstream Model-Armor /
 * publish gates (P1-A, a parallel track) own that boundary.
 *
 * Ladder mapping handled here (spec §1 table):
 *   Tier 0 — anonymous human: no usable referral platform signal -> platform 'direct'.
 *   Tier 1 — LLM-referred human: referrer is a known LLM platform -> platform set,
 *            tier 1. (The query is stripped by the referrer; only the platform
 *            survives — that is exactly the Fibr-parity signal.)
 *   Agent  — non-human User-Agent -> visitor_kind 'agent', platform 'agent'.
 *            Agents are NOT yet given a tier-3 path in Phase 1; they fall through
 *            to the same inference branch (tier 0/1) until forced declaration ships.
 */

// Known LLM referral host fragments -> canonical platform label.
// Matched as substrings against the lowercased referrer hostname so subdomains
// (e.g. www.chatgpt.com, chat.openai.com) and future host variants still resolve.
const PLATFORM_HOST_FRAGMENTS = Object.freeze([
  { fragment: 'chatgpt.com', platform: 'chatgpt' },
  { fragment: 'chat.openai.com', platform: 'chatgpt' },
  { fragment: 'openai.com', platform: 'chatgpt' },
  { fragment: 'perplexity.ai', platform: 'perplexity' },
  { fragment: 'claude.ai', platform: 'claude' },
  { fragment: 'anthropic.com', platform: 'claude' },
]);

// User-Agent substrings that mark a non-human (agent / bot / automated) caller.
// Lowercased substring match. Deliberately broad: when in doubt about humanity,
// inference is cheap and the classification is advisory, not enforcing.
const AGENT_UA_FRAGMENTS = Object.freeze([
  'bot', 'crawler', 'spider', 'scraper',
  'gptbot', 'oai-searchbot', 'chatgpt-user',
  'perplexitybot', 'claudebot', 'claude-web', 'anthropic-ai',
  'python-requests', 'axios', 'node-fetch', 'curl', 'wget',
  'go-http-client', 'okhttp', 'httpx', 'headlesschrome',
  'agent',
]);

/**
 * Extract the lowercased hostname from a Referer header value.
 * Returns '' when the referrer is absent or unparseable.
 */
function refererHost(referer) {
  if (!referer || typeof referer !== 'string') return '';
  try {
    return new URL(referer).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Classify the referral platform from a Referer header value.
 * Returns one of the LLM platform labels, or 'direct' when no known LLM
 * referrer is present (anonymous / direct / unknown-referrer traffic).
 */
export function classifyPlatform(referer) {
  const host = refererHost(referer);
  if (!host) return 'direct';
  for (const { fragment, platform } of PLATFORM_HOST_FRAGMENTS) {
    if (host.includes(fragment)) return platform;
  }
  return 'direct';
}

/**
 * Classify the visitor kind from a User-Agent header value.
 * Returns 'agent' for non-human UAs (bots, scrapers, HTTP libraries, declared
 * agents), 'human' otherwise. A missing/empty UA is treated as 'agent' —
 * real browsers always send one, so its absence is an automated-caller signal.
 */
export function classifyVisitorKind(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return 'agent';
  const ua = userAgent.toLowerCase();
  for (const fragment of AGENT_UA_FRAGMENTS) {
    if (ua.includes(fragment)) return 'agent';
  }
  return 'human';
}

/**
 * Tier 0/1 classification of a visitor from request headers.
 *
 * @param {object} headers - HTTP request headers (lowercased keys, Node style).
 *   Reads `referer` (and the `referrer` misspelling) and `user-agent`.
 * @returns {{ visitor_kind: 'human'|'agent',
 *             platform: 'chatgpt'|'perplexity'|'claude'|'direct'|'agent',
 *             tier: 0|1 }}
 *
 * Tier logic (spec §1):
 *   - A known LLM referrer => tier 1 (LLM-referred), platform = that LLM.
 *   - No LLM referrer => tier 0 (anonymous/direct), platform 'direct'.
 *   - A non-human UA reports visitor_kind 'agent' and platform 'agent' (it has
 *     no browser referrer to attribute), pinned to tier 0. Phase 3 will give
 *     agents their own forced-declaration path; until then they infer like a
 *     tier-0 visitor.
 */
export function classifyVisitor(headers = {}) {
  const referer = headers.referer || headers.referrer || '';
  const userAgent = headers['user-agent'] || '';

  const visitor_kind = classifyVisitorKind(userAgent);

  if (visitor_kind === 'agent') {
    // No browser referrer to attribute an LLM platform to; agents are their own
    // platform bucket and sit at tier 0 until the Phase 3 declaration path lands.
    return { visitor_kind, platform: 'agent', tier: 0 };
  }

  const platform = classifyPlatform(referer);
  const tier = platform === 'direct' ? 0 : 1;
  return { visitor_kind, platform, tier };
}
