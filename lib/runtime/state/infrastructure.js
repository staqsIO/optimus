import { query } from '../../db.js';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/infrastructure');

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Infrastructure services wired to schema objects from 010-phase1-hardening.sql.
 * All functions are safe to call from setInterval — they catch their own errors.
 */

// ============================================================
// Public event log (autobot_public.event_log)
// ============================================================

/**
 * Allow-list of metadata keys that are safe to expose on the UNAUTHENTICATED
 * public event archive (GET /api/public/events). Deny-by-default (P1): any key
 * not on this list is dropped, so a new/unexpected `publishEvent` caller can
 * never leak PII, email content, or secrets to the public archive.
 *
 * Only opaque identifiers, enum-ish status labels, and numeric counts/metrics
 * belong here — never free-text (reason/title/question/summary-like), agent
 * identifiers (agent_id is already omitted from the public view), or nested
 * arbitrary objects (issues/mismatches/fields/routes).
 *
 * Enforced at BOTH read time (public-archive.js projection, protects historical
 * rows) and write time (publishEvent below, so the public table never even
 * stores unexpected fields). Adding a key here exposes it publicly — a reviewer
 * must confirm it can never carry PII/secrets.
 */
export const PUBLIC_EVENT_METADATA_KEYS = Object.freeze([
  'draft_id',
  'campaign_id',
  'iteration',
  'decision',
  'score',
  'status',
  'action',
  'severity',
  'confidence',
  'duration_ms',
  'cost_usd',
  'num_turns',
  'events_cleared',
  'halts_cleared',
  'signals_cleared',
  'terminal',
  'enabled',
]);

// Allow-listing a key restricts the NAME, not the VALUE — nothing stops a
// caller stuffing free text or PII into an allow-listed key like `status`/
// `action`/`decision` (issue #496, "the same bug class one layer down" found
// during the #492 review). Allow-listed keys are only ever opaque ids,
// enum-ish labels, or numeric counts/metrics (see the allow-list comment
// above), so anything longer than a short label is presumptively free text.
const MAX_PUBLIC_METADATA_STRING_LENGTH = 100;

// Reject string values that look like an email address or a phone number
// outright, regardless of length — closes the exact contact_split leak shape
// (sql/106-contact-split.sql:224-234: `identities_moved`/`reason`/
// `performed_by` are raw PII/free text; those keys are already off the
// allow-list, but this stops the same PII from ever riding through an
// allow-listed key instead).
const PUBLIC_METADATA_EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PUBLIC_METADATA_PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/;

// Canonical UUID (8-4-4-4-12 hex). The allow-listed keys `draft_id`/`campaign_id`
// are always UUIDs — opaque identifiers, never PII. Allow them explicitly BEFORE
// the phone-shape heuristic: that heuristic is unanchored and matches any 8+
// digit run, so it false-dropped ~36% of random UUIDs (e.g. the all-digit final
// group `…-446655440000`) — a functional regression that silently removed a
// third of draft/campaign references from the public archive (issue #496).
const PUBLIC_METADATA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `str` contains an email-shaped token or a phone-shaped/long-digit-run
 * token — the PII-shape heuristics `isPublicSafeMetadataValue` applies to
 * allow-listed metadata values, extracted so other public-facing projections
 * (e.g. the `summary` column in public-archive.js, issue #546 — "the same bug
 * class one layer down") can apply the identical email/phone check without
 * inheriting the length cap or object/array rejection that make sense for
 * allow-listed metadata fields but not for free-text prose.
 */
export function containsPublicUnsafePii(str) {
  if (typeof str !== 'string') return false;
  if (PUBLIC_METADATA_EMAIL_PATTERN.test(str)) return true;
  if (PUBLIC_METADATA_PHONE_PATTERN.test(str)) return true;
  return false;
}

/**
 * True if `value` is a safe SHAPE for the public archive: a scalar
 * (string/number/boolean/null), never an object or array, and — for strings —
 * short and free of email/phone-shaped PII. Object and array values (e.g. an
 * `identities_moved`-style list) are always rejected, no matter the key.
 */
function isPublicSafeMetadataValue(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type === 'string') {
    if (value.length > MAX_PUBLIC_METADATA_STRING_LENGTH) return false;
    // Opaque canonical UUIDs are safe IDs — exempt them from the PII-shape
    // heuristics so a UUID's digit runs can't be mistaken for a phone number.
    if (PUBLIC_METADATA_UUID_PATTERN.test(value)) return true;
    if (containsPublicUnsafePii(value)) return false;
    return true;
  }
  return false; // objects, arrays, undefined, symbols, functions, bigint
}

/**
 * Project an arbitrary metadata object down to the public allow-list.
 * Explicit projection (deny-by-default): a key absent from
 * PUBLIC_EVENT_METADATA_KEYS never appears in the result, and an allow-listed
 * key whose value isn't a safe scalar SHAPE (free text, PII-shaped string,
 * object, or array) is dropped too (issue #496 value-shape enforcement).
 */
export function pickPublicEventMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const out = {};
  for (const key of PUBLIC_EVENT_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      const value = metadata[key];
      if (isPublicSafeMetadataValue(value)) {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Publish a significant event to the public transparency log.
 * Non-critical: failures are swallowed (logs shouldn't break the pipeline).
 *
 * Metadata is filtered to the public allow-list before insert (belt-and-
 * suspenders — read-time projection in public-archive.js is the primary gate).
 */
export async function publishEvent(eventType, summary, agentId = null, workItemId = null, metadata = {}) {
  try {
    await query(
      `SELECT autobot_public.publish_event($1, $2, $3, $4, $5)`,
      [eventType, summary, agentId, workItemId, JSON.stringify(pickPublicEventMetadata(metadata))]
    );
  } catch {
    // Non-critical: public log failures must not affect the pipeline
  }
}

// ============================================================
// Cross-schema reconciliation (spec §12)
// ============================================================

/**
 * Run cross-schema reconciliation and log any issues found.
 * Returns the number of issues detected.
 */
export async function runReconciliation() {
  const result = await query(`SELECT * FROM agent_graph.reconcile_schemas()`);
  const issues = result.rows;

  if (issues.length > 0) {
    log.warn(`Found ${issues.length} issue(s):`);
    for (const issue of issues) {
      log.warn(`  [${issue.issue_type}] ${issue.schema_name}.${issue.table_name} ${issue.record_id}: ${issue.details}`);
    }
    await publishEvent('config_changed', `Schema reconciliation: ${issues.length} issue(s) found`, null, null, { issues });
  }

  return issues.length;
}

// ============================================================
// Hash chain checkpointing (spec §12)
// ============================================================

/**
 * Create a hash chain checkpoint. Verifies integrity and stores
 * the latest hash for faster future verification.
 */
export async function createHashCheckpoint() {
  await query(`SELECT agent_graph.create_hash_checkpoint()`);
}

// ============================================================
// Tool registry verification (spec §6)
// ============================================================

/**
 * Verify tool integrity at startup.
 * Computes SHA-256 hashes of tool source files and compares against registry.
 * Returns { verified, mismatches }.
 */
export async function verifyToolRegistry() {
  const toolsDir = join(__dirname, '..', '..', 'tools');
  let toolFiles;
  try {
    toolFiles = readdirSync(toolsDir).filter(f => f.endsWith('.js'));
  } catch {
    return { verified: 0, mismatches: [] };
  }

  const mismatches = [];
  let verified = 0;

  for (const file of toolFiles) {
    const toolName = file.replace('.js', '').replace(/-/g, '_');
    try {
      const content = readFileSync(join(toolsDir, file), 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');

      const result = await query(
        `SELECT tool_hash FROM agent_graph.tool_registry WHERE tool_name = $1`,
        [toolName]
      );

      if (result.rows.length > 0) {
        if (result.rows[0].tool_hash === 'builtin') {
          // First real startup: seed the hash so future runs compare normally
          await query(
            `UPDATE agent_graph.tool_registry SET tool_hash = $1, updated_at = now() WHERE tool_name = $2`,
            [hash, toolName]
          );
          verified++;
        } else if (result.rows[0].tool_hash !== hash) {
          mismatches.push({ tool: toolName, expected: result.rows[0].tool_hash, actual: hash });
        } else {
          verified++;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (mismatches.length > 0) {
    log.warn(`${mismatches.length} tool hash mismatch(es)!`);
    for (const m of mismatches) {
      log.warn(`  ${m.tool}: expected ${m.expected}, got ${m.actual}`);
    }
    await publishEvent('config_changed', `Tool registry: ${mismatches.length} mismatch(es)`, null, null, { mismatches });
  }

  return { verified, mismatches };
}

// ============================================================
// Agent activity log (agent_graph.agent_activity_steps)
// ============================================================

/**
 * Start an activity step. Returns the step ID, which can be passed as
 * parentStepId to create child steps (e.g., LLM call nested under a task
 * execution, or a sub-agent's execution nested under the calling agent).
 *
 * Non-critical: failures are swallowed — logging must never break the pipeline.
 */
export async function startActivityStep(workItemId, description, {
  type = null,
  parentStepId = null,
  agentId = null,
  campaignId = null,
  iterationNumber = null,
  metadata = {},
} = {}) {
  try {
    const result = await query(
      `INSERT INTO agent_graph.agent_activity_steps
       (work_item_id, campaign_id, iteration_number, parent_step_id, depth,
        agent_id, step_type, description, metadata)
       VALUES ($1, $2, $3, $4,
         COALESCE((SELECT depth + 1 FROM agent_graph.agent_activity_steps WHERE id = $4), 0),
         $5, $6, $7, $8)
       RETURNING id`,
      [workItemId, campaignId, iterationNumber, parentStepId,
       agentId, type, description, JSON.stringify(metadata)]
    );
    return result.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark an activity step as completed or failed.
 * Optionally merges additional metadata into the step's metadata field.
 *
 * Non-critical: failures are swallowed.
 */
export async function completeActivityStep(stepId, { status = 'completed', metadata = null } = {}) {
  if (!stepId) return;
  try {
    if (metadata) {
      await query(
        `UPDATE agent_graph.agent_activity_steps
         SET status = $1, completed_at = NOW(),
             metadata = metadata || $3::jsonb
         WHERE id = $2`,
        [status, stepId, JSON.stringify(metadata)]
      );
    } else {
      await query(
        `UPDATE agent_graph.agent_activity_steps
         SET status = $1, completed_at = NOW()
         WHERE id = $2`,
        [status, stepId]
      );
    }
  } catch {
    // Non-critical
  }
}

// ============================================================
// Comms shadow logging (autobot_comms)
// ============================================================

/**
 * Log a communication intent to the shadow comms log.
 * In Phase 1, this records what the system WOULD send.
 */
export async function logCommsIntent({ channel = 'email', recipient, subject, body, intentType = 'draft', sourceAgent = null, sourceTask = null }) {
  try {
    await query(
      `INSERT INTO autobot_comms.outbound_intents
       (channel, recipient, subject, body, intent_type, source_agent, source_task)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [channel, recipient, subject, body, intentType, sourceAgent, sourceTask]
    );
  } catch {
    // Non-critical
  }
}
