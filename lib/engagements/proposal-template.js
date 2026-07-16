/**
 * Generate a client-facing project-proposal template from the Master spec.
 *
 * The Master spec is internal guidelines ("our standards", "contractor
 * responsibilities", risk register, etc.). A proposal template is the
 * outbound document — what you send a prospective client — with the same
 * substance reframed in client-facing language and with [BRACKET]
 * placeholders for the per-client customization (name, budget, timeline,
 * specific scope items, etc.).
 *
 * Input: the Master spec's current markdown.
 * Output: a markdown document, ~80–90% done, that the user edits lightly
 * before sending to a specific client.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('engagements/proposal-template');
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL_KEY = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 16_000;

const TAILORED_SYSTEM_PROMPT = `You produce a client-facing project proposal for a specific client, drafted from real source material this agency has gathered (meetings, transcripts, emails, extracted signals) PLUS the agency's Master spec baselines.

You'll receive:
1. CLIENT_NAME (free-text — use it literally where the proposal addresses the client)
2. ENGAGEMENT SPEC — the synthesized spec for this specific engagement (already incorporates baselines + client-specific signal)
3. MASTER SPEC BASELINES — Staqs's defaults that apply to most engagements
4. SOURCE TOUCHPOINTS — the raw meetings/emails/transcripts/signals the system found for this client

Your job: produce ONE polished proposal in markdown, structured for client delivery. Fill in real values from the source material wherever they exist. Where a specific value is genuinely unknown, use a [BRACKET_PLACEHOLDER] the user can fill before sending.

Section structure (use these headers in this order):
1. # Proposal for ${'${CLIENT_NAME}'}   ← substitute the actual client name
2. > Prepared by Staqs · [DATE] · v1
3. ## Overview        — what we propose to build, in client's terms
4. ## Our Understanding — what they've told us they need (drawn from meetings/emails)
5. ## Approach         — how we'll work together
6. ## Scope            — In Scope / Out of Scope, derived from real conversations
7. ## Deliverables     — concrete items, with real specifics where discussed
8. ## Technology & Architecture
9. ## Timeline & Milestones — real dates if discussed, [BRACKETS] otherwise
10. ## Investment      — real numbers if discussed, [BUDGET_TOTAL] otherwise
11. ## Key Risks & How We Mitigate Them — pulled from real risks raised

Hard rules:
1. PREFER real values over placeholders. If a meeting mentioned "12 weeks, $60k, launch by Sept 30", use those numbers. Only use [BRACKETS] for genuine gaps.
2. CITE-AT-MOST-IMPLICITLY: don't quote specific people or attribute quotes ("as you said in our 2/14 call"). Just internalize the content. Clients shouldn't feel surveilled.
3. NEVER invent commitments. If a budget wasn't discussed, write [BUDGET_TOTAL]. Don't fill it with a guess. Same for dates, team sizes, integrations.
4. The Master baselines are DEFAULTS — apply them but let engagement-specific signal override. ("Vercel as default hosting" yields to "client wants AWS" if a meeting said that.)
5. Voice: confident, plain, client-facing. "We'll deliver", "your team will see", "you'll review". Not "the contractor shall".
6. NO legal/contract boilerplate. End the Investment section with "Detailed terms are in our Master Services Agreement, provided separately."
7. NO "Open Questions" section in the output — internal kickoff item, not client-facing.
8. NO "About Us" or "Next Steps" sections — final-doc audit (2026-06) showed these were always cut by hand before sending. Don't generate them.
9. Timeline & Milestones table: 2 columns only (Milestone, Description). NO "Target Date" column with placeholders — operators were removing it every time. Date specifics belong in the Investment section's payment-schedule bullets or in the body of a milestone description.
10. Prose style: prefer commas to em-dashes and parenthetical thoughts; collapse numbered-list spacing (no blank lines between items). Avoid the AI-tells: "in conclusion", "it's worth noting", inflated symbolism. Audit-driven rule from the iComply final.
11. Output is markdown ONLY. No surrounding prose, no fenced code wrapper, no commentary.`;

const SYSTEM_PROMPT = `You convert an agency's internal Master spec into a polished, client-ready project proposal template.

INPUT: the agency's internal Master spec markdown — baseline standards, default scope/out-of-scope, deliverables, milestone structure, risk register, communication standards, etc. Treat it as authoritative for substance.

OUTPUT: a single client-facing project proposal in markdown, ~80-90% done, with [BRACKET] placeholders where the user will fill in per-client details before sending. The user wants to edit it lightly and send it.

Use these exact section headers in this order:
1. # [PROJECT_NAME] Proposal
2. > Prepared for [CLIENT_NAME] · [DATE] · v1
3. ## Overview
4. ## Our Understanding
5. ## Approach
6. ## Scope
7. ## Deliverables
8. ## Technology & Architecture
9. ## Timeline & Milestones
10. ## Investment
11. ## Key Risks & How We Mitigate Them

Hard rules:
1. Use [BRACKETS] for everything per-client. Common ones: [CLIENT_NAME], [PROJECT_NAME], [PROJECT_DESCRIPTION], [LAUNCH_DATE], [TIMELINE_WEEKS], [BUDGET_TOTAL], [DEPOSIT_AMOUNT], [PAYMENT_SCHEDULE], [PRIMARY_CONTACT], [TARGET_USERS], [SUCCESS_METRICS]. Add others where helpful.
2. Reframe internal language to client-facing voice. "Contractor" → "we" / "our team". "Client must" → "you'll" / "your team will". "Required" → "we recommend" or "we'll need" depending on tone.
3. Pull substantive content from the Master where it applies — concrete deliverables, milestone names, default risks (rewritten in client-friendly language), default communication cadence. Don't water it down.
4. Do NOT include legal/contract boilerplate (governing law, IP transfer, liability caps, payment terms beyond a high-level Investment section). At the bottom of Investment, note: "Detailed terms are in our Master Services Agreement, provided separately."
5. Do NOT include the Master's "Open Questions" checklist — those are internal kickoff items, not part of the client-facing proposal.
6. Risks section: pick 3-5 risks from the Master register, reframe each as "Risk: X. How we handle it: Y." Skip likelihood/impact ratings — clients don't want a probabilistic risk matrix.
7. Do NOT include "About Us" or "Next Steps" sections. Final-doc audit (2026-06) showed these were always cut by hand before sending. About-us belongs on the website; next-steps belongs in the cover email.
8. Timeline & Milestones table: 2 columns only (Milestone, Description). NO "Target Date" column with placeholders — operators were removing it every time. Date specifics belong in milestone descriptions or the Investment payment schedule.
9. Prose style: commas over em-dashes; compact numbered lists (no blank lines between items). Avoid AI-tells ("in conclusion", "it's worth noting", inflated symbolism). Audit-driven rule from the iComply final.
10. Keep it concise — a real proposal is 4-8 pages. Don't pad. Don't repeat.
11. Output is markdown ONLY. No surrounding prose, no fenced code wrapper, no commentary. Just the proposal markdown, ready to render.`;

/**
 * Generate a client-facing proposal template from a Master spec markdown.
 *
 * @param {string} masterMarkdown
 * @param {object} [opts]
 * @param {string} [opts.modelKey]
 * @returns {{ markdown: string, costUsd: number, modelKey: string }}
 */
export async function generateProposalTemplate(masterMarkdown, opts = {}) {
  if (!masterMarkdown || typeof masterMarkdown !== 'string') {
    throw new Error('masterMarkdown is required');
  }
  const modelKey = opts.modelKey || DEFAULT_MODEL_KEY;
  const modelsConfig = loadModelsConfig();
  const llm = createLLMClient(modelKey, modelsConfig.models);

  log.info(`generating proposal template from master spec (${masterMarkdown.length} chars), model=${modelKey}`);

  const response = await callProvider(llm, {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `MASTER SPEC MARKDOWN:\n\n${masterMarkdown}\n\n---\n\nNow produce the client-facing proposal template. Markdown only.`,
      },
    ],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.4,
  });

  let md = (response.text || '').trim();
  if (!md) throw new Error('LLM returned empty proposal template');
  // Strip an accidental fenced-code wrapper if the model added one.
  md = md.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');

  const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
  log.info(`proposal template generated (${md.length} chars, cost=$${costUsd.toFixed(4)})`);

  return { markdown: md, costUsd, modelKey };
}

/**
 * Generate a CLIENT-TAILORED proposal — for a specific engagement, drawing
 * on its own spec + master baselines + the raw source touchpoints (meetings,
 * emails, signals) that fed the engagement. Fills brackets with real values
 * where available; leaves brackets where data is genuinely missing.
 *
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.engagementSpecMarkdown
 * @param {string} [args.masterSpecMarkdown]
 * @param {string[]} [args.sourceTouchpoints]  - markdown blocks from the ingested proposals
 * @param {string} [args.modelKey]
 */
export async function generateTailoredProposal({
  clientName,
  engagementSpecMarkdown,
  masterSpecMarkdown,
  sourceTouchpoints = [],
  modelKey,
}) {
  if (!clientName) throw new Error('clientName is required');
  if (!engagementSpecMarkdown) throw new Error('engagementSpecMarkdown is required');

  const modelsConfig = loadModelsConfig();
  const useModel = modelKey || DEFAULT_MODEL_KEY;
  const llm = createLLMClient(useModel, modelsConfig.models);

  const userParts = [
    `CLIENT_NAME: ${clientName}`,
    '',
    '## ENGAGEMENT SPEC',
    '',
    engagementSpecMarkdown,
  ];
  if (masterSpecMarkdown) {
    userParts.push('', '## MASTER SPEC BASELINES (defaults — engagement signal can override)', '', masterSpecMarkdown);
  }
  if (sourceTouchpoints.length) {
    userParts.push('', `## SOURCE TOUCHPOINTS (${sourceTouchpoints.length} items)`, '');
    for (const block of sourceTouchpoints) {
      userParts.push('---', '', block, '');
    }
  }
  userParts.push('', '---', '', `Produce the client-facing proposal now. Substitute "${clientName}" everywhere it should appear. Markdown only.`);

  log.info(`generating tailored proposal for "${clientName}" (engagement spec ${engagementSpecMarkdown.length} chars, ${sourceTouchpoints.length} touchpoints), model=${useModel}`);

  const response = await callProvider(llm, {
    system: TAILORED_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  });

  let md = (response.text || '').trim();
  if (!md) throw new Error('LLM returned empty tailored proposal');
  md = md.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');

  const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
  log.info(`tailored proposal generated (${md.length} chars, cost=$${costUsd.toFixed(4)})`);

  return { markdown: md, costUsd, modelKey: useModel };
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
  throw new Error('Could not locate autobot-inbox/config/agents.json from proposal-template.js');
}
