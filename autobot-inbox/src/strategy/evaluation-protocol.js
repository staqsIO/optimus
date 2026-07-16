import { createHash } from 'crypto';
import { query } from '../db.js';
import { createLLMClient, callProvider, computeCost as sharedComputeCost } from '../llm/provider.js';
import { gatherSignals } from './signal-gatherer.js';
import { getConfig } from '../../../lib/config/loader.js';

/**
 * Three-Perspective Strategy Evaluation Protocol (spec S19).
 *
 * Phase 2: Shadow mode — evaluations are logged but do NOT block or override
 * board decisions. Shadow comparisons feed G4 capability gate measurement.
 *
 * Tiers:
 *   - Tactical (~90%): Single-pass structured evaluation
 *   - Strategic (~9%): Three-perspective (Opportunity, Risk, Capability) + compliance gate
 *   - Existential (~1%): Three-perspective + 2-round adversarial debate + escalation
 *
 * Uses Claude Sonnet for perspective evaluations (cost-effective for shadow mode).
 */

const agentsConfig = getConfig('agents');
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.3;

let _llm = null;
function getLLM() {
  if (!_llm) _llm = createLLMClient(MODEL, agentsConfig.models);
  return _llm;
}

// ============================================================
// Hard thresholds (spec S19)
// ============================================================

const FAILURE_PROBABILITY_THRESHOLD = 0.3;
const IMPACT_HIGH_KEYWORDS = ['high', 'critical', 'severe', 'catastrophic'];

// ============================================================
// Public API
// ============================================================

/**
 * Classify which evaluation tier a work item requires.
 *
 * @param {object} workItem - Work item row from agent_graph.work_items
 * @returns {'tactical'|'strategic'|'existential'}
 */
export function classifyDecisionTier(workItem) {
  if (!workItem) return 'tactical';

  // Existential: directive-level items with high budget or explicit escalation
  if (workItem.type === 'directive') {
    const budgetUsd = parseFloat(workItem.budget_usd || 0);
    if (budgetUsd > 100) return 'existential';
    return 'strategic';
  }

  // Strategic: workstream-level or high-priority items
  if (workItem.type === 'workstream' || workItem.priority >= 8) {
    return 'strategic';
  }

  // Tactical: tasks, subtasks, and routine items
  return 'tactical';
}

/**
 * Run a tactical (single-pass) evaluation.
 *
 * @param {string} proposedAction - The action being evaluated
 * @param {object} context - Evaluation context (signals, metadata)
 * @returns {Promise<object>} Evaluation result with scores
 */
export async function evaluateTactical(proposedAction, context) {
  const decisionId = context.decisionId;

  // Create evaluation record
  const evalId = await createEvaluationRecord(decisionId, 'tactical');
  await updateEvaluationStatus(evalId, 'evaluating');

  const systemPrompt = `You are a tactical decision evaluator for an AI agent organization.
Evaluate the proposed action with a single-pass structured analysis.
Be concise and precise. Score each dimension 1-5 (1=very low, 5=very high).`;

  const userMessage = `Evaluate this proposed action:

ACTION: ${proposedAction}

CONTEXT:
${formatContext(context)}

Respond with JSON only:
{
  "recommendation": "proceed" | "defer" | "reject" | "escalate",
  "confidence": <1-5>,
  "scores": {
    "opportunity": <1-5>,
    "risk": <1-5>,
    "feasibility": <1-5>
  },
  "rationale": "<brief justification>",
  "kill_criteria": ["<condition that should halt this action>"]
}`;

  const response = await callLLM(systemPrompt, userMessage, evalId);
  const parsed = parseJSON(response.text);

  if (!parsed) {
    await updateEvaluationStatus(evalId, 'completed');
    return {
      evaluationId: evalId,
      tier: 'tactical',
      recommendation: 'defer',
      confidence: 1,
      scores: { opportunity: 0, risk: 0, feasibility: 0 },
      rationale: 'Failed to parse evaluation response',
      costUsd: response.costUsd,
    };
  }

  // Store as a single perspective (tactical uses one pass)
  await storePerspective(evalId, 'opportunity', {
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    scores: parsed.scores || {},
    rationale: parsed.rationale,
    killCriteria: parsed.kill_criteria || [],
  });

  await updateEvaluationStatus(evalId, 'completed');

  return {
    evaluationId: evalId,
    tier: 'tactical',
    recommendation: parsed.recommendation || 'defer',
    confidence: parsed.confidence || 1,
    scores: parsed.scores || {},
    rationale: parsed.rationale || '',
    killCriteria: parsed.kill_criteria || [],
    costUsd: response.costUsd,
  };
}

/**
 * Run a strategic (three-perspective) evaluation.
 * Each perspective commits its recommendation before seeing the others.
 *
 * @param {string} proposedAction - The action being evaluated
 * @param {object} context - Evaluation context (signals, metadata)
 * @returns {Promise<object>} Synthesized evaluation result
 */
export async function evaluateStrategic(proposedAction, context) {
  const decisionId = context.decisionId;

  // Create evaluation record
  const evalId = await createEvaluationRecord(decisionId, 'strategic');

  // Phase 1: Gather signals
  await updateEvaluationStatus(evalId, 'gathering_signals');
  const workItemId = context.workItemId || context.signals?.workItem?.id;
  let signals = context.signals;
  if (!signals && workItemId) {
    signals = await gatherSignals(workItemId);
  }

  const enrichedContext = { ...context, signals };

  // Phase 2: Three perspectives in parallel (each commits before seeing others)
  await updateEvaluationStatus(evalId, 'evaluating');

  const [opportunity, risk, capability] = await Promise.all([
    evaluateOpportunityPerspective(proposedAction, enrichedContext, evalId),
    evaluateRiskPerspective(proposedAction, enrichedContext, evalId),
    evaluateCapabilityPerspective(proposedAction, enrichedContext, evalId),
  ]);

  // Phase 3: Synthesis
  await updateEvaluationStatus(evalId, 'synthesizing');
  const synthesis = synthesizeRecommendation(opportunity, risk, capability);

  // Compliance gate: check hard thresholds
  const complianceResult = checkComplianceGate(risk, synthesis);
  if (complianceResult.blocked) {
    synthesis.recommendation = complianceResult.overrideRecommendation;
    synthesis.complianceBlock = complianceResult.reason;
  }

  await updateEvaluationStatus(evalId, 'completed');

  const totalCost = (opportunity.costUsd || 0) +
    (risk.costUsd || 0) +
    (capability.costUsd || 0);

  return {
    evaluationId: evalId,
    tier: 'strategic',
    recommendation: synthesis.recommendation,
    confidence: synthesis.confidence,
    perspectives: {
      opportunity: { recommendation: opportunity.recommendation, confidence: opportunity.confidence, scores: opportunity.scores },
      risk: { recommendation: risk.recommendation, confidence: risk.confidence, scores: risk.scores },
      capability: { recommendation: capability.recommendation, confidence: capability.confidence, scores: capability.scores },
    },
    synthesis,
    complianceBlock: synthesis.complianceBlock || null,
    killCriteria: [
      ...(opportunity.killCriteria || []),
      ...(risk.killCriteria || []),
      ...(capability.killCriteria || []),
    ],
    costUsd: totalCost,
  };
}

/**
 * Run an existential evaluation: three-perspective + 2-round adversarial debate.
 *
 * @param {string} proposedAction - The action being evaluated
 * @param {object} context - Evaluation context
 * @returns {Promise<object>} Full evaluation with debate record
 */
export async function evaluateExistential(proposedAction, context) {
  // Start with strategic evaluation
  const strategicResult = await evaluateStrategic(proposedAction, context);
  const evalId = strategicResult.evaluationId;

  // Update tier in the record to existential
  await query(
    `UPDATE agent_graph.strategy_evaluations
     SET evaluation_tier = 'existential', status = 'evaluating', completed_at = NULL
     WHERE id = $1`,
    [evalId]
  );

  // Adversarial debate: 2 rounds
  const debateRounds = [];
  let totalDebateCost = 0;

  for (let round = 1; round <= 2; round++) {
    const debateResult = await runAdversarialRound(
      proposedAction,
      context,
      strategicResult,
      debateRounds,
      round,
      evalId
    );
    debateRounds.push(debateResult);
    totalDebateCost += debateResult.costUsd || 0;
  }

  // Final synthesis incorporating debate
  const finalRecommendation = synthesizeWithDebate(strategicResult, debateRounds);

  // Existential decisions always escalate to human board
  if (finalRecommendation.recommendation !== 'reject') {
    finalRecommendation.recommendation = 'escalate';
    finalRecommendation.escalationReason = 'Existential-tier decision requires human board review';
  }

  await updateEvaluationStatus(evalId, 'escalated');

  return {
    evaluationId: evalId,
    tier: 'existential',
    recommendation: finalRecommendation.recommendation,
    confidence: finalRecommendation.confidence,
    perspectives: strategicResult.perspectives,
    synthesis: strategicResult.synthesis,
    debate: debateRounds,
    escalationReason: finalRecommendation.escalationReason || null,
    complianceBlock: strategicResult.complianceBlock || null,
    killCriteria: strategicResult.killCriteria,
    costUsd: strategicResult.costUsd + totalDebateCost,
  };
}

/**
 * Record a shadow comparison between protocol recommendation and board decision.
 * This is the core measurement for G4 graduated autonomy.
 *
 * @param {string} evaluationId - The strategy evaluation ID
 * @param {string} boardDecision - The board's actual decision ('approved'|'rejected'|'modified')
 * @returns {Promise<object>} The shadow comparison record
 */
export async function recordShadowComparison(evaluationId, boardDecision) {
  // Get the protocol's recommendation
  const evalResult = await query(
    `SELECT se.id, se.evaluation_tier,
            pe.recommendation AS protocol_recommendation
     FROM agent_graph.strategy_evaluations se
     LEFT JOIN agent_graph.perspective_evaluations pe ON pe.evaluation_id = se.id
     WHERE se.id = $1
     ORDER BY pe.created_at DESC
     LIMIT 1`,
    [evaluationId]
  );

  if (evalResult.rows.length === 0) {
    console.warn(`[evaluation-protocol] No evaluation found for ID: ${evaluationId}`);
    return null;
  }

  const eval_ = evalResult.rows[0];

  // For strategic/existential, get the synthesized recommendation from the latest perspective
  // (the synthesis recommendation is stored as the last perspective update or can be inferred)
  const protocolRec = eval_.protocol_recommendation || 'unknown';

  // Map board decision to comparable format
  const boardRecMapped = boardDecision === 'approved' ? 'proceed'
    : boardDecision === 'rejected' ? 'reject'
    : 'defer'; // 'modified' maps to defer

  const isMatch = protocolRec === boardRecMapped;
  const divergenceReason = isMatch ? null
    : `Protocol recommended '${protocolRec}', board decided '${boardDecision}' (mapped to '${boardRecMapped}')`;

  const result = await query(
    `INSERT INTO agent_graph.shadow_strategy_comparisons
     (evaluation_id, protocol_recommendation, board_decision, is_match, divergence_reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [evaluationId, protocolRec, boardDecision, isMatch, divergenceReason]
  );

  const comparison = result.rows[0];

  console.log(
    `[evaluation-protocol] Shadow comparison: protocol=${protocolRec}, board=${boardDecision}, match=${isMatch}`
  );

  return comparison;
}

// ============================================================
// Perspective Evaluators (private)
// ============================================================

async function evaluateOpportunityPerspective(proposedAction, context, evalId) {
  const systemPrompt = `You are the Opportunity Assessor in a three-perspective strategy evaluation protocol.
Your role: Identify and quantify the upside potential of the proposed action.
Focus on value creation, competitive advantage, and strategic alignment.
Be rigorous and evidence-based. Do not see risk — that is another assessor's job.
Score each dimension 1-5.`;

  const userMessage = `Evaluate the OPPORTUNITY of this proposed action:

ACTION: ${proposedAction}

CONTEXT:
${formatContext(context)}

IMPORTANT: Commit your evaluation independently. You will NOT see the other assessors' evaluations.

Respond with JSON only:
{
  "recommendation": "proceed" | "defer" | "reject" | "escalate",
  "confidence": <1-5>,
  "scores": {
    "value_creation": <1-5>,
    "strategic_alignment": <1-5>,
    "timing_advantage": <1-5>,
    "resource_efficiency": <1-5>
  },
  "rationale": "<why this opportunity assessment>",
  "kill_criteria": ["<what would invalidate the opportunity>"],
  "counter_evidence_required": <true if more data needed>
}`;

  const response = await callLLM(systemPrompt, userMessage, evalId);
  const parsed = parseJSON(response.text);

  const result = {
    perspective: 'opportunity',
    recommendation: parsed?.recommendation || 'defer',
    confidence: parsed?.confidence || 1,
    scores: parsed?.scores || {},
    rationale: parsed?.rationale || 'Failed to evaluate opportunity',
    killCriteria: parsed?.kill_criteria || [],
    counterEvidenceRequired: parsed?.counter_evidence_required || false,
    costUsd: response.costUsd,
  };

  await storePerspective(evalId, 'opportunity', result);
  return result;
}

async function evaluateRiskPerspective(proposedAction, context, evalId) {
  const systemPrompt = `You are the Risk Assessor in a three-perspective strategy evaluation protocol.
Your role: Identify and quantify all downside risks of the proposed action.
Focus on failure modes, financial exposure, reputational risk, and compliance.
Be thorough and adversarial. Assume the worst plausible scenarios.
Score each dimension 1-5 (5 = highest risk).`;

  const userMessage = `Evaluate the RISK of this proposed action:

ACTION: ${proposedAction}

CONTEXT:
${formatContext(context)}

IMPORTANT: Commit your evaluation independently. You will NOT see the other assessors' evaluations.

Respond with JSON only:
{
  "recommendation": "proceed" | "defer" | "reject" | "escalate",
  "confidence": <1-5>,
  "scores": {
    "failure_probability": <0.0-1.0>,
    "financial_exposure": <1-5>,
    "reputational_risk": <1-5>,
    "compliance_risk": <1-5>,
    "reversibility": <1-5>,
    "impact_level": "low" | "medium" | "high" | "critical"
  },
  "rationale": "<why this risk assessment>",
  "kill_criteria": ["<conditions that should halt the action>"],
  "compliance_violations": ["<any gate violations detected>"],
  "counter_evidence_required": <true if more data needed>
}`;

  const response = await callLLM(systemPrompt, userMessage, evalId);
  const parsed = parseJSON(response.text);

  const result = {
    perspective: 'risk',
    recommendation: parsed?.recommendation || 'defer',
    confidence: parsed?.confidence || 1,
    scores: parsed?.scores || {},
    rationale: parsed?.rationale || 'Failed to evaluate risk',
    killCriteria: parsed?.kill_criteria || [],
    complianceViolations: parsed?.compliance_violations || [],
    counterEvidenceRequired: parsed?.counter_evidence_required || false,
    costUsd: response.costUsd,
  };

  await storePerspective(evalId, 'risk', result);
  return result;
}

async function evaluateCapabilityPerspective(proposedAction, context, evalId) {
  const systemPrompt = `You are the Capability Assessor in a three-perspective strategy evaluation protocol.
Your role: Evaluate whether the organization has the resources, skills, and infrastructure to execute.
Focus on current capacity, technical feasibility, and execution track record.
Be realistic about constraints. Score each dimension 1-5.`;

  const userMessage = `Evaluate the CAPABILITY to execute this proposed action:

ACTION: ${proposedAction}

CONTEXT:
${formatContext(context)}

CAPABILITY SIGNALS:
${formatCapabilitySignals(context.signals?.capability)}

FINANCIAL SIGNALS:
${formatFinancialSignals(context.signals?.financial)}

IMPORTANT: Commit your evaluation independently. You will NOT see the other assessors' evaluations.

Respond with JSON only:
{
  "recommendation": "proceed" | "defer" | "reject" | "escalate",
  "confidence": <1-5>,
  "scores": {
    "technical_feasibility": <1-5>,
    "resource_availability": <1-5>,
    "track_record": <1-5>,
    "infrastructure_readiness": <1-5>
  },
  "rationale": "<why this capability assessment>",
  "kill_criteria": ["<capability gaps that would block execution>"],
  "counter_evidence_required": <true if more data needed>
}`;

  const response = await callLLM(systemPrompt, userMessage, evalId);
  const parsed = parseJSON(response.text);

  const result = {
    perspective: 'capability',
    recommendation: parsed?.recommendation || 'defer',
    confidence: parsed?.confidence || 1,
    scores: parsed?.scores || {},
    rationale: parsed?.rationale || 'Failed to evaluate capability',
    killCriteria: parsed?.kill_criteria || [],
    counterEvidenceRequired: parsed?.counter_evidence_required || false,
    costUsd: response.costUsd,
  };

  await storePerspective(evalId, 'capability', result);
  return result;
}

// ============================================================
// Synthesis (private)
// ============================================================

/**
 * Synthesize three perspective evaluations into a single recommendation.
 * Hard thresholds from spec S19:
 *   - P(failure) > 0.3 AND impact HIGH -> auto-block
 *   - Compliance violation -> hard stop
 *   - All 3 REJECT -> rejected
 */
function synthesizeRecommendation(opportunity, risk, capability) {
  const recommendations = [
    opportunity.recommendation,
    risk.recommendation,
    capability.recommendation,
  ];

  // Hard rule: all three reject -> rejected
  if (recommendations.every(r => r === 'reject')) {
    return {
      recommendation: 'reject',
      confidence: Math.max(opportunity.confidence, risk.confidence, capability.confidence),
      rationale: 'All three perspectives recommend rejection',
    };
  }

  // Hard rule: any escalate -> escalate
  if (recommendations.includes('escalate')) {
    return {
      recommendation: 'escalate',
      confidence: Math.min(opportunity.confidence, risk.confidence, capability.confidence),
      rationale: 'One or more perspectives recommend escalation to board',
    };
  }

  // Weighted synthesis: count proceed/defer/reject
  const counts = { proceed: 0, defer: 0, reject: 0 };
  for (const rec of recommendations) {
    if (rec in counts) counts[rec]++;
  }

  // Majority rules
  if (counts.proceed >= 2) {
    return {
      recommendation: 'proceed',
      confidence: Math.round(
        (opportunity.confidence + risk.confidence + capability.confidence) / 3
      ),
      rationale: `${counts.proceed}/3 perspectives recommend proceeding`,
    };
  }

  if (counts.reject >= 2) {
    return {
      recommendation: 'reject',
      confidence: Math.round(
        (opportunity.confidence + risk.confidence + capability.confidence) / 3
      ),
      rationale: `${counts.reject}/3 perspectives recommend rejection`,
    };
  }

  // No clear majority -> defer
  return {
    recommendation: 'defer',
    confidence: Math.min(opportunity.confidence, risk.confidence, capability.confidence),
    rationale: 'No clear consensus among perspectives; deferring for more information',
  };
}

/**
 * Check compliance gate hard thresholds.
 */
function checkComplianceGate(riskResult, _synthesis) {
  const scores = riskResult.scores || {};

  // Hard threshold: P(failure) > 0.3 AND impact HIGH -> auto-block
  const failureProb = parseFloat(scores.failure_probability || 0);
  const impactLevel = (scores.impact_level || '').toLowerCase();
  if (failureProb > FAILURE_PROBABILITY_THRESHOLD && IMPACT_HIGH_KEYWORDS.includes(impactLevel)) {
    return {
      blocked: true,
      reason: `Auto-block: P(failure)=${failureProb} > ${FAILURE_PROBABILITY_THRESHOLD} AND impact=${impactLevel}`,
      overrideRecommendation: 'reject',
    };
  }

  // Hard threshold: compliance violation -> hard stop
  const violations = riskResult.complianceViolations || [];
  if (violations.length > 0) {
    return {
      blocked: true,
      reason: `Compliance violation(s): ${violations.join(', ')}`,
      overrideRecommendation: 'reject',
    };
  }

  return { blocked: false };
}

// ============================================================
// Adversarial Debate (existential tier, private)
// ============================================================

async function runAdversarialRound(proposedAction, context, strategicResult, previousRounds, roundNumber, evalId) {
  const perspectiveSummary = Object.entries(strategicResult.perspectives)
    .map(([name, p]) => `${name}: ${p.recommendation} (confidence ${p.confidence})`)
    .join('\n');

  const previousDebate = previousRounds
    .map((r, i) => `Round ${i + 1} challenger: ${r.challengerArgument}\nRound ${i + 1} defender: ${r.defenderArgument}`)
    .join('\n\n');

  // Challenger: argues against the current recommendation
  const challengerPrompt = `You are the Adversarial Challenger in an existential-tier decision evaluation.
Your job: Find the strongest argument AGAINST the current recommendation.
Be rigorous, specific, and cite concrete failure modes.`;

  const challengerMessage = `The current recommendation for this action is: ${strategicResult.synthesis.recommendation}

ACTION: ${proposedAction}

PERSPECTIVE EVALUATIONS:
${perspectiveSummary}

SYNTHESIS RATIONALE: ${strategicResult.synthesis.rationale}

${previousDebate ? `PREVIOUS DEBATE ROUNDS:\n${previousDebate}` : ''}

This is adversarial round ${roundNumber}. Present the strongest counterargument.
Respond with JSON:
{
  "argument": "<your strongest counterargument>",
  "failure_modes": ["<specific failure mode 1>", "<specific failure mode 2>"],
  "evidence_gaps": ["<what evidence is missing>"],
  "severity": "low" | "medium" | "high" | "critical"
}`;

  const challengerResponse = await callLLM(challengerPrompt, challengerMessage, evalId);
  const challengerParsed = parseJSON(challengerResponse.text);

  // Defender: responds to the challenger
  const defenderPrompt = `You are the Defense Advocate in an existential-tier decision evaluation.
Your job: Respond to the challenger's arguments with evidence and mitigation strategies.
Be honest — concede points where the challenger is correct.`;

  const defenderMessage = `The current recommendation is: ${strategicResult.synthesis.recommendation}

ACTION: ${proposedAction}

CHALLENGER'S ARGUMENT (Round ${roundNumber}):
${challengerParsed?.argument || challengerResponse.text}

FAILURE MODES CITED: ${JSON.stringify(challengerParsed?.failure_modes || [])}

Respond with JSON:
{
  "argument": "<your defense or concession>",
  "mitigations": ["<mitigation for each failure mode>"],
  "concessions": ["<points where challenger is correct>"],
  "revised_confidence": <1-5>
}`;

  const defenderResponse = await callLLM(defenderPrompt, defenderMessage, evalId);
  const defenderParsed = parseJSON(defenderResponse.text);

  return {
    round: roundNumber,
    challengerArgument: challengerParsed?.argument || challengerResponse.text,
    challengerFailureModes: challengerParsed?.failure_modes || [],
    challengerSeverity: challengerParsed?.severity || 'medium',
    defenderArgument: defenderParsed?.argument || defenderResponse.text,
    defenderMitigations: defenderParsed?.mitigations || [],
    defenderConcessions: defenderParsed?.concessions || [],
    revisedConfidence: defenderParsed?.revised_confidence || null,
    costUsd: (challengerResponse.costUsd || 0) + (defenderResponse.costUsd || 0),
  };
}

/**
 * Synthesize strategic evaluation with adversarial debate results.
 */
function synthesizeWithDebate(strategicResult, debateRounds) {
  const hasHighSeverityChallenge = debateRounds.some(r => r.challengerSeverity === 'critical');
  const hasConcessions = debateRounds.some(r => (r.defenderConcessions || []).length > 0);

  let recommendation = strategicResult.synthesis.recommendation;
  let confidence = strategicResult.synthesis.confidence || 3;

  // If critical severity challenge with concessions, downgrade recommendation
  if (hasHighSeverityChallenge && hasConcessions) {
    if (recommendation === 'proceed') {
      recommendation = 'defer';
    }
    confidence = Math.max(1, confidence - 1);
  }

  // Use the last round's revised confidence if available
  const lastRound = debateRounds[debateRounds.length - 1];
  if (lastRound?.revisedConfidence != null) {
    confidence = Math.min(confidence, lastRound.revisedConfidence);
  }

  return {
    recommendation,
    confidence,
    escalationReason: recommendation === 'escalate'
      ? 'Existential-tier decision requires human board review'
      : null,
  };
}

// ============================================================
// Database Operations (private)
// ============================================================

async function createEvaluationRecord(decisionId, tier) {
  const result = await query(
    `INSERT INTO agent_graph.strategy_evaluations (decision_id, evaluation_tier)
     VALUES ($1, $2)
     RETURNING id`,
    [decisionId, tier]
  );
  return result.rows[0].id;
}

async function updateEvaluationStatus(evalId, status) {
  const isTerminal = status === 'completed' || status === 'escalated';
  if (isTerminal) {
    await query(
      `UPDATE agent_graph.strategy_evaluations
       SET status = $1, completed_at = now()
       WHERE id = $2`,
      [status, evalId]
    );
  } else {
    await query(
      `UPDATE agent_graph.strategy_evaluations
       SET status = $1, completed_at = NULL
       WHERE id = $2`,
      [status, evalId]
    );
  }
}

async function storePerspective(evalId, perspective, result) {
  await query(
    `INSERT INTO agent_graph.perspective_evaluations
     (evaluation_id, perspective, recommendation, confidence, scores, rationale, kill_criteria, counter_evidence_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (evaluation_id, perspective) DO UPDATE SET
       recommendation = EXCLUDED.recommendation,
       confidence = EXCLUDED.confidence,
       scores = EXCLUDED.scores,
       rationale = EXCLUDED.rationale,
       kill_criteria = EXCLUDED.kill_criteria,
       counter_evidence_required = EXCLUDED.counter_evidence_required`,
    [
      evalId,
      perspective,
      result.recommendation || null,
      result.confidence || null,
      JSON.stringify(result.scores || {}),
      result.rationale || null,
      JSON.stringify(result.killCriteria || []),
      result.counterEvidenceRequired || false,
    ]
  );
}

// ============================================================
// LLM Integration (private)
// ============================================================

/**
 * Call LLM provider and track the invocation for cost accounting.
 * Shadow mode: costs are tracked but do not deduct from the daily budget.
 */
async function callLLM(systemPrompt, userMessage, evalId) {
  const idempotencyKey = `strategy-eval-${evalId}-${createHash('sha256').update(systemPrompt + userMessage).digest('hex').slice(0, 12)}`;

  const llm = getLLM();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  const start = Date.now();
  let response;
  try {
    response = await callProvider(llm, {
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - start;
  const { inputTokens, outputTokens, text: responseText } = response;
  const costUsd = sharedComputeCost(inputTokens, outputTokens, llm.modelConfig);

  const promptHash = createHash('sha256').update(systemPrompt + userMessage).digest('hex').slice(0, 16);
  const responseHash = createHash('sha256').update(responseText).digest('hex').slice(0, 16);

  // Track invocation in llm_invocations (shadow mode: logged, not deducted from budget)
  try {
    await query(
      `INSERT INTO agent_graph.llm_invocations
       (agent_id, task_id, model, input_tokens, output_tokens, cost_usd, prompt_hash, response_hash, latency_ms, idempotency_key, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      ['strategist', evalId, MODEL, inputTokens, outputTokens, costUsd, promptHash, responseHash, latencyMs, idempotencyKey, llm.provider]
    );
  } catch (err) {
    console.warn('[evaluation-protocol] Failed to log LLM invocation:', err.message);
  }

  return {
    text: responseText,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
  };
}

// ============================================================
// Formatting Helpers (private)
// ============================================================

function parseJSON(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }
}

function formatContext(context) {
  const parts = [];

  if (context.signals?.workItem) {
    const wi = context.signals.workItem;
    parts.push(`Work Item: ${wi.title || 'untitled'} (type: ${wi.type}, priority: ${wi.priority})`);
    if (wi.description) parts.push(`Description: ${wi.description}`);
    if (wi.budget_usd) parts.push(`Budget: $${wi.budget_usd}`);
  }

  if (context.signals?.financial) {
    parts.push(formatFinancialSignals(context.signals.financial));
  }

  if (context.signals?.capability) {
    parts.push(formatCapabilitySignals(context.signals.capability));
  }

  if (context.signals?.legal) {
    const legal = context.signals.legal;
    parts.push(`Autonomy Level: L${legal.autonomyLevel}`);
    parts.push(`Daily Budget Ceiling: $${legal.dailyBudgetCeilingUsd}`);
    parts.push(`Constraints: ${legal.constraints.join('; ')}`);
  }

  if (context.additionalContext) {
    parts.push(`Additional: ${context.additionalContext}`);
  }

  return parts.join('\n') || '(no context available)';
}

function formatFinancialSignals(financial) {
  if (!financial) return 'Financial: (no data)';
  const parts = ['Financial Signals:'];
  if (financial.dailyBudgetRemaining != null) {
    parts.push(`  Daily budget remaining: $${financial.dailyBudgetRemaining.toFixed(2)}`);
  }
  if (financial.monthlySpend != null) {
    parts.push(`  Monthly spend: $${financial.monthlySpend.toFixed(2)}`);
  }
  if (financial.operatingBalance != null) {
    parts.push(`  Operating balance: $${financial.operatingBalance.toFixed(2)}`);
  }
  if (financial.reserveBalance != null) {
    parts.push(`  Reserve balance: $${financial.reserveBalance.toFixed(2)}`);
  }
  return parts.join('\n');
}

function formatCapabilitySignals(capability) {
  if (!capability) return 'Capability: (no data)';
  const parts = ['Capability Signals:'];
  parts.push(`  Completed (30d): ${capability.completedLast30Days}`);
  parts.push(`  Failed (30d): ${capability.failedLast30Days}`);
  if (capability.errorRate != null) {
    parts.push(`  Error rate: ${(capability.errorRate * 100).toFixed(1)}%`);
  }
  if (capability.avgCompletionTimeMs != null) {
    parts.push(`  Avg completion: ${(capability.avgCompletionTimeMs / 1000).toFixed(1)}s`);
  }
  return parts.join('\n');
}
