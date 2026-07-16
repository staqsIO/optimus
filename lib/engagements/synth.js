/**
 * Synthesize the living spec for an engagement.
 *
 * Pipeline:
 *   1. Load engagement, proposals, current sections, open conflicts.
 *   2. Call LLM with structured prompt; expect JSON.
 *   3. Apply in a single transaction:
 *      - Skip pinned sections (audit row 'synth_skip_pin').
 *      - Upsert non-pinned sections (audit 'edit' or 'section_add').
 *      - Soft-remove sections present locally but absent from response (audit 'section_remove').
 *      - Insert new conflicts (dedup by summary against current open set).
 *      - Bump specs.version, last_synth_at, last_synth_proposal_count.
 *
 * Pin enforcement is here, NOT in the prompt (P2).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, withTransaction } from '../db.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { createLogger } from '../logger.js';
import {
  getEngagement,
  SYSTEM_PRINCIPAL,
  ensureSpec,
  listProposals,
  listSections,
  listOpenConflicts,
  getMasterSections,
  getChildEngagementSpecs,
  queueSectionChangeProposal,
  listPendingSectionProposals,
  acceptSectionProposal,
  setEngagementAsyncStatus,
  clearEngagementAsyncStatus,
} from './db.js';
import { buildSynthMessages, CORE_SECTIONS } from './synth-prompt.js';

const log = createLogger('engagements/synth');
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL_KEY = 'claude-sonnet-4-6';
// Sonnet 4.6 caps at 64k output, but the Anthropic SDK refuses
// non-streaming requests with max_tokens > 21333 (10-min timeout guard
// at 128k tokens/hour). We sized this at 16k initially; real-world
// specs with master inheritance and several proposals can truncate
// mid-tool-call, which surfaces as "missing sections array" because
// the SDK delivers a partial `input` object. 20k is the practical
// ceiling without flipping the streaming flow.
const MAX_OUTPUT_TOKENS = 20_000;

/**
 * Structured-output tool. We force the model to call this; the SDK
 * guarantees `toolCall.input` is valid JSON matching the schema, which
 * eliminates the class of "unescaped quote at position N" parse failures
 * that text-mode JSON suffers from.
 */
const EMIT_SPEC_TOOL = {
  name: 'emit_spec',
  description: 'Emit the synthesized engagement spec. You MUST call this tool to deliver your output.',
  input_schema: {
    type: 'object',
    required:['sections', 'conflicts', 'removed'],
    properties: {
      sections: {
        type: 'array',
        description: 'Spec sections in display order. Core sections (Overview, Scope, Deliverables, Stack, Milestones, Risks) come first.',
        items: {
          type: 'object',
          required:['key', 'title', 'body', 'ordinal', 'is_core', 'provenance'],
          properties: {
            key: { type: 'string', description: 'Stable section identifier (e.g. "overview", "scope"). Lowercase, snake_case.' },
            title: { type: 'string' },
            body: { type: 'string', description: 'Markdown content for this section. Can be empty for placeholder sections.' },
            ordinal: { type: 'integer', minimum: 1 },
            is_core: { type: 'boolean' },
            provenance: {
              type: 'array',
              description: 'Proposal IDs that informed this section.',
              items: { type: 'string' },
            },
          },
        },
      },
      conflicts: {
        type: 'array',
        description: 'Genuine contradictions between proposals that need human resolution.',
        items: {
          type: 'object',
          required:['summary', 'options'],
          properties: {
            summary: { type: 'string' },
            section_key: { type: 'string', description: 'Which section this conflict touches, if any.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                required:['text'],
                properties: {
                  source_proposal_id: { type: 'string' },
                  text: { type: 'string' },
                  rationale: { type: 'string' },
                },
              },
            },
          },
        },
      },
      removed: {
        type: 'array',
        description: 'Features present in earlier syntheses that are no longer included.',
        items: {
          type: 'object',
          required:['summary', 'rationale'],
          properties: {
            summary: { type: 'string' },
            rationale: { type: 'string' },
          },
        },
      },
    },
  },
};

function loadModelsConfig() {
  // agents.json lives in autobot-inbox; this lib is product-agnostic in intent
  // but the config is the one source of truth for model definitions today.
  const candidates = [
    join(__dirname, '..', '..', 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'config', 'agents.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not locate autobot-inbox/config/agents.json from synth.js');
}

function parseSynthJSON(text) {
  // Try strict parse first.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate accidental markdown fences.
    const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(fenced);
  }
}

function validateSynthResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('synth response is not an object');
  }
  // Be lenient about empty/null shapes — the model sometimes returns
  // `sections: null` or `sections: {}` when the input isn't a project
  // proposal (e.g. user uploaded a legal template by mistake). Coerce
  // to an empty array; the caller decides whether to warn the user.
  if (!Array.isArray(parsed.sections)) {
    parsed.sections = [];
  }
  parsed.conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
  parsed.removed = Array.isArray(parsed.removed) ? parsed.removed : [];

  const seenKeys = new Set();
  for (const s of parsed.sections) {
    if (!s.key || !s.title) throw new Error(`section missing key/title: ${JSON.stringify(s).slice(0, 200)}`);
    if (seenKeys.has(s.key)) throw new Error(`duplicate section key: ${s.key}`);
    seenKeys.add(s.key);
    s.body = typeof s.body === 'string' ? s.body : '';
    s.ordinal = Number.isInteger(s.ordinal) ? s.ordinal : 999;
    s.is_core = !!s.is_core;
    s.provenance = Array.isArray(s.provenance) ? s.provenance : [];
  }

  // If the model returned zero sections we don't auto-fill placeholders —
  // that would mask the real issue (the input wasn't a project proposal).
  // The caller surfaces this via the `extractedNothing` flag.
  if (parsed.sections.length === 0) {
    return parsed;
  }

  // Ensure all core sections present — LLM is instructed to include them.
  const missing = CORE_SECTIONS.filter((c) => !seenKeys.has(c.key));
  if (missing.length > 0) {
    log.warn(`synth response missing core sections: ${missing.map((m) => m.key).join(', ')} — will add empty placeholders`);
    let nextOrd = parsed.sections.reduce((m, s) => Math.max(m, s.ordinal), 0) + 1;
    for (const c of missing) {
      parsed.sections.push({
        key: c.key,
        title: c.title,
        body: '',
        ordinal: nextOrd++,
        is_core: true,
        provenance: [],
      });
    }
  }

  return parsed;
}

/**
 * Run a synth pass for one engagement.
 *
 * @param {string} engagementId
 * @param {object} [opts]
 * @param {string} [opts.modelKey]
 * @param {string} [opts.actor='synth']  - audit actor for this run
 * @param {boolean} [opts.dryRun=false]  - if true, return what would happen without writing
 * @returns {{ specId, version, sectionsUpdated, sectionsAdded, sectionsSkippedPin, sectionsRemoved, conflictsAdded, costUsd, modelKey }}
 */
export async function synthesizeEngagementSpec(engagementId, opts = {}) {
  const modelKey = opts.modelKey || DEFAULT_MODEL_KEY;
  const actor = opts.actor || 'synth';

  const engagement = await getEngagement(engagementId, { principal: SYSTEM_PRINCIPAL });
  if (!engagement) throw new Error(`engagement not found: ${engagementId}`);

  const spec = await ensureSpec(engagementId);
  const [proposals, sections, openConflicts] = await Promise.all([
    listProposals(engagementId),
    listSections(spec.id),
    listOpenConflicts(spec.id),
  ]);

  // Master synth distills from child engagement specs in addition to (or
  // instead of) proposals attached directly to the master. Non-master synth
  // inherits from the master's current sections.
  let masterSections = [];
  let childSpecs = [];
  if (engagement.is_master) {
    try {
      childSpecs = await getChildEngagementSpecs();
    } catch (err) {
      log.warn(`could not load child engagement specs (continuing without distillation): ${err.message}`);
    }
  } else {
    try {
      const { sections: ms } = await getMasterSections();
      masterSections = ms;
    } catch (err) {
      log.warn(`could not load master sections (continuing without baseline): ${err.message}`);
    }
  }

  // Guard: refuse the synth when there's literally nothing to work with.
  // Master allows synth when EITHER a manual baseline proposal exists OR at
  // least one child engagement has been synthesized. Non-master always
  // requires at least one proposal.
  if (engagement.is_master) {
    if (proposals.length === 0 && childSpecs.length === 0) {
      throw new Error('Cannot synthesize master — no manual baseline proposals attached and no child engagements have been synthesized yet.');
    }
  } else if (proposals.length === 0) {
    throw new Error('Cannot synthesize — no proposals have been ingested yet.');
  }

  // Build messages
  const { system, user } = buildSynthMessages({
    engagement,
    proposals,
    sections,
    openConflicts,
    masterSections,
    childSpecs,
  });

  // Call LLM
  const modelsConfig = loadModelsConfig();
  const llm = createLLMClient(modelKey, modelsConfig.models);

  log.info(`synthesizing engagement ${engagementId}${engagement.is_master ? ' (MASTER, distill mode)' : ''} with ${proposals.length} proposals, ${sections.length} existing sections, ${engagement.is_master ? `${childSpecs.length} child specs` : `${masterSections.length} master baseline sections`}, model=${modelKey}`);

  // Stamp async status so the UI can show a "Synthesizing..." banner even
  // when called directly (not from auto-build, which sets its own status).
  if (!opts.dryRun) {
    try {
      await setEngagementAsyncStatus(engagementId, {
        status: 'synthesizing',
        progress: {
          stage: 'synthesizing',
          label: `Synthesizing spec (${proposals.length} proposal${proposals.length === 1 ? '' : 's'}${engagement.is_master ? `, ${childSpecs.length} child spec${childSpecs.length === 1 ? '' : 's'}` : `, ${masterSections.length} master baseline section${masterSections.length === 1 ? '' : 's'}`})`,
          model: modelKey,
        },
      });
    } catch { /* non-fatal */ }
  }

  // Everything from here on runs inside a try/finally that guarantees
  // we clear async_status — including on LLM errors. Otherwise a synth
  // failure would leave the engagement stuck "synthesizing" forever.
  try {

  const response = await callProvider(llm, {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    tools: [EMIT_SPEC_TOOL],
    toolChoice: { type: 'tool', name: 'emit_spec' },
  });

  // Prefer the tool-use path — SDK guarantees parsed JSON matching the schema.
  let rawParsed;
  const toolCall = (response.toolCalls || []).find((t) => t.name === 'emit_spec');
  if (toolCall && toolCall.input && typeof toolCall.input === 'object') {
    rawParsed = toolCall.input;
  } else if (response.text) {
    // Fallback: model returned text instead of calling the tool. Try to parse.
    log.warn('synth: model returned text instead of calling emit_spec; falling back to JSON parse');
    try {
      rawParsed = parseSynthJSON(response.text);
    } catch (err) {
      const snippet = response.text.slice(0, 400).replace(/\s+/g, ' ');
      throw new Error(`LLM did not call emit_spec and text-mode JSON failed to parse: ${err.message}. First 400 chars: ${snippet}`);
    }
  } else {
    throw new Error('LLM returned empty response (no tool call, no text)');
  }

  // Diagnostics: log what came back so validation failures are debuggable.
  function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return `array(${v.length})`;
    if (typeof v === 'object') return `object{${Object.keys(v).join(',')}}`;
    if (typeof v === 'string') return `string(${v.length}): ${JSON.stringify(v.slice(0, 80))}`;
    return `${typeof v}: ${JSON.stringify(v).slice(0, 80)}`;
  }
  const inputKeys = rawParsed ? Object.keys(rawParsed) : [];
  const shape = {
    sections: describe(rawParsed?.sections),
    conflicts: describe(rawParsed?.conflicts),
    removed: describe(rawParsed?.removed),
  };
  log.info(`synth response shape: keys=[${inputKeys.join(',')}] sections=${shape.sections} conflicts=${shape.conflicts} removed=${shape.removed} stop_reason=${response.stopReason} out_tokens=${response.outputTokens}`);

  let parsed;
  try {
    parsed = validateSynthResponse(rawParsed);
  } catch (err) {
    const isTruncated = response.stopReason === 'max_tokens';
    const hint = isTruncated
      ? ' (output hit max_tokens — try with fewer/shorter proposals or a pinned-section strategy)'
      : ` (sections=${shape.sections}, stop_reason=${response.stopReason}, out_tokens=${response.outputTokens})`;
    throw new Error(`${err.message}${hint}`);
  }

  // The model produced zero sections. Refuse with a clear message instead
  // of silently writing an empty spec.
  if (parsed.sections.length === 0) {
    const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
    let message;
    if (engagement.is_master) {
      message = `The model couldn't distill any baseline patterns from the inputs (${proposals.length} manual proposal${proposals.length === 1 ? '' : 's'}, ${childSpecs.length} child engagement spec${childSpecs.length === 1 ? '' : 's'}). With this little signal, that's an honest result — add more client engagements or attach a manual baseline proposal and try again. (cost: $${costUsd.toFixed(4)})`;
    } else {
      const titles = proposals.map((p) => p.title || '(untitled)').join(', ');
      message = `The model couldn't extract any scope from the ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} (${titles}). This usually means the input isn't a project scoping document — e.g. a contract template, legal boilerplate, or an image-only PDF. Add a real proposal (RFP, scoping draft, finalized scope) and try again. (cost: $${costUsd.toFixed(4)})`;
    }
    const err = new Error(message);
    err.code = 'SYNTH_EMPTY';
    err.statusCode = 422;
    throw err;
  }

  const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);

  log.info(`synth received: ${parsed.sections.length} sections, ${parsed.conflicts.length} conflicts, ${parsed.removed.length} removed, cost=$${costUsd.toFixed(4)}`);

  if (opts.dryRun) {
    return {
      specId: spec.id,
      version: spec.version,
      proposed: parsed,
      costUsd,
      modelKey,
      dryRun: true,
    };
  }

  // Dedup against pending section proposals so re-synth doesn't queue
  // the same section_key twice. Indexed by kind+key.
  const pendingProposalsBeforeApply = await listPendingSectionProposals(spec.id);
  const pendingAddKeys = new Set(
    pendingProposalsBeforeApply
      .filter((p) => p.kind === 'add')
      .map((p) => p.payload?.section_key)
      .filter(Boolean)
  );
  const pendingRemoveSectionIds = new Set(
    pendingProposalsBeforeApply
      .filter((p) => p.kind === 'remove' && p.section_id)
      .map((p) => p.section_id)
  );

  // Apply in a single transaction
  const result = await withTransaction(async (client) => {
    const existingByKey = new Map(sections.map((s) => [s.section_key, s]));
    const responseKeys = new Set(parsed.sections.map((s) => s.key));
    // First-synth auto-accept: when the spec is empty (no sections, no
    // pending proposals from prior runs), accept all proposed adds inline.
    // Otherwise the user faces 8+ "accept" clicks just to see anything.
    const autoAcceptOnEmpty = sections.length === 0 && pendingProposalsBeforeApply.length === 0;

    let sectionsUpdated = 0;
    let sectionsAdded = 0;            // direct inserts (auto-accept on empty)
    let sectionsAddedProposed = 0;    // queued for review
    let sectionsSkippedPin = 0;
    let sectionsRemovedProposed = 0;

    for (const proposed of parsed.sections) {
      const existing = existingByKey.get(proposed.key);
      const provenanceJson = JSON.stringify(proposed.provenance);

      if (!existing) {
        // Skip if the same key is already pending — re-synth was firing
        // duplicate proposals otherwise.
        if (pendingAddKeys.has(proposed.key)) continue;

        const payload = {
          section_key: proposed.key,
          title: proposed.title,
          body: proposed.body,
          ordinal: proposed.ordinal,
          is_core: proposed.is_core,
          provenance: proposed.provenance,
        };

        if (autoAcceptOnEmpty) {
          // Virgin spec — insert directly instead of forcing a click-fest.
          const ordR = await client.query(
            `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ord
               FROM engagements.spec_sections WHERE spec_id = $1`,
            [spec.id]
          );
          const ordinal = proposed.ordinal || ordR.rows[0].next_ord;
          const ins = await client.query(
            `INSERT INTO engagements.spec_sections
               (spec_id, section_key, title, body, ordinal, is_core, provenance)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             RETURNING *`,
            [spec.id, proposed.key, proposed.title, proposed.body, ordinal, proposed.is_core, JSON.stringify(proposed.provenance)]
          );
          await client.query(
            `INSERT INTO engagements.spec_edits
               (spec_id, section_id, actor, change_kind, after, note)
             VALUES ($1, $2, $3, 'section_add', $4, $5)`,
            [spec.id, ins.rows[0].id, actor, proposed.body, `auto-accepted on first synth (empty spec)`]
          );
          sectionsAdded++;
          continue;
        }

        await queueSectionChangeProposal({
          specId: spec.id,
          kind: 'add',
          payload,
          summary: `Add section: "${proposed.title}"`,
          rationale: proposed.provenance.length
            ? `Synthesized from ${proposed.provenance.length} proposal${proposed.provenance.length === 1 ? '' : 's'}.`
            : 'Synth produced this from current inputs.',
          proposedBy: actor,
          client,
        });
        await client.query(
          `INSERT INTO engagements.spec_edits
             (spec_id, section_id, actor, change_kind, after, note)
           VALUES ($1, NULL, $2, 'section_proposal_new', $3, $4)`,
          [spec.id, actor, proposed.body, `proposed add: "${proposed.title}"`]
        );
        sectionsAddedProposed++;
        continue;
      }

      if (existing.pin_state === 'pinned') {
        // PIN ENFORCEMENT — infrastructure layer, not prompt
        await client.query(
          `INSERT INTO engagements.spec_edits
             (spec_id, section_id, actor, change_kind, before, after, note)
           VALUES ($1, $2, $3, 'synth_skip_pin', $4, $4, 'pinned section preserved')`,
          [spec.id, existing.id, actor, existing.body]
        );
        // Still allow ordinal/title to track current numbering even when body is locked.
        await client.query(
          `UPDATE engagements.spec_sections
              SET ordinal = $2,
                  title = $3
            WHERE id = $1`,
          [existing.id, proposed.ordinal, proposed.title]
        );
        sectionsSkippedPin++;
        continue;
      }

      if (existing.body === proposed.body
          && existing.ordinal === proposed.ordinal
          && existing.title === proposed.title) {
        // No-op; skip audit.
        continue;
      }

      await client.query(
        `INSERT INTO engagements.spec_edits
           (spec_id, section_id, actor, change_kind, before, after, note)
         VALUES ($1, $2, $3, 'edit', $4, $5, $6)`,
        [
          spec.id,
          existing.id,
          actor,
          existing.body,
          proposed.body,
          `provenance: ${proposed.provenance.join(', ') || 'none'}`,
        ]
      );
      await client.query(
        `UPDATE engagements.spec_sections
            SET title = $2,
                body = $3,
                ordinal = $4,
                provenance = $5::jsonb
          WHERE id = $1`,
        [existing.id, proposed.title, proposed.body, proposed.ordinal, provenanceJson]
      );
      sectionsUpdated++;
    }

    // Sections present locally but absent from the LLM response = queue
    // a removal proposal. Never auto-remove pinned or core sections.
    for (const existing of sections) {
      if (responseKeys.has(existing.section_key)) continue;
      if (existing.pin_state === 'pinned' || existing.is_core) continue;
      // Dedup: skip if there's already a pending remove proposal for this section.
      if (pendingRemoveSectionIds.has(existing.id)) continue;

      const payload = {
        section_key: existing.section_key,
        title: existing.title,
        body: existing.body,
        ordinal: existing.ordinal,
        is_core: existing.is_core,
        provenance: existing.provenance || [],
      };
      await queueSectionChangeProposal({
        specId: spec.id,
        sectionId: existing.id,
        kind: 'remove',
        payload,
        summary: `Remove section: "${existing.title}"`,
        rationale: 'Synth produced no content for this section in the latest pass.',
        proposedBy: actor,
        client,
      });
      await client.query(
        `INSERT INTO engagements.spec_edits
           (spec_id, section_id, actor, change_kind, before, note)
         VALUES ($1, $2, $3, 'section_proposal_new', $4, $5)`,
        [spec.id, existing.id, actor, existing.body, `proposed remove: "${existing.title}"`]
      );
      sectionsRemovedProposed++;
    }

    // Conflicts. Dedup against existing open summaries to avoid re-raising.
    const openSummaries = new Set(openConflicts.map((c) => c.summary));
    let conflictsAdded = 0;
    for (const c of parsed.conflicts) {
      if (!c?.summary || openSummaries.has(c.summary)) continue;
      // Resolve section_key → section_id if present in our just-applied set.
      let sectionId = null;
      if (c.section_key) {
        const r = await client.query(
          `SELECT id FROM engagements.spec_sections WHERE spec_id = $1 AND section_key = $2`,
          [spec.id, c.section_key]
        );
        sectionId = r.rows[0]?.id || null;
      }
      await client.query(
        `INSERT INTO engagements.spec_conflicts (spec_id, section_id, summary, options)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [spec.id, sectionId, c.summary, JSON.stringify(c.options || [])]
      );
      conflictsAdded++;
    }

    // Bump spec metadata
    const bump = await client.query(
      `UPDATE engagements.specs
          SET version = version + 1,
              last_synth_at = now(),
              last_synth_proposal_count = $2
        WHERE id = $1
        RETURNING *`,
      [spec.id, proposals.length]
    );

    return {
      specId: spec.id,
      version: bump.rows[0].version,
      sectionsUpdated,
      sectionsAdded,
      sectionsAddedProposed,
      sectionsSkippedPin,
      sectionsRemovedProposed,
      conflictsAdded,
    };
  });

  return { ...result, costUsd, modelKey };
  } finally {
    if (!opts.dryRun) {
      try { await clearEngagementAsyncStatus(engagementId); } catch { /* non-fatal */ }
    }
  }
}
