import { query, withSystemScope, withAgentScope } from '../../db.js';
import { sanitize, countInjectionAttempts, detectAndRecordThreats, detectPII, getModelArmorConfig } from '../sanitizer.js';
import { getAdapterForMessage } from '../../adapters/registry.js';
import { checkPermission, logCapabilityInvocation } from '../permissions.js';
import { createLogger } from '../../logger.js';
import { publishEvent } from '../infrastructure.js';
import { G8QuarantineError } from '../errors.js';
const log = createLogger('runtime/context-loader');

/**
 * Context loader: assemble context for agent LLM calls.
 * Tiers control how much context an agent receives:
 *   Q1 (Haiku executors): Minimal — just the task + email metadata
 *   Q2 (Sonnet orchestrator/reviewer): Task + email + related signals + draft
 *   Q3 (Opus strategist): Full context — email + signals + contact history + voice profile
 *   Q4 (Sonnet architect): Aggregate — daily stats, pipeline metrics, no individual emails
 */

const CONTEXT_TIERS = {
  'executor-intake':     'Q1',
  'executor-triage':     'Q1',
  'executor-responder':  'Q2',
  orchestrator:          'Q2',
  reviewer:              'Q2',
  strategist:            'Q3',
  architect:             'Q4',
};

// Token budgets per tier (metric 4 target: max 8,000 input tokens)
const TIER_TOKEN_BUDGETS = { Q1: 4000, Q2: 6000, Q3: 7000, Q4: 6000 };

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// Truncate context to fit within token budget (metric 4 compliance).
// Exception: webhook-channel content (meeting transcripts, voice memos) needs
// its full body for triage to do useful extraction. The 4K-token Q1 budget is
// sized for email bodies — a 30-minute meeting transcript is 5–10K tokens and
// gets sliced to 3000 chars by the rule below, leaving the LLM blind to ~95%
// of the meeting. The provider's context window (200K) is the real ceiling
// and it's plenty for any single transcript we'd ingest.
function enforceTokenBudget(context) {
  if (context.email?.channel === 'webhook') {
    return context;
  }
  const budget = TIER_TOKEN_BUDGETS[context.tier] || 6000;
  let tokens = estimateTokens(context);
  if (tokens <= budget) return context;

  // Truncate fields in order of expendability (least critical first).
  //
  // STAQPRO-311 Phase 2: knowledgeContext leads the list as the lowest-
  // priority field — first evicted under budget pressure. The envelope
  // carries wiki + RAG citations that the agent can fall back to live
  // retrieval for if missing, so dropping items here is recoverable.
  // Email/voice/signal context is harder to recover and stays higher
  // priority. Linus's hardcoded-list blocker is resolved by registering
  // knowledgeContext explicitly.
  const truncatable = [
    { key: 'knowledgeContext', keepItems: 3 },
    { key: 'contactHistory', keep: 5 },   // reduce from 20 to 5
    { key: 'specAlignment', maxChars: 500 },
    { key: 'signals', keep: 5 },
    { key: 'emailBody', maxChars: 3000 },
    { key: 'fewShots', keep: 2 },
    { key: 'dailyBriefing', maxChars: 2000 },
    { key: 'agentActivity', keep: 5 },
  ];

  for (const rule of truncatable) {
    if (tokens <= budget) break;
    const val = context[rule.key];
    if (!val) continue;

    if (rule.keepItems != null && Array.isArray(val?.items)) {
      // Envelope shape: { items: [...], totalTokens }. Recompute
      // totalTokens after slicing so the field stays internally
      // consistent for any consumer that reads it.
      val.items = val.items.slice(0, rule.keepItems);
      val.totalTokens = Math.ceil(
        val.items.reduce((s, it) => s + (it.excerpt?.length || 0), 0) / 4
      );
    } else if (Array.isArray(val) && rule.keep != null) {
      context[rule.key] = val.slice(0, rule.keep);
    } else if (typeof val === 'string' && rule.maxChars != null) {
      context[rule.key] = val.slice(0, rule.maxChars);
    } else if (typeof val === 'object' && rule.maxChars != null) {
      const s = JSON.stringify(val);
      if (s.length > rule.maxChars) {
        context[rule.key] = JSON.parse(s.slice(0, rule.maxChars - 1) + '}') ?? val;
      }
    }
    tokens = estimateTokens(context);
  }

  if (tokens > budget) {
    context._tokenBudgetExceeded = true;
    context._estimatedTokens = tokens;
  }
  return context;
}

/**
 * Load context for an agent working on a task.
 *
 * @param {string} agentId - Agent requesting context
 * @param {string} workItemId - The task being worked on
 * @param {Object} [extra] - Additional context (few-shots, etc.)
 * @returns {Promise<Object>} Assembled context object
 */
export async function loadContext(agentId, workItemId, extra = {}) {
  const tier = CONTEXT_TIERS[agentId] || 'Q1';
  const context = { tier, agentId, workItemId };

  // All tiers: get the work item (account_id included via SELECT *).
  //
  // OPT-166 P2c: agent_graph.work_items is RLS-gated post pool-flip. This is an
  // org-unique PK read (WHERE id = $1) of the task the caller was already handed,
  // so a brief system scope leaks nothing cross-org (it is not a correspondent
  // fan-out) yet GUARANTEES the read never black-holes — regardless of whether
  // the item is assigned to the loading agent (the agent_read_work_items policy
  // keys on assigned_to/created_by/parent_id and would deny e.g. a chat/api load
  // of another agent's child item). Single statement → release() covers any
  // throw; released immediately, before any injection/adapter/RAG network await.
  // INERT today (superuser bypasses RLS). Consistent with the P2a tick-context
  // per-tick system scope precedent.
  const bootstrap = await withSystemScope('context-loader');
  let workItem;
  try {
    workItem = await bootstrap(
      `SELECT * FROM agent_graph.work_items WHERE id = $1`,
      [workItemId]
    );
  } finally {
    await bootstrap.release();
  }
  context.workItem = workItem.rows[0] || null;

  // Expose account_id at top level for convenient access by agent handlers
  context.accountId = context.workItem?.account_id || null;

  // OPT-166 P2c: this work item's owning org — Tier-2 scope key for the
  // correspondent-keyed (from_address/email_address) Q2/Q3 reads below, which
  // hit org-gated tables (inbox.signals, signal.contacts). Scoping those to this
  // org prevents a correspondent who emails multiple orgs from leaking the OTHER
  // orgs' signals/contacts into this org's agent context. null → orgIds:[] →
  // those reads black-hole to empty (correct: an org-less item has no tenant).
  const ownerOrgId = context.workItem?.owner_org_id ?? null;

  // Get associated email if this is an email task
  // PGlite may return JSONB as a string — parse if needed
  let metadata = context.workItem?.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  const emailId = metadata?.email_id;
  if (emailId) {
    const email = await query(
      `SELECT * FROM inbox.messages WHERE id = $1`,
      [emailId]
    );
    context.email = email.rows[0] || null;

    // Check for injection attempts in email metadata
    if (context.email) {
      const fields = [context.email.subject, context.email.snippet, context.email.from_name].filter(Boolean).join(' ');
      const attempts = countInjectionAttempts(fields);
      if (attempts > 0) {
        log.warn(`INJECTION DETECTED: ${attempts} pattern(s) in email ${context.email.id}`);
        // Record to threat_memory for graduated escalation (spec §8)
        detectAndRecordThreats(fields, agentId).catch(() => {});
      }
    }

    // Fetch body + prompt context via adapter (centralizes provider-specific logic)
    // Permission check: agent must have adapter grant for this channel (ADR-017)
    try {
      const adapter = getAdapterForMessage(context.email);
      // Use provider (gmail, outlook, slack, webhook, telegram) to match grant names.
      // Not channel ('email', 'slack', etc.) — 'email' doesn't match 'gmail'/'outlook'.
      const adapterName = context.email.provider || 'gmail';
      const adapterAllowed = await checkPermission(agentId, 'adapter', adapterName);
      if (!adapterAllowed) {
        // Graceful degradation: denied adapter = null body, not crash
        log.warn(`Permission denied: ${agentId} lacks adapter grant for '${adapterName}'`);
        logCapabilityInvocation({
          agentId, resourceType: 'adapter', resourceName: adapterName,
          success: false, errorMessage: 'permission_denied', workItemId,
        });
        context.emailBody = null;
        context.promptContext = null;
      } else {
        const startMs = Date.now();
        try {
          context.emailBody = await adapter.fetchContent(context.email);
          logCapabilityInvocation({
            agentId, resourceType: 'adapter', resourceName: adapterName,
            success: true, durationMs: Date.now() - startMs, workItemId,
          });
        } catch (err) {
          log.error(`Failed to fetch body for message ${context.email.id}: ${err.message}`);
          logCapabilityInvocation({
            agentId, resourceType: 'adapter', resourceName: adapterName,
            success: false, durationMs: Date.now() - startMs, errorMessage: err.message, workItemId,
          });
          context.emailBody = null;
        }
        // G8 block-mode body screen (warn mode is byte-identical to pre-block behavior).
        // Only runs when explicitly enabled via MODEL_ARMOR_MODE=block; warn-mode
        // fire-and-forget metadata check at line 120 is unaffected.
        if (context.emailBody && getModelArmorConfig().mode === 'block') {
          const verdict = await detectAndRecordThreats(context.emailBody, agentId, 'agent');
          if (verdict.blocked) {
            // OPT-166 P2c: PK-targeted work_items WRITE. Post-flip
            // agent_update_work_items grants under tenancy.is_system(); the
            // loading agent may not be the item's assignee, so system scope
            // guarantees the quarantine stamp lands. Single statement.
            const quar = await withSystemScope('context-loader');
            try {
              await quar(
                `UPDATE agent_graph.work_items
                   SET input_quarantined = true,
                       quarantine_reason = $2
                 WHERE id = $1`,
                [workItemId, `G8: ${verdict.severity} prompt injection (Model Armor confidence: ${verdict.confidence})`]
              );
            } finally {
              await quar.release();
            }
            await publishEvent('input_quarantined', `G8 quarantined work item ${workItemId}`, agentId, workItemId, {
              reason: 'g8_prompt_injection',
              confidence: verdict.confidence,
              severity: verdict.severity,
              email_id: context.email.id,
            }).catch(() => {});
            throw new G8QuarantineError('Email body flagged by Model Armor', {
              confidence: verdict.confidence,
              severity: verdict.severity,
              contentType: 'email_body',
            });
          }
        }
        context.promptContext = adapter.buildPromptContext(context.email, context.emailBody);
      }
    } catch (err) {
      // Re-throw quarantine errors — agent-loop catches and routes to clean cancel.
      if (err instanceof G8QuarantineError) throw err;
      // No adapter registered (e.g., tests without registry) — agents fall back to null
      context.emailBody = null;
      context.promptContext = null;
    }
  }

  // PII detection on fetched content (spec §5 step 4f, Gap 12)
  // Flags work items containing PII for data classification review — does not block.
  if (context.emailBody) {
    const piiResult = detectPII(context.emailBody);
    if (piiResult.hasPII) {
      context._piiDetected = piiResult.detections;
      // Flag the work item for data classification review (non-blocking).
      // OPT-166 P2c: PK-targeted work_items WRITE via system scope (same
      // rationale as the G8 quarantine stamp — the loading agent may not be the
      // item's assignee, so tenancy.is_system() is what grants the UPDATE
      // post-flip). Kept fire-and-forget: the IIFE opens+releases its own
      // single-statement scope and swallows all errors.
      (async () => {
        const pii = await withSystemScope('context-loader');
        try {
          await pii(
            `UPDATE agent_graph.work_items
             SET metadata = metadata || $1
             WHERE id = $2 AND NOT (metadata ? 'pii_flagged')`,
            [JSON.stringify({ pii_flagged: true, pii_types: piiResult.detections.map(d => d.type) }), workItemId]
          );
        } finally {
          await pii.release();
        }
      })().catch(() => {}); // non-critical
    }
  }

  // Spec alignment context (all tiers, advisory only per P2)
  try {
    const { getAgentSpecContext, formatSpecContext } = await import('../../graph/spec-queries.js');
    const specCtx = await getAgentSpecContext(agentId);
    const agentTier = tier === 'Q1' ? 'haiku' : tier === 'Q4' ? 'sonnet' : tier === 'Q3' ? 'opus' : 'sonnet';
    const specSection = formatSpecContext(specCtx, agentTier);
    if (specSection) context.specAlignment = specSection;
  } catch {
    // Neo4j unavailable — no spec context (graceful degradation)
  }

  // RAG knowledge base context (from brain-rag — meeting transcripts, documents)
  // Q2+ tiers get RAG context for richer responses. Graceful degradation if unavailable.
  if (tier !== 'Q1' && context.email) {
    try {
      const { getRAGContext } = await import('../../rag/client.js');
      const ragContext = await getRAGContext(context.email);
      if (ragContext) context.ragContext = ragContext;
    } catch {
      // brain-rag unavailable — proceed without (graceful degradation)
    }
  }

  // ── STAQPRO-311 Phase 2: wiki knowledge context ────────────────────────
  // Compiled wiki pages (lib/wiki/compiler.js) get surfaced to Q2+ agents
  // through the same context envelope as RAG. Classification-gated via
  // lib/runtime/classification-policy.js — agents only see pages at or
  // below their Q-tier ceiling. Sub-10ms in-transaction (Postgres FTS via
  // GIN-indexed tsvector from migration 109).
  //
  // The unified context.knowledgeContext envelope (Neo Architect's design)
  // is what Phase 3 agent prompts will read. Phase 2 ships only the
  // plumbing — agents still call retrieveContext() directly inside their
  // handlers today; the prompt migration to context.knowledgeContext is
  // a Phase 3 concern.
  let wikiItems = [];
  if (tier !== 'Q1' && context.email) {
    try {
      const { wikiPageSearch } = await import('../../rag/retriever.js');
      const { maxLevelForTier } = await import('../classification-policy.js');
      const { ORG_SCOPE_ALLOWED_TIERS, getAgentTier } = await import('../../rag/scope.js');
      const maxLevel = maxLevelForTier(tier);
      const senderName = context.email.from_name
        || context.email.from_address?.split('@')[0]
        || '';
      const subject = context.email.subject || '';

      // Worktree 1 (RAG scope hardening): resolve a retriever scope for
      // these wiki lookups. Preference order:
      //   1. ownerId from context.email.owner_id or work_item.account_id →
      //      inbox.accounts.owner_id (the per-member surface).
      //   2. org-wide scope if the calling agent is in
      //      ORG_SCOPE_ALLOWED_TIERS.
      //   3. Personal scope with the email's own owner_id (always present
      //      since migration 007 backfills inbox.messages.owner_id from
      //      its account_id).
      // wikiPageSearch's SQL has no owner column yet (FOLLOWUP-WIKI-OWNER)
      // so the scope mostly governs the tier gate today; the filter goes
      // live with the future wiki_pages.owner_id migration.
      // Phase-2 tenancy: agent context-load has no board viewer. Org-scope to
      // Staqs via syntheticPrincipal.readOrgIds so wikiPageSearch / RAG fail
      // closed on owner_org_id. (wikiPageSearch's SQL has no org column yet —
      // FOLLOWUP-WIKI-OWNER — so this primarily satisfies the validateScope
      // org gate and threads through to any match_chunks path consistently.)
      const { CURRENT_ORG_READ_SCOPE } = await import('../../tenancy/scope.js');
      const { SCOPE_VALIDATED_BY_PARENT } = await import('../../rag/scope.js');
      const STAQS_READ_ORGS = CURRENT_ORG_READ_SCOPE;
      let wikiScope;
      const emailOwner = context.email.owner_id;
      if (emailOwner) {
        wikiScope = { ownerId: String(emailOwner), readOrgIds: STAQS_READ_ORGS };
      } else if (ORG_SCOPE_ALLOWED_TIERS.includes(getAgentTier(agentId))) {
        wikiScope = { org: true, agentId, readOrgIds: STAQS_READ_ORGS };
      } else {
        // Fall back to looking up the owner via the work_item's account_id.
        // This may legitimately resolve to null (e.g. orphan work_items).
        try {
          const accountId = context.workItem?.metadata?.account_id || null;
          if (accountId) {
            const r = await query(
              `SELECT owner_id FROM inbox.accounts WHERE id = $1`,
              [accountId]
            );
            if (r.rows[0]?.owner_id) {
              wikiScope = { ownerId: String(r.rows[0].owner_id), readOrgIds: STAQS_READ_ORGS };
            }
          }
        } catch { /* non-fatal */ }
      }

      // STAQPRO-570: validateScope no longer soft-degrades a scope-less call —
      // it hard-throws. When no per-member owner resolved above and the agent
      // tier is not org-allowed, we have NOT abandoned the org gate: this
      // context-loader is the validated boundary that already resolved the
      // principal's readable orgs (STAQS_READ_ORGS via syntheticPrincipal). We
      // express that to wikiPageSearch as an internal passthrough
      // (`__scopeValidatedByParent`) carrying the resolved readOrgIds, rather
      // than a `scope` arg — passing `{ org:true }` here would have to forge an
      // org-allowed agentId and would be a tier-gate privilege escalation. The
      // org gate (readOrgIds) still bounds visibility; the per-owner gate is
      // left open to the org-shared corpus (deny-by-default org boundary,
      // SPEC §0 P1, preserved without a tier bypass).
      const wikiOpts = {
        maxClassification: maxLevel,
        matchCount: 3,
        agentId,
        workItemId,
      };
      if (!wikiScope) {
        wikiOpts.readOrgIds = STAQS_READ_ORGS;
        wikiOpts[SCOPE_VALIDATED_BY_PARENT] = true;
      }

      // Two parallel lookups mirroring getRAGContext's sender + subject
      // strategy. matchCount=3 each, capped to 5 total after dedup.
      const [senderRes, subjectRes] = await Promise.all([
        wikiPageSearch(`${senderName} ${context.email.from_address || ''}`.trim(), wikiOpts, wikiScope),
        subject
          ? wikiPageSearch(subject, wikiOpts, wikiScope)
          : Promise.resolve({ pages: [] }),
      ]);

      const seen = new Map();
      for (const page of [...senderRes.pages, ...subjectRes.pages]) {
        const prev = seen.get(page.id);
        if (!prev || prev.score < page.score) seen.set(page.id, page);
      }
      wikiItems = [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    } catch {
      // wiki retrieval unavailable — graceful degradation (no wiki items)
    }
  }

  // Unified knowledgeContext envelope (per Neo Architect).
  // Phase 2: starts with wiki_pages source_type. Phase 3 will fold the
  // existing ragContext.chunks into items[] so a single envelope serves
  // all knowledge sources. For now ragContext stays as-is for the few
  // direct callers (agent-chat, api-routes/search) that read its shape.
  const ragChunks = Array.isArray(context.ragContext?.chunks)
    ? context.ragContext.chunks
    : [];
  const ragItems = ragChunks.slice(0, 5).map(c => ({
    sourceType: 'documents',
    id: c.documentId || c.id || null,
    excerpt: c.text || c.excerpt || '',
    classificationLevel: null,
    score: typeof c.similarity === 'number' ? c.similarity : 0,
  }));
  const allItems = [...wikiItems, ...ragItems];
  if (allItems.length > 0) {
    const totalTokens = Math.ceil(
      allItems.reduce((s, it) => s + (it.excerpt?.length || 0), 0) / 4
    );
    context.knowledgeContext = { items: allItems, totalTokens };
  }

  // Skill performance context (all tiers): "what am I good/bad at?"
  // P2 compliant — structural data, not behavioral instructions.
  try {
    const perfResult = await query(
      `SELECT event_type, tool_name, total_runs, success_count, fail_count,
              CASE WHEN total_runs > 0 THEN total_duration_ms / total_runs ELSE 0 END AS avg_duration_ms,
              CASE WHEN total_runs > 0 THEN ROUND(total_cost_usd / total_runs, 6) ELSE 0 END AS avg_cost_usd
       FROM agent_graph.skill_performance
       WHERE agent_id = $1 AND total_runs > 0
       ORDER BY total_runs DESC LIMIT 10`,
      [agentId]
    );
    if (perfResult.rows.length > 0) context.skillPerformance = perfResult.rows;
  } catch {
    // Table may not exist (pre-migration 047) — graceful degradation
  }

  // Q1: Just task + email metadata + body. Done.
  if (tier === 'Q1') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q2+: Parallel context assembly (Change 0 — 10x M14 lever) ──────────
  // Previously all queries ran sequentially (~500-1200ms). Independent queries
  // now run via Promise.all(), bounded by the slowest single query (~200-500ms).
  // Inspired by Claude Code's four-stage context pipeline.

  const targetProject = metadata?.target_project || metadata?.triage_result?.target_project;
  const fromAddress = context.email?.from_address;

  // ── Q2 parallel batch: signals + drafts + spec + RAG ──────────
  if (tier !== 'Q1' && emailId) {
    const q2Promises = [];

    // Signals (project-scoped when available).
    // OPT-166 P2c: inbox.signals is RLS-gated post-flip AND keyed on the
    // correspondent (from_address / message_id), which is NOT org-unique — a
    // sender who emails multiple orgs would, under an over-broad scope, leak the
    // other orgs' signals into this org's agent context. So this one read runs
    // under this work item's OWN org scope (Tier-2 app.org_ids = [ownerOrgId]).
    // null ownerOrgId → orgIds:[] → black-holes to empty (correct for an
    // org-less item). Its own single-statement scope, opened+released inside the
    // pushed promise so it still runs concurrently with the bare drafts read.
    // INERT today (superuser bypasses RLS).
    if (targetProject && fromAddress) {
      q2Promises.push((async () => {
        // Scope ACQUISITION is inside the outer try: withAgentScope can throw
        // (identity resolution / allow-list / pool BEGIN — lib/db.js), and this
        // promise has no external .catch, so an uncaught reject here would fail
        // the whole Promise.all and crash loadContext. Degrade to [] instead
        // (mirrors the reflection/topology pattern below).
        try {
          const sScope = await withAgentScope(agentId, { orgIds: ownerOrgId ? [ownerOrgId] : [] });
          try {
            const r = await sScope(
              `SELECT s.* FROM inbox.signals s
               JOIN inbox.messages m ON m.id = s.message_id
               WHERE m.from_address = $1
                 AND s.created_at >= NOW() - INTERVAL '30 days'
                 AND (s.metadata->>'target_project' = $2 OR s.message_id = $3)
               ORDER BY s.created_at`,
              [fromAddress, targetProject, emailId]
            );
            context.signals = r.rows;
            context._contextScope = { project: targetProject, window: '30d' };
          } finally {
            await sScope.release();
          }
        } catch {
          context.signals = [];
        }
      })());
    } else {
      q2Promises.push((async () => {
        // Acquisition inside the outer try — see the sibling read above.
        try {
          const sScope = await withAgentScope(agentId, { orgIds: ownerOrgId ? [ownerOrgId] : [] });
          try {
            const r = await sScope(
              `SELECT * FROM inbox.signals WHERE message_id = $1 ORDER BY created_at`,
              [emailId]
            );
            context.signals = r.rows;
          } finally {
            await sScope.release();
          }
        } catch {
          context.signals = [];
        }
      })());
    }

    // Drafts
    q2Promises.push(
      query(
        `SELECT * FROM agent_graph.action_proposals WHERE message_id = $1 AND action_type = 'email_draft' ORDER BY version DESC LIMIT 3`,
        [emailId]
      ).then(r => { context.drafts = r.rows; })
       .catch(() => { context.drafts = []; })
    );

    await Promise.all(q2Promises);
  }

  if (tier === 'Q2') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q3 parallel batch: contact + voice + history + few-shots ──────────
  if (fromAddress) {
    const q3Promises = [];

    // Contact lookup.
    // OPT-166 P2c: signal.contacts is RLS-gated post-flip and keyed on
    // email_address (NOT org-unique) — same cross-org leak shape as the signals
    // read above (a correspondent in multiple orgs returns multiple rows and
    // context.contact = rows[0] would grab an arbitrary org's contact). Scope to
    // THIS work item's org. null ownerOrgId → orgIds:[] → empty. Own
    // single-statement scope; runs concurrently with the bare voice/history
    // reads (voice.profiles is no-RLS, inbox.messages permissive). INERT today.
    q3Promises.push((async () => {
      // Acquisition inside the outer try — withAgentScope can throw and this
      // promise feeds Promise.all with no external .catch; degrade to null.
      try {
        const cScope = await withAgentScope(agentId, { orgIds: ownerOrgId ? [ownerOrgId] : [] });
        try {
          const r = await cScope(`SELECT * FROM signal.contacts WHERE email_address = $1`, [fromAddress]);
          context.contact = r.rows[0] || null;
        } finally {
          await cScope.release();
        }
      } catch {
        context.contact = null;
      }
    })());

    // Voice profile resolution (account-scoped, with fallback chain)
    q3Promises.push(
      (async () => {
        let voiceAccountId = context.accountId || null;
        if (voiceAccountId) {
          try {
            const sourceR = await query(
              `SELECT voice_profile_source FROM inbox.accounts WHERE id = $1`,
              [voiceAccountId]
            );
            const source = sourceR.rows[0]?.voice_profile_source;
            if (source && source !== voiceAccountId) voiceAccountId = source;
          } catch { /* column may not exist yet */ }
        }
        context.voiceAccountId = voiceAccountId;

        // Try in priority order: scoped recipient → scoped global → unscoped recipient → unscoped global
        if (voiceAccountId) {
          const scopedRecip = await query(
            `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 AND account_id = $2`,
            [fromAddress, voiceAccountId]
          );
          if (scopedRecip.rows[0]) { context.voiceProfile = scopedRecip.rows[0]; return; }

          const scopedGlobal = await query(
            `SELECT * FROM voice.profiles WHERE scope = 'global' AND account_id = $1 LIMIT 1`,
            [voiceAccountId]
          );
          if (scopedGlobal.rows[0]) { context.voiceProfile = scopedGlobal.rows[0]; return; }
        }

        const unscoped = await query(
          `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1`,
          [fromAddress]
        );
        if (unscoped.rows[0]) { context.voiceProfile = unscoped.rows[0]; return; }

        const globalFallback = await query(`SELECT * FROM voice.profiles WHERE scope = 'global' LIMIT 1`);
        context.voiceProfile = globalFallback.rows[0] || null;
      })().catch(() => { context.voiceProfile = null; })
    );

    // Contact history (project-scoped when available)
    if (targetProject) {
      q3Promises.push(
        query(
          `SELECT m.id, m.subject, m.snippet, m.received_at, m.from_address
           FROM inbox.messages m
           WHERE m.from_address = $1
             AND m.received_at >= NOW() - INTERVAL '30 days'
           ORDER BY m.received_at DESC
           LIMIT 20`,
          [fromAddress]
        ).then(r => {
          context.contactHistory = r.rows;
          context._contextScope = { ...(context._contextScope || {}), project: targetProject, window: '30d' };
        }).catch(() => { context.contactHistory = []; })
      );
    }

    await Promise.all(q3Promises);
  }

  if (extra.fewShots) context.fewShots = extra.fewShots;

  if (tier === 'Q3') {
    return sanitize(enforceTokenBudget(context));
  }

  // ── Q4 parallel batch: architect aggregate metrics ──────────
  const [dailyBriefing, agentActivity, budgetStatus] = await Promise.all([
    query(`SELECT * FROM signal.v_daily_briefing`).catch(() => ({ rows: [] })),
    query(`SELECT * FROM agent_graph.v_agent_activity`).catch(() => ({ rows: [] })),
    query(`SELECT * FROM agent_graph.v_budget_status WHERE period_end >= CURRENT_DATE`).catch(() => ({ rows: [] })),
  ]);
  context.dailyBriefing = dailyBriefing.rows[0] || null;
  context.agentActivity = agentActivity.rows;
  context.budgetStatus = budgetStatus.rows;

  return sanitize(enforceTokenBudget(context));
}

/**
 * Load reflection context for an agent: recent outcomes + Neo4j patterns.
 * Called by agent reflect() methods for self-improvement.
 */
export async function loadReflectionContext(agentId) {
  const context = { agentId };

  // Intent match rate from Postgres
  try {
    const matchRate = await query(
      `SELECT * FROM agent_graph.intent_match_rate WHERE agent_id = $1`,
      [agentId]
    );
    context.intentMatchRate = matchRate.rows;
  } catch {
    context.intentMatchRate = [];
  }

  // Recent task outcomes (last 7 days).
  // OPT-166 P2c: work_items is RLS-gated post-flip. This read is scoped to the
  // reflecting agent's OWN items (wi.assigned_to = $1 = agentId), so plain AGENT
  // scope is exactly the right (least-privilege) key: agent_read_work_items'
  // USING clause grants on assigned_to = agent_graph.current_agent_id(). No org
  // scope / no system scope needed — this is not a cross-agent aggregate. The
  // JOINed state_transitions is permissive (read_transitions USING true). Own
  // single-statement scope. INERT today (superuser bypasses RLS).
  try {
    const rScope = await withAgentScope(agentId);
    try {
      const outcomes = await rScope(
        `SELECT wi.id, wi.title, wi.status, wi.metadata,
                st.cost_usd, st.reason, st.created_at as completed_at
         FROM agent_graph.work_items wi
         JOIN agent_graph.state_transitions st ON st.work_item_id = wi.id AND st.to_state = wi.status
         WHERE wi.assigned_to = $1
           AND wi.status IN ('completed', 'failed')
           AND st.created_at > now() - INTERVAL '7 days'
         ORDER BY st.created_at DESC
         LIMIT 20`,
        [agentId]
      );
      context.recentOutcomes = outcomes.rows;
    } finally {
      await rScope.release();
    }
  } catch {
    context.recentOutcomes = [];
  }

  // Neo4j multi-hop patterns (if available) — ADR-019
  // P2: Neo4j data is advisory only — never use for enforcement decisions
  try {
    const { getDecisionOutcomeChain, getDelegationEffectiveness, getRecentMeetings } = await import('../../graph/queries.js');
    const [decisionChains, delegationEffectiveness, recentMeetings] = await Promise.all([
      getDecisionOutcomeChain(agentId),
      getDelegationEffectiveness(),
      // Plan 041: recent :Meeting nodes — the payoff of the capture→enrich→graph
      // chain now that meetings are first-class nodes (advisory only, P2).
      getRecentMeetings(),
    ]);
    context.decisionChains = decisionChains || [];
    context.delegationEffectiveness = delegationEffectiveness || [];
    context.recentMeetings = recentMeetings || [];
  } catch {
    context.decisionChains = [];
    context.delegationEffectiveness = [];
    context.recentMeetings = [];
  }

  return context;
}

/**
 * Load system topology for an agent: who can do what, delegation paths.
 * Used by orchestrator for dynamic routing decisions.
 */
export async function loadSystemTopology(forAgent) {
  const topology = { forAgent };

  // Active agents with their capabilities.
  // OPT-166 P2c: the correlated subquery counts in-progress work_items PER
  // agent across ALL agents — a cross-agent operational aggregate for routing.
  // Under RLS post-flip, agent scope would restrict the count to the calling
  // agent's own items and silently under-report every other agent's load,
  // breaking delegation. System scope (tenancy.is_system() Tier-0 operational
  // read) is the correct key. Single statement; released immediately. INERT
  // today (superuser bypasses RLS).
  try {
    const topoScope = await withSystemScope('context-loader');
    try {
      const agents = await topoScope(
        `SELECT ac.id, ac.agent_type, ac.model, ac.is_active,
                ac.tools_allowed,
                (SELECT array_agg(can_assign) FROM agent_graph.agent_assignment_rules WHERE agent_id = ac.id) AS can_delegate_to,
                (SELECT COUNT(*) FROM agent_graph.work_items WHERE assigned_to = ac.id AND status = 'in_progress') AS active_tasks
         FROM agent_graph.agent_configs ac
         WHERE ac.is_active = true
         ORDER BY ac.agent_type, ac.id`
      );
      topology.agents = agents.rows;
    } finally {
      await topoScope.release();
    }
  } catch {
    topology.agents = [];
  }

  // Recent routing success rates (last 7 days).
  // OPT-166 P2c: GROUP BY wi.assigned_to is a cross-agent aggregate (routing
  // health across the whole fleet) — same rationale as the agent-capabilities
  // read above. Agent scope would collapse it to the caller's own rows; system
  // scope (operational Tier-0 read) is correct. Single statement; released
  // immediately. INERT today (superuser bypasses RLS).
  try {
    const rateScope = await withSystemScope('context-loader');
    try {
      const successRates = await rateScope(
        `SELECT wi.assigned_to,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE wi.status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE wi.status = 'failed') AS failed,
                ROUND(100.0 * COUNT(*) FILTER (WHERE wi.status = 'completed') / NULLIF(COUNT(*), 0), 1) AS success_pct
         FROM agent_graph.work_items wi
         WHERE wi.created_at > now() - INTERVAL '7 days'
           AND wi.status IN ('completed', 'failed')
         GROUP BY wi.assigned_to
         ORDER BY success_pct DESC`
      );
      topology.successRates = successRates.rows;
    } finally {
      await rateScope.release();
    }
  } catch {
    topology.successRates = [];
  }

  return topology;
}
