import { readFileSync } from 'fs';
import { query } from '../../lib/db.js';
import { isHalted } from '../../lib/runtime/event-bus.js';
import { fetchUrlContent } from '../executor-research/index.js';
import { requirePermission } from '../../lib/runtime/permissions.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'deep-research' });

const agentsConfig = JSON.parse(readFileSync(new URL('../../autobot-inbox/config/agents.json', import.meta.url), 'utf-8'));
const researchConfig = agentsConfig.agents['executor-research'].research;

/**
 * Strip markdown code fences from LLM response before JSON.parse.
 * Handles ```json ... ```, ``` ... ```, and leading/trailing whitespace.
 */
function stripFences(text) {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

const PLAN_SYSTEM_PROMPT = `You are a deep research agent. Given a research objective, current knowledge state, and coverage gaps, produce the next research iteration.

Respond with JSON only (no markdown fences):
{
  "hypothesis": "What you expect to find in this iteration",
  "queries": ["search query 1", "search query 2", "search query 3"]
}

Rules:
- Generate 3-5 diverse search queries that cover different angles of the gaps
- Each query should be specific and likely to surface actionable information
- Avoid repeating queries from prior iterations (provided in context)
- Focus on the least-covered focus areas first`;

const SYNTH_SYSTEM_PROMPT = `You are a deep research synthesizer. Given new search results and prior accumulated knowledge, produce a merged knowledge state.

Respond with JSON only (no markdown fences):
{
  "findings": [
    {
      "focus_area": "Which focus area this finding addresses",
      "claim": "A specific, factual claim supported by sources",
      "sources": ["url1", "url2"],
      "confidence": "high|medium|low"
    }
  ],
  "new_sources_count": 3,
  "new_claims_count": 5
}

Rules:
- Merge new findings with prior knowledge — don't duplicate existing claims
- Each claim must cite at least one source URL
- Focus on specific, actionable information — not vague observations
- If search results are empty or irrelevant, return new_sources_count: 0 and new_claims_count: 0`;

/**
 * Search the web using Brave Search API.
 * Returns array of { title, url, snippet }.
 */
async function webSearch(searchQuery) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    log.warn(' BRAVE_API_KEY not set, skipping search');
    return [];
  }

  // ADR-017: permission check for web_search
  await requirePermission('executor-research', 'api_client', 'web_search');

  try {
    const params = new URLSearchParams({ q: searchQuery, count: '5' });
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      log.warn(` Brave search failed (${res.status}): ${searchQuery}`);
      return [];
    }

    const data = await res.json();
    return (data.web?.results || []).slice(0, 5).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description || '',
    }));
  } catch (err) {
    log.warn(` Search error: ${err.message}`);
    return [];
  }
}

/**
 * Fan-out: run multiple searches in parallel, fetch top URLs from each.
 */
async function fanOutSearch(queries) {
  const maxConcurrent = researchConfig.maxConcurrentSearches || 5;
  const timeoutMs = researchConfig.urlFetchTimeoutMs || 15000;
  const maxChars = researchConfig.urlMaxChars || 50000;

  // Run all searches in parallel
  const searchResults = await Promise.all(
    queries.slice(0, maxConcurrent).map(q => webSearch(q))
  );

  // Collect unique URLs across all results
  const seen = new Set();
  const urlsToFetch = [];
  for (const results of searchResults) {
    for (const r of results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        urlsToFetch.push(r);
      }
    }
  }

  // ADR-017: permission check for web_fetch before fetching URLs
  await requirePermission('executor-research', 'api_client', 'web_fetch');

  // Fetch top URLs in parallel (limit to 10 to avoid overload)
  const fetchTargets = urlsToFetch.slice(0, 10);
  const fetchResults = await Promise.all(
    fetchTargets.map(async (r) => {
      const content = await fetchUrlContent(r.url, timeoutMs, maxChars);
      return { ...r, content: content || r.snippet };
    })
  );

  return { searchResults: urlsToFetch, fetchedContent: fetchResults };
}

/**
 * Compute coverage: ratio of focus areas that have at least one finding.
 * Uses word overlap for fuzzy matching — if >=50% of a focus area's
 * significant words appear in a finding's focus_area, it counts as covered.
 */
function computeCoverage(focusAreas, allFindings) {
  if (!focusAreas.length) return 1;
  const stopWords = new Set(['for', 'the', 'and', 'of', 'in', 'to', 'a', 'an', 'on', 'at', 'by', 'with', 'from']);
  const tokenize = (s) => (s || '').toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));

  const covered = new Set();
  for (const f of allFindings) {
    const findingWords = new Set(tokenize(f.focus_area));
    for (const area of focusAreas) {
      if (covered.has(area)) continue;
      // Substring match (original)
      const aLower = area.toLowerCase();
      const fLower = (f.focus_area || '').toLowerCase();
      if (fLower.includes(aLower) || aLower.includes(fLower)) {
        covered.add(area);
        continue;
      }
      // Word overlap: >=50% of focus area words appear in finding
      const areaWords = tokenize(area);
      if (areaWords.length === 0) continue;
      const overlap = areaWords.filter(w => findingWords.has(w)).length;
      if (overlap / areaWords.length >= 0.5) {
        covered.add(area);
      }
    }
  }
  return covered.size / focusAreas.length;
}

/**
 * Compute delta: count of new sources + claims vs prior iteration.
 */
function computeDelta(newSourcesCount, newClaimsCount) {
  return newSourcesCount + newClaimsCount;
}

const CONFIDENCE_TO_NUMERIC = { high: 0.9, medium: 0.6, low: 0.3 };

/**
 * Map a text confidence label to a numeric value. Defaults to 0.5 for unknown.
 */
function confidenceToNumeric(c) {
  if (typeof c === 'number') return Math.max(0, Math.min(1, c));
  return CONFIDENCE_TO_NUMERIC[String(c || '').toLowerCase()] ?? 0.5;
}

/**
 * Compute the executive summary fields stored on research_outputs:
 * - key_finding: 1-sentence claim from the highest-confidence finding (ties → first)
 * - confidence: mean of all finding confidences (numeric)
 *
 * The briefing reads key_finding directly; longer body_md is fetched on demand.
 */
function summarizeFindings(allFindings) {
  if (!allFindings.length) {
    return { keyFinding: null, confidence: 0 };
  }
  const numerics = allFindings.map(f => ({ f, n: confidenceToNumeric(f.confidence) }));
  const top = numerics.reduce((best, cur) => (cur.n > best.n ? cur : best), numerics[0]);
  const meanConfidence = numerics.reduce((sum, x) => sum + x.n, 0) / numerics.length;
  return {
    keyFinding: top.f.claim || null,
    confidence: Number(meanConfidence.toFixed(2)),
  };
}

/**
 * Build a markdown research report from accumulated findings.
 */
function buildReport(plan, keptCount, allFindings) {
  const sections = [`# Deep Research Report: ${plan.objective}\n`];

  // Group findings by focus area
  const byArea = {};
  for (const f of allFindings) {
    const area = f.focus_area || 'General';
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(f);
  }

  for (const [area, findings] of Object.entries(byArea)) {
    sections.push(`## ${area}\n`);
    for (const f of findings) {
      const confidence = f.confidence ? ` (${f.confidence})` : '';
      sections.push(`- ${f.claim}${confidence}`);
      if (f.sources?.length) {
        sections.push(`  Sources: ${f.sources.join(', ')}`);
      }
    }
    sections.push('');
  }

  // Summary stats
  const totalSources = new Set(allFindings.flatMap(f => f.sources || [])).size;
  sections.push(`---`);
  sections.push(`**Iterations:** ${keptCount} kept`);
  sections.push(`**Unique sources:** ${totalSources}`);
  sections.push(`**Total findings:** ${allFindings.length}`);

  return sections.join('\n');
}

/**
 * Deep research handler — Karpathy-style iterative research loop.
 *
 * Flow per iteration:
 *   1. Check halt + budget
 *   2. LLM plans hypothesis + queries
 *   3. Fan-out web search (parallel)
 *   4. LLM synthesizes findings
 *   5. Score coverage + delta
 *   6. Keep/discard decision
 *   7. Checkpoint
 */
export async function deepResearchHandler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const plan = metadata.research_plan;

  if (!plan?.objective) {
    return { success: false, reason: 'No research_plan.objective in metadata', costUsd: 0 };
  }

  const focusAreas = plan.focus_areas || [plan.objective];
  const maxIterations = plan.constraints?.max_iterations || researchConfig.maxIterationsPerSession;
  const maxCostUsd = plan.constraints?.max_cost_usd || researchConfig.maxCostPerResearchUsd;
  const taskId = task.work_item_id;
  const checkpointStart = metadata.checkpoint_iteration || 0;

  // Load prior kept iterations
  const priorResult = await query(
    `SELECT iteration_num, hypothesis, queries, findings, coverage_score, cost_usd
     FROM agent_graph.research_iterations
     WHERE workstream_id = $1 AND decision = 'kept'
     ORDER BY iteration_num`,
    [taskId]
  );
  const keptIterations = priorResult.rows;

  // Reconstruct cumulative knowledge from kept iterations
  let allFindings = keptIterations.flatMap(r => r.findings || []);
  let allQueries = keptIterations.flatMap(r => r.queries || []);
  let totalCost = keptIterations.reduce((sum, r) => sum + parseFloat(r.cost_usd || 0), 0);
  let lastCoverage = keptIterations.length > 0
    ? parseFloat(keptIterations[keptIterations.length - 1].coverage_score)
    : 0;

  let iterationsRun = 0;
  let keptThisRun = 0;
  let stopReason = 'max_iterations';

  for (let n = checkpointStart; n < maxIterations; n++) {
    const iterStart = Date.now();

    // 1. Check halt (fail-closed)
    if (await isHalted()) {
      stopReason = 'halted';
      // Save checkpoint before stopping
      await query(
        `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
        [JSON.stringify({ checkpoint_iteration: n }), taskId]
      );
      break;
    }

    // 2. Check budget
    const remainingBudget = maxCostUsd - totalCost;
    if (remainingBudget <= 0.01) {
      stopReason = 'budget_exhausted';
      await query(
        `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
        [JSON.stringify({ checkpoint_iteration: n }), taskId]
      );
      break;
    }

    let iterCost = 0;
    let iterError = null;

    try {
      // 3. PLAN: generate hypothesis + queries
      const knowledgeSummary = allFindings.length > 0
        ? allFindings.map(f => `[${f.focus_area}] ${f.claim}`).join('\n')
        : 'No findings yet.';

      const planResponse = await agent.callLLM(
        PLAN_SYSTEM_PROMPT,
        `<objective>${plan.objective}</objective>
<focus_areas>${JSON.stringify(focusAreas)}</focus_areas>
<prior_queries>${JSON.stringify(allQueries.slice(-20))}</prior_queries>
<current_knowledge>
${knowledgeSummary}
</current_knowledge>
<coverage>${lastCoverage.toFixed(2)} (${Math.round(lastCoverage * 100)}% of focus areas covered)</coverage>`,
        {
          taskId,
          idempotencyKey: `${taskId}-iter${n}-plan`,
          maxTokens: 1024,
          temperature: 0.5,
        }
      );
      iterCost += planResponse.costUsd;

      let planData;
      try {
        planData = JSON.parse(stripFences(planResponse.text));
      } catch {
        planData = { hypothesis: planResponse.text, queries: [plan.objective] };
      }

      const hypothesis = planData.hypothesis || 'Exploring gaps in coverage';
      const queries = planData.queries || [plan.objective];

      // 4. FAN-OUT EXECUTE: parallel web searches + URL fetches
      const { searchResults, fetchedContent } = await fanOutSearch(queries);

      const fetchedText = fetchedContent
        .map(r => `<source url="${r.url}" title="${r.title}">\n${(r.content || '').slice(0, 8000)}\n</source>`)
        .join('\n\n');

      // 5. SYNTHESIZE: merge new content with prior knowledge
      const synthResponse = await agent.callLLM(
        SYNTH_SYSTEM_PROMPT,
        `<hypothesis>${hypothesis}</hypothesis>
<search_results>
${fetchedText || 'No results found.'}
</search_results>
<prior_findings>
${knowledgeSummary}
</prior_findings>`,
        {
          taskId,
          idempotencyKey: `${taskId}-iter${n}-synth`,
          maxTokens: 4096,
          temperature: 0.2,
        }
      );
      iterCost += synthResponse.costUsd;

      let synthData;
      try {
        synthData = JSON.parse(stripFences(synthResponse.text));
      } catch {
        synthData = { findings: [], new_sources_count: 0, new_claims_count: 0 };
      }

      const newFindings = synthData.findings || [];

      // 6. SCORE
      const candidateFindings = [...allFindings, ...newFindings];
      const coverage = computeCoverage(focusAreas, candidateFindings);

      // Derive delta from observable findings rather than LLM self-report.
      // The synth model can hallucinate new_sources_count/new_claims_count
      // even when findings is empty; gating on observed state prevents
      // keeping no-op iterations.
      const priorSourceSet = new Set(allFindings.flatMap(f => f.sources || []));
      const candidateSourceSet = new Set(candidateFindings.flatMap(f => f.sources || []));
      const realNewSources = candidateSourceSet.size - priorSourceSet.size;
      const delta = computeDelta(Math.max(0, realNewSources), newFindings.length);

      // 7. DECIDE
      let decision;
      if (delta > 0 && coverage >= lastCoverage) {
        decision = 'kept';
        allFindings = candidateFindings;
        allQueries = [...allQueries, ...queries];
        lastCoverage = coverage;
        keptThisRun++;
      } else {
        decision = 'discarded';
        // Still track queries to avoid repeating them
        allQueries = [...allQueries, ...queries];
      }

      const durationMs = Date.now() - iterStart;

      // 8. LOG iteration
      await query(
        `INSERT INTO agent_graph.research_iterations
         (workstream_id, iteration_num, hypothesis, queries, sources, findings,
          coverage_score, delta_score, decision, cost_usd, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          taskId, n, hypothesis,
          JSON.stringify(queries),
          JSON.stringify(searchResults.map(r => ({ url: r.url, title: r.title }))),
          JSON.stringify(newFindings),
          coverage, delta, decision, iterCost, durationMs,
        ]
      );

      totalCost += iterCost;
      iterationsRun++;

      log.info(
        `iter ${n}: ${decision} | coverage=${coverage.toFixed(2)} delta=${delta} cost=$${iterCost.toFixed(4)}`
      );

      // 9. CHECKPOINT
      await query(
        `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
        [JSON.stringify({ checkpoint_iteration: n + 1 }), taskId]
      );

      // Early stop on high coverage
      if (coverage >= 0.85) {
        stopReason = 'coverage_threshold';
        break;
      }
    } catch (err) {
      iterError = err.message;
      log.error(` iter ${n} error: ${iterError}`);

      // Classify error: transient errors checkpoint at n (retry on resume),
      // permanent errors checkpoint at n+1 (skip the slot).
      const msg = iterError || '';
      const isTransient = err.name === 'AbortError'
        || msg.includes('429')
        || msg.includes('529')
        || msg.includes('ECONNRESET')
        || msg.includes('ETIMEDOUT')
        || msg.includes('fetch failed');

      // Log failed iteration. ON CONFLICT updates instead of dropping so
      // a retried iteration's second failure isn't silently lost — error
      // text reflects latest attempt, cost accumulates across attempts.
      await query(
        `INSERT INTO agent_graph.research_iterations
         (workstream_id, iteration_num, hypothesis, queries, sources, findings,
          coverage_score, delta_score, decision, cost_usd, duration_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (workstream_id, iteration_num) DO UPDATE SET
           error = EXCLUDED.error,
           cost_usd = agent_graph.research_iterations.cost_usd + EXCLUDED.cost_usd,
           duration_ms = EXCLUDED.duration_ms`,
        [
          taskId, n, 'Error during iteration',
          '[]', '[]', '[]', 0, 0, 'discarded', iterCost,
          Date.now() - iterStart, iterError,
        ]
      );

      totalCost += iterCost;

      const nextCheckpoint = isTransient ? n : n + 1;
      await query(
        `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
        [JSON.stringify({ checkpoint_iteration: nextCheckpoint }), taskId]
      );
      stopReason = 'error';
      break;
    }
  }

  // Persist the final report as a canonical research_outputs row.
  // The daily briefing reads recent rows directly from this table; future
  // consumers (board UI, RAG, wiki) read by id without coupling to the
  // briefing's query shape. Per-iteration trace remains in research_iterations.
  if (allFindings.length > 0) {
    const totalKept = keptIterations.length + keptThisRun;
    const report = buildReport(plan, totalKept, allFindings);
    const { keyFinding, confidence } = summarizeFindings(allFindings);
    const sourceCount = new Set(allFindings.flatMap(f => f.sources || [])).size;

    await query(
      `INSERT INTO agent_graph.research_outputs
       (workstream_id, objective, focus_areas, body_md, key_finding,
        confidence, coverage_score, source_count, iteration_count, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        taskId, plan.objective, focusAreas, report, keyFinding,
        confidence, lastCoverage, sourceCount, totalKept, totalCost,
      ]
    );
  }

  const reason = `Deep research complete: ${iterationsRun} iterations, ${allFindings.length} findings, ` +
    `coverage=${lastCoverage.toFixed(2)}, cost=$${totalCost.toFixed(4)}, stop=${stopReason}`;

  return { success: true, reason, costUsd: totalCost };
}
