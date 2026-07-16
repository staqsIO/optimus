import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyByHeaders,
  classifyMachineNotification,
  classifyGithubNoise,
} from '../../lib/runtime/triage-header-sniff.js';

/**
 * STAQPRO-523 — header-sniff pre-LLM classifier.
 *
 * Each rule has at least one positive test and one negative test, plus a
 * shared override test proving that an inner_circle / active contact bypasses
 * the sniffer entirely (the safety belt for legitimate humans at
 * support@/hello@ addresses).
 */
describe('classifyByHeaders (STAQPRO-523)', () => {
  describe('Rule 1: List-Unsubscribe header', () => {
    it('returns noise when List-Unsubscribe is present', () => {
      const result = classifyByHeaders({
        from_address: 'subscriptions@medium.com',
        headers: { 'list-unsubscribe': '<mailto:unsubscribe@medium.com>' },
      });
      assert.deepEqual(result, { category: 'noise', reason: 'header_sniff:list_unsubscribe' });
    });

    it('returns null when List-Unsubscribe absent and no other rule fires', () => {
      const result = classifyByHeaders({
        from_address: 'dustin@umbadvisors.com',
        headers: {},
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 2: Precedence: bulk | list', () => {
    it('returns noise on Precedence: bulk', () => {
      const result = classifyByHeaders({
        from_address: 'newsletter@example.com',
        headers: { precedence: 'bulk' },
      });
      assert.equal(result.category, 'noise');
      assert.equal(result.reason, 'header_sniff:precedence_bulk');
    });

    it('returns noise on Precedence: list', () => {
      const result = classifyByHeaders({
        from_address: 'list@example.com',
        headers: { precedence: 'list' },
      });
      assert.equal(result.category, 'noise');
      assert.equal(result.reason, 'header_sniff:precedence_list');
    });

    it('returns null on Precedence: first-class', () => {
      const result = classifyByHeaders({
        from_address: 'real-human@example.com',
        headers: { precedence: 'first-class' },
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 3: Auto-Submitted', () => {
    it('returns noise on Auto-Submitted: auto-generated', () => {
      const result = classifyByHeaders({
        from_address: 'bounces@example.com',
        headers: { 'auto-submitted': 'auto-generated' },
      });
      assert.equal(result.category, 'noise');
      assert.equal(result.reason, 'header_sniff:auto_submitted');
    });

    it('returns null on Auto-Submitted: no', () => {
      const result = classifyByHeaders({
        from_address: 'real-human@example.com',
        headers: { 'auto-submitted': 'no' },
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 4: Generic role-account localpart', () => {
    it('returns fyi for hey@posthog.com', () => {
      const result = classifyByHeaders({
        from_address: 'hey@posthog.com',
      });
      assert.equal(result.category, 'fyi');
      assert.equal(result.reason, 'header_sniff:generic_localpart_hey');
    });

    it('returns NOISE (not fyi) for noreply@github.com — moved to machine_notification (STAQPRO-562)', () => {
      // Previously fyi via generic-localpart. Rule 0 now fires first: github.com
      // is a machine-notification vendor, so it is noise, never surfaced.
      const result = classifyByHeaders({
        from_address: 'noreply@github.com',
      });
      assert.equal(result.category, 'noise');
      assert.equal(result.reason, 'machine_notification:github.com');
    });

    it('returns null for a real localpart at a real domain', () => {
      const result = classifyByHeaders({
        from_address: 'dustin@umbadvisors.com',
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 5: Known ESP envelope sender', () => {
    it('returns fyi when From: domain ends in sendgrid.net', () => {
      const result = classifyByHeaders({
        from_address: 'no-bounce@em.sendgrid.net',
      });
      // generic localpart matches first (no-reply variant present? "no-bounce" doesn't)
      assert.equal(result.category, 'fyi');
      assert.ok(result.reason.startsWith('header_sniff:'));
    });

    it('returns fyi when Return-Path is on a known ESP even if From: is masked', () => {
      const result = classifyByHeaders({
        from_address: 'braden@clerk.com',
        headers: { 'return-path': '<bounce@bounces.sendgrid.net>' },
      });
      assert.equal(result.category, 'fyi');
      assert.equal(result.reason, 'header_sniff:esp_sendgrid.net');
    });

    it('returns null when neither From: nor Return-Path matches an ESP', () => {
      const result = classifyByHeaders({
        from_address: 'realuser@stripe.com',
        headers: { 'return-path': '<realuser@stripe.com>' },
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 6: Unsubscribe footer in snippet', () => {
    it('returns fyi when snippet contains an unsubscribe footer', () => {
      const result = classifyByHeaders({
        from_address: 'partnerships@anyvendor.com',
        snippet: 'Some marketing copy here. To unsubscribe, click here: https://example.com/opt-out',
      });
      assert.equal(result.category, 'fyi');
      assert.equal(result.reason, 'header_sniff:unsubscribe_footer');
    });

    it('returns null when "unsubscribe" appears without a link/CTA', () => {
      const result = classifyByHeaders({
        from_address: 'realhuman@example.com',
        snippet: 'I would like to unsubscribe from this discussion.',
      });
      assert.equal(result, null);
    });
  });

  describe('Rule 7: Gmail CATEGORY_PROMOTIONS / CATEGORY_FORUMS', () => {
    it('returns noise for CATEGORY_PROMOTIONS', () => {
      const result = classifyByHeaders({
        from_address: 'someone@vendor.com',
        labels: ['CATEGORY_PROMOTIONS', 'INBOX'],
      });
      assert.equal(result.category, 'noise');
      assert.equal(result.reason, 'header_sniff:gmail_promotions');
    });

    it('returns null for CATEGORY_PERSONAL', () => {
      const result = classifyByHeaders({
        from_address: 'realhuman@example.com',
        labels: ['CATEGORY_PERSONAL', 'INBOX'],
      });
      assert.equal(result, null);
    });
  });

  describe('Override: inner_circle / active contact bypasses the sniffer', () => {
    it('returns null when contactTier=inner_circle even with List-Unsubscribe', () => {
      const result = classifyByHeaders(
        {
          from_address: 'support@umbadvisors.com',
          headers: { 'list-unsubscribe': '<mailto:opt-out@umbadvisors.com>' },
        },
        { contactTier: 'inner_circle' }
      );
      assert.equal(result, null);
    });

    it('returns null when contactTier=active even with generic localpart', () => {
      const result = classifyByHeaders(
        { from_address: 'hello@partner.com' },
        { contactTier: 'active' }
      );
      assert.equal(result, null);
    });

    it('still fires when contactTier=unknown', () => {
      const result = classifyByHeaders(
        { from_address: 'hello@cold-vendor.com' },
        { contactTier: 'unknown' }
      );
      assert.equal(result.category, 'fyi');
    });

    it('still fires when contactTier=inbound_only', () => {
      const result = classifyByHeaders(
        { from_address: 'hello@cold-vendor.com' },
        { contactTier: 'inbound_only' }
      );
      assert.equal(result.category, 'fyi');
    });
  });

  describe('Defensive: malformed / missing inputs', () => {
    it('returns null on null message', () => {
      assert.equal(classifyByHeaders(null), null);
    });

    it('returns null on empty message', () => {
      assert.equal(classifyByHeaders({}), null);
    });

    it('handles array-valued header (multi-instance header)', () => {
      const result = classifyByHeaders({
        from_address: 'newsletter@example.com',
        headers: { 'list-unsubscribe': ['<mailto:a@b>', '<https://c/d>'] },
      });
      assert.equal(result.category, 'noise');
    });

    it('handles missing from_address gracefully', () => {
      const result = classifyByHeaders({
        headers: { 'list-unsubscribe': '<mailto:x@y>' },
      });
      assert.equal(result.category, 'noise');
    });
  });
});

/**
 * STAQPRO-562 — machine-notification class. INVARIANT: classification derived
 * ONLY from structured fields (channel, sender domain, event type, linked
 * work_item). No body content, no LLM.
 */
describe('classifyMachineNotification (STAQPRO-562)', () => {
  describe('github channel + noise event type → noise', () => {
    for (const ev of ['push', 'check_run', 'check_suite', 'workflow_run', 'status']) {
      it(`unlinked github ${ev} → noise`, () => {
        const r = classifyMachineNotification({ channel: 'github', eventType: ev });
        assert.equal(r.category, 'noise');
        assert.equal(r.reason, `machine_notification:github_${ev}`);
      });
    }

    it('any unlinked github event (no specific type) → noise via fallback', () => {
      const r = classifyMachineNotification({ channel: 'github', eventType: 'fork' });
      assert.equal(r.category, 'noise');
      assert.match(r.reason, /^machine_notification:github_unlinked/);
    });
  });

  describe('linked work_item bypasses the gate', () => {
    it('returns null when a github push is tied to an owned work_item', () => {
      const r = classifyMachineNotification({
        channel: 'github',
        eventType: 'push',
        linkedWorkItemId: 'pr:staqsIO/optimus#42',
      });
      assert.equal(r, null);
    });

    it('returns null for a linked pull_request review', () => {
      const r = classifyMachineNotification({
        channel: 'github',
        eventType: 'pull_request_review',
        linkedWorkItemId: 'pr:staqsIO/optimus#42',
      });
      assert.equal(r, null);
    });
  });

  describe('vendor sender domains → noise (email side)', () => {
    for (const d of ['github.com', 'linear.app', 'vercel.com', 'railway.app']) {
      it(`${d} sender → noise`, () => {
        const r = classifyMachineNotification({ channel: 'email', senderDomain: d });
        assert.equal(r.category, 'noise');
        assert.equal(r.reason, `machine_notification:${d}`);
      });
    }

    it('subdomain of a vendor (notifications.github.com) → noise', () => {
      const r = classifyMachineNotification({
        channel: 'email',
        senderDomain: 'notifications.github.com',
      });
      assert.equal(r.category, 'noise');
    });

    it('calendar-notification@google.com → noise (per-address override)', () => {
      const r = classifyMachineNotification({
        channel: 'email',
        senderDomain: 'google.com',
        fromAddress: 'calendar-notification@google.com',
      });
      assert.equal(r.category, 'noise');
    });

    it('a real human at google.com is NOT noise', () => {
      const r = classifyMachineNotification({
        channel: 'email',
        senderDomain: 'google.com',
        fromAddress: 'someone@google.com',
      });
      assert.equal(r, null);
    });
  });

  describe('non-vendor / non-github → null', () => {
    it('email from a normal domain with no vendor match → null', () => {
      const r = classifyMachineNotification({
        channel: 'email',
        senderDomain: 'umbadvisors.com',
      });
      assert.equal(r, null);
    });

    it('empty input → null', () => {
      assert.equal(classifyMachineNotification({}), null);
      assert.equal(classifyMachineNotification(null), null);
    });
  });

  describe('classifyByHeaders Rule 0 routes vendors to noise (not fyi)', () => {
    it('linear.app notification email → noise', () => {
      const r = classifyByHeaders({ from_address: 'notifications@linear.app' });
      assert.equal(r.category, 'noise');
      assert.equal(r.reason, 'machine_notification:linear.app');
    });

    it('vercel.com deploy email → noise', () => {
      const r = classifyByHeaders({ from_address: 'noreply@vercel.com' });
      assert.equal(r.category, 'noise');
      assert.equal(r.reason, 'machine_notification:vercel.com');
    });

    it('trusted-tier contact at a vendor domain still bypasses (safety belt)', () => {
      const r = classifyByHeaders(
        { from_address: 'someone@github.com' },
        { contactTier: 'inner_circle' }
      );
      assert.equal(r, null);
    });
  });
});

/**
 * STAQPRO-563 — explicit GitHub belt-and-suspenders rule. Independent of the
 * 562 vendor table: notifications@github.com OR List-ID containing github.com
 * → noise, no LLM. Structured fields only.
 */
describe('classifyGithubNoise (STAQPRO-563)', () => {
  it('notifications@github.com → noise (address trigger)', () => {
    const r = classifyGithubNoise('notifications@github.com', {});
    assert.equal(r.category, 'noise');
    assert.equal(r.reason, 'github_noise:notifications_address');
  });

  it('notifications@github.com with display name → noise', () => {
    const r = classifyGithubNoise('GitHub <notifications@github.com>', {});
    assert.equal(r.category, 'noise');
    assert.equal(r.reason, 'github_noise:notifications_address');
  });

  it('List-ID containing github.com → noise (header trigger)', () => {
    const r = classifyGithubNoise('whatever@example.com', {
      'list-id': 'staqsIO/optimus <optimus.staqsIO.github.com>',
    });
    assert.equal(r.category, 'noise');
    assert.equal(r.reason, 'github_noise:list_id');
  });

  it('non-github sender with no github List-ID → null', () => {
    const r = classifyGithubNoise('dustin@umbadvisors.com', {
      'list-id': 'something.else.com',
    });
    assert.equal(r, null);
  });

  it('empty/missing inputs → null', () => {
    assert.equal(classifyGithubNoise('', {}), null);
    assert.equal(classifyGithubNoise(null, null), null);
  });

  describe('wired into classifyByHeaders as Rule 0a', () => {
    it('notifications@github.com routes to github_noise reason (not the 562 domain reason)', () => {
      const r = classifyByHeaders({ from_address: 'notifications@github.com' });
      assert.equal(r.category, 'noise');
      assert.equal(r.reason, 'github_noise:notifications_address');
    });

    it('List-ID github.com on an otherwise-unknown sender → noise', () => {
      const r = classifyByHeaders({
        from_address: 'ci-bot@example.com',
        headers: { 'list-id': 'repo <repo.org.github.com>' },
      });
      assert.equal(r.category, 'noise');
      assert.equal(r.reason, 'github_noise:list_id');
    });

    it('trusted-tier human still bypasses even with the github rule', () => {
      const r = classifyByHeaders(
        { from_address: 'notifications@github.com' },
        { contactTier: 'active' }
      );
      assert.equal(r, null);
    });
  });
});
