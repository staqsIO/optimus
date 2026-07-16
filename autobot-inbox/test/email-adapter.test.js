import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateInputAdapter } from '../src/adapters/input-adapter.js';
import { validateOutputAdapter } from '../src/adapters/output-adapter.js';
import { createEmailAdapter } from '../src/adapters/email-adapter.js';

describe('EmailAdapter', () => {
  let adapter;
  const mockFetchEmailBody = mock.fn(async () => 'mock body');
  const mockCreateGmailDraft = mock.fn(async () => 'draft-123');
  const mockSendApprovedDraft = mock.fn(async () => 'sent-456');

  before(() => {
    adapter = createEmailAdapter({
      fetchEmailBody: mockFetchEmailBody,
      createGmailDraft: mockCreateGmailDraft,
      sendApprovedDraft: mockSendApprovedDraft,
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
    it('is "email"', () => {
      assert.equal(adapter.channel, 'email');
    });
  });

  describe('fetchContent', () => {
    it('delegates to fetchEmailBody with provider_msg_id and account_id', async () => {
      mockFetchEmailBody.mock.resetCalls();
      const message = { provider_msg_id: 'msg-abc', account_id: 'acct-1' };
      const result = await adapter.fetchContent(message);
      assert.equal(result, 'mock body');
      assert.equal(mockFetchEmailBody.mock.calls.length, 1);
      assert.deepEqual(mockFetchEmailBody.mock.calls[0].arguments, ['msg-abc', 'acct-1']);
    });
  });

  describe('buildPromptContext', () => {
    it('returns correct shape with full message', () => {
      const message = {
        from_name: 'Alice',
        from_address: 'alice@example.com',
        thread_id: 'thread-1',
        in_reply_to: '<ref@example.com>',
        subject: 'Hello',
        to_addresses: ['bob@example.com'],
        cc_addresses: ['carol@example.com'],
        snippet: 'short preview',
      };
      const ctx = adapter.buildPromptContext(message, 'full body text');

      assert.equal(ctx.channel, 'email');
      assert.equal(ctx.body, 'full body text');
      assert.equal(ctx.contentLabel, 'untrusted_email');
      assert.equal(ctx.contentType, 'email');
      assert.equal(ctx.channelHint, '');
      assert.deepEqual(ctx.sender, { name: 'Alice', address: 'alice@example.com' });
      assert.deepEqual(ctx.threading, {
        threadId: 'thread-1',
        inReplyTo: '<ref@example.com>',
        subject: 'Hello',
        toAddresses: ['bob@example.com'],
        ccAddresses: ['carol@example.com'],
      });
    });

    it('falls back to snippet when body is null', () => {
      const message = { snippet: 'snippet text', from_name: '', from_address: '' };
      const ctx = adapter.buildPromptContext(message, null);
      assert.equal(ctx.body, 'snippet text');
    });

    it('returns null body when both body and snippet are missing', () => {
      const message = { from_name: '', from_address: '' };
      const ctx = adapter.buildPromptContext(message, null);
      assert.equal(ctx.body, null);
    });

    it('defaults missing threading fields to null/empty', () => {
      const message = { from_name: '', from_address: '' };
      const ctx = adapter.buildPromptContext(message, 'body');
      assert.equal(ctx.threading.threadId, null);
      assert.equal(ctx.threading.inReplyTo, null);
      assert.equal(ctx.threading.subject, null);
      assert.deepEqual(ctx.threading.toAddresses, []);
      assert.deepEqual(ctx.threading.ccAddresses, []);
    });
  });

  describe('createDraft', () => {
    it('delegates to createGmailDraft', async () => {
      mockCreateGmailDraft.mock.resetCalls();
      const result = await adapter.createDraft('draft-99');
      assert.equal(result, 'draft-123');
      assert.equal(mockCreateGmailDraft.mock.calls.length, 1);
      assert.deepEqual(mockCreateGmailDraft.mock.calls[0].arguments, ['draft-99']);
    });
  });

  describe('executeDraft', () => {
    it('delegates to sendApprovedDraft', async () => {
      mockSendApprovedDraft.mock.resetCalls();
      const result = await adapter.executeDraft('draft-99');
      assert.equal(result, 'sent-456');
      assert.equal(mockSendApprovedDraft.mock.calls.length, 1);
      assert.deepEqual(mockSendApprovedDraft.mock.calls[0].arguments, ['draft-99']);
    });
  });
});
