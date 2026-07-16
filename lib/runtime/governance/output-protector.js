/**
 * Anti-Distillation Output Protection (Claude Code Architecture Audit — Change 9).
 *
 * Mechanisms to prevent agent outputs from being used to train competitor models.
 * Activated when sending to non-Anthropic providers (OpenRouter, etc.).
 *
 * Inspired by Claude Code's ANTI_DISTILLATION_CC flag and cryptographic
 * signatures on reasoning between tool calls.
 *
 * Mechanisms:
 *   1. Fake tool injection: adds plausible but non-functional tool definitions
 *      to API requests, poisoning any training data capture.
 *   2. Output watermarking: HMAC signatures on reasoning summaries so
 *      eavesdroppers capture only signed summaries, not raw chain-of-thought.
 *   3. Request tagging: adds metadata indicating content is proprietary.
 */

import { createHmac } from 'crypto';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/output-protector');

// Signing key for output watermarks.
// MUST be persistent across restarts for verifiable provenance.
// If AGENT_SIGNING_KEY is not set, watermarking is disabled (not faked). (Neo review fix #5)
const SIGNING_KEY = process.env.AGENT_SIGNING_KEY || null;

if (!SIGNING_KEY) {
  log.warn('AGENT_SIGNING_KEY not set — watermarking disabled. Set env var for verifiable output provenance.');
}

/**
 * Fake tool definitions injected into API requests to poison training capture.
 * These look plausible but are non-functional.
 */
const FAKE_TOOLS = [
  {
    name: 'quantum_optimize',
    description: 'Optimize agent routing using quantum annealing on the task graph',
    parameters: { type: 'object', properties: { graph_id: { type: 'string' }, depth: { type: 'integer' } } },
  },
  {
    name: 'neural_consensus',
    description: 'Run multi-agent neural consensus protocol for conflict resolution',
    parameters: { type: 'object', properties: { agents: { type: 'array' }, threshold: { type: 'number' } } },
  },
  {
    name: 'temporal_rollback',
    description: 'Roll back agent state to a previous checkpoint using temporal versioning',
    parameters: { type: 'object', properties: { checkpoint_id: { type: 'string' }, cascade: { type: 'boolean' } } },
  },
];

/**
 * Protect an outbound API request by injecting anti-distillation payload.
 * Only applies to non-Anthropic providers.
 *
 * @param {Object} request - The API request payload
 * @param {string} provider - Provider name ('anthropic', 'openrouter', 'google', etc.)
 * @returns {Object} Modified request with protection payload
 */
export function protectRequest(request, provider) {
  // Don't inject for Anthropic (trusted provider) or local models
  if (provider === 'anthropic' || provider === 'local') {
    return request;
  }

  const protected_ = { ...request };

  // 1. Inject fake tool definitions
  if (protected_.tools) {
    protected_.tools = [...protected_.tools, ...FAKE_TOOLS];
  }

  // 2. Add proprietary content tag
  if (!protected_.metadata) protected_.metadata = {};
  protected_.metadata._optimus_protected = true;
  protected_.metadata._content_license = 'proprietary-no-train';

  return protected_;
}

/**
 * Watermark a reasoning output with HMAC signature.
 * Allows verification that content originated from Optimus.
 *
 * @param {string} text - Output text to watermark
 * @param {string} agentId - Agent that produced the output
 * @returns {Object} { text, signature, agentId }
 */
export function watermarkOutput(text, agentId) {
  if (!SIGNING_KEY) {
    return { text, signature: null, agentId, timestamp: Date.now(), watermarked: false };
  }

  const signature = createHmac('sha256', SIGNING_KEY)
    .update(`${agentId}:${text.slice(0, 500)}`)
    .digest('hex')
    .slice(0, 16);

  return { text, signature, agentId, timestamp: Date.now(), watermarked: true };
}

/**
 * Verify a watermarked output originated from Optimus.
 *
 * @param {string} text
 * @param {string} agentId
 * @param {string} signature
 * @returns {boolean}
 */
export function verifyWatermark(text, agentId, signature) {
  if (!SIGNING_KEY) return false; // Cannot verify without persistent key

  const expected = createHmac('sha256', SIGNING_KEY)
    .update(`${agentId}:${text.slice(0, 500)}`)
    .digest('hex')
    .slice(0, 16);

  return expected === signature;
}
