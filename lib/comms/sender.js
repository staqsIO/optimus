import { query } from '../db.js';
import { createLogger } from '../logger.js';
import { getAdapter } from '../adapters/registry.js';
const log = createLogger('comms/sender');

/**
 * Provider-aware sender dispatcher. Routes approve/send calls to the channel
 * adapter the product registered at startup (lib/adapters/registry.js). The
 * provider key on the draft (gmail/outlook/slack/telegram) selects the adapter.
 *
 * Adapters expose createDraft(draftId) and executeDraft(draftId); see
 * lib/adapters/output-adapter.js for the full contract.
 */

/**
 * Look up the provider for a draft.
 * @param {string} draftId
 * @returns {Promise<{provider: string, draft: Object}>}
 */
async function getDraftProvider(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);
  return { provider: draft.provider || 'gmail', draft };
}

/**
 * Create a platform-specific draft (e.g., Gmail draft).
 * For channels without a draft concept (Slack, Telegram), the adapter's
 * createDraft returns null and we propagate that.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string|null>} Platform draft ID or null
 */
export async function createDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  const adapter = getAdapter(provider);
  if (typeof adapter.createDraft !== 'function') {
    return null;
  }
  return adapter.createDraft(draftId);
}

/**
 * Send an approved draft through the appropriate provider.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Platform-specific sent ID
 */
export async function sendDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  const adapter = getAdapter(provider);
  if (typeof adapter.executeDraft !== 'function') {
    throw new Error(`No send handler for provider: ${provider}`);
  }
  return adapter.executeDraft(draftId);
}

/**
 * Approve and optionally create a platform draft.
 * For email: creates Gmail draft. For Slack: no-op.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<{draftId: string, platformDraftId: string|null, provider: string}>}
 */
export async function approveDraft(draftId) {
  const { provider } = await getDraftProvider(draftId);
  let platformDraftId = null;

  try {
    platformDraftId = await createDraft(draftId);
  } catch (err) {
    log.error(`Failed to create platform draft for ${draftId}:`, err.message);
  }

  return { draftId, platformDraftId, provider };
}
