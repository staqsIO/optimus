/**
 * Triage Evaluator — LLM-based issue assessment.
 *
 * Single Haiku call per issue (~$0.005). Evaluates:
 * - Clarity (1-5): Is the ask specific enough to implement?
 * - Feasibility: Can Optimus agents handle this?
 * - Scope: S/M/L estimate
 * - Classification: bug_fix, feature, research, documentation, config
 * - Target repo + playbook
 *
 * Extends the pattern from src/linear/issue-classifier.js.
 */

import { createLLMClient, callProvider } from '../../lib/llm/provider.js';
import { getConfig } from '../../lib/config/loader.js';
import { createChildLogger } from '../../lib/logger.js';
import { screenUntrustedContent } from '../../lib/runtime/governance/screen-untrusted-content.js';

const log = createChildLogger({ agent: 'issue-triage' });

// Route through the LLM provider abstraction (ADR-020). Model must exist in
// agents.json `models`.
const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

let _models = null;
function models() {
  return (_models ??= getConfig('agents').models);
}

const VALID_PLAYBOOKS = [
  'implement-feature',
  'fix-bug',
  'investigate',
  'design-implement',
  'scaffold-repo',
  'report',
];

// Load repo descriptions from config at startup, fallback to hardcoded
let REPO_DESCRIPTIONS = null;
async function getRepoDescriptions() {
  if (REPO_DESCRIPTIONS) return REPO_DESCRIPTIONS;
  try {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(readFileSync(join(__dirname, '../../autobot-inbox/config/linear-bot.json'), 'utf-8'));
    REPO_DESCRIPTIONS = config.repoDescriptions || {};
  } catch {
    REPO_DESCRIPTIONS = {
      'staqsIO/optimus-private': 'Optimus governed agent organization — Node.js monorepo with agents, board UI, RAG pipeline',
      'f8ai/formul8-platform': 'Formul8 cannabis compliance platform — polyrepo, Express + Next.js + tRPC + Prisma',
      'f8ai/formul8-metrc-platform': 'Metrc track-and-trace integration platform, state cannabis compliance API',
      'staqsIO/staqs-splash': 'Staqs Inc marketing website',
    };
  }
  return REPO_DESCRIPTIONS;
}

/**
 * Evaluate a single issue for triage.
 *
 * @param {Object} issue - Unified issue from issue-fetcher
 * @param {Object} context - { runnerCapacity: { workshopSlots, campaignerSlots } }
 * @returns {Promise<{ clarity_score, feasibility, scope_estimate, classification, target_repo, playbook_id, campaign_mode, reasoning }>}
 */
export async function evaluateIssue(issue, context = {}) {
  const descriptions = await getRepoDescriptions();
  const repoList = Object.entries(descriptions)
    .map(([repo, desc]) => `- ${repo}: ${desc}`)
    .join('\n');

  // Calculate issue age for staleness detection
  const ageMs = issue.createdAt ? Date.now() - new Date(issue.createdAt).getTime() : 0;
  const ageHours = Math.round(ageMs / 3600000);
  const ageDays = Math.round(ageHours / 24);
  const ageStr = ageDays > 0 ? `${ageDays} day(s) old` : `${ageHours} hour(s) old`;

  const issueContext = [
    `Source: ${issue.source}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description || '(no description)'}`,
    `Age: ${ageStr}`,
    issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : null,
    issue.priority ? `Priority: ${issue.priority} (1=urgent, 4=low)` : null,
    issue.team ? `Team: ${issue.team}` : null,
    issue.repo ? `Repo: ${issue.repo}` : null,
  ].filter(Boolean).join('\n');

  const capacityHint = context.runnerCapacity
    ? `Workshop slots available: ${context.runnerCapacity.workshopSlots}, Campaigner slots available: ${context.runnerCapacity.campaignerSlots}`
    : '';

  const prompt = `You are an issue triage agent for a software organization called Optimus. Evaluate this issue and decide how to handle it.

## Issue
${issueContext}

## Available Repositories
${repoList}

## Available Playbooks
- implement-feature: Build or add functionality
- fix-bug: Something is broken, fix it
- investigate: Research question or analysis
- design-implement: Design + build (UI/UX work)
- scaffold-repo: Create a new repository
- report: Generate a written report or analysis

${capacityHint}

## Respond with JSON only:
{
  "clarity_score": <1-5, where 5 = perfectly clear, actionable issue; 1 = vague wish>,
  "feasibility": "<auto_assign | needs_clarification | board_review | skip>",
  "scope_estimate": "<S | M | L>",
  "classification": "<bug_fix | feature | research | documentation | config | design>",
  "target_repo": "<owner/repo or null>",
  "playbook_id": "<playbook name or null>",
  "campaign_mode": "<workshop | stateless>",
  "reasoning": "<1-2 sentence explanation>",
  "clarification_questions": ["<question 1>", "<question 2>"] // only if needs_clarification
}

Rules:
- clarity >= 4 AND scope S or M → auto_assign (agents can handle this)
- clarity <= 2 → needs_clarification (ask questions)
- scope L or unclear feasibility → board_review
- Issues about infrastructure, security, or governance → board_review
- Issues already labeled "in-progress" or assigned → skip
- CI/test failures older than 24 hours → skip (likely already fixed)
- Issues older than 7 days with no recent activity → board_review (may be stale)
- workshop mode for code changes (PRs), stateless for research/docs`;

  // GH #541: screen the fully rendered prompt (Linus V-5) before it reaches
  // the LLM. The prompt interpolates more than title/description — labels,
  // priority, team, and repo are all attacker-influenceable GitHub/Linear
  // issue fields — so screening only title+description missed the same
  // class of gap found in claw-workshop. issue-triage is a read-only
  // classifier, so a can't-screen result is allowed through with a warn
  // rather than blocked; only a confirmed Model Armor match blocks the call.
  const screening = await screenUntrustedContent(prompt, {
    agentId: 'issue-triage',
    failClosed: false,
  });
  if (screening.decision === 'block') {
    log.warn(` Blocked by content screening for "${issue.title}": ${screening.reason}`);
    return defaultEvaluation(issue, `blocked by content screening (${screening.reason})`);
  }

  try {
    const llm = createLLMClient(TRIAGE_MODEL, models());
    const response = await callProvider(llm, {
      system: undefined,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      temperature: 0.1,
    });

    const text = response.text || '';
    // Extract JSON from response (may have markdown fencing)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn(` No JSON in LLM response for "${issue.title}"`);
      return defaultEvaluation(issue, 'LLM returned no JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and clamp values
    return {
      clarity_score: Math.max(1, Math.min(5, parseInt(parsed.clarity_score) || 3)),
      feasibility: ['auto_assign', 'needs_clarification', 'board_review', 'skip'].includes(parsed.feasibility)
        ? parsed.feasibility : 'board_review',
      scope_estimate: ['S', 'M', 'L'].includes(parsed.scope_estimate) ? parsed.scope_estimate : 'M',
      classification: parsed.classification || 'feature',
      target_repo: parsed.target_repo || null,
      playbook_id: VALID_PLAYBOOKS.includes(parsed.playbook_id) ? parsed.playbook_id : null,
      campaign_mode: parsed.campaign_mode === 'stateless' ? 'stateless' : 'workshop',
      reasoning: (parsed.reasoning || '').slice(0, 500),
      clarification_questions: parsed.clarification_questions || [],
    };
  } catch (err) {
    log.error(` Evaluation failed for "${issue.title}": ${err.message}`);
    return defaultEvaluation(issue, err.message);
  }
}

function defaultEvaluation(issue, reason) {
  return {
    clarity_score: 3,
    feasibility: 'board_review',
    scope_estimate: 'M',
    classification: 'feature',
    target_repo: null,
    playbook_id: null,
    campaign_mode: 'workshop',
    reasoning: `Default: board_review (${reason})`,
    clarification_questions: [],
  };
}
