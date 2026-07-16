import { getConfig } from '../config/loader.js';
import { buildMeetingHint, isMeetingSource } from './meeting-prompt.js';

const webhookSources = getConfig('webhook-sources');

/**
 * Create a webhook adapter implementing InputAdapter.
 * Input-only — webhooks are inbound, no OutputAdapter needed.
 * @returns {import('./input-adapter.js').InputAdapter}
 */
export function createWebhookAdapter() {
  return {
    channel: 'webhook',

    async fetchContent(message) {
      // Webhook stores body as snippet at ingestion (same as Slack pattern)
      return message.snippet || null;
    },

    buildPromptContext(message, body) {
      // Resolve source from labels (e.g. 'webhook:tldv' → 'tldv').
      // Labels are always present on webhook messages; metadata column doesn't exist.
      const source = (message.labels || [])
        .map(l => l.match?.(/^webhook:(.+)$/)?.[1])
        .find(Boolean) || 'generic';
      const sourceConfig = webhookSources.sources[source] || webhookSources.sources.generic;

      // Meeting-shaped sources (tl;dv, gemini, voice_memo) build their hint
      // from the shared template in meeting-prompt.js — JSON only carries
      // their security/HMAC config. Non-meeting sources still pull
      // channelHint from JSON.
      const channelHint = isMeetingSource(source)
        ? buildMeetingHint(source)
        : sourceConfig.channelHint;

      return {
        channel: 'webhook',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_webhook',
        contentType: 'webhook',
        sender: {
          name: message.from_name || source,
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: null,
          subject: message.subject || null,
          toAddresses: [],
          ccAddresses: [],
        },
        channelHint: `\n${channelHint}`,
      };
    },
  };
}
