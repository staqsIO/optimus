import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateInputAdapter } from '../src/adapters/input-adapter.js';
import { validateOutputAdapter } from '../src/adapters/output-adapter.js';
import { createOutlookAdapter } from '../src/adapters/outlook-adapter.js';

describe('OutlookAdapter', () => {
  let adapter;
  const mockFetchOutlookBody = mock.fn(async () => 'mock outlook body');
  const mockCreateOutlookDraft = mock.fn(async () => 'outlook-draft-123');
  const mockSendApprovedOutlookDraft = mock.fn(async () => 'outlook-sent-456');

  before(() => {
    adapter = createOutlookAdapter({
      fetchOutlookBody: mockFetchOutlookBody,
      createOutlookDraft: mockCreateOutlookDraft,
      sendApprovedOutlookDraft: mockSendApprovedOutlookDraft,
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
    it('delegates to fetchOutlookBody with provider_msg_id and account_id', async () => {
      mockFetchOutlookBody.mock.resetCalls();
      const message = { provider_msg_id: 'AAMk-outlook-123', account_id: 'acct-outlook-1' };
      const result = await adapter.fetchContent(message);
      assert.equal(result, 'mock outlook body');
      assert.equal(mockFetchOutlookBody.mock.calls.length, 1);
      assert.deepEqual(mockFetchOutlookBody.mock.calls[0].arguments, ['AAMk-outlook-123', 'acct-outlook-1']);
    });
  });

  describe('buildPromptContext', () => {
    it('returns correct shape with full message', () => {
      const message = {
        from_name: 'Bennett',
        from_address: 'bennett@example.com',
        thread_id: 'conv-1',
        in_reply_to: '<ref@outlook.com>',
        subject: 'Recruiting update',
        to_addresses: ['eric@formul8.ai'],
        cc_addresses: ['dustin@staqs.io'],
        snippet: 'short preview',
      };
      const ctx = adapter.buildPromptContext(message, 'full body text');

      assert.equal(ctx.channel, 'email');
      assert.equal(ctx.body, 'full body text');
      assert.equal(ctx.contentLabel, 'untrusted_email');
      assert.equal(ctx.contentType, 'email');
      assert.equal(ctx.channelHint, '');
      assert.deepEqual(ctx.sender, { name: 'Bennett', address: 'bennett@example.com' });
      assert.deepEqual(ctx.threading, {
        threadId: 'conv-1',
        inReplyTo: '<ref@outlook.com>',
        subject: 'Recruiting update',
        toAddresses: ['eric@formul8.ai'],
        ccAddresses: ['dustin@staqs.io'],
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
    it('delegates to createOutlookDraft', async () => {
      mockCreateOutlookDraft.mock.resetCalls();
      const result = await adapter.createDraft('draft-99');
      assert.equal(result, 'outlook-draft-123');
      assert.equal(mockCreateOutlookDraft.mock.calls.length, 1);
      assert.deepEqual(mockCreateOutlookDraft.mock.calls[0].arguments, ['draft-99']);
    });
  });

  describe('executeDraft', () => {
    it('delegates to sendApprovedOutlookDraft', async () => {
      mockSendApprovedOutlookDraft.mock.resetCalls();
      const result = await adapter.executeDraft('draft-99');
      assert.equal(result, 'outlook-sent-456');
      assert.equal(mockSendApprovedOutlookDraft.mock.calls.length, 1);
      assert.deepEqual(mockSendApprovedOutlookDraft.mock.calls[0].arguments, ['draft-99']);
    });
  });
});
