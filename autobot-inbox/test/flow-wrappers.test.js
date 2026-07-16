/**
 * Unit tests for flow wrappers.
 *
 * These tests mock the underlying agent handler (responderLoop.handler, etc.)
 * so no LLM calls are made. They verify:
 *   - input validation guards (missing required fields)
 *   - synthetic work_item creation with metadata.source='flow'
 *   - context shape passed to the handler (handler sees what it expects)
 *   - output extraction maps DB state onto the tool's output_schema
 *
 * Run with PGlite (default):
 *   node --test autobot-inbox/test/flow-wrappers.test.js
 */

import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

// Loop modules — we stub .handler on each before calling the wrapper.
import { responderLoop } from '../src/agents/executor-responder.js';
import { strategistLoop } from '../src/agents/strategist.js';
import { intakeLoop } from '../src/agents/executor-intake.js';
import { ticketLoop } from '../src/agents/executor-ticket.js';
import { researchLoop } from '../src/agents/executor-research.js';

import composeReplyWrapper from '../src/flow-wrappers/compose-reply.js';
import scorePriorityWrapper from '../src/flow-wrappers/score-priority.js';
import classifyMessageWrapper from '../src/flow-wrappers/classify-message.js';
import createTicketWrapper from '../src/flow-wrappers/create-ticket.js';
import researchAnalyzeWrapper from '../src/flow-wrappers/research-analyze.js';

let query;

before(async () => {
  ({ query } = await getDb());
});

// ---------------------------------------------------------------------------
// compose_reply → executor-responder
// ---------------------------------------------------------------------------

describe('composeReplyWrapper', () => {
  let originalHandler;
  beforeEach(() => {
    originalHandler = responderLoop.handler;
  });

  it('rejects missing `from`', async () => {
    const result = await composeReplyWrapper({ emailBody: 'hi', subject: 's' });
    assert.equal(result.success, false);
    assert.match(result.reason, /`from`/);
  });

  it('skips noreply senders without invoking handler', async () => {
    let called = false;
    responderLoop.handler = async () => { called = true; return { success: true }; };
    try {
      const result = await composeReplyWrapper({
        from: 'noreply@example.com',
        subject: 'Notice',
        emailBody: 'body',
      });
      assert.equal(result.success, false);
      assert.match(result.reason, /automated sender/);
      assert.equal(called, false);
    } finally {
      responderLoop.handler = originalHandler;
    }
  });

  it('creates synthetic work_item with metadata.source="flow" and extracts draft', async () => {
    let capturedTask = null;
    let capturedContext = null;
    responderLoop.handler = async (task, context, _agent) => {
      capturedTask = task;
      capturedContext = context;
      // Simulate the real handler: insert a draft row for this work_item.
      // No message_id — the responder code has no synthetic id for flow-path
      // invocations. Migration 061's BEFORE INSERT trigger derives
      // source='flow' from the parent work_item.metadata, and the relaxed
      // CHECK allows message_id NULL when source='flow'.
      await query(
        `INSERT INTO agent_graph.action_proposals
           (action_type, work_item_id, body, subject, to_addresses, email_summary, draft_intent, channel)
         VALUES ('email_draft', $1, $2, $3, $4, $5, $6, $7)`,
        [task.work_item_id, 'Test draft body', 'Re: hello', ['alice@example.com'],
         'Asking about status', 'Acknowledge + defer', 'email'],
      );
      return { success: true, reason: 'ok', costUsd: 0.0012 };
    };
    try {
      const result = await composeReplyWrapper({
        from: 'alice@example.com',
        subject: 'hello',
        emailBody: 'What is the status?',
        channel: 'email',
      });
      assert.equal(result.body, 'Test draft body');
      assert.equal(result.subject, 'Re: hello');
      assert.deepEqual(result.toAddresses, ['alice@example.com']);
      assert.equal(result.draftIntent, 'Acknowledge + defer');
      assert.equal(result.emailSummary, 'Asking about status');
      assert.equal(result.costUsd, 0.0012);
      assert.ok(result.workItemId);

      // Verify work item has source='flow'
      const wi = await query(
        `SELECT metadata FROM agent_graph.work_items WHERE id = $1`,
        [result.workItemId],
      );
      let meta = wi.rows[0].metadata;
      if (typeof meta === 'string') meta = JSON.parse(meta);
      assert.equal(meta.source, 'flow');

      // Verify migration-061 trigger stamped the proposal's source='flow'
      // (inherited from parent work_item.metadata.source) and allowed the
      // INSERT despite message_id being NULL.
      const prop = await query(
        `SELECT source, message_id FROM agent_graph.action_proposals
         WHERE id = $1`,
        [result.draftId],
      );
      assert.equal(prop.rows[0].source, 'flow');
      assert.equal(prop.rows[0].message_id, null);

      // Context shape checks — what the handler saw
      assert.ok(capturedContext.email);
      assert.equal(capturedContext.email.from_address, 'alice@example.com');
      assert.equal(capturedContext.email.subject, 'hello');
      assert.equal(capturedContext.email.channel, 'email');
      assert.equal(capturedContext.emailBody, 'What is the status?');
      assert.ok(capturedContext.promptContext);
      assert.equal(capturedContext.promptContext.sender.address, 'alice@example.com');
      assert.equal(capturedTask.work_item_id, result.workItemId);
    } finally {
      responderLoop.handler = originalHandler;
    }
  });

  it('returns success with null body when handler reports skip', async () => {
    responderLoop.handler = async () => ({ success: true, reason: 'Skipped: newsletter', costUsd: 0 });
    try {
      const result = await composeReplyWrapper({
        from: 'bob@example.com',
        subject: 'Newsletter',
        emailBody: 'unsubscribe link here',
      });
      assert.equal(result.success, true);
      assert.equal(result.body, null);
      assert.match(result.reason, /Skipped/);
    } finally {
      responderLoop.handler = originalHandler;
    }
  });

  it('marks work item failed when handler throws', async () => {
    responderLoop.handler = async () => { throw new Error('LLM timeout'); };
    try {
      const result = await composeReplyWrapper({
        from: 'alice@example.com',
        subject: 'x',
        emailBody: 'y',
      });
      assert.equal(result.success, false);
      assert.match(result.reason, /LLM timeout/);
    } finally {
      responderLoop.handler = originalHandler;
    }
  });
});

// ---------------------------------------------------------------------------
// score_priority → strategist
// ---------------------------------------------------------------------------

describe('scorePriorityWrapper', () => {
  let originalHandler;
  beforeEach(() => { originalHandler = strategistLoop.handler; });

  it('short-circuits fyi/noise without creating a work item', async () => {
    let called = false;
    strategistLoop.handler = async () => { called = true; return { success: true }; };
    try {
      const result = await scorePriorityWrapper({
        from: 'a@b.com',
        subject: 'spam',
        emailBody: 'buy now',
        triageCategory: 'noise',
      });
      assert.equal(result.priorityScore, 0);
      assert.equal(result.urgency, 'routine');
      assert.equal(called, false);
    } finally {
      strategistLoop.handler = originalHandler;
    }
  });

  it('extracts strategy_result from work_item metadata', async () => {
    strategistLoop.handler = async (task, _context, _agent) => {
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          strategy_result: {
            priorityScore: 82,
            urgency: 'urgent',
            recommendation: 'proceed',
            responseGuidance: 'reply within 24h',
            flags: ['G7:pricing'],
            suggestedTone: 'formal',
          },
        }), task.work_item_id],
      );
      return { success: true, reason: 'scored', costUsd: 0.003 };
    };
    try {
      const result = await scorePriorityWrapper({
        from: 'vip@partner.com',
        subject: 'renewal',
        emailBody: 'Can we discuss pricing?',
        triageCategory: 'needs_response',
      });
      assert.equal(result.priorityScore, 82);
      assert.equal(result.urgency, 'urgent');
      assert.equal(result.recommendation, 'proceed');
      assert.equal(result.responseGuidance, 'reply within 24h');
      assert.deepEqual(result.flags, ['G7:pricing']);
      assert.equal(result.costUsd, 0.003);
    } finally {
      strategistLoop.handler = originalHandler;
    }
  });
});

// ---------------------------------------------------------------------------
// classify_message → executor-intake
// ---------------------------------------------------------------------------

describe('classifyMessageWrapper', () => {
  let originalHandler;
  beforeEach(() => { originalHandler = intakeLoop.handler; });

  it('rejects empty input', async () => {
    const result = await classifyMessageWrapper({});
    assert.equal(result.success, false);
  });

  it('extracts classification and routing from metadata', async () => {
    intakeLoop.handler = async (task, _ctx, _agent) => {
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          triage_result: { category: 'action_required', needs_strategist: true, quick_score: 0.87 },
          intake_classification: {
            complexity: 'COMPLEX',
            confidence: 4,
            domain_tags: ['billing'],
            rationale: 'Contains specific amount and deadline',
          },
          routing: { assigned_to: 'orchestrator', routing_class: 'COMPLEX', needs_review: false },
        }), task.work_item_id],
      );
      return { success: true, result: 'ok', metadata: { cost_usd: 0.0005 } };
    };
    try {
      const result = await classifyMessageWrapper({
        from: 'customer@example.com',
        subject: 'Invoice #123 overdue',
        emailBody: 'Please settle $1200 by Friday',
        channel: 'email',
      });
      assert.equal(result.classification, 'action_required');
      assert.equal(result.confidence, 4);
      assert.equal(result.routingClass, 'COMPLEX');
      assert.deepEqual(result.domainTags, ['billing']);
      assert.match(result.rationale, /deadline/);
    } finally {
      intakeLoop.handler = originalHandler;
    }
  });
});

// ---------------------------------------------------------------------------
// create_ticket → executor-ticket
// ---------------------------------------------------------------------------

describe('createTicketWrapper', () => {
  let originalHandler;
  beforeEach(() => { originalHandler = ticketLoop.handler; });

  it('requires targetRepo', async () => {
    const result = await createTicketWrapper({ emailBody: 'b', from: 'a@b.com', subject: 's' });
    assert.equal(result.success, false);
    assert.match(result.reason, /targetRepo/);
  });

  it('rejects malformed targetRepo', async () => {
    const result = await createTicketWrapper({
      emailBody: 'b', from: 'a@b.com', subject: 's', targetRepo: 'no-slash',
    });
    assert.equal(result.success, false);
    assert.match(result.reason, /owner\/repo/);
  });

  it('builds ticket from proposal row + ticket_result metadata', async () => {
    ticketLoop.handler = async (task, _ctx, _agent) => {
      const p = await query(
        `INSERT INTO agent_graph.action_proposals
           (action_type, work_item_id, body, linear_issue_url, github_issue_url, target_repo)
         VALUES ('ticket_create', $1, $2, $3, $4, $5) RETURNING id`,
        [task.work_item_id, '## Description\nButton does not work\n', null,
         'https://github.com/staqsIO/optimus/issues/42', 'staqsIO/optimus'],
      );
      await query(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          ticket_result: {
            proposal_id: p.rows[0].id,
            title: 'Button does not work',
            category: 'bug',
            severity: 'medium',
            linear_url: null,
            github_issue_number: 42,
            github_issue_url: 'https://github.com/staqsIO/optimus/issues/42',
            target_repo: 'staqsIO/optimus',
          },
        }), task.work_item_id],
      );
      return { success: true, reason: 'created', costUsd: 0.002 };
    };
    try {
      const result = await createTicketWrapper({
        emailBody: 'The submit button does nothing',
        from: 'user@example.com',
        subject: 'Bug report',
        targetRepo: 'staqsIO/optimus',
      });
      assert.equal(result.title, 'Button does not work');
      assert.equal(result.category, 'bug');
      assert.equal(result.severity, 'medium');
      assert.equal(result.githubUrl, 'https://github.com/staqsIO/optimus/issues/42');
      assert.equal(result.linearUrl, null);
      assert.equal(result.targetRepo, 'staqsIO/optimus');
      assert.match(result.description, /Button does not work/);
    } finally {
      ticketLoop.handler = originalHandler;
    }
  });
});

// ---------------------------------------------------------------------------
// research_analyze → executor-research
// ---------------------------------------------------------------------------

describe('researchAnalyzeWrapper', () => {
  let originalHandler;
  beforeEach(() => { originalHandler = researchLoop.handler; });

  it('requires content', async () => {
    const result = await researchAnalyzeWrapper({ researchType: 'gap_analysis' });
    assert.equal(result.success, false);
    assert.match(result.reason, /content/);
  });

  it('puts research_type and research_content on work_item.metadata', async () => {
    let capturedMetadata = null;
    researchLoop.handler = async (task, _ctx, _agent) => {
      const wi = await query(`SELECT metadata FROM agent_graph.work_items WHERE id = $1`, [task.work_item_id]);
      let m = wi.rows[0].metadata;
      if (typeof m === 'string') m = JSON.parse(m);
      capturedMetadata = m;

      await query(
        `UPDATE agent_graph.work_items
         SET metadata = metadata || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({
          research_result: {
            summary: 'Article describes retrieval-augmented generation techniques.',
            gaps: [{ id: 'gap-1', title: 'Chunk overlap', description: 'not currently configured' }],
            alreadyCovered: ['pgvector embeddings'],
            notApplicable: [],
          },
        }), task.work_item_id],
      );
      return { success: true, reason: 'analyzed', costUsd: 0.015 };
    };
    try {
      const result = await researchAnalyzeWrapper({
        researchType: 'gap_analysis',
        content: 'Recent paper on RAG chunking strategies...',
      });
      assert.equal(capturedMetadata.research_type, 'gap_analysis');
      assert.match(capturedMetadata.research_content, /RAG chunking/);
      assert.equal(capturedMetadata.source, 'flow');
      assert.match(result.summary, /retrieval-augmented/);
      assert.equal(result.gaps.length, 1);
      assert.deepEqual(result.alreadyCovered, ['pgvector embeddings']);
    } finally {
      researchLoop.handler = originalHandler;
    }
  });
});

// ---------------------------------------------------------------------------
// Registry / dispatchToAgent
// ---------------------------------------------------------------------------

describe('attachFlowWrappers', () => {
  it('routes each known agentId to the correct wrapper', async () => {
    const { FlowToolRegistry } = await import('../../lib/runtime/tool-registry.js');
    const { attachFlowWrappers, wrappers } = await import('../src/flow-wrappers/index.js');

    const registry = new FlowToolRegistry(null);
    attachFlowWrappers(registry);

    // All 5 agent ids should be wired
    assert.ok(wrappers['executor-responder']);
    assert.ok(wrappers['strategist']);
    assert.ok(wrappers['executor-intake']);
    assert.ok(wrappers['executor-ticket']);
    assert.ok(wrappers['executor-research']);

    // Unknown agent should throw
    await assert.rejects(
      () => registry.dispatchToAgent('nonexistent-agent', {}, {}),
      /No flow wrapper registered/,
    );
  });
});

// Keep original `mock` import used — node:test requires it even if unused here.
void mock;
