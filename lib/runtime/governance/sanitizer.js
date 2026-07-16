/**
 * Content sanitization on context load (spec §5, step 4f).
 * P2: Infrastructure enforces. The task graph IS the persistent memory —
 * therefore the attack surface for delayed-execution payloads.
 *
 * Three-layer defense:
 *   1. Regex blocklist (this file) — strip known injection patterns
 *   2. XML structural separation (agent prompts) — email content in <untrusted_email> tags
 *   3. System prompt hardening (agent prompts) — explicit instructions to ignore injections
 *
 * Phase 2: Versioned rule sets (spec §5).
 * Each rule set is content-addressed (SHA-256). The active version is recorded
 * in every audit entry. New versions require Strategist approval and a test pass
 * against the adversarial test suite before activation.
 */

import { createHash } from 'crypto';
import { google } from 'googleapis';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
const log = createLogger('runtime/sanitizer');

// ============================================================
// Hardcoded fallback patterns (v1.0.0 — used when DB unavailable)
// ============================================================
const FALLBACK_PATTERNS = [
  // Prompt injection — direct
  /\b(ignore|disregard|forget|override|bypass|skip)\s+(previous|above|all|prior|these|the|my|your|any)(\s+\w+)*\s*(instructions?|prompts?|rules?|directives?|guidelines?|constraints?|system)\b/gi,
  /\bnew\s+(instructions?|rules?|directives?|task|objective)\s*:/gi,
  /\b(from now on|starting now|henceforth)\b.*\b(you (are|will|should|must)|your (role|task|job))\b/gi,
  // Role hijacking
  /\b(you are|act as|pretend to be|roleplay as|assume the role|behave as|switch to|become)\b/gi,
  /\bsystem\s*:\s*/gi,
  /\bassistant\s*:\s*/gi,
  /\bhuman\s*:\s*/gi,
  /\buser\s*:\s*/gi,
  // Output manipulation — trying to inject JSON responses
  /\brespond\s+with\s+(json|the following|this|exactly)\b/gi,
  /\boutput\s*:\s*\{/gi,
  /```json\s*\{/gi,
  // Data exfiltration attempts
  /\b(send|forward|transmit|exfiltrate|leak|copy|share)\s+(to|data|info|credentials|keys|tokens|secrets|password|api.?key|private)\b/gi,
  /\b(fetch|curl|wget|request|call|invoke)\s+(https?:\/\/|url|endpoint|webhook)/gi,
  // Tool/code abuse
  /\b(execute|run|eval|exec|spawn|fork)\s*\(/gi,
  /\bimport\s*\(|require\s*\(/gi,
  // Delimiter/tag injection — trying to close/open XML tags
  /<\/?(?:untrusted_email|system|instructions|rules|context|prompt)[\s>]/gi,
  // Base64-encoded payloads (suspicious long strings)
  /[A-Za-z0-9+/=]{200,}/g,
  // Unicode homoglyph evasion (common substitutions for "ignore", "system")
  /[\u0456\u0069][\u0261\u0067]n[\u043E\u006F]r[\u0435\u0065]/gi,
];

// PII detection patterns (spec §5 step 4f, Gap 12)
// These flag content for data classification review — they don't block.
// Used by detectPII() separately from injection sanitization.
const PII_PATTERNS = [
  // US Social Security Number (XXX-XX-XXXX or XXXXXXXXX)
  { type: 'ssn', pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  // Credit card numbers (13-19 digits with optional separators)
  { type: 'credit_card', pattern: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g },
  // US phone numbers (various formats)
  { type: 'phone', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // Email addresses (basic detection — not for sanitization, just flagging)
  { type: 'email', pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  // Date of birth patterns (MM/DD/YYYY, YYYY-MM-DD near "dob", "born", "birthday")
  { type: 'dob', pattern: /\b(?:dob|born|birthday|date of birth)\b[^.]{0,30}\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/gi },
  // US passport number (9 digits)
  { type: 'passport', pattern: /\bpassport\b[^.]{0,20}\b[A-Z]?\d{8,9}\b/gi },
  // Driver's license (state-dependent, catch common format: letters + digits)
  { type: 'drivers_license', pattern: /\b(?:driver'?s?\s*licen[cs]e|DL)\b[^.]{0,20}\b[A-Z]{1,2}\d{5,12}\b/gi },
];

// ============================================================
// Active rule set state
// ============================================================
let activeRuleSet = null;  // { id, version, sha256Hash, patterns: RegExp[] }
let dbAvailable = false;

/**
 * Initialize the sanitizer by loading the active rule set from DB.
 * Falls back to hardcoded patterns if DB is unavailable.
 */
export async function initSanitizer() {
  try {
    const { query } = await import('../../db.js');
    const result = await query(
      `SELECT id, version, sha256_hash, rules
       FROM agent_graph.sanitization_rule_sets
       WHERE is_active = true
       LIMIT 1`
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const patterns = compilePatterns(row.rules);
      activeRuleSet = {
        id: row.id,
        version: row.version,
        sha256Hash: row.sha256_hash,
        patterns,
      };
      dbAvailable = true;
      log.info(`Loaded rule set v${row.version} (${row.sha256_hash.slice(0, 12)}...)`);
    } else {
      log.info('No active rule set in DB, using hardcoded fallback');
      activeRuleSet = null;
    }
  } catch (err) {
    log.warn(`DB unavailable, using hardcoded fallback: ${err.message}`);
    activeRuleSet = null;
    dbAvailable = false;
  }
}

/**
 * Compile JSONB pattern definitions into RegExp objects.
 */
function compilePatterns(rules) {
  if (!rules || !rules.patterns || !Array.isArray(rules.patterns)) {
    return [];
  }
  const compiled = [];
  for (const rule of rules.patterns) {
    try {
      compiled.push(new RegExp(rule.pattern, rule.flags || 'gi'));
    } catch (err) {
      log.warn(`Invalid pattern "${rule.pattern}": ${err.message}`);
    }
  }
  return compiled;
}

/**
 * Get the current injection patterns (DB-loaded or fallback).
 */
function getPatterns() {
  if (activeRuleSet && activeRuleSet.patterns.length > 0) {
    return activeRuleSet.patterns;
  }
  return FALLBACK_PATTERNS;
}

// ============================================================
// Public API — preserved from Phase 1
// ============================================================

/**
 * Sanitize a context object by scanning all string values.
 * Returns a new object with sanitized strings.
 */
export function sanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj instanceof Date) return obj;
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitize(value);
    }
    return result;
  }
  return obj;
}

/**
 * Count injection attempts (for logging/alerting).
 */
export function countInjectionAttempts(str) {
  if (typeof str !== 'string') return 0;
  const patterns = getPatterns();
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(str)) count++;
  }
  return count;
}

/**
 * Count injection attempts and record as threat events (spec §8).
 * Async wrapper that feeds into the graduated escalation system.
 *
 * Returns a verdict object. Existing fire-and-forget callers ignore the
 * return value, so the shape change is backward-compatible.
 *
 * @param {string} str - Input string to scan
 * @param {string} agentId - Agent processing this input
 * @param {string} [scopeType='agent'] - Scope for threat recording
 * @returns {Promise<{
 *   count: number,
 *   modelArmorMatched: boolean,
 *   confidence: string|null,
 *   severity: 'LOW'|'MEDIUM'|'HIGH'|null,
 *   blocked: boolean,
 * }>}
 */
export async function detectAndRecordThreats(str, agentId, scopeType = 'agent') {
  const count = countInjectionAttempts(str);

  // G8: Model Armor check (second layer — regex is fast, Model Armor is thorough)
  let modelArmorResult = null;
  if (getModelArmorConfig().template && str && str.length >= 20) {
    modelArmorResult = await checkModelArmor(str);
  }

  const modelArmorMatched = modelArmorResult?.matched || false;
  const confidence = modelArmorResult?.confidence || null;
  const threatDetected = count > 0 || modelArmorMatched;

  let severity = null;
  if (threatDetected) {
    // Determine severity: Model Armor HIGH overrides regex count
    if (confidence === 'HIGH' || count >= 3) {
      severity = 'HIGH';
    } else if (confidence === 'MEDIUM_AND_ABOVE' || count >= 2) {
      severity = 'MEDIUM';
    } else {
      severity = 'LOW';
    }

    try {
      const { recordThreatEvent } = await import('../escalation-manager.js');
      await recordThreatEvent({
        sourceType: 'sanitization',
        scopeType,
        scopeId: agentId,
        threatClass: 'INJECTION_ATTEMPT',
        severity,
        detail: {
          patternCount: count,
          modelArmor: modelArmorMatched ? {
            confidence,
            mode: getModelArmorConfig().mode,
          } : null,
          inputPreview: str.slice(0, 200),
        },
      });
    } catch {
      // Non-fatal: threat_memory table may not exist yet
    }
  }

  // Block iff: mode is 'block' AND Model Armor matched AND confidence meets threshold.
  // Regex-only matches never block — they're noisy and high-false-positive.
  const { mode, blockThreshold } = getModelArmorConfig();
  const blocked = mode === 'block' && modelArmorMatched && confidence === blockThreshold;

  return { count, modelArmorMatched, confidence, severity, blocked };
}

/**
 * Detect PII in content (spec §5 step 4f, Gap 12).
 * Returns array of detected PII types with counts. Does NOT redact — flags only.
 * Use this to set data_classification on work items that contain PII.
 *
 * @param {string} str - Content to scan
 * @returns {{ hasPII: boolean, detections: Array<{type: string, count: number}> }}
 */
export function detectPII(str) {
  if (typeof str !== 'string' || !str) return { hasPII: false, detections: [] };
  const detections = [];
  for (const { type, pattern } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = str.match(pattern);
    if (matches && matches.length > 0) {
      detections.push({ type, count: matches.length });
    }
  }
  return { hasPII: detections.length > 0, detections };
}

// ============================================================
// G8: Model Armor — Google Cloud prompt injection detection
// Infrastructure-enforced (P2), not prompt-advised.
// ============================================================

// The real Model Armor template ships via the MODEL_ARMOR_TEMPLATE env var so
// it never lives in the (now public) config. gates.json G8 carries a non-secret
// placeholder as a documented fallback. The placeholder is treated as
// "unconfigured" (null) so fail-open/fail-closed behavior is IDENTICAL to an
// unset env var — a placeholder must never be sent to the Model Armor API.
const MODEL_ARMOR_TEMPLATE_PLACEHOLDER = 'YOUR_GCP_PROJECT';

// Resolve the template: env var wins; otherwise fall back to the gates.json G8
// value, unless that value is the OSS placeholder (or config is unreadable),
// in which case the template is unconfigured (null).
function resolveModelArmorTemplate() {
  const fromEnv = process.env.MODEL_ARMOR_TEMPLATE;
  if (fromEnv) return fromEnv;
  try {
    const fromGates = getConfig('gates')?.gates?.G8?.params?.template;
    if (fromGates && !fromGates.includes(MODEL_ARMOR_TEMPLATE_PLACEHOLDER)) {
      return fromGates;
    }
  } catch {
    // gates.json missing/malformed — treat template as unconfigured (null).
  }
  return null;
}

// Read at call time, not import time (dotenv may not have loaded yet)
export function getModelArmorConfig() {
  return {
    template: resolveModelArmorTemplate(),
    mode: process.env.MODEL_ARMOR_MODE || 'warn',
    blockThreshold: process.env.MODEL_ARMOR_BLOCK_THRESHOLD || 'HIGH',
  };
}

const MODEL_ARMOR_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MODEL_ARMOR_FETCH_TIMEOUT_MS = 10000;

// Cached GoogleAuth client (module scope). The library handles token refresh,
// so we build the auth client once and reuse it across calls (P4).
let _modelArmorAuth = null;

// Test seam: lets the test suite stub access-token minting without a live
// credential. Production leaves this null and uses the real GoogleAuth client.
let _tokenMinterOverride = null;

/**
 * @internal — test-only. Override the access-token minter so the REST path can
 * be exercised without live Google credentials. Pass null to restore default.
 */
export function __setModelArmorTokenMinterForTest(fn) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[sanitizer:G8] test-only seam invoked in production');
  }
  _tokenMinterOverride = fn;
  _modelArmorAuth = null; // force rebuild on next real call
}

/**
 * Parse a Google service-account key from GOOGLE_SERVICE_ACCOUNT_KEY.
 * Tolerates either raw JSON or base64-encoded JSON. Returns null if unset
 * or unparseable (caller falls back to ADC).
 */
function loadServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Not raw JSON — try base64-encoded JSON
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }
}

/**
 * Build (or return the cached) GoogleAuth client scoped for cloud-platform.
 * Uses GOOGLE_SERVICE_ACCOUNT_KEY if present; otherwise falls back to ADC so
 * local dev with `gcloud auth application-default login` still works.
 */
function getModelArmorAuth() {
  if (_modelArmorAuth) return _modelArmorAuth;
  const credentials = loadServiceAccountKey();
  _modelArmorAuth = credentials
    ? new google.auth.GoogleAuth({ credentials, scopes: [MODEL_ARMOR_SCOPE] })
    : new google.auth.GoogleAuth({ scopes: [MODEL_ARMOR_SCOPE] });
  return _modelArmorAuth;
}

/**
 * Mint an access token for the Model Armor REST call. The GoogleAuth client
 * caches and refreshes tokens internally, so this is cheap on the hot path.
 */
async function mintModelArmorToken() {
  if (_tokenMinterOverride) return _tokenMinterOverride();
  const client = await getModelArmorAuth().getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Check content against Google Model Armor for prompt injection (G8).
 * Returns { matched, confidence, raw } or null if unavailable.
 *
 * Calls the Model Armor REST API directly (no CLI / subprocess dependency).
 * Auth via google.auth.GoogleAuth (GOOGLE_SERVICE_ACCOUNT_KEY or ADC fallback),
 * scope cloud-platform. The endpoint is regional — the location is parsed from
 * the MODEL_ARMOR_TEMPLATE resource path. Non-blocking on failure: if Model
 * Armor is unavailable or returns non-2xx, logs a warning and returns null
 * (P4: graceful degradation at this layer; fail-open upstream is OPT-106).
 *
 * @param {string} text - Content to sanitize (email body, document content)
 * @returns {Promise<{matched: boolean, confidence: string|null, raw: object}|null>}
 */
export async function checkModelArmor(text) {
  const { template: MODEL_ARMOR_TEMPLATE } = getModelArmorConfig();
  if (!MODEL_ARMOR_TEMPLATE) return null;
  if (!text || typeof text !== 'string' || text.length < 20) return null;

  // Parse the region from the template resource path:
  // projects/<P>/locations/<L>/templates/<T>
  const locationMatch = MODEL_ARMOR_TEMPLATE.match(/\/locations\/([^/]+)\//);
  const location = locationMatch?.[1];
  if (!location) {
    log.warn(`[sanitizer:G8] MODEL_ARMOR_TEMPLATE missing /locations/<L>/ — skipping: ${MODEL_ARMOR_TEMPLATE}`);
    return null;
  }

  // Cap input to avoid oversized API calls (Model Armor has limits)
  const input = text.slice(0, 10000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_ARMOR_FETCH_TIMEOUT_MS);

  try {
    const token = await mintModelArmorToken();
    if (!token) {
      log.warn('[sanitizer:G8] Failed to mint access token — skipping Model Armor check');
      return null;
    }

    const url = `https://modelarmor.${location}.rep.googleapis.com/v1/${MODEL_ARMOR_TEMPLATE}:sanitizeUserPrompt`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userPromptData: { text: input } }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.warn(`[sanitizer:G8] Model Armor HTTP ${res.status} (non-fatal) — skipping`);
      return null;
    }

    const json = await res.json();
    const sr = json.sanitizationResult || json;
    const matched = sr.filterMatchState === 'MATCH_FOUND';
    const confidence = sr.filterResults?.pi_and_jailbreak?.piAndJailbreakFilterResult?.confidenceLevel || null;

    if (matched) {
      const { mode: MODEL_ARMOR_MODE } = getModelArmorConfig();
      log.info(`[sanitizer:G8] Model Armor MATCH — confidence: ${confidence}, mode: ${MODEL_ARMOR_MODE}`);
    }

    return { matched, confidence, raw: sr };
  } catch (err) {
    // Non-fatal: Model Armor is a defense-in-depth layer, not a gate blocker
    // Redact any access-token material and cap length — google-auth errors can embed credentials.
    const safeMsg = String(err?.message || err).slice(0, 200).replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]');
    log.warn(`[sanitizer:G8] Model Armor check failed (non-fatal): ${safeMsg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the active rule set version string, or 'fallback' if using hardcoded.
 */
export function getActiveRuleSetVersion() {
  if (activeRuleSet) {
    return {
      id: activeRuleSet.id,
      version: activeRuleSet.version,
      sha256Hash: activeRuleSet.sha256Hash,
    };
  }
  return {
    id: null,
    version: 'fallback',
    sha256Hash: null,
  };
}

// ============================================================
// Rule set management API
// ============================================================

/**
 * Compute SHA-256 content address for a rules JSONB object.
 * Deterministic: deep sort all object keys before serialization.
 */
export function computeRuleSetHash(rules) {
  const canonical = JSON.stringify(deepSortKeys(rules));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Recursively sort all object keys for deterministic serialization.
 */
function deepSortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = deepSortKeys(obj[key]);
  }
  return sorted;
}

/**
 * Propose a new rule set (inactive until activated).
 * Returns the created rule set record.
 */
export async function proposeNewRuleSet(rules, proposedBy) {
  const { query } = await import('../../db.js');

  const sha256Hash = computeRuleSetHash(rules);
  const categories = extractCategories(rules);

  // Determine next version: increment patch from current active
  const activeResult = await query(
    `SELECT version FROM agent_graph.sanitization_rule_sets
     WHERE is_active = true LIMIT 1`
  );
  const currentVersion = activeResult.rows.length > 0
    ? activeResult.rows[0].version
    : '0.0.0';
  const nextVersion = incrementVersion(currentVersion);

  const result = await query(
    `INSERT INTO agent_graph.sanitization_rule_sets
       (version, sha256_hash, rules, categories, is_active, approved_by)
     VALUES ($1, $2, $3, $4, false, $5)
     RETURNING id, version, sha256_hash, created_at`,
    [nextVersion, sha256Hash, JSON.stringify(rules), categories, proposedBy]
  );

  log.info(`Proposed rule set v${nextVersion} (${sha256Hash.slice(0, 12)}...) by ${proposedBy}`);
  return result.rows[0];
}

/**
 * Activate a rule set by ID. Deactivates the current active set first.
 * Requires: test_pass_rate and false_positive_rate to be set (test suite must run first).
 */
export async function activateRuleSet(ruleSetId) {
  const { query, withTransaction } = await import('../../db.js');

  // Verify the rule set exists and has been tested
  const check = await query(
    `SELECT id, version, sha256_hash, rules, test_pass_rate, false_positive_rate
     FROM agent_graph.sanitization_rule_sets
     WHERE id = $1`,
    [ruleSetId]
  );

  if (check.rows.length === 0) {
    throw new Error(`Rule set ${ruleSetId} not found`);
  }

  const ruleSet = check.rows[0];

  if (ruleSet.test_pass_rate === null) {
    throw new Error(`Rule set ${ruleSetId} has not been tested. Run adversarial test suite first.`);
  }

  if (ruleSet.false_positive_rate !== null && parseFloat(ruleSet.false_positive_rate) > 5.0) {
    throw new Error(
      `Rule set ${ruleSetId} exceeds false positive target: ${ruleSet.false_positive_rate}% (max 5%)`
    );
  }

  await withTransaction(async (client) => {
    // Deactivate current active rule set
    await client.query(
      `UPDATE agent_graph.sanitization_rule_sets SET is_active = false WHERE is_active = true`
    );
    // Activate the new one
    await client.query(
      `UPDATE agent_graph.sanitization_rule_sets SET is_active = true WHERE id = $1`,
      [ruleSetId]
    );
  });

  // Reload into memory
  const patterns = compilePatterns(ruleSet.rules);
  activeRuleSet = {
    id: ruleSet.id,
    version: ruleSet.version,
    sha256Hash: ruleSet.sha256_hash,
    patterns,
  };

  log.info(`Activated rule set v${ruleSet.version} (${ruleSet.sha256_hash.slice(0, 12)}...)`);
  return ruleSet;
}

/**
 * Get a specific rule set by ID (for testing against).
 */
export async function getRuleSet(ruleSetId) {
  const { query } = await import('../../db.js');
  const result = await query(
    `SELECT id, version, sha256_hash, rules, categories, is_active,
            approved_by, test_pass_rate, false_positive_rate, created_at
     FROM agent_graph.sanitization_rule_sets
     WHERE id = $1`,
    [ruleSetId]
  );
  return result.rows[0] || null;
}

/**
 * List all rule set versions.
 */
export async function listRuleSets() {
  const { query } = await import('../../db.js');
  const result = await query(
    `SELECT id, version, sha256_hash, categories, is_active,
            approved_by, test_pass_rate, false_positive_rate, created_at
     FROM agent_graph.sanitization_rule_sets
     ORDER BY created_at DESC`
  );
  return result.rows;
}

/**
 * Sanitize a string using a specific rule set (for testing).
 * Does NOT modify the active rule set.
 */
export function sanitizeWithRules(str, rules) {
  if (typeof str !== 'string') return str;
  const patterns = compilePatterns(rules);
  let sanitized = str;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

// ============================================================
// Internal helpers
// ============================================================

function sanitizeString(str) {
  const patterns = getPatterns();
  let sanitized = str;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Extract unique categories from a rules JSONB object.
 */
function extractCategories(rules) {
  if (!rules || !rules.patterns) return [];
  const cats = new Set();
  for (const p of rules.patterns) {
    if (p.category) cats.add(p.category);
  }
  return [...cats];
}

/**
 * Increment the patch version: "1.0.0" -> "1.1.0".
 */
function incrementVersion(version) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3) return '1.0.0';
  parts[1] += 1;
  parts[2] = 0;
  return parts.join('.');
}
