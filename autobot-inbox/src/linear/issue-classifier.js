/**
 * Linear Issue Classifier — smart repo + task-type routing.
 *
 * Uses a single Haiku call to classify both:
 * - target_repo: which GitHub repo the issue belongs to
 * - playbook_id: what type of work this is (code, research, report, etc.)
 *
 * Only called when labels don't provide explicit routing (cost guard).
 * P4: boring infrastructure — single LLM call, structured output.
 */

import { createLLMClient, callProvider } from '../../../lib/llm/provider.js';
import { getConfig } from '../../../lib/config/loader.js';

// Route through the LLM provider abstraction (ADR-020) — one choke point for
// provider selection + pricing. Model must exist in agents.json `models`.
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

let _models = null;
function models() {
  return (_models ??= getConfig('agents').models);
}

// Valid playbook IDs — must match config/playbooks/*.md
const VALID_PLAYBOOKS = [
  'implement-feature',
  'fix-bug',
  'investigate',
  'design-implement',
  'scaffold-repo',
  'report',
];

/**
 * Classify a Linear issue for repo routing and task-type selection.
 *
 * @param {Object} issue - Full Linear issue (from getIssue())
 * @param {Object} repoDescriptions - Map of "owner/repo" → description string
 * @returns {Promise<{ target_repo: string|null, playbook_id: string, confidence: number, reasoning: string }>}
 */
export async function classifyIssue(issue, repoDescriptions) {
  const repoList = Object.entries(repoDescriptions || {})
    .map(([repo, desc]) => `- ${repo}: ${desc}`)
    .join('\n');

  const issueContext = [
    `Title: ${issue.title}`,
    `Description: ${(issue.description || '').slice(0, 500)}`,
    issue.labels?.nodes?.length
      ? `Labels: ${issue.labels.nodes.map(l => l.name).join(', ')}`
      : null,
    issue.team?.name ? `Team: ${issue.team.name}` : null,
    issue.project?.name ? `Project: ${issue.project.name}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `Classify this Linear issue for routing.

## Issue
${issueContext}

## Available Repositories
${repoList || '(none configured)'}
- NEW-REPO: This task requires creating a brand new repository

## Available Playbooks
- implement-feature: Build or add functionality, code changes required
- fix-bug: Something is broken, fix it
- investigate: Research question or analysis, no code output expected
- design-implement: UI/design work with implementation
- scaffold-repo: Create a new project/repository from scratch
- report: Non-code deliverable — documentation, analysis, strategy, planning

## Instructions
1. Determine which repository this issue belongs to. If it's about creating something entirely new that doesn't fit any existing repo, choose NEW-REPO.
2. Determine which playbook best fits the work type.
3. Rate your confidence 0.0 to 1.0.

Respond in this exact JSON format (no markdown, no explanation):
{"target_repo": "owner/repo or NEW-REPO or null", "playbook_id": "one-of-the-playbook-ids", "confidence": 0.85, "reasoning": "one sentence why"}`;

  try {
    const llm = createLLMClient(CLASSIFIER_MODEL, models());
    const response = await callProvider(llm, {
      system: undefined,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
    });

    const text = response.text?.trim();
    const parsed = JSON.parse(text);

    // Validate playbook_id
    if (!VALID_PLAYBOOKS.includes(parsed.playbook_id)) {
      parsed.playbook_id = 'implement-feature'; // safe fallback
    }

    // Normalize NEW-REPO
    if (parsed.target_repo === 'NEW-REPO') {
      parsed.target_repo = 'new-repo';
      if (parsed.playbook_id === 'implement-feature') {
        parsed.playbook_id = 'scaffold-repo';
      }
    }

    // Validate target_repo against known repos — reject hallucinated repo names
    let validatedRepo = parsed.target_repo || null;
    if (validatedRepo && validatedRepo !== 'new-repo') {
      const knownRepos = Object.keys(repoDescriptions || {});
      if (knownRepos.length > 0 && !knownRepos.includes(validatedRepo)) {
        console.warn(`[issue-classifier] LLM hallucinated repo "${validatedRepo}" — not in known repos [${knownRepos.join(', ')}]. Falling back to null.`);
        validatedRepo = null;
      }
    }

    return {
      target_repo: validatedRepo,
      playbook_id: parsed.playbook_id,
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0)),
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    console.error(`[issue-classifier] Classification failed: ${err.message}`);
    // Safe fallback — don't block the pipeline
    return {
      target_repo: null,
      playbook_id: 'implement-feature',
      confidence: 0,
      reasoning: `Classification failed: ${err.message}`,
    };
  }
}
