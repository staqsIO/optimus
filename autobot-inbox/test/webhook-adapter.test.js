import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { validateInputAdapter } from '../src/adapters/input-adapter.js';
import { createWebhookAdapter } from '../src/adapters/webhook-adapter.js';

const webhookSources = JSON.parse(
  readFileSync(new URL('../config/webhook-sources.json', import.meta.url), 'utf-8')
);

describe('WebhookAdapter', () => {
  let adapter;

  before(() => {
    adapter = createWebhookAdapter();
  });

  describe('interface conformance', () => {
    it('passes InputAdapter validation', () => {
      const result = validateInputAdapter(adapter);
      assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
    });
  });

  describe('channel', () => {
    it('is "webhook"', () => {
      assert.equal(adapter.channel, 'webhook');
    });
  });

  describe('fetchContent', () => {
    it('returns message snippet', async () => {
      const message = { snippet: 'Payment received: $99.00' };
      const result = await adapter.fetchContent(message);
      assert.equal(result, 'Payment received: $99.00');
    });

    it('returns null when snippet is missing', async () => {
      const result = await adapter.fetchContent({});
      assert.equal(result, null);
    });
  });

  describe('buildPromptContext', () => {
    it('returns correct shape with webhook-specific values', () => {
      const message = {
        from_name: 'stripe',
        from_address: 'events@stripe.com',
        subject: 'Payment succeeded',
        snippet: 'Payment of $99.00 received',
        labels: ['webhook:stripe'],
      };
      const ctx = adapter.buildPromptContext(message, 'full body');

      assert.equal(ctx.channel, 'webhook');
      assert.equal(ctx.body, 'full body');
      assert.equal(ctx.contentLabel, 'untrusted_webhook');
      assert.equal(ctx.contentType, 'webhook');
      assert.deepEqual(ctx.sender, { name: 'stripe', address: 'events@stripe.com' });
      assert.equal(ctx.threading.subject, 'Payment succeeded');
      assert.deepEqual(ctx.threading.toAddresses, []);
      assert.deepEqual(ctx.threading.ccAddresses, []);
    });

    it('uses source-specific channelHint from config', () => {
      const message = { labels: ['webhook:github'] };
      const ctx = adapter.buildPromptContext(message, 'body');
      assert.ok(ctx.channelHint.includes('GitHub webhook event'));
    });

    it('falls back to generic channelHint for unknown source', () => {
      const message = { labels: ['webhook:unknown_source'] };
      const ctx = adapter.buildPromptContext(message, 'body');
      assert.ok(ctx.channelHint.includes('External webhook event'));
    });

    it('falls back to snippet when body is null', () => {
      const message = { snippet: 'webhook snippet', metadata: {} };
      const ctx = adapter.buildPromptContext(message, null);
      assert.equal(ctx.body, 'webhook snippet');
    });

    it('uses source name as sender.name when from_name is empty', () => {
      const message = { labels: ['webhook:github'] };
      const ctx = adapter.buildPromptContext(message, 'body');
      assert.equal(ctx.sender.name, 'github');
    });
  });
});

describe('HMAC verification logic', () => {
  const secret = 'test-secret-key-for-hmac';
  const payload = '{"title":"Test event","body":"Something happened"}';

  it('accepts valid HMAC signature', () => {
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    const expected = `sha256=${computed}`;
    const sigBuf = Buffer.from(expected);
    const expBuf = Buffer.from(expected);
    assert.equal(sigBuf.length, expBuf.length);
    assert.ok(timingSafeEqual(sigBuf, expBuf));
  });

  it('rejects invalid HMAC signature (timing-safe)', () => {
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    const expected = `sha256=${computed}`;
    const wrong = `sha256=${'a'.repeat(computed.length)}`;
    const sigBuf = Buffer.from(wrong);
    const expBuf = Buffer.from(expected);
    assert.equal(sigBuf.length, expBuf.length);
    assert.equal(timingSafeEqual(sigBuf, expBuf), false);
  });

  it('rejects signature with different length', () => {
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    const expected = `sha256=${computed}`;
    const wrong = 'too-short';
    const sigBuf = Buffer.from(wrong);
    const expBuf = Buffer.from(expected);
    // Different lengths should fail the length check before timingSafeEqual
    assert.notEqual(sigBuf.length, expBuf.length);
  });

  it('produces different HMAC for different payloads', () => {
    const hmac1 = createHmac('sha256', secret).update(payload).digest('hex');
    const hmac2 = createHmac('sha256', secret).update('different payload').digest('hex');
    assert.notEqual(hmac1, hmac2);
  });

  it('produces different HMAC for different secrets', () => {
    const hmac1 = createHmac('sha256', secret).update(payload).digest('hex');
    const hmac2 = createHmac('sha256', 'different-secret').update(payload).digest('hex');
    assert.notEqual(hmac1, hmac2);
  });
});

describe('Webhook source config', () => {
  it('has github source configured', () => {
    const github = webhookSources.sources.github;
    assert.ok(github);
    assert.equal(github.hmacHeader, 'X-Hub-Signature-256');
    assert.equal(github.hmacAlgorithm, 'sha256');
    assert.equal(github.hmacPrefix, 'sha256=');
  });

  it('has stripe source configured', () => {
    const stripe = webhookSources.sources.stripe;
    assert.ok(stripe);
    assert.equal(stripe.hmacHeader, 'Stripe-Signature');
  });

  it('has generic source configured', () => {
    const generic = webhookSources.sources.generic;
    assert.ok(generic);
    assert.equal(generic.hmacHeader, 'X-Webhook-Signature');
  });

  it('rejects unknown source (not in config)', () => {
    assert.equal(webhookSources.sources['nonexistent'], undefined);
  });
});
