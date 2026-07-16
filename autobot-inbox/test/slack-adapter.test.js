import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateInputAdapter } from '../src/adapters/input-adapter.js';
import { validateOutputAdapter } from '../src/adapters/output-adapter.js';
import { createSlackAdapter } from '../src/adapters/slack-adapter.js';

describe('SlackAdapter', () => {
  let adapter;
  const mockSendSlackDraft = mock.fn(async () => 'ts-789');

  before(() => {
    adapter = createSlackAdapter({
      sendSlackDraft: mockSendSlackDraft,
    });
  });

  describe('interface conformance', () => {
    it('passes InputAdapter validation', () => {
      const result = validateInputAdapter(adapter);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
    });

    it('passes OutputAdapter validation', () => {
      const result = validateOutputAdapter(adapter);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
    });
  });

  describe('channel', () => {
    it('is "slack"', () => {
      assert.equal(adapter.channel, 'slack');
    });
  });

  describe('fetchContent', () => {
    it('returns message snippet (no API call)', async () => {
      const message = { snippet: 'Hey, quick question about the deploy' };
      const result = await adapter.fetchContent(message);
      assert.equal(result, 'Hey, quick question about the deploy');
    });

    it('returns null when snippet is missing', async () => {
      const result = await adapter.fetchContent({});
      assert.equal(result, null);
    });
  });

  describe('buildPromptContext', () => {
    it('returns correct shape with channel-specific values', () => {
      const message = {
        from_name: 'Bob',
        from_address: 'U12345',
        thread_id: 'C67890',
        in_reply_to: '1234567890.123456',
        to_addresses: ['U99999'],
        snippet: 'slack msg',
      };
      const ctx = adapter.buildPromptContext(message, 'full body');

      assert.equal(ctx.channel, 'slack');
      assert.equal(ctx.body, 'full body');
      assert.equal(ctx.contentLabel, 'untrusted_message');
      assert.equal(ctx.contentType, 'message');
      assert.deepEqual(ctx.sender, { name: 'Bob', address: 'U12345' });
      assert.equal(ctx.threading.subject, null);
      assert.deepEqual(ctx.threading.ccAddresses, []);
    });

    it('includes channel hint for Slack bias', () => {
      const message = { from_name: '', from_address: '' };
      const ctx = adapter.buildPromptContext(message, 'body');
      assert.ok(ctx.channelHint.includes('Slack DM/mention'));
      assert.ok(ctx.channelHint.includes('needs_response'));
    });

    it('falls back to snippet when body is null', () => {
      const message = { snippet: 'slack snippet', from_name: '', from_address: '' };
      const ctx = adapter.buildPromptContext(message, null);
      assert.equal(ctx.body, 'slack snippet');
    });
  });

  describe('createDraft', () => {
    it('returns null (Slack has no draft concept)', async () => {
      const result = await adapter.createDraft('draft-99');
      assert.equal(result, null);
    });
  });

  describe('executeDraft', () => {
    it('delegates to sendSlackDraft', async () => {
      mockSendSlackDraft.mock.resetCalls();
      const result = await adapter.executeDraft('draft-99');
      assert.equal(result, 'ts-789');
      assert.equal(mockSendSlackDraft.mock.calls.length, 1);
      assert.deepEqual(mockSendSlackDraft.mock.calls[0].arguments, ['draft-99']);
    });
  });
});
