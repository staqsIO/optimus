import { randomUUID } from 'crypto';
import { createWorkItem } from '../runtime/state-machine.js';
import { subscribe } from '../runtime/event-bus.js';
import { sendMessageWithKeyboard, editMessage, answerCallback } from './client.js';
import { notifyBoard } from './sender.js';

/**
 * Telegram action confirmation flow.
 * P1 deny-by-default: every proposed action gets an inline keyboard (Confirm/Cancel)
 * before execution. In-memory pending store with 5-min TTL.
 */

// ============================================================
// Pending actions store (in-memory, 5-min TTL)
// ============================================================

const pendingActions = new Map();
const ACTION_TTL_MS = 5 * 60 * 1000;

// Purge expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingActions) {
    if (now - entry.createdAt > ACTION_TTL_MS) {
      pendingActions.delete(id);
    }
  }
}, 60_000).unref();

// ============================================================
// Propose an action (send confirmation keyboard)
// ============================================================

/**
 * Send a proposed action to Telegram with Confirm/Cancel buttons.
 * @param {string|number} chatId - Telegram chat ID
 * @param {string|number} userId - Telegram user ID (for verification)
 * @param {{ tool: string, input: object, summary: string, costUsd: number }} action
 */
export async function proposeAction(chatId, userId, action) {
  const callbackId = randomUUID().slice(0, 12); // short enough for callback_data

  pendingActions.set(callbackId, {
    tool: action.tool,
    input: action.input,
    summary: action.summary,
    chatId,
    userId: String(userId),
    createdAt: Date.now(),
  });

  const text = `Proposed action:\n${action.summary}\n\nConfirm or cancel?`;
  const keyboard = [[
    { text: 'Confirm', callback_data: `action:confirm:${callbackId}` },
    { text: 'Cancel', callback_data: `action:cancel:${callbackId}` },
  ]];

  await sendMessageWithKeyboard(chatId, text, keyboard);
}

// ============================================================
// Handle callback_query (button clicks)
// ============================================================

/**
 * Process a callback_query from an inline keyboard button click.
 * @param {object} callbackQuery - Telegram callback_query object
 */
export async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const cbqId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = String(callbackQuery.from?.id);

  // Acknowledge immediately to dismiss loading indicator
  await answerCallback(cbqId);

  if (!data || !chatId || !messageId) return;

  // Parse: action:confirm:<callbackId> or action:cancel:<callbackId>
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'action') return;

  const [, verb, callbackId] = parts;
  const pending = pendingActions.get(callbackId);

  if (!pending) {
    await editMessage(chatId, messageId, 'Action expired (5-min TTL). Please try again.');
    return;
  }

  // P1: verify the clicker is the original requester
  if (pending.userId !== userId) {
    return; // silently ignore — not their action
  }

  pendingActions.delete(callbackId);

  if (verb === 'cancel') {
    await editMessage(chatId, messageId, `Cancelled: ${pending.summary}`);
    return;
  }

  if (verb === 'confirm') {
    await editMessage(chatId, messageId, `Executing: ${pending.summary}...`);
    try {
      const result = await executeAction(pending);
      await editMessage(chatId, messageId, `Done: ${result}`);
    } catch (err) {
      console.error(`[telegram-actions] Execution failed:`, err.message);
      await editMessage(chatId, messageId, `Failed: ${err.message}`);
    }
  }
}

// ============================================================
// Execute confirmed actions
// ============================================================

/**
 * Execute a confirmed board action.
 * @param {{ tool: string, input: object, chatId: string|number }} pending
 * @returns {Promise<string>} Human-readable result
 */
async function executeAction({ tool, input }) {
  switch (tool) {
    case 'start_research': {
      const item = await createWorkItem({
        type: 'task',
        title: `Research: ${input.content.slice(0, 80)}`,
        createdBy: 'board',
        assignedTo: 'executor-research',
        priority: 2,
        routingClass: 'FULL',
        metadata: { research_content: input.content, research_type: input.type, source: 'telegram' },
      });
      return `Research queued (${item.id.slice(0, 8)}). Results will be sent here when ready.`;
    }

    case 'create_github_issue': {
      const { createIssue } = await import('../github/issues.js');
      const repoStr = input.repo || 'staqsIO/optimus';
      const repo = repoStr.includes('/') ? repoStr : `staqsIO/${repoStr}`;
      const [owner, name] = repo.split('/');
      const issue = await createIssue({ owner, repo: name, title: input.title, body: input.body, labels: input.labels });
      return `Issue #${issue.number} created: ${issue.html_url}`;
    }

    case 'create_directive': {
      const item = await createWorkItem({
        type: 'directive',
        title: input.title,
        createdBy: 'board',
        assignedTo: 'orchestrator',
        priority: 1,
        metadata: { source: 'telegram' },
      });
      return `Directive created: ${item.id.slice(0, 8)}`;
    }

    default:
      throw new Error(`Unknown action: ${tool}`);
  }
}

// ============================================================
// Subscribe to async completions (research results → Telegram)
// ============================================================

let _subscribed = false;

/**
 * Subscribe to task completion events for Telegram-sourced work items.
 * When research completes, pushes the result back to the board via Telegram.
 */
export function subscribeToCompletions() {
  if (_subscribed) return;
  _subscribed = true;

  subscribe('*', (payload) => {
    if (payload.event_type === 'task_completed') {
      handleCompletion(payload).catch(err => {
        console.error('[telegram-actions] Completion handler error:', err.message);
      });
    }
  });

  console.log('[telegram-actions] Subscribed to task completions');
}

async function handleCompletion(payload) {
  // Only handle Telegram-sourced work items
  const { query: dbQuery } = await import('../db.js');
  const result = await dbQuery(
    `SELECT id, title, metadata, status FROM agent_graph.work_items WHERE id = $1`,
    [payload.work_item_id]
  );

  const item = result.rows[0];
  if (!item) return;

  const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
  if (meta?.source !== 'telegram') return;

  // Format and send result to board
  let text = `Completed: ${item.title}`;
  if (meta.research_result) {
    // research_result can be { summary, gaps, ... } or { error }
    const rr = meta.research_result;
    if (rr.error) {
      text += `\n\nError: ${rr.error}`;
    } else if (rr.summary) {
      text += `\n\n${rr.summary.slice(0, 3000)}`;
    } else {
      text += `\n\n${JSON.stringify(rr).slice(0, 3000)}`;
    }
  }

  await notifyBoard(text);
}
