/**
 * Draft a contract from an approved engagement proposal.
 *
 * Inputs: an `engagements.generated_proposals` row that's been marked approved,
 * a counterparty (derived from the engagement), and the slug of a contract
 * template (file-based in agents/executor-contract/template-*.md or DB-backed
 * in content.contract_templates). The LLM folds the proposal's scope,
 * deliverables, pricing, timeline, etc. into the legal template's section
 * structure and fills bracket placeholders with concrete values from the
 * proposal where they exist. Generic legalese ([TERMS_AND_CONDITIONS],
 * indemnification, IP, governing law, etc.) is synthesized in full — never
 * left as a placeholder.
 *
 * The drafter is idempotent on (engagement_id, source_generated_proposal_id):
 * re-drafting from the same approved proposal returns the existing draft
 * instead of producing a duplicate, unless { force: true } is set.
 *
 * Output: an inserted row in content.drafts with content_type='contract',
 * status='draft', engagement_id + source_generated_proposal_id linkage, and
 * a seed entry in the version history.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { createLogger } from '../logger.js';
import { query, withTransaction } from '../db.js';
import {
  getEngagement,
  SYSTEM_PRINCIPAL,
  getGeneratedProposal,
  updateEngagementAsyncProgress,
} from './db.js';

const log = createLogger('engagements/contract-drafter');
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL_KEY = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 16_000;

// File-template fallback (same set the contracts route loads). Kept in
// sync with autobot-inbox/src/api-routes/contracts.js — both resolve the
// same agents/executor-contract/ directory.
const FILE_TEMPLATE_DIR = join(__dirname, '..', '..', 'agents', 'executor-contract');
const FILE_TEMPLATE_FILES = {
  'service-proposal': 'template-service-proposal.md',
  'nda': 'template-nda.md',
  'sow': 'template-sow.md',
};

const SYSTEM_PROMPT = `You are drafting a binding services contract for UMB Advisors. Two inputs:

1. LEGAL TEMPLATE — a contract skeleton with [BRACKET] placeholders. The legal scaffolding (parties, term, definitions, IP, indemnification, payment terms, governing law, dispute resolution, termination, liability cap, etc.) MUST be preserved. Section headings, numbering, and tables stay as-is unless the proposal genuinely supersedes a clause.

2. APPROVED PROPOSAL — a client-facing proposal already approved by both UMB and the prospective client. Source of truth for scope, deliverables, pricing, timeline, milestones, retainer hours, client identity, named contacts.

Your job: produce a single, complete contract in markdown that merges the proposal's substance into the template's legal structure. Specifically:

A. FILL BRACKETS with real values from the proposal wherever the proposal supplies them. Examples: [CLIENT_NAME], [CLIENT_ADDRESS], [PROPOSAL_DATE], [COMMENCEMENT_DATE], [OBJECTIVES], [SCOPE_OF_WORK], [RETAINER_HOURS], [PRICING_DETAILS].

B. GENERATE FULL LEGALESE for brackets like [TERMS_AND_CONDITIONS], [LEGAL_TERMS], [GOVERNING_LAW], [INDEMNIFICATION], [IP_OWNERSHIP], [CONFIDENTIALITY], [WARRANTIES], [LIMITATION_OF_LIABILITY], [TERMINATION], [DISPUTE_RESOLUTION]. Write each clause out completely with standard, defensible language appropriate for a US-based professional services contract. Don't leave a placeholder pointing at "to be added" or refer the reader elsewhere — produce the actual clause text.

C. LEAVE [BRACKETS] only where the proposal genuinely doesn't supply the value AND it isn't standard legalese you can write yourself. Example: if the proposal doesn't name a specific commencement date, [COMMENCEMENT_DATE] stays in. Don't invent dates, dollar figures, or person names that aren't in the proposal.

D. PRESERVE the template's section numbering and order. The contract reader expects "1. SCOPE", "2. TIMELINE", etc. — don't reshuffle.

E. USE PROPER MARKDOWN HEADING SYNTAX. Every section label MUST start with the appropriate hash prefix — NOT plain text, NOT bold paragraphs. Specifically:
   * Document title  → "# " (one hash)             e.g. "# Service Agreement"
   * Numbered top-level sections → "## " (two hashes) e.g. "## 1. SCOPE OF SERVICES", "## 2. PROPOSAL TIMELINE"
   * Sub-sections within a section → "### " (three hashes) e.g. "### SCOPE OF WORK", "### RETAINER HOURS INCLUDED"
   This is non-negotiable: the renderer's typography depends on heading semantics. A bare paragraph that reads "1. SCOPE OF PROPOSAL" with no "## " prefix renders as body text and the document looks broken. **Never** use **bold** as a substitute for a heading.

F. RESPECT THE PROPOSAL: if the proposal explicitly overrides a template default (e.g., proposal sets a different payment cadence, different governing law, different deliverable categorization), the proposal wins. Note overrides only inline where the contract section appears — no meta-commentary.

G. ADD a final acceptance block at the end:

---

**Signatures and acceptance are captured electronically via the secure signing link sent to the parties named in this document. All signers' identity, timestamp, and IP are recorded in a tamper-evident audit trail.**

H. OUTPUT IS MARKDOWN ONLY. No fenced code wrapper. No preamble. No commentary. Just the contract markdown ready to render.`;

/**
 * Resolve a template slug or DB UUID to its markdown body.
 * Mirrors the resolver in autobot-inbox/src/api-routes/contracts.js so file
 * and DB templates work identically. DB wins on slug collision.
 *
 * @returns {Promise<{ templateSlug: string, body: string, source: 'file' | 'db' }>}
 */
async function resolveTemplate(slugOrId) {
  if (!slugOrId) {
    const body = loadFileTemplate('service-proposal');
    if (!body) throw new Error('default service-proposal template is unavailable');
    return { templateSlug: 'service-proposal', body, source: 'file' };
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  if (isUuid) {
    const r = await query(
      `SELECT slug, body FROM content.contract_templates
        WHERE id = $1 AND archived_at IS NULL LIMIT 1`,
      [slugOrId]
    );
    if (r.rows[0]) return { templateSlug: r.rows[0].slug, body: r.rows[0].body, source: 'db' };
    throw new Error(`template not found: ${slugOrId}`);
  }
  // Slug — try DB first, then file
  try {
    const r = await query(
      `SELECT slug, body FROM content.contract_templates
        WHERE slug = $1 AND archived_at IS NULL LIMIT 1`,
      [slugOrId]
    );
    if (r.rows[0]) return { templateSlug: r.rows[0].slug, body: r.rows[0].body, source: 'db' };
  } catch {
    /* DB lookup failed — fall through to file */
  }
  const fileBody = loadFileTemplate(slugOrId);
  if (fileBody) return { templateSlug: slugOrId, body: fileBody, source: 'file' };
  throw new Error(`template not found: ${slugOrId}`);
}

function loadFileTemplate(slug) {
  const filename = FILE_TEMPLATE_FILES[slug];
  if (!filename) return null;
  try {
    return readFileSync(join(FILE_TEMPLATE_DIR, filename), 'utf-8');
  } catch {
    return null;
  }
}

function loadModelsConfig() {
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
  throw new Error('Could not locate autobot-inbox/config/agents.json from contract-drafter.js');
}

/**
 * Resolve a counterparty for the engagement. If the engagement's
 * `client` field matches an existing counterparty by name, reuse it; else
 * lazy-create one. Mirrors the lazy-create behavior of
 * POST /api/contracts/new so engagement-spawned contracts and manually-
 * created contracts converge on the same counterparty row.
 */
async function resolveCounterpartyForEngagement(engagement, actor) {
  if (!engagement.client || !engagement.client.trim()) return null;
  const name = engagement.client.trim();
  const existing = await query(
    `SELECT id, name, primary_signer_name, primary_signer_email, primary_signer_title
       FROM content.counterparties
      WHERE lower(name) = lower($1) AND archived_at IS NULL
      LIMIT 1`,
    [name]
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await query(
    `INSERT INTO content.counterparties (name, created_by)
     VALUES ($1, $2)
     RETURNING id, name, primary_signer_name, primary_signer_email, primary_signer_title`,
    [name, actor || 'engagement-drafter']
  );
  return created.rows[0];
}

/**
 * Look up the existing draft for this (engagement, generated_proposal) pair,
 * if one was created already. Used to make the drafter idempotent.
 */
async function findExistingDraft({ engagementId, generatedProposalId }) {
  const r = await query(
    `SELECT id, title, status, created_at
       FROM content.drafts
      WHERE engagement_id = $1
        AND source_generated_proposal_id = $2
        AND content_type = 'contract'
      ORDER BY created_at DESC
      LIMIT 1`,
    [engagementId, generatedProposalId]
  );
  return r.rows[0] || null;
}

/**
 * Main entry. Draft a contract from an approved generated proposal.
 *
 * @param {object} args
 * @param {string} args.engagementId
 * @param {string} args.generatedProposalId   - must be approved
 * @param {string} args.templateSlugOrId      - template to merge into
 * @param {string} args.actor                 - audit/created_by
 * @param {string} [args.modelKey]
 * @param {boolean} [args.force]              - bypass idempotency
 *
 * @returns {Promise<{ draftId: string, costUsd: number, modelKey: string, templateSlug: string, reused: boolean }>}
 */
export async function draftContractFromApprovedProposal({
  engagementId,
  generatedProposalId,
  templateSlugOrId,
  actor,
  modelKey,
  force = false,
}) {
  if (!engagementId) throw new Error('engagementId is required');
  if (!generatedProposalId) throw new Error('generatedProposalId is required');
  if (!actor) throw new Error('actor is required');

  const engagement = await getEngagement(engagementId, { principal: SYSTEM_PRINCIPAL });
  if (!engagement) throw new Error('engagement not found');

  const gp = await getGeneratedProposal(generatedProposalId);
  if (!gp) throw new Error('generated proposal not found');
  if (gp.engagement_id !== engagementId) {
    throw new Error('generated proposal does not belong to this engagement');
  }
  if (!gp.approved_at) {
    throw new Error('generated proposal is not approved — cannot draft a contract from it');
  }

  // Idempotency: if a draft already exists for this exact approved proposal,
  // return it (unless force=true). Prevents accidental duplicates from
  // double-clicks or page reloads.
  if (!force) {
    const existing = await findExistingDraft({ engagementId, generatedProposalId });
    if (existing) {
      log.info(`reusing existing contract draft ${existing.id} for engagement=${engagementId} gp=${generatedProposalId}`);
      return {
        draftId: existing.id,
        costUsd: 0,
        modelKey: null,
        templateSlug: null,
        reused: true,
      };
    }
  }

  const reportProgress = async (stage, label, extra = {}) => {
    try {
      await updateEngagementAsyncProgress(engagementId, { stage, label, step: stage, ...extra });
    } catch { /* non-fatal — banner just stays on the previous stage */ }
  };

  await reportProgress('resolving_template', 'Loading legal template…');
  const { templateSlug, body: templateBody } = await resolveTemplate(templateSlugOrId);

  await reportProgress('resolving_counterparty', 'Looking up client counterparty…');
  const counterparty = await resolveCounterpartyForEngagement(engagement, actor);

  const clientName = (counterparty?.name) || engagement.client || engagement.name;
  const useModel = modelKey || DEFAULT_MODEL_KEY;
  const modelsConfig = loadModelsConfig();
  const llm = createLLMClient(useModel, modelsConfig.models);

  log.info(`drafting contract: engagement="${engagement.name}" proposal=${generatedProposalId.slice(0, 8)} template=${templateSlug} model=${useModel}`);

  await reportProgress(
    'calling_llm',
    `Folding "${clientName}" proposal into ${templateSlug} template…`,
    { model: useModel },
  );

  const userParts = [
    `CLIENT_NAME: ${clientName}`,
    '',
    '## LEGAL TEMPLATE',
    '',
    templateBody,
    '',
    '---',
    '',
    '## APPROVED PROPOSAL',
    '',
    gp.markdown,
    '',
    '---',
    '',
    `Now produce the merged contract. Use "${clientName}" everywhere the template references the client. Markdown only.`,
  ];

  const response = await callProvider(llm, {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
  });

  let contractMarkdown = (response.text || '').trim();
  if (!contractMarkdown) throw new Error('LLM returned empty contract body');
  contractMarkdown = contractMarkdown
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '');

  const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
  const wordCount = contractMarkdown.split(/\s+/).filter(Boolean).length;

  await reportProgress('persisting', `Saving ${wordCount.toLocaleString()}-word draft…`);

  const title = `${clientName} — Service Agreement (engagement: ${engagement.name})`;
  const slug = `contract-${(clientName || engagement.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;

  const draftId = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO content.drafts
         (content_type, status, title, slug, author, body, word_count, cost_usd,
          seo_metadata, template_id, counterparty_id,
          engagement_id, source_generated_proposal_id)
       VALUES ('contract', 'draft', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        title,
        slug,
        'Dustin Powers & Eric Gang',
        contractMarkdown,
        wordCount,
        costUsd,
        JSON.stringify({
          client_name: clientName,
          signer_name: counterparty?.primary_signer_name || null,
          signer_email: counterparty?.primary_signer_email || null,
          signer_title: counterparty?.primary_signer_title || null,
          drafted_from_engagement: engagementId,
          source_generated_proposal: generatedProposalId,
          source_spec_version: gp.spec_version,
        }),
        templateSlug,
        counterparty?.id || null,
        engagementId,
        generatedProposalId,
      ]
    );

    const id = inserted.rows[0].id;

    // Seed version history with the initial body. Same helper the contracts
    // /new route uses.
    await client.query(
      `SELECT * FROM content.append_draft_version($1, $2, 'initial', $3, $4, NULL, NULL)`,
      [
        id,
        contractMarkdown,
        `Drafted from approved engagement proposal (spec v${gp.spec_version}, template ${templateSlug})`,
        actor,
      ]
    );

    // OPT-99: notify artifact consumer — same txn so draft row + notify are
    // atomic. No import of lib/content/* here (CG-1 clean); consumer re-fetches.
    if (engagement.owner_org_id) {
      const payload = JSON.stringify({ id, kind: 'contract', owner_org_id: engagement.owner_org_id, draft_id: id });
      await client.query(`SELECT pg_notify('artifact_register', $1)`, [payload]);
    }

    return id;
  });

  log.info(`contract drafted: draft_id=${draftId} client="${clientName}" cost=$${costUsd.toFixed(4)} words=${wordCount}`);

  return {
    draftId,
    costUsd,
    modelKey: useModel,
    templateSlug,
    reused: false,
  };
}

/**
 * Look up the latest contract draft (if any) spawned from this engagement.
 * Used by the engagement detail endpoint to surface contract status in the
 * sidebar without forcing the client to poll /api/contracts separately.
 */
export async function getLatestContractForEngagement(engagementId) {
  if (!engagementId) return null;
  const r = await query(
    `SELECT d.id, d.title, d.status AS draft_status, d.created_at, d.updated_at,
            d.template_id, d.source_generated_proposal_id,
            sr.id AS request_id, sr.status AS signing_status,
            COALESCE((SELECT count(*) FROM signatures.signers s
                       WHERE s.request_id = sr.id AND s.status = 'signed'), 0)::int AS signed_count,
            COALESCE((SELECT count(*) FROM signatures.signers s
                       WHERE s.request_id = sr.id), 0)::int AS total_signers
       FROM content.drafts d
       LEFT JOIN LATERAL (
         SELECT id, status FROM signatures.signature_requests
          WHERE draft_id = d.id
          ORDER BY created_at DESC LIMIT 1
       ) sr ON true
      WHERE d.engagement_id = $1
        AND d.content_type = 'contract'
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [engagementId]
  );
  return r.rows[0] || null;
}
