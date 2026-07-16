import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quickScore } from '../src/signal/priority-scorer.js';

describe('quickScore', () => {
  it('returns base score for unknown email', () => {
    const email = { subject: 'Hello', labels: [] };
    const score = quickScore(email);
    assert.equal(score, 50);
  });

  it('boosts VIP contacts', () => {
    const email = { subject: 'Hello', labels: [] };
    const contact = { is_vip: true, contact_type: 'unknown', emails_received: 5 };
    const score = quickScore(email, contact);
    assert.ok(score > 70);
  });

  it('boosts investor contacts', () => {
    const email = { subject: 'Follow up', labels: [] };
    const contact = { is_vip: false, contact_type: 'investor', emails_received: 10 };
    const score = quickScore(email, contact);
    assert.ok(score > 70);
  });

  it('boosts urgent subjects', () => {
    const email = { subject: 'URGENT: Server down', labels: [] };
    const score = quickScore(email);
    assert.ok(score >= 70);
  });

  it('penalizes promotions', () => {
    const email = { subject: 'Sale this week', labels: ['CATEGORY_PROMOTIONS'] };
    const score = quickScore(email);
    assert.ok(score < 50);
  });

  it('caps score at 0-100', () => {
    const email = { subject: 'URGENT', labels: ['IMPORTANT'] };
    const contact = { is_vip: true, contact_type: 'investor', emails_received: 100 };
    const score = quickScore(email, contact);
    assert.ok(score >= 0 && score <= 100);
  });
});
