/**
 * Spawn agent_graph.work_items from a signed contract.
 *
 * This is the "signed doc = authority token for the task graph" step.
 * Called fire-and-forget from lib/signatures/signer.js executeSign when
 * signature_requests.status transitions to 'completed'.
 *
 * Idempotency: the request row carries work_items_spawned_at. A conditional
 * UPDATE with `WHERE work_items_spawned_at IS NULL` lets only one caller
 * win the claim. Subsequent calls return { claimed: false } without doing
 * work. Safe under concurrent signer completion.
 *
 * Error handling: any failure is logged and swallowed. Signing must not
 * fail because the task-graph hand-off had trouble — the signature is
 * the primary artifact; work items are a follow-up.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';
import { getConfig } from '../config/loader.js';

const log = createChildLogger({ module: 'contracts/spawn-work-items' });

const COMMITMENT_SYSTEM_PROMPT = `You extract concrete deliverables from a signed UMB Advisors services contract. Read the body, identify what UMB has committed to produce or perform, and emit a structured list of work items.

Rules:
- Each item is one deliverable — don't bundle multiple commitments under one title
- Titles are short imperative phrases ("Set up quarterly reporting", "Deliver brand audit")
- Descriptions cite the clause that establishes the commitment
- Include due dates only when the body gives a concrete timeline (specific date, "within 30 days", "Q2", etc). Parse these to ISO dates relative to the commencement date when possible; otherwise leave null
- Ignore standard contractual machinery (termination, governing law, signatures themselves). Only operational deliverables
- Recurring deliverables (monthly reports, quarterly reviews) → ONE work item representing the recurring obligation, not N individual items

Return strict JSON only, no fences, no prose:
{
  "commitments": [
    { "title": "short phrase (<=80 chars)",
      "description": "what it is and where in the doc it comes from",
      "due_date": "YYYY-MM-DD" | null,
      "priority": "low" | "normal" | "high" }
  ]
}

If no operational deliverables are extractable, return { "commitments": [] }.`;

/**
 * @param {Object} opts
 * @param {string} opts.requestId - signatures.signature_requests.id
 * @returns {Promise<{claimed: boolean, workItemsCreated: number, commitments: number, costUsd: number, error?: string}>}
 */
export async function spawnWorkItemsForRequest({ requestId }) {
  // 1. Atomic claim — only one concurrent caller gets to proceed
  const claim = await query(
    `UPDATE signatures.signature_requests
        SET work_items_spawned_at = now()
      WHERE id = $1
        AND status = 'completed'
        AND work_items_spawned_at IS NULL
      RETURNING draft_id, title, created_by`,
    [requestId]
  );
  if (claim.rows.length === 0) {
    return { claimed: false, workItemsCreated: 0, commitments: 0, costUsd: 0 };
  }
  const { draft_id: draftId, title: requestTitle, created_by: createdBy } = claim.rows[0];

  // 2. Load draft body + counterparty for the extraction prompt
  let draftRow;
  try {
    const r = await query(
      `SELECT d.id, d.body, d.title, d.counterparty_id,
              cp.name AS counterparty_name
         FROM content.drafts d
         LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
        WHERE d.id = $1`,
      [draftId]
    );
    draftRow = r.rows[0];
  } catch (err) {
    log.error({ err: err.message, requestId, draftId }, 'Draft load failed; claim already set — manual recovery needed');
    return { claimed: true, workItemsCreated: 0, commitments: 0, costUsd: 0, error: err.message };
  }
  if (!draftRow) {
    log.error({ requestId, draftId }, 'Draft not found after claim');
    return { claimed: true, workItemsCreated: 0, commitments: 0, costUsd: 0, error: 'draft not found' };
  }

  // 3. Extract commitments via LLM
  let commitments = [];
  let costUsd = 0;
  try {
    const { createLLMClient, callProvider, computeCost } = await import('../llm/provider.js');
    const agentsConfig = getConfig('agents');
    const modelKey = 'claude-haiku-4-5-20251001';
    const llm = createLLMClient(modelKey, agentsConfig.models);

    const userPrompt = `SIGNED CONTRACT
Title: ${draftRow.title}
${draftRow.counterparty_name ? `Counterparty: ${draftRow.counterparty_name}\n` : ''}
BODY:
\`\`\`
${draftRow.body}
\`\`\`

Extract the operational deliverables UMB now owes.`;

    const response = await callProvider(llm, {
      system: COMMITMENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 3000,
      temperature: 0.1,
    });

    costUsd = computeCost(
      response.inputTokens || 0,
      response.outputTokens || 0,
      llm.modelConfig
    );

    const raw = (response.text || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.commitments)) {
      commitments = parsed.commitments
        .filter((c) => c && typeof c.title === 'string')
        .map((c) => ({
          title: String(c.title).slice(0, 200),
          description: String(c.description || '').slice(0, 2000),
          due_date: c.due_date && /^\d{4}-\d{2}-\d{2}$/.test(c.due_date) ? c.due_date : null,
          priority: ['low', 'normal', 'high'].includes(c.priority) ? c.priority : 'normal',
        }));
    }
  } catch (err) {
    log.error({ err: err.message, requestId }, 'Commitment extraction failed');
    return { claimed: true, workItemsCreated: 0, commitments: 0, costUsd, error: err.message };
  }

  if (commitments.length === 0) {
    log.info({ requestId, draftId }, 'No commitments extracted — nothing to spawn');
    return { claimed: true, workItemsCreated: 0, commitments: 0, costUsd };
  }

  // 4. Insert work_items. One per commitment. Created unassigned so the
  //    orchestrator or the board can route them.
  const priorityMap = { low: 3, normal: 5, high: 8 };
  let workItemsCreated = 0;
  for (const c of commitments) {
    try {
      await query(
        `INSERT INTO agent_graph.work_items
           (type, title, description, status, created_by, priority, deadline, metadata)
         VALUES ('task', $1, $2, 'created', $3, $4, $5, $6::jsonb)`,
        [
          c.title,
          c.description,
          `contract:${createdBy || 'unknown'}`,
          priorityMap[c.priority] ?? 5,
          c.due_date ? new Date(c.due_date) : null,
          JSON.stringify({
            source: 'contract-signed',
            contract_draft_id: draftId,
            signature_request_id: requestId,
            contract_title: requestTitle,
            counterparty_id: draftRow.counterparty_id || null,
            counterparty_name: draftRow.counterparty_name || null,
          }),
        ]
      );
      workItemsCreated += 1;
    } catch (err) {
      log.error({ err: err.message, requestId, title: c.title }, 'Failed to insert work_item');
    }
  }

  log.info({
    requestId,
    draftId,
    commitments: commitments.length,
    workItemsCreated,
    costUsd,
  }, 'Work items spawned from signed contract');

  // Emit a contract_signed signal for the flow engine. Any flow defined
  // with trigger_signal_type='contract_signed' can react (CRM sync,
  // agent notification, onboarding kickoff, etc.). Signals are a durable
  // event record even when no flow is subscribed.
  //
  // Non-fatal: signal emit failure must not unwind the work_items spawn.
  try {
    await query(
      `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by)
       VALUES ('contract_signed', 'contracts', $1::jsonb, 'contracts-module')`,
      [JSON.stringify({
        request_id: requestId,
        draft_id: draftId,
        counterparty_id: draftRow.counterparty_id,
        counterparty_name: draftRow.counterparty_name,
        title: requestTitle,
        work_items_created: workItemsCreated,
        commitments_extracted: commitments.length,
      })]
    );
  } catch (err) {
    log.warn({ err: err.message, requestId }, 'contract_signed signal emit failed — flows will not trigger');
  }

  return {
    claimed: true,
    workItemsCreated,
    commitments: commitments.length,
    costUsd,
  };
}
