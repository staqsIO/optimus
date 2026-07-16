import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../../lib/db.js';
import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { createChildLogger } from '../../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createChildLogger({ agent: 'executor-contract' });

// Load default template
const DEFAULT_TEMPLATE = readFileSync(
  join(__dirname, 'template-service-proposal.md'),
  'utf-8'
);

const SYSTEM_PROMPT = `You are a contract writer for UMB Advisors. You generate professional service proposals and contracts based on templates and client-specific details.

Your job:
1. Take the template and fill in ALL placeholder fields (formatted as [FIELD_NAME]) with appropriate content
2. Use the provided client context (from conversations, transcripts, prior interactions) to make the content specific and relevant
3. Write professional, clear language — not legal jargon. UMB's tone is direct, practical, and partner-oriented.
4. Pricing should be realistic based on the scope described
5. Objectives should reflect the actual client needs discussed in conversations

Output rules:
- Return the COMPLETE filled contract as markdown
- Replace ALL [PLACEHOLDER] bracket fields — none should remain unless you genuinely lack the info
- Do NOT add markdown fences around the output
- Do NOT include commentary or notes — just the contract text
- Maintain the exact section structure of the template
- Tables should use proper markdown table syntax
- Pricing should include specific dollar amounts based on scope

Placeholder format: Bracket placeholders are written as [UPPER_SNAKE_CASE], e.g. [CLIENT_NAME], [PROPOSAL_NUMBER]. Replace them with real values. If you don't have enough context for a field, leave the bracket intact so a human can fill it later. Do NOT invent data when uncertain — leave [UNKNOWN_FIELD] untouched rather than fabricate.`;

async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const {
    client_name,
    topic,
    template_id,
    signer_name,
    signer_email,
    signer_title,
    campaign_id,
  } = metadata;

  const clientName = client_name || topic || 'Client';

  log.info({ clientName, template_id, workItemId: task.work_item_id }, 'Starting contract generation');

  // Load template (custom or default)
  let template = DEFAULT_TEMPLATE;
  if (template_id) {
    try {
      const tmpl = await query(
        `SELECT body FROM content.contract_templates WHERE id = $1`,
        [template_id]
      );
      if (tmpl.rows[0]) template = tmpl.rows[0].body;
    } catch {
      log.warn({ template_id }, 'Custom template not found, using default');
    }
  }

  // Gather context from RAG. retrieveContext returns { answer, citations,
  // chunks } — `answer` is the pre-formatted context block, ready to inject.
  // Previous code checked `chunks?.length` against the wrapper object, so the
  // RAG branch never executed (silent miss).
  //
  // Worktree 1 (RAG tenancy hardening): Executor tier — resolve ownerId
  // via the work_item's creator (created_by_member_id) or its source
  // account, never via org-wide scope. Skip RAG entirely if neither
  // resolves rather than fall through to org-wide.
  let ragContext = '';
  try {
    let ownerId = metadata.owner_id
      || context.workItem?.created_by_member_id
      || metadata.board_member_id
      || null;
    if (!ownerId && metadata.account_id) {
      try {
        const r = await query(
          `SELECT owner_id FROM inbox.accounts WHERE id = $1`,
          [metadata.account_id]
        );
        ownerId = r.rows[0]?.owner_id || null;
      } catch { /* fall through */ }
    }
    if (ownerId) {
      const { retrieveContext } = await import('../../lib/rag/retriever.js');
      // Phase-2 tenancy: attach readOrgIds (syntheticPrincipal Staqs) so
      // match_chunks fails closed on owner_org_id.
      const { CURRENT_ORG_READ_SCOPE } = await import('../../lib/tenancy/scope.js');
      const result = await retrieveContext(
        `${clientName} service proposal scope of work pricing`,
        { matchCount: 8 },
        {
          ownerId: String(ownerId),
          readOrgIds: CURRENT_ORG_READ_SCOPE,
        }
      );
      if (result?.answer) {
        ragContext = result.answer;
      }
    } else {
      log.warn({ workItemId: task.work_item_id }, 'executor-contract: no ownerId resolvable — skipping RAG');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'RAG context retrieval failed');
  }

  // Build prompt
  const today = new Date().toISOString().split('T')[0];
  const proposalNum = `26-${String(Date.now()).slice(-4)}`;

  const userMsg = `Fill in the following contract template for client "${clientName}".

TEMPLATE:
${template}

CLIENT CONTEXT (from conversations, transcripts, knowledge base):
${ragContext || 'No additional context available. Use reasonable defaults based on the client name and mark uncertain fields with [CONFIRM].'}

ADDITIONAL DETAILS:
- Client Name: ${clientName}
- Proposal Date: ${today}
- Proposal Number: ${proposalNum}
- Client Signer Name: ${signer_name || '[CONFIRM]'}
- Client Signer Title: ${signer_title || '[CONFIRM]'}
${metadata.scope_notes ? `- Scope Notes: ${metadata.scope_notes}` : ''}
${metadata.budget_range ? `- Budget Range: ${metadata.budget_range}` : ''}
${metadata.duration ? `- Engagement Duration: ${metadata.duration}` : ''}

Generate the complete filled contract now.`;

  const response = await agent.callLLM(SYSTEM_PROMPT, userMsg, {
    taskId: task.work_item_id,
    maxTokens: 8192,
    temperature: 0.3,
  });

  let contractText = response.text.trim();
  // Strip markdown fences if wrapped
  const fenceMatch = contractText.match(/```(?:markdown)?\s*([\s\S]*?)```/);
  if (fenceMatch) contractText = fenceMatch[1].trim();

  const totalCost = response.costUsd || 0;
  const wordCount = contractText.split(/\s+/).length;

  // Check for unfilled placeholders (legacy {{}} and [] formats, plus typed [TYPE:NAME])
  const unfilled = [
    ...(contractText.match(/\{\{[A-Z_]+\}\}/g) || []),
    ...(contractText.match(/\[[A-Z][A-Z0-9_:]{1,80}\]/g) || []),
  ];
  const confirmNeeded = (contractText.match(/\[CONFIRM\]/g) || []).length;

  // Store in content.drafts
  let draftId;
  try {
    const slug = `contract-${clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${proposalNum}`;
    const result = await query(
      `INSERT INTO content.drafts
         (campaign_id, work_item_id, content_type, status, title, author,
          body, slug, word_count, cost_usd, seo_metadata)
       VALUES ($1, $2, 'contract', 'review', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        campaign_id || null,
        task.work_item_id,
        `Service Proposal — ${clientName}`,
        'Dustin Powers & Eric Gang',
        contractText,
        slug,
        wordCount,
        totalCost,
        JSON.stringify({
          client_name: clientName,
          signer_name: signer_name || null,
          signer_email: signer_email || null,
          signer_title: signer_title || null,
          unfilled_placeholders: unfilled.length,
          confirm_needed: confirmNeeded,
          proposal_number: proposalNum,
        }),
      ]
    );
    draftId = result.rows[0]?.id;
  } catch (err) {
    log.error({ err }, 'Failed to store contract draft');
  }

  const summary = [
    `Contract generated: "Service Proposal — ${clientName}" (${wordCount} words)`,
    unfilled.length ? `WARNING: ${unfilled.length} unfilled placeholders` : 'All fields filled',
    confirmNeeded ? `${confirmNeeded} fields marked [CONFIRM] for review` : '',
    `Cost: $${totalCost.toFixed(4)}`,
  ].filter(Boolean).join('. ');

  log.info({ draftId, wordCount, unfilled: unfilled.length, confirmNeeded }, 'Contract draft stored');

  return { success: true, reason: summary, costUsd: totalCost };
}

export const contractLoop = new AgentLoop('executor-contract', handler);
