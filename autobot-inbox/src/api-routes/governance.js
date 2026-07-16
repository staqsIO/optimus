import { query, withBoardScope } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { createLLMClient, callProvider, computeCost } from '../../../lib/llm/provider.js';
import { getConfig } from '../../../lib/config/loader.js';

/**
 * Parse JSON from an LLM response, handling markdown code blocks.
 * Tries direct JSON.parse first (cleanest case), then falls back to regex extraction.
 */
function parseJsonResponse(text) {
  // Try direct parse first (cleanest case — no wrapper text)
  try {
    return JSON.parse(text);
  } catch { /* fall through to regex extraction */ }
  // Fall back to regex extraction for responses wrapped in markdown/text
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* fall through */ }
  }
  return {};
}

// Routes through lib/llm/provider.js (ADR-020): provider selection + pricing
// live in one place. Models must exist in agents.json `models` (issue #512 /
// Plan 036 follow-up — this file was left un-migrated in PR #510 because it
// used the undated `claude-sonnet-4-20250514`).
let _llmHaiku = null;
let _llmSonnet = null;
function getLLMClients() {
  const models = getConfig('agents').models;
  _llmHaiku ??= createLLMClient('claude-haiku-4-5-20251001', models);
  _llmSonnet ??= createLLMClient('claude-sonnet-4-6', models);
  return { llmHaiku: _llmHaiku, llmSonnet: _llmSonnet };
}

let _cachedConstitution = null;
async function loadConstitution() {
  if (_cachedConstitution) return _cachedConstitution;
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    _cachedConstitution = await fs.readFile(path.resolve(process.cwd(), '..', 'CONSTITUTION.md'), 'utf-8');
  } catch {
    _cachedConstitution = 'CONSTITUTION.md not available';
  }
  return _cachedConstitution;
}

let _cachedAgentsConfig = null;
async function loadAgentsConfig() {
  if (_cachedAgentsConfig) return _cachedAgentsConfig;
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    _cachedAgentsConfig = await fs.readFile(path.resolve(process.cwd(), 'config', 'agents.json'), 'utf-8');
  } catch {
    _cachedAgentsConfig = '{}';
  }
  return _cachedAgentsConfig;
}

/**
 * Stage 1: Intake Classification (Haiku, ~$0.001).
 * Fast triage — classify content_type, spec_domains, affected_sections, etc.
 */
async function runIntakeClassification(submission, llm) {
  const startTime = Date.now();

  const response = await callProvider(llm, {
    maxTokens: 2048,
    messages: [{
      role: 'user',
      content: `You are a governance intake classifier for Optimus, an AI agent organization.

Analyze this submission and produce a JSON classification:

SUBMISSION:
- Title: ${submission.title}
- Type: ${submission.content_type}
- Content: ${(submission.raw_content || '').slice(0, 4000)}
${submission.source_url ? `- URL: ${submission.source_url}` : ''}

Respond with ONLY a JSON object:
{
  "content_type": "${submission.content_type}",
  "spec_domains": ["list of affected domains like agent_graph, voice, inbox, signal, content"],
  "affected_sections": ["list of spec sections like §2.3, §5"],
  "affected_adrs": ["list of ADRs like ADR-009"],
  "impact_level": "low|medium|high|critical",
  "urgency": "low|normal|high|blocking",
  "audit_summary": "2-3 sentence assessment"
}`
    }],
  });

  const elapsed = Date.now() - startTime;
  const text = response.text || '{}';

  let classification;
  try {
    classification = parseJsonResponse(text);
  } catch {
    classification = { audit_summary: text };
  }

  const cost = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);

  console.log(`[governance] intake classification completed in ${elapsed}ms ($${cost.toFixed(4)})`);

  return {
    spec_domains: classification.spec_domains || [],
    affected_sections: classification.affected_sections || [],
    affected_adrs: classification.affected_adrs || [],
    impact_level: classification.impact_level || 'medium',
    urgency: classification.urgency || 'normal',
    audit_summary: classification.audit_summary || '',
    cost,
  };
}

/**
 * Stage 2a: Constitutional Audit (Sonnet).
 * Checks P1-P6 alignment, Lethal Trifecta risk, kill switch implications.
 */
async function runConstitutionalAudit(submission, classification, llm) {
  try {
    const constitution = await loadConstitution();

    const startTime = Date.now();

    const response = await callProvider(llm, {
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a constitutional auditor for Optimus, an AI agent organization governed by a constitution.

Audit this governance submission against the constitution:

SUBMISSION:
- Title: ${submission.title}
- Type: ${submission.content_type}
- Content: ${(submission.raw_content || '').slice(0, 4000)}
${submission.source_url ? `- URL: ${submission.source_url}` : ''}
- Classification: impact=${classification.impact_level}, urgency=${classification.urgency}
- Affected domains: ${classification.spec_domains.join(', ') || 'none identified'}

CONSTITUTION:
${constitution.slice(0, 6000)}

Analyze for:
1. P1-P6 principle alignment (Deny by default, Infrastructure enforces, Transparency by structure, Boring infrastructure, Measure before trust, Familiar interfaces)
2. Lethal Trifecta risk (budget + autonomy + external communication combining dangerously)
3. Kill switch implications (does this affect the board's ability to halt operations?)

Respond with ONLY a JSON object:
{
  "score": 0-10,
  "alignment": "aligned|minor_concerns|major_concerns|violation",
  "findings": ["list of specific constitutional findings"],
  "recommendation": "accept|discuss|reject|defer"
}`
      }],
    });

    const elapsed = Date.now() - startTime;
    const text = response.text || '{}';

    let result;
    try {
      result = parseJsonResponse(text);
    } catch {
      result = { score: 5, alignment: 'unknown', findings: [text], recommendation: 'discuss' };
    }

    const cost = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);

    console.log(`[governance] constitutional audit completed in ${elapsed}ms ($${cost.toFixed(4)}): ${result.alignment}`);

    return {
      score: result.score ?? 5,
      alignment: result.alignment || 'unknown',
      findings: result.findings || [],
      recommendation: result.recommendation || 'discuss',
      cost,
    };
  } catch (err) {
    console.error('[governance] constitutional audit failed:', err.message);
    return { score: 5, alignment: 'unknown', findings: [`Audit failed: ${err.message}`], recommendation: 'discuss', cost: 0 };
  }
}

/**
 * Stage 2b: Architectural Audit (Sonnet).
 * Checks ADR conflicts, schema impact, agent tier boundary violations.
 */
async function runArchitecturalAudit(submission, classification, llm) {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');

    // Load agents.json (cached)
    const agentsConfig = await loadAgentsConfig();

    // Load affected ADRs
    const adrContents = [];
    const adrDir = path.resolve(process.cwd(), 'docs', 'internal', 'adrs');
    for (const adrRef of (classification.affected_adrs || [])) {
      try {
        const files = await fs.readdir(adrDir);
        // Match ADR-009 -> files containing "009" in name
        const adrNum = adrRef.replace(/^ADR-/i, '').padStart(3, '0');
        const match = files.find(f => f.includes(adrNum) && f.endsWith('.md'));
        if (match) {
          const content = await fs.readFile(path.join(adrDir, match), 'utf-8');
          adrContents.push(`--- ${adrRef} (${match}) ---\n${content.slice(0, 2000)}`);
        }
      } catch { /* ADR directory may not exist */ }
    }
    const adrContext = adrContents.length > 0
      ? adrContents.join('\n\n')
      : 'No affected ADRs loaded';

    const startTime = Date.now();

    const response = await callProvider(llm, {
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content: `You are an architectural auditor for Optimus, an AI agent organization.

Audit this governance submission for architectural impact:

SUBMISSION:
- Title: ${submission.title}
- Type: ${submission.content_type}
- Content: ${(submission.raw_content || '').slice(0, 4000)}
${submission.source_url ? `- URL: ${submission.source_url}` : ''}
- Classification: impact=${classification.impact_level}, urgency=${classification.urgency}
- Affected domains: ${classification.spec_domains.join(', ') || 'none identified'}
- Affected sections: ${classification.affected_sections.join(', ') || 'none identified'}

AGENT CONFIGURATION:
${agentsConfig.slice(0, 3000)}

AFFECTED ADRs:
${adrContext.slice(0, 4000)}

Analyze for:
1. ADR conflicts (does this contradict existing architecture decisions?)
2. Schema impact (which of the 5 schemas -- agent_graph, inbox, voice, signal, content -- are affected?)
3. Agent tier boundary violations (does this violate the Strategist/Architect/Orchestrator/Reviewer/Executor hierarchy?)

Respond with ONLY a JSON object:
{
  "score": 0-10,
  "adr_conflicts": ["list of conflicting ADRs with explanation"],
  "schema_impact": ["list of affected schemas"],
  "tier_violations": ["list of tier boundary violations"],
  "recommendation": "accept|discuss|reject|defer"
}`
      }],
    });

    const elapsed = Date.now() - startTime;
    const text = response.text || '{}';

    let result;
    try {
      result = parseJsonResponse(text);
    } catch {
      result = { score: 5, adr_conflicts: [], schema_impact: [], tier_violations: [text], recommendation: 'discuss' };
    }

    const cost = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);

    console.log(`[governance] architectural audit completed in ${elapsed}ms ($${cost.toFixed(4)}): score=${result.score}`);

    return {
      score: result.score ?? 5,
      adr_conflicts: result.adr_conflicts || [],
      schema_impact: result.schema_impact || [],
      tier_violations: result.tier_violations || [],
      recommendation: result.recommendation || 'discuss',
      cost,
    };
  } catch (err) {
    console.error('[governance] architectural audit failed:', err.message);
    return { score: 5, adr_conflicts: [], schema_impact: [], tier_violations: [`Audit failed: ${err.message}`], recommendation: 'discuss', cost: 0 };
  }
}

/**
 * Stage 2c: Operational Audit (Sonnet).
 * Checks budget implications, deployment risk, timing/freezes.
 */
async function runOperationalAudit(submission, classification, llm) {
  try {
    // Query live pipeline state
    const [budgetResult, pipelineResult, gateStatus] = await Promise.all([
      query(`
        SELECT allocated_usd, spent_usd
        FROM agent_graph.budgets
        WHERE scope = 'daily' AND period_start <= CURRENT_DATE AND period_end >= CURRENT_DATE
        ORDER BY created_at DESC LIMIT 1
      `).catch(() => ({ rows: [] })),
      query(`
        SELECT status, COUNT(*) as count
        FROM agent_graph.work_items
        WHERE status NOT IN ('completed', 'cancelled', 'failed')
        GROUP BY status
      `).catch(() => ({ rows: [] })),
      (async () => {
        try {
          const { getGateStatus } = await import('../runtime/capability-gates.js');
          return await getGateStatus();
        } catch {
          return {};
        }
      })(),
    ]);

    const budget = budgetResult.rows[0];
    const spent = parseFloat(budget?.spent_usd || '0');
    const allocated = parseFloat(budget?.allocated_usd || '20');
    const budgetPct = allocated > 0 ? Math.round((spent / allocated) * 100) : 0;

    const pipelineSummary = pipelineResult.rows
      .map(r => `${r.status}: ${r.count}`)
      .join(', ') || 'no active items';

    const gatesTotal = Object.keys(gateStatus).length || 7;
    const gatesPassing = Object.values(gateStatus).filter(g => g.passing === true).length;
    const gatesFailing = gatesTotal - gatesPassing;

    const startTime = Date.now();

    const response = await callProvider(llm, {
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content: `You are an operational auditor for Optimus, an AI agent organization.

Audit this governance submission for operational risk:

SUBMISSION:
- Title: ${submission.title}
- Type: ${submission.content_type}
- Content: ${(submission.raw_content || '').slice(0, 4000)}
${submission.source_url ? `- URL: ${submission.source_url}` : ''}
- Classification: impact=${classification.impact_level}, urgency=${classification.urgency}
- Affected domains: ${classification.spec_domains.join(', ') || 'none identified'}

CURRENT OPERATIONAL STATE:
- Budget: $${spent.toFixed(2)} / $${allocated.toFixed(2)} (${budgetPct}% consumed today)
- Pipeline: ${pipelineSummary}
- Gates: ${gatesPassing}/${gatesTotal} passing${gatesFailing > 0 ? ` (${gatesFailing} failing)` : ''}

Analyze for:
1. Budget implications (will implementing this increase LLM costs? By how much?)
2. Deployment risk (can this be deployed safely? Rolling update or requires downtime?)
3. Timing (any conflicts with current pipeline load, gate failures, or budget pressure?)

Respond with ONLY a JSON object:
{
  "score": 0-10,
  "budget_impact": "description of budget implications",
  "deployment_risk": "low|medium|high",
  "operational_flags": ["list of operational concerns"],
  "recommendation": "accept|discuss|reject|defer"
}`
      }],
    });

    const elapsed = Date.now() - startTime;
    const text = response.text || '{}';

    let result;
    try {
      result = parseJsonResponse(text);
    } catch {
      result = { score: 5, budget_impact: 'unknown', deployment_risk: 'medium', operational_flags: [text], recommendation: 'discuss' };
    }

    const cost = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);

    console.log(`[governance] operational audit completed in ${elapsed}ms ($${cost.toFixed(4)}): risk=${result.deployment_risk}`);

    return {
      score: result.score ?? 5,
      budget_impact: result.budget_impact || 'unknown',
      deployment_risk: result.deployment_risk || 'medium',
      operational_flags: result.operational_flags || [],
      recommendation: result.recommendation || 'discuss',
      cost,
    };
  } catch (err) {
    console.error('[governance] operational audit failed:', err.message);
    return { score: 5, budget_impact: 'unknown', deployment_risk: 'medium', operational_flags: [`Audit failed: ${err.message}`], recommendation: 'discuss', cost: 0 };
  }
}

/**
 * Aggregate three audit dimensions into a final recommendation.
 */
function deriveRecommendation(constitutional, architectural, operational) {
  // Any violation or high-risk finding -> reject
  if (constitutional.alignment === 'violation') return 'reject';

  // Score-based thresholds
  const scores = [constitutional.score, architectural.score, operational.score];
  const avgScore = scores.reduce((a, b) => a + b, 0) / 3;

  if (avgScore < 3) return 'reject';
  if (avgScore < 5) return 'discuss';

  if (constitutional.alignment === 'major_concerns') return 'discuss';
  if (operational.deployment_risk === 'high') return 'discuss';
  if (architectural.adr_conflicts.length > 0) return 'discuss';
  if (architectural.tier_violations.length > 0) return 'discuss';

  // Count how many dimensions recommend something other than accept
  const nonAccept = [constitutional, architectural, operational]
    .filter(d => d.recommendation !== 'accept').length;

  if (nonAccept >= 2) return 'discuss';
  if (avgScore >= 7 && nonAccept === 0) return 'accept';

  return 'discuss';
}

/**
 * Knowledge extraction — produces actionable cards from submission content.
 * Liotta redesign: replace per-pillar voting with per-extraction confirmation.
 *
 * Produces three card types:
 *   - knowledge: facts/insights worth ingesting into RAG
 *   - action: things to build/change (creates work items)
 *   - spec: architecture implications (routes to discussion/ADR)
 */
async function runKnowledgeExtraction(submission, classification, constitutional, llm) {
  const content = (submission.raw_content || submission.title || '').slice(0, 8000);
  const isViolation = constitutional?.alignment === 'violation';

  // Skip extraction for constitutional violations
  if (isViolation) {
    return [{ type: 'knowledge', title: 'Constitutional violation flagged', content: constitutional.findings?.join('; ') || 'Review required', confidence: 1.0, preChecked: false }];
  }

  try {
    const msg = await callProvider(llm, {
      maxTokens: 2048,
      system: `You are a knowledge extractor for the Optimus governed agent organization. Given a submission (URL, research, idea, or spec amendment), extract discrete actionable items.

For each extraction, produce a JSON object with:
- type: "knowledge" (facts/insights to remember), "action" (something to build/change), or "spec" (architecture implication)
- title: brief title (under 80 chars)
- content: the extracted information (2-3 sentences)
- confidence: 0.0-1.0 (how sure you are this is worth acting on)
- tags: relevant tags (e.g., ["security", "performance", "rag"])

Return a JSON array of extractions. Aim for 2-6 items. Don't pad — if there's only 1 useful thing, return 1.`,
      messages: [{
        role: 'user',
        content: `SUBMISSION: ${submission.title}\nTYPE: ${submission.content_type}\nDOMAINS: ${(classification.spec_domains || []).join(', ')}\n\nCONTENT:\n${content}`,
      }],
    });

    const text = msg.text || '[]';
    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.map((item, i) => ({
      id: `ext-${i}`,
      type: item.type || 'knowledge',
      title: item.title || `Extraction ${i + 1}`,
      content: item.content || '',
      confidence: Math.min(1, Math.max(0, item.confidence ?? 0.5)),
      tags: item.tags || [],
      preChecked: (item.confidence ?? 0.5) >= 0.8,
    }));
  } catch (err) {
    console.error(`[governance] extraction error: ${err.message}`);
    return [];
  }
}

/**
 * Intake classifier — two-stage pipeline:
 *   Stage 1: Haiku classification (~$0.001)
 *   Stage 2: Three-dimension parallel Sonnet audit (~$0.05-0.15)
 *   Stage 3: Knowledge extraction (Sonnet — produces actionable cards)
 * Transitions status: submitted -> auditing -> awaiting_review
 */
async function classifySubmission(submissionId) {
  const sub = await query(
    'SELECT * FROM agent_graph.governance_submissions WHERE id = $1',
    [submissionId]
  );
  if (sub.rows.length === 0) return;
  const submission = sub.rows[0];

  // Transition to auditing (with status guard to prevent race conditions)
  const lockResult = await query(
    "UPDATE agent_graph.governance_submissions SET status = 'auditing' WHERE id = $1 AND status = 'submitted'",
    [submissionId]
  );
  if (lockResult.rowCount === 0) {
    console.log(`[governance] skipping classification for ${submissionId} — not in submitted state`);
    return;
  }

  try {
    const { llmHaiku, llmSonnet } = getLLMClients();

    const overallStart = Date.now();

    // Stage 1: Quick classification (Haiku)
    const classification = await runIntakeClassification(submission, llmHaiku);

    // Update with classification results immediately
    await query(
      `UPDATE agent_graph.governance_submissions SET
        spec_domains = $1,
        affected_sections = $2,
        affected_adrs = $3,
        impact_level = $4,
        urgency = $5
       WHERE id = $6`,
      [
        classification.spec_domains,
        classification.affected_sections,
        classification.affected_adrs,
        classification.impact_level,
        classification.urgency,
        submissionId,
      ]
    );

    // Stage 2: Three-dimension parallel audit (3x Sonnet)
    const [constitutional, architectural, operational] = await Promise.all([
      runConstitutionalAudit(submission, classification, llmSonnet),
      runArchitecturalAudit(submission, classification, llmSonnet),
      runOperationalAudit(submission, classification, llmSonnet),
    ]);

    // Aggregate results
    const auditResult = {
      classification: {
        spec_domains: classification.spec_domains,
        affected_sections: classification.affected_sections,
        affected_adrs: classification.affected_adrs,
        impact_level: classification.impact_level,
        urgency: classification.urgency,
        audit_summary: classification.audit_summary,
      },
      constitutional,
      architectural,
      operational,
      overall_score: Math.round((constitutional.score + architectural.score + operational.score) / 3),
      recommendation: deriveRecommendation(constitutional, architectural, operational),
      flags: [
        ...constitutional.findings,
        ...architectural.adr_conflicts,
        ...architectural.tier_violations,
        ...operational.operational_flags,
      ].filter(Boolean),
    };

    // Calculate total cost
    const totalCost = classification.cost + constitutional.cost + architectural.cost + operational.cost;
    const overallElapsed = Date.now() - overallStart;

    // Update submission with full audit
    await query(
      `UPDATE agent_graph.governance_submissions SET
        audit_result = $1,
        audit_completed = now(),
        audit_agent = 'intake-haiku+audit-sonnet-3d',
        audit_cost_usd = $2,
        status = 'awaiting_review'
       WHERE id = $3`,
      [
        JSON.stringify(auditResult),
        totalCost,
        submissionId,
      ]
    );

    // Stage 3: Knowledge extraction (Sonnet — produces actionable cards instead of scores)
    let extractions = [];
    try {
      extractions = await runKnowledgeExtraction(submission, classification, constitutional, llmSonnet);
      auditResult.extractions = extractions;
    } catch (err) {
      console.warn(`[governance] extraction failed for ${submissionId}: ${err.message}`);
      auditResult.extractions = [];
    }

    console.log(`[governance] full audit completed for ${submissionId} in ${overallElapsed}ms ($${totalCost.toFixed(4)}): score=${auditResult.overall_score}, rec=${auditResult.recommendation}, extractions=${extractions.length}`);

    // Fire-and-forget Neo4j logging for relationship intelligence
    import('../graph/governance-sync.js').then(m => {
      m.logSubmission(submission);
      m.logAudit(submissionId, auditResult, totalCost);
    }).catch(() => {});

    // Fire-and-forget Slack notification
    import('../governance/notify.js').then(m => m.notifyAuditComplete(submission, { ...auditResult, cost_usd: totalCost })).catch(() => {});
  } catch (err) {
    console.error(`[governance] classification failed for ${submissionId}:`, err.message);
    // Fall back to awaiting_review with no audit
    await query(
      `UPDATE agent_graph.governance_submissions SET
        status = 'awaiting_review',
        audit_result = $1
       WHERE id = $2`,
      [JSON.stringify({ error: err.message, recommendation: 'discuss' }), submissionId]
    );
  }
}

/**
 * Governance Feed API routes.
 *
 * GET  /api/governance/feed      — unified governance feed from v_governance_feed
 * GET  /api/governance/summary   — narrative summary + counts for board overview
 * POST /api/governance/directive — create a board directive work item
 */
export function registerGovernanceRoutes(routes, cachedQuery) {
  // GET /api/governance/closure-metrics — OPT-52 headline metric.
  //
  // Reads the agent_graph.autonomous_closure_metrics materialized view and
  // returns { autonomous_closure_rate, cost_per_closed_loop, window } for the
  // board Overview card. The MV is per-org; this endpoint aggregates across the
  // visible orgs (or a single org via ?org_id=<uuid>) so the headline number is
  // a true org-weighted figure, not an average-of-averages:
  //   rate = SUM(autonomous_loops) / SUM(closed_loops)
  //   cost = SUM(total_loop_cost_usd) / SUM(closed_loops)
  // The view is refreshed opportunistically (stale-on-read) before the read,
  // mirroring the enrichment-worker poll-backstop pattern (migration 155).
  routes.set('GET /api/governance/closure-metrics', async (req) => {
    const orgId = new URL(req.url, 'http://localhost').searchParams.get('org_id');
    const cacheKey = `governance-closure-metrics:${orgId || '__all__'}`;
    const result = await cachedQuery(cacheKey, async () => {
      // Stale-on-read refresh; never let a refresh failure block the read.
      try {
        await query('SELECT agent_graph.refresh_autonomous_closure_metrics()');
      } catch { /* serve last-good snapshot if refresh is unavailable */ }

      const params = [];
      let where = '';
      if (orgId) { params.push(orgId); where = 'WHERE owner_org_id = $1'; }

      const r = await query(
        `SELECT
           COALESCE(SUM(closed_loops), 0)        AS closed_loops,
           COALESCE(SUM(autonomous_loops), 0)    AS autonomous_loops,
           COALESCE(SUM(total_loop_cost_usd), 0) AS total_loop_cost_usd,
           MAX(computed_at)                       AS computed_at
         FROM agent_graph.autonomous_closure_metrics
         ${where}`,
        params
      );

      const row = r.rows[0] || {};
      const closed = parseInt(row.closed_loops || '0', 10);
      const autonomous = parseInt(row.autonomous_loops || '0', 10);
      const totalCost = parseFloat(row.total_loop_cost_usd || '0');

      return {
        autonomous_closure_rate: closed > 0 ? +(autonomous / closed).toFixed(4) : null,
        cost_per_closed_loop: closed > 0 ? +(totalCost / closed).toFixed(6) : null,
        closed_loops: closed,
        autonomous_loops: autonomous,
        total_loop_cost_usd: +totalCost.toFixed(6),
        org_id: orgId || null,
        window: 'all_time',
        computed_at: row.computed_at || null,
      };
    }, 30_000);
    return result || {
      autonomous_closure_rate: null,
      cost_per_closed_loop: null,
      closed_loops: 0,
      autonomous_loops: 0,
      total_loop_cost_usd: 0,
      org_id: orgId || null,
      window: 'all_time',
      computed_at: null,
    };
  });

  // GET /api/governance/feed — query v_governance_feed, cached 15s
  routes.set('GET /api/governance/feed', async () => {
    const result = await cachedQuery('governance-feed', async () => {
      const r = await query(
        `SELECT * FROM v_governance_feed
         ORDER BY requires_action DESC, board_relevance DESC, priority ASC, created_at DESC
         LIMIT 50`
      );
      return { items: r.rows };
    }, 15_000);
    return result || { items: [] };
  });

  // GET /api/governance/summary — narrative one-liner + counts
  routes.set('GET /api/governance/summary', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      // OPT-166 P3-B6: cachedQuery results are scoped-query output — a global
      // key would let one principal's cached result bleed into another's
      // response within the TTL. Key by principal so board (per-sub) and
      // non-board (unscoped-pool) results never share a cache slot.
      const principalKey = req.auth?.role === 'board' ? `board:${req.auth.sub}` : 'anon';
      const result = await cachedQuery(`governance-summary:${principalKey}`, async () => {
        // Parallelize the 4 guaranteed DB queries
        const [draftsR, budgetR, pipelineR, strategicR] = await Promise.all([
          scopedQuery(`
            SELECT COUNT(*) as count FROM agent_graph.action_proposals
            WHERE board_action IS NULL AND reviewer_verdict IS NOT NULL
          `),
          scopedQuery(`
            SELECT allocated_usd, spent_usd
            FROM agent_graph.budgets
            WHERE scope = 'daily' AND period_start <= CURRENT_DATE AND period_end >= CURRENT_DATE
            ORDER BY created_at DESC LIMIT 1
          `),
          scopedQuery(`
            SELECT COUNT(*) as count FROM agent_graph.work_items
            WHERE status NOT IN ('completed', 'cancelled', 'failed')
          `),
          scopedQuery(`
            SELECT COUNT(*) as count FROM agent_graph.strategic_decisions
            WHERE board_verdict IS NULL
          `),
        ]);

        const draftsPending = parseInt(draftsR.rows[0]?.count || '0');

        const budget = budgetR.rows[0];
        const spent = parseFloat(budget?.spent_usd || '0');
        const allocated = parseFloat(budget?.allocated_usd || '20');
        const pct = allocated > 0 ? Math.round((spent / allocated) * 100) : 0;

        const pipelineActive = parseInt(pipelineR.rows[0]?.count || '0');
        const strategicPending = parseInt(strategicR.rows[0]?.count || '0');

        // Gate status (may fail — separate try/catch)
        let gatesPassing = 7, gatesTotal = 7;
        try {
          const { getGateStatus } = await import('../runtime/capability-gates.js');
          const status = await getGateStatus();
          gatesTotal = Object.keys(status).length || 7;
          gatesPassing = Object.values(status).filter(g => g.passing === true).length;
        } catch { /* gates unavailable */ }

        // Agent intents pending board review (table may not exist — separate try/catch)
        let intentsPending = 0;
        try {
          const intentsR = await scopedQuery(`
            SELECT COUNT(*) as count FROM agent_graph.agent_intents
            WHERE status = 'pending'
          `);
          intentsPending = parseInt(intentsR.rows[0]?.count || '0');
        } catch { /* table may not exist yet */ }

        const attentionNeeded = draftsPending + strategicPending + intentsPending;

        // Build narrative
        const parts = [];
        if (draftsPending > 0) parts.push(`${draftsPending} draft${draftsPending === 1 ? '' : 's'} need${draftsPending === 1 ? 's' : ''} review`);
        if (strategicPending > 0) parts.push(`${strategicPending} strategic decision${strategicPending === 1 ? '' : 's'} pending`);
        if (intentsPending > 0) parts.push(`${intentsPending} intent${intentsPending === 1 ? '' : 's'} awaiting review`);
        parts.push(`Budget at ${pct}%`);
        parts.push(gatesPassing === gatesTotal ? 'All gates passing' : `${gatesTotal - gatesPassing} gate${gatesTotal - gatesPassing === 1 ? '' : 's'} failing`);

        return {
          attention_needed: attentionNeeded,
          narrative: parts.join('. ') + '.',
          budget: { spent: +spent.toFixed(2), allocated: +allocated.toFixed(2), pct },
          gates: { passing: gatesPassing, total: gatesTotal },
          drafts_pending: draftsPending,
          strategic_pending: strategicPending,
          intents_pending: intentsPending,
          pipeline_active: pipelineActive,
        };
      }, 15_000);
      return result || {
        attention_needed: 0,
        narrative: 'Unable to fetch summary.',
        budget: { spent: 0, allocated: 20, pct: 0 },
        gates: { passing: 0, total: 7 },
        drafts_pending: 0,
        strategic_pending: 0,
        intents_pending: 0,
        pipeline_active: 0,
      };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // POST /api/governance/directive — create a directive work item
  routes.set('POST /api/governance/directive', async (_req, body) => {
    const { title, description } = body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw Object.assign(new Error('title is required'), { statusCode: 400 });
    }
    if (title.trim().length > 500) {
      throw Object.assign(new Error('title too long (max 500 characters)'), { statusCode: 400 });
    }
    if (description != null && typeof description !== 'string') {
      throw Object.assign(new Error('description must be a string'), { statusCode: 400 });
    }

    const item = await createWorkItem({
      type: 'directive',
      title: title.trim(),
      description: description || null,
      createdBy: 'board',
      assignedTo: 'orchestrator',
      priority: 1,
      metadata: { source: 'governance_feed' },
    });

    // Log the directive as a public event
    await publishEvent(
      'board_directive',
      `Board directive: ${title.trim()}`,
      null,
      item.id,
      { source: 'governance_feed', directive_title: title.trim() },
    );

    return { ok: true, workItem: item };
  });

  // POST /api/governance/command — create a board command work item with proper typing
  routes.set('POST /api/governance/command', async (_req, body) => {
    const { title, description, assignTo, priority, jamie } = body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw Object.assign(new Error('title is required'), { statusCode: 400 });
    }
    if (title.trim().length > 500) {
      throw Object.assign(new Error('title too long (max 500 characters)'), { statusCode: 400 });
    }

    // Validate assignTo against known agents
    const validAgents = [
      'orchestrator', 'strategist', 'architect', 'reviewer',
      'executor-triage', 'executor-responder', 'executor-ticket',
      'executor-coder', 'executor-redesign',
    ];
    const agent = validAgents.includes(assignTo) ? assignTo : 'orchestrator';

    const metadata = { source: 'board_command', assigned_agent: agent };

    // Jamie dispatch: create a Linear issue so the full audit trail flows through Linear
    if (jamie && agent === 'executor-coder') {
      try {
        const { createIssue, getOrCreateLabel } = await import('../linear/client.js');
        const labelId = await getOrCreateLabel('auto-fix');
        const linearIssue = await createIssue({
          title: title.trim(),
          description: `**Board command (Jamie dispatch)**\n\n${description || 'No description provided.'}\n\n_Created via Board Workstation._`,
          priority: Math.max(1, Math.min(4, parseInt(priority) || 3)),
          labelIds: [labelId],
        });
        metadata.linear_issue_id = linearIssue.id;
        metadata.linear_issue_url = linearIssue.url;
        metadata.linear_issue_identifier = linearIssue.identifier;
        console.log(`[governance] Jamie dispatch → Linear ${linearIssue.identifier}: ${linearIssue.url}`);
      } catch (err) {
        // Non-fatal: Linear issue creation failure shouldn't block task creation
        console.warn(`[governance] Linear issue creation failed (proceeding without): ${err.message}`);
      }
    }

    const item = await createWorkItem({
      type: 'task',
      title: title.trim(),
      description: description || null,
      createdBy: 'board',
      assignedTo: agent,
      priority: Math.max(1, Math.min(5, parseInt(priority) || 2)),
      metadata,
    });

    // Return Linear info in the work item for the dashboard to display
    const workItemResponse = {
      ...item,
      linear_issue_url: metadata.linear_issue_url || null,
      linear_issue_identifier: metadata.linear_issue_identifier || null,
    };

    await publishEvent(
      'board_directive',
      `Board command: ${title.trim()} → ${agent}${metadata.linear_issue_identifier ? ` (${metadata.linear_issue_identifier})` : ''}`,
      null,
      item.id,
      { source: 'board_command', assigned_agent: agent, linear_url: metadata.linear_issue_url || null },
    );

    return { ok: true, workItem: workItemResponse };
  });

  // POST /api/governance/decide — record a board verdict on a strategic decision
  routes.set('POST /api/governance/decide', async (_req, body) => {
    const { id, verdict, notes } = body || {};

    if (!id || typeof id !== 'string') {
      throw Object.assign(new Error('id is required and must be a string'), { statusCode: 400 });
    }

    const allowedVerdicts = ['approved', 'rejected', 'modified'];
    if (!allowedVerdicts.includes(verdict)) {
      throw Object.assign(new Error(`verdict must be one of: ${allowedVerdicts.join(', ')}`), { statusCode: 400 });
    }

    if (notes != null && typeof notes !== 'string') {
      throw Object.assign(new Error('notes must be a string'), { statusCode: 400 });
    }

    // Fetch the decision first to get agent recommendation for suggest_mode_log
    const decisionRow = await query(
      `SELECT id, recommendation FROM agent_graph.strategic_decisions
       WHERE id = $1 AND board_verdict IS NULL`,
      [id]
    );

    if (decisionRow.rows.length === 0) {
      throw Object.assign(new Error('Decision not found or already decided'), { statusCode: 404 });
    }

    const agentRecommendation = decisionRow.rows[0].recommendation;

    const result = await query(
      `UPDATE agent_graph.strategic_decisions
       SET board_verdict = $1, board_notes = $2, decided_by = 'board', decided_at = now()
       WHERE id = $3 AND board_verdict IS NULL`,
      [verdict, notes || null, id]
    );

    if (result.rowCount === 0) {
      throw Object.assign(new Error('Decision not found or already decided'), { statusCode: 404 });
    }

    // Log to suggest_mode_log for G4 measurement (Gap 1: SPEC §14)
    // Map board verdict to comparable terms for match detection:
    //   agent: proceed/defer/reject/escalate
    //   board: approved/rejected/modified
    // "approved" matches "proceed", "rejected" matches "reject", "modified" is a mismatch
    const verdictMatchMap = {
      approved: ['proceed'],
      rejected: ['reject', 'defer'],
      modified: [],  // modified never matches — board overrode the recommendation
    };
    const matched = (verdictMatchMap[verdict] || []).includes(agentRecommendation);
    const mismatchReason = matched ? null
      : `Agent recommended "${agentRecommendation}", board decided "${verdict}"${notes ? `: ${notes}` : ''}`;

    await query(
      `INSERT INTO agent_graph.suggest_mode_log
       (decision_id, agent_recommendation, board_decision, matched, mismatch_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, agentRecommendation, verdict, matched, mismatchReason]
    );

    await publishEvent(
      'config_changed',
      `Board verdict on strategic decision ${id}: ${verdict}`,
      null,
      id,
      { decision_id: id, verdict, notes: notes || null },
    );

    return { ok: true, matched };
  });

  // GET /api/governance/decision — fetch full details for a single strategic decision
  routes.set('GET /api/governance/decision', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (!id) {
      throw Object.assign(new Error('Missing ?id= query parameter'), { statusCode: 400 });
    }

    const result = await query(
      `SELECT id, proposed_action, rationale, decision_type, recommendation,
              confidence, perspective_scores, alternatives_rejected, kill_criteria,
              board_verdict, board_notes, decided_at, created_at
       FROM agent_graph.strategic_decisions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Decision not found'), { statusCode: 404 });
    }

    return result.rows[0];
  });

  // GET /api/governance/patterns — learned patterns summary for dashboard
  // Auth: same as other governance GET routes (unauthenticated at this layer, proxied via /api/ops)
  routes.set('GET /api/governance/patterns', async () => {
    const result = await cachedQuery('learned-patterns', async () => {
      const summary = await query(
        `SELECT pattern_type, COUNT(*) AS count,
                AVG(confidence) AS avg_confidence,
                MAX(created_at) AS last_extracted
         FROM agent_graph.learned_patterns
         GROUP BY pattern_type
         ORDER BY count DESC`
      );
      const topPatterns = await query(
        `SELECT agent_id, pattern_type, description, metric_value, confidence, sample_size, created_at
         FROM agent_graph.learned_patterns
         WHERE sample_size >= 5
         ORDER BY confidence DESC, sample_size DESC
         LIMIT 15`
      );
      const agentCoverage = await query(
        `SELECT agent_id, COUNT(DISTINCT pattern_type) AS pattern_types, SUM(sample_size) AS total_samples
         FROM agent_graph.learned_patterns
         WHERE sample_size >= 5
         GROUP BY agent_id
         ORDER BY pattern_types DESC`
      );
      return {
        summary: summary.rows,
        topPatterns: topPatterns.rows,
        agentCoverage: agentCoverage.rows,
      };
    }, 60_000);
    return result || { summary: [], topPatterns: [], agentCoverage: [] };
  });

  // GET /api/governance/capabilities — agent capability matrix (cached 60s)
  routes.set('GET /api/governance/capabilities', async () => {
    const result = await cachedQuery('agent-capabilities', async () => {
      const r = await query(`SELECT * FROM agent_graph.v_agent_capabilities`);
      return { agents: r.rows };
    }, 60_000);
    return result || { agents: [] };
  });

  // GET /api/governance/autonomy — autonomy levels, exit criteria, promotion history
  // Auth: same as other governance GET routes (see topology route comment)
  routes.set('GET /api/governance/autonomy', async () => {
    const result = await cachedQuery('autonomy-status', async () => {
      // Get current levels
      const levels = await query(`
        SELECT ac.id AS agent_id, ac.agent_type, ac.model, ac.is_active,
               COALESCE(al.current_level, 0) AS current_level,
               al.promoted_at, al.promoted_by
        FROM agent_graph.agent_configs ac
        LEFT JOIN agent_graph.autonomy_levels al ON al.agent_id = ac.id
        WHERE ac.is_active = true
        ORDER BY ac.id
      `);

      // Run evaluation
      const { evaluateAutonomy } = await import('../runtime/autonomy-evaluator.js');
      let evaluation = null;
      try {
        evaluation = await evaluateAutonomy();
      } catch (err) {
        console.warn('[governance] autonomy evaluation failed:', err.message);
      }

      // Get promotion history
      const history = await query(`
        SELECT agent_id, from_level, to_level, promoted_by, notes, criteria_snapshot, created_at
        FROM agent_graph.autonomy_promotions
        ORDER BY created_at DESC
        LIMIT 20
      `);

      return {
        agents: levels.rows,
        evaluation,
        history: history.rows,
      };
    }, 30_000);
    return result || { agents: [], evaluation: null, history: [] };
  });

  // POST /api/governance/autonomy/promote — advance an agent's autonomy level
  routes.set('POST /api/governance/autonomy/promote', async (_req, body) => {
    const { agentId, notes } = body || {};
    if (!agentId || typeof agentId !== 'string') {
      throw Object.assign(new Error('agentId is required'), { statusCode: 400 });
    }

    // Get current level
    const currentResult = await query(
      `SELECT current_level FROM agent_graph.autonomy_levels WHERE agent_id = $1`,
      [agentId]
    );
    const currentLevel = currentResult.rows[0]?.current_level ?? 0;
    const toLevel = currentLevel + 1;

    // P1: Only +1 increments, max L2
    if (toLevel > 2) {
      throw Object.assign(new Error('Agent is already at maximum autonomy level (L2)'), { statusCode: 400 });
    }

    // Run evaluation to capture criteria snapshot
    const { evaluateAutonomy } = await import('../runtime/autonomy-evaluator.js');
    let criteriaSnapshot = {};
    try {
      const evaluation = await evaluateAutonomy();
      criteriaSnapshot = evaluation.exitCriteria?.criteria || {};
    } catch {}

    // Update level
    await query(
      `INSERT INTO agent_graph.autonomy_levels (agent_id, current_level, promoted_at, promoted_by)
       VALUES ($1, $2, now(), 'board')
       ON CONFLICT (agent_id)
       DO UPDATE SET current_level = $2, promoted_at = now(), promoted_by = 'board', updated_at = now()`,
      [agentId, toLevel]
    );

    // Append-only promotion log (P3)
    await query(
      `INSERT INTO agent_graph.autonomy_promotions
       (agent_id, from_level, to_level, promoted_by, notes, criteria_snapshot)
       VALUES ($1, $2, $3, 'board', $4, $5)`,
      [agentId, currentLevel, toLevel, notes || null, JSON.stringify(criteriaSnapshot)]
    );

    // Public event
    await publishEvent(
      'config_changed',
      `Board promoted ${agentId}: L${currentLevel} → L${toLevel}`,
      null,
      null,
      { agent_id: agentId, from_level: currentLevel, to_level: toLevel, notes: notes || null },
    );

    return { ok: true, agentId, fromLevel: currentLevel, toLevel };
  });

  // GET /api/governance/signals-summary — cross-channel signal counts for graph visualizer
  routes.set('GET /api/governance/signals-summary', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      // OPT-166 P3-B6: principal-suffixed cache key — see governance-summary above.
      const principalKey = req.auth?.role === 'board' ? `board:${req.auth.sub}` : 'anon';
      const result = await cachedQuery(`signals-summary:${principalKey}`, async () => {
        let crossChannel = {};
        try {
          const ccResult = await scopedQuery(`SELECT * FROM signal.v_cross_channel_signals`);
          crossChannel = ccResult.rows[0] || {};
        } catch {
          // Views may not exist yet (pre-migration 007)
        }

        let intentsPending = 0;
        try {
          const intentsR = await scopedQuery(
            `SELECT COUNT(*) as count FROM agent_graph.agent_intents WHERE status = 'pending'`
          );
          intentsPending = parseInt(intentsR.rows[0]?.count || '0');
        } catch { /* table may not exist */ }

        let workItemsActive = 0;
        try {
          const wiR = await scopedQuery(
            `SELECT COUNT(*) as count FROM agent_graph.work_items
             WHERE status NOT IN ('completed', 'cancelled', 'failed')`
          );
          workItemsActive = parseInt(wiR.rows[0]?.count || '0');
        } catch { /* table may not exist */ }

        return {
          linear_signals_today: parseInt(crossChannel.linear_signals_today || '0'),
          github_signals_today: parseInt(crossChannel.github_signals_today || '0'),
          transcript_signals_today: parseInt(crossChannel.transcript_signals_today || '0'),
          signal_only_today: parseInt(crossChannel.signal_only_today || '0'),
          webhook_total_today: parseInt(crossChannel.webhook_total_today || '0'),
          intents_pending: intentsPending,
          work_items_active: workItemsActive,
        };
      }, 15_000);
      return result || {
        linear_signals_today: 0, github_signals_today: 0, transcript_signals_today: 0,
        signal_only_today: 0, webhook_total_today: 0, intents_pending: 0, work_items_active: 0,
      };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // GET /api/governance/topology — organizational topology for dashboard visualization
  // Auth: governance GET routes are unauthenticated at this layer.
  // Dashboard access goes through /api/ops proxy (adds Bearer token server-side).
  // Direct API access requires API_SECRET header. See ADR-019.
  routes.set('GET /api/governance/topology', async () => {
    const start = performance.now();
    const result = await cachedQuery('org-topology', async () => {
      try {
        const { getOrganizationalTopology } = await import('../graph/queries.js');
        const topology = await getOrganizationalTopology();
        if (topology && topology.length > 0) {
          // Transform Neo4j records -> { nodes, edges } with safe field extraction
          const nodes = topology.map(r => ({
            id: r.agent,
            tier: r.tier,
            model: r.model,
            recentTasks: typeof r.recent_tasks?.toNumber === 'function' ? r.recent_tasks.toNumber() : (r.recent_tasks || 0),
            recentSuccesses: typeof r.recent_successes?.toNumber === 'function' ? r.recent_successes.toNumber() : (r.recent_successes || 0),
            capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
          }));
          const edges = [];
          for (const r of topology) {
            const delegates = Array.isArray(r.delegates) ? r.delegates : [];
            for (const target of delegates) {
              if (target) {
                const sourceNode = nodes.find(n => n.id === r.agent);
                const successRate = sourceNode && sourceNode.recentTasks > 0
                  ? sourceNode.recentSuccesses / sourceNode.recentTasks
                  : null;
                edges.push({ source: r.agent, target, successRate });
              }
            }
          }
          const durationMs = Math.round(performance.now() - start);
          console.log(`[governance] topology: source=neo4j, nodes=${nodes.length}, edges=${edges.length}, duration=${durationMs}ms`);
          return { nodes, edges, source: 'neo4j' };
        }
      } catch (err) {
        console.warn('[governance] Neo4j topology unavailable, falling back to Postgres:', err.message);
      }

      // Fallback: Postgres-only from v_agent_capabilities
      // Narrow projection: strip tools_allowed and permissions before they leave the server (Linus blocker)
      const pgResult = await query(
        `SELECT agent_id, agent_type, model, is_active, active_tasks, completed_7d, failed_7d, can_delegate_to
         FROM agent_graph.v_agent_capabilities
         WHERE is_active = true`
      );
      const nodes = pgResult.rows.map(r => ({
        id: r.agent_id,
        tier: r.agent_type,
        model: r.model,
        recentTasks: (parseInt(r.completed_7d, 10) || 0) + (parseInt(r.failed_7d, 10) || 0),
        recentSuccesses: parseInt(r.completed_7d, 10) || 0,
        capabilities: [],
      }));
      const edges = [];
      for (const r of pgResult.rows) {
        const delegates = r.can_delegate_to || [];
        for (const target of delegates) {
          const total = (parseInt(r.completed_7d, 10) || 0) + (parseInt(r.failed_7d, 10) || 0);
          const successRate = total > 0 ? (parseInt(r.completed_7d, 10) || 0) / total : null;
          edges.push({ source: r.agent_id, target, successRate });
        }
      }
      const durationMs = Math.round(performance.now() - start);
      console.log(`[governance] topology: source=postgres, nodes=${nodes.length}, edges=${edges.length}, duration=${durationMs}ms`);
      return { nodes, edges, source: 'postgres' };
    }, 60_000);
    return result || { nodes: [], edges: [], source: 'unavailable' };
  });

  // POST /api/governance/submit — create a new governance submission
  routes.set('POST /api/governance/submit', async (req, body) => {
    const { title, contentType, sourceFormat, rawContent, sourceUrl, attachedFiles } = body || {};
    const submittedBy = req.headers?.['x-board-user'] || body.submittedBy || 'board';

    // Validation
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw Object.assign(new Error('title is required'), { statusCode: 400 });
    }
    if (title.trim().length > 500) {
      throw Object.assign(new Error('title too long (max 500 characters)'), { statusCode: 400 });
    }
    if (rawContent && typeof rawContent === 'string' && rawContent.length > 100_000) {
      throw Object.assign(new Error('rawContent too large (max 100,000 characters)'), { statusCode: 400 });
    }

    const validTypes = ['spec_amendment', 'agent_proposal', 'research', 'idea', 'adr', 'process_improvement', 'external_reference'];
    if (!validTypes.includes(contentType)) {
      throw Object.assign(new Error(`contentType must be one of: ${validTypes.join(', ')}`), { statusCode: 400 });
    }

    const validFormats = ['markdown', 'url', 'file_upload', 'paste', 'repo_reference'];
    const format = validFormats.includes(sourceFormat) ? sourceFormat : 'markdown';

    // Insert submission
    const result = await query(
      `INSERT INTO agent_graph.governance_submissions
       (title, content_type, source_format, raw_content, source_url, attached_files, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        title.trim(),
        contentType,
        format,
        rawContent || null,
        sourceUrl || null,
        JSON.stringify(attachedFiles || []),
        submittedBy || 'board',
      ]
    );

    const submission = result.rows[0];

    // Kick off intake classification asynchronously (don't block response)
    classifySubmission(submission.id).catch(err => {
      console.warn(`[governance] intake classification failed for ${submission.id}:`, err.message);
    });

    await publishEvent(
      'governance_submission',
      `New governance submission: ${title.trim()} (${contentType})`,
      null,
      submission.id,
      { content_type: contentType, submitted_by: submittedBy || 'board' },
    );

    // Fire-and-forget Neo4j logging for relationship intelligence
    import('../graph/governance-sync.js').then(m => {
      m.logSubmission(submission);
    }).catch(() => {});

    // Fire-and-forget Slack notification
    import('../governance/notify.js').then(m => m.notifySubmission(submission)).catch(() => {});

    return { ok: true, submission };
  });

  // GET /api/governance/submissions — list submissions with optional filters
  routes.set('GET /api/governance/submissions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    const contentType = url.searchParams.get('content_type');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));

    let sql = 'SELECT * FROM agent_graph.v_governance_inbox WHERE 1=1';
    const params = [];
    let paramIdx = 0;

    if (status) {
      paramIdx++;
      sql += ` AND status = $${paramIdx}`;
      params.push(status);
    }
    if (contentType) {
      paramIdx++;
      sql += ` AND content_type = $${paramIdx}`;
      params.push(contentType);
    }

    paramIdx++;
    sql += ` LIMIT $${paramIdx}`;
    params.push(limit);

    if (offset > 0) {
      paramIdx++;
      sql += ` OFFSET $${paramIdx}`;
      params.push(offset);
    }

    const result = await query(sql, params);
    return { submissions: result.rows };
  });

  // GET /api/governance/submission — get single submission by ID
  routes.set('GET /api/governance/submission', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      throw Object.assign(new Error('Missing ?id= query parameter'), { statusCode: 400 });
    }

    // Intentionally returns full row including raw_content — used by detail slide-over
    const result = await query(
      'SELECT * FROM agent_graph.governance_submissions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Submission not found'), { statusCode: 404 });
    }

    return result.rows[0];
  });

  // POST /api/governance/submissions/decide — accept/reject/defer a submission
  routes.set('POST /api/governance/submissions/decide', async (_req, body) => {
    const { id, decision, reason, createWorkItem: shouldCreateWorkItem } = body || {};

    if (!id || typeof id !== 'string') {
      throw Object.assign(new Error('id is required'), { statusCode: 400 });
    }

    const validDecisions = ['accepted', 'rejected', 'deferred', 'superseded'];
    if (!validDecisions.includes(decision)) {
      throw Object.assign(new Error(`decision must be one of: ${validDecisions.join(', ')}`), { statusCode: 400 });
    }

    if (decision === 'rejected' && (!reason || !reason.trim())) {
      throw Object.assign(new Error('reason is required when rejecting'), { statusCode: 400 });
    }

    // Verify submission exists and is in a decidable state
    const existing = await query(
      `SELECT id, status, title, content_type FROM agent_graph.governance_submissions
       WHERE id = $1 AND status IN ('awaiting_review', 'discussing')`,
      [id]
    );

    if (existing.rows.length === 0) {
      throw Object.assign(new Error('Submission not found or not in a decidable state'), { statusCode: 404 });
    }

    const submission = existing.rows[0];

    // Update status
    await query(
      `UPDATE agent_graph.governance_submissions
       SET status = $1, decision_by = 'board', decision_at = now(), decision_reason = $2
       WHERE id = $3`,
      [decision, reason || null, id]
    );

    let workItem = null;

    // On accept, optionally create a work item in the task graph
    if (decision === 'accepted' && shouldCreateWorkItem !== false) {
      workItem = await createWorkItem({
        type: 'task',
        title: submission.title,
        description: `Governance submission accepted: ${submission.content_type}`,
        createdBy: 'board',
        assignedTo: 'orchestrator',
        priority: 2,
        metadata: { source: 'governance_intake', submission_id: id },
      });

      await query(
        'UPDATE agent_graph.governance_submissions SET work_item_id = $1 WHERE id = $2',
        [workItem.id, id]
      );
    }

    await publishEvent(
      'governance_decision',
      `Governance decision: ${decision} on "${submission.title}"`,
      null,
      id,
      { decision, submission_id: id, work_item_id: workItem?.id || null },
    );

    // Fire-and-forget Neo4j logging for relationship intelligence
    import('../graph/governance-sync.js').then(m => {
      m.logDecision(id, decision, 'board', workItem?.id);
    }).catch(() => {});

    // Fire-and-forget Slack notification
    import('../governance/notify.js').then(m => m.notifyDecision(submission, decision, reason, workItem?.id)).catch(() => {});

    return { ok: true, decision, workItem };
  });

  // POST /api/governance/submissions/confirm-extractions — confirm extracted knowledge/action/spec cards
  // Liotta redesign: board confirms which extractions to act on (ingest, create work items, discuss)
  routes.set('POST /api/governance/submissions/confirm-extractions', async (req, body) => {
    const { id, confirmedIds, dismissedIds } = body || {};
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });
    if (!confirmedIds || !Array.isArray(confirmedIds)) {
      throw Object.assign(new Error('confirmedIds array required'), { statusCode: 400 });
    }

    const sub = await query('SELECT * FROM agent_graph.governance_submissions WHERE id = $1', [id]);
    if (sub.rows.length === 0) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });

    const submission = sub.rows[0];
    const auditResult = typeof submission.audit_result === 'string'
      ? JSON.parse(submission.audit_result) : submission.audit_result;
    const extractions = auditResult?.extractions || [];

    const confirmed = extractions.filter(e => confirmedIds.includes(e.id));
    const actedBy = req.headers?.['x-board-user'] || 'board';
    const results = { ingested: 0, workItems: 0, discussions: 0 };

    for (const ext of confirmed) {
      if (ext.type === 'knowledge') {
        // Ingest into RAG knowledge base
        const { ingestDocument } = await import('../rag/ingest.js');
        await ingestDocument({
          source: 'governance',
          sourceId: `${id}-${ext.id}`,
          title: `[Governance] ${ext.title}`,
          rawText: ext.content,
          format: 'plain',
          metadata: { submissionId: id, submissionTitle: submission.title, tags: ext.tags, confirmedBy: actedBy },
        });
        results.ingested++;
      } else if (ext.type === 'action') {
        // Create work item
        const { createWorkItem } = await import('../runtime/state-machine.js');
        await createWorkItem({
          type: 'task',
          title: ext.title,
          description: ext.content,
          createdBy: 'board',
          assignedTo: 'orchestrator',
          priority: 2,
          metadata: { source: 'governance_extraction', submission_id: id, tags: ext.tags },
        });
        results.workItems++;
      } else if (ext.type === 'spec') {
        // Add to discussion thread for spec implications
        await query(
          `UPDATE agent_graph.governance_submissions SET
            discussion_thread = COALESCE(discussion_thread, '[]'::jsonb) || $1::jsonb
          WHERE id = $2`,
          [JSON.stringify([{
            author: 'system',
            message: `Spec implication confirmed by ${actedBy}: ${ext.title}\n\n${ext.content}`,
            created_at: new Date().toISOString(),
            extraction_id: ext.id,
          }]), id]
        );
        results.discussions++;
      }
    }

    // Update submission status
    const allConfirmed = confirmedIds.length > 0;
    await query(
      `UPDATE agent_graph.governance_submissions SET
        status = $1,
        decision_by = $2,
        decision_at = now(),
        decision_reason = $3
      WHERE id = $4`,
      [
        allConfirmed ? 'accepted' : 'deferred',
        actedBy,
        `Confirmed ${confirmedIds.length} extractions (${results.ingested} ingested, ${results.workItems} work items, ${results.discussions} discussions)`,
        id,
      ]
    );

    return { ok: true, ...results, confirmed: confirmedIds.length, dismissed: (dismissedIds || []).length };
  });

  // POST /api/governance/submissions/discuss — add to discussion thread
  routes.set('POST /api/governance/submissions/discuss', async (_req, body) => {
    // NOTE: discussion_thread is a JSONB array — acceptable for <50 comments per submission.
    // At scale, normalize to a governance_comments table (each append rewrites the full column).
    const { id, message, author } = body || {};

    if (!id || typeof id !== 'string') {
      throw Object.assign(new Error('id is required'), { statusCode: 400 });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      throw Object.assign(new Error('message is required'), { statusCode: 400 });
    }

    const entry = {
      author: author || 'board',
      message: message.trim(),
      created_at: new Date().toISOString(),
    };

    // Append to discussion thread and set status to discussing if awaiting_review
    const result = await query(
      `UPDATE agent_graph.governance_submissions
       SET discussion_thread = COALESCE(discussion_thread, '[]'::jsonb) || $1::jsonb,
           status = CASE WHEN status = 'awaiting_review' THEN 'discussing' ELSE status END
       WHERE id = $2
       RETURNING id, status, discussion_thread`,
      [JSON.stringify(entry), id]
    );

    if (result.rowCount === 0) {
      throw Object.assign(new Error('Submission not found'), { statusCode: 404 });
    }

    // Notify channel + DM any @mentioned board members
    const titleRow = await query('SELECT title FROM agent_graph.governance_submissions WHERE id = $1', [id]);
    const subTitle = titleRow.rows[0]?.title || 'Untitled';
    import('../governance/notify.js').then(m => m.notifyDiscussion(subTitle, message.trim(), author || 'board')).catch(() => {});

    return { ok: true, submission: result.rows[0] };
  });

  // GET /api/governance/system-state — live system state for dashboard
  routes.set('GET /api/governance/system-state', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    // OPT-166 P3-B6 [codex-4b]: system-state returns scoped-query output. A global
    // cache key let a board request warm the bucket and a subsequent non-board
    // request read board-scoped rows without running its own RLS-filtered query.
    // Key per principal class — same fix as governance-summary / signals-summary.
    const principalKey = req.auth?.role === 'board' ? `board:${req.auth.sub}` : 'anon';
    try {
      const result = await cachedQuery(`system-state:${principalKey}`, async () => {
        // Active agents
        const agents = await scopedQuery(
          `SELECT id, agent_type, model, is_active,
                  array_length(tools_allowed, 1) AS tool_count
           FROM agent_graph.agent_configs
           WHERE is_active = true
           ORDER BY agent_type, id`
        );

        // Schema table counts
        const schemas = await scopedQuery(
          `SELECT schemaname AS schema, COUNT(*) AS table_count
           FROM pg_tables
           WHERE schemaname IN ('agent_graph', 'inbox', 'voice', 'signal', 'content')
           GROUP BY schemaname
           ORDER BY schemaname`
        );

        // Gate status
        let gates = [];
        try {
          const { getGateStatus } = await import('../runtime/capability-gates.js');
          const status = await getGateStatus();
          gates = Object.entries(status).map(([id, g]) => ({
            id,
            passing: g.passing,
            value: g.value,
            threshold: g.threshold,
          }));
        } catch { /* gates unavailable */ }

        // Budget status
        const budget = await scopedQuery(
          `SELECT scope, allocated_usd, spent_usd, period_start, period_end
           FROM agent_graph.budgets
           WHERE period_end >= CURRENT_DATE
           ORDER BY scope, period_start DESC
           LIMIT 5`
        );

        // Governance submission stats
        const govStats = await scopedQuery(
          `SELECT status, COUNT(*) AS count
           FROM agent_graph.governance_submissions
           GROUP BY status
           ORDER BY count DESC`
        );

        // Pipeline stats
        const pipeline = await scopedQuery(
          `SELECT status, COUNT(*) AS count
           FROM agent_graph.work_items
           WHERE created_at > now() - interval '7 days'
           GROUP BY status
           ORDER BY count DESC`
        );

        return {
          agents: agents.rows,
          schemas: schemas.rows,
          gates,
          budgets: budget.rows,
          governance: govStats.rows,
          pipeline: pipeline.rows,
          generated_at: new Date().toISOString(),
        };
      }, 30_000);
      return result || { agents: [], schemas: [], gates: [], budgets: [], governance: [], pipeline: [], generated_at: null };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // GET /api/governance/work-item — fetch linked work item details for a governance submission
  routes.set('GET /api/governance/work-item', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      throw Object.assign(new Error('Missing ?id= query parameter'), { statusCode: 400 });
    }

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await scopedQuery(
        `SELECT id, title, status, assigned_to, priority, type,
                created_at, updated_at
         FROM agent_graph.work_items WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        throw Object.assign(new Error('Work item not found'), { statusCode: 404 });
      }

      return result.rows[0];
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // POST /api/governance/classify-intent — lightweight intent classification via DeepSeek v3
  routes.set('POST /api/governance/classify-intent', async (_req, body) => {
    const { input } = body || {};
    if (!input || typeof input !== 'string' || !input.trim()) {
      throw Object.assign(new Error('input is required'), { statusCode: 400 });
    }

    const trimmed = input.trim().slice(0, 2000); // cap input size

    try {
      const { resolveLLM, callLLM } = await import('../llm/provider.js');
      const llm = resolveLLM('deepseek/deepseek-chat-v3-0324');

      const result = await callLLM(llm, {
        system: `You classify user input for a Board Workstation into exactly one intent.

Intents:
- "change": User wants to modify code, spec, or config files (update, fix, add, refactor, implement)
- "ask": User has a question or wants information/analysis
- "research": User wants to analyze a URL or research a topic in depth
- "intake": User wants to submit a governance proposal, spec amendment, or formal submission

Respond with ONLY a JSON object: {"intent":"change"|"ask"|"research"|"intake","confidence":0.0-1.0}`,
        messages: [{ role: 'user', content: trimmed }],
        maxTokens: 30,
        temperature: 0,
      });

      const parsed = parseJsonResponse(result.text);
      const validIntents = ['change', 'ask', 'research', 'intake'];
      const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'ask';

      console.log(`[governance] classify-intent: "${trimmed.slice(0, 60)}..." → ${intent} (${(parsed.confidence || 0).toFixed(2)}) $${(result.cost || 0).toFixed(5)}`);

      return { intent, confidence: parsed.confidence || 0.5 };
    } catch (err) {
      console.warn('[governance] classify-intent LLM failed:', err.message);
      return { intent: 'ask', confidence: 0 };
    }
  });
}

/** Exported for use by agent submission helper */
export function triggerClassification(submissionId) {
  return classifySubmission(submissionId);
}
