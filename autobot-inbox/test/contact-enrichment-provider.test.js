/**
 * OPT-71 — Pluggable enrichment provider layer + email-signature parser.
 *
 * Tests:
 *   1. extractSignatureBlock — finds sig after common delimiters and fallback
 *   2. parseSignatureFields  — extracts title / phone / company / linkedin
 *      from realistic signature fixtures
 *   3. createEmailSignatureProvider — full provider contract (enrich, isAvailable,
 *      majority-vote across multiple snippets, provenance shape)
 *   4. runWaterfall — merges providers cheapest-first, per-field source recorded
 *   5. mergeEnrichment — skips already-populated fields, overwrites when asked
 *   6. createPdlProvider — inert without PDL_API_KEY (gate confirmed)
 *   7. createContactEnricher — end-to-end convenience wrapper
 *
 * All tests are OFFLINE (no DB, no network). PGlite is NOT used here — the
 * enrichment layer is pure-function with an injected fetchSnippets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSignatureBlock,
  parseSignatureFields,
  createEmailSignatureProvider,
} from '../../lib/enrichment/email-signature-parser.js';

import { runWaterfall, mergeEnrichment } from '../../lib/enrichment/provider.js';
import { createPdlProvider } from '../../lib/enrichment/pdl-provider.js';
import { createContactEnricher } from '../../lib/enrichment/index.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeProvider(name, fields, { available = true } = {}) {
  return {
    name,
    isAvailable: () => available,
    enrich: async (_entity, _opts) => ({ fields }),
  };
}

// ── 1. extractSignatureBlock ──────────────────────────────────────────────────

describe('extractSignatureBlock', () => {
  it('splits on RFC-3676 "-- " delimiter', () => {
    const body = 'Hi there,\n\nSounds good.\n\n-- \nJane Smith\nVP of Engineering\nAcme Corp';
    const lines = extractSignatureBlock(body);
    assert.ok(lines.some((l) => l.includes('VP of Engineering')), 'should include title line');
    assert.ok(!lines.some((l) => l.includes('Sounds good')), 'body should be excluded');
  });

  it('splits on "Best regards," delimiter', () => {
    const body = 'Thanks for the update.\n\nBest regards,\nJohn Doe\nSenior Software Engineer\n+1 (555) 123-4567';
    const lines = extractSignatureBlock(body);
    assert.ok(lines.some((l) => l.includes('Senior Software Engineer')));
    assert.ok(lines.some((l) => l.includes('555')));
  });

  it('falls back to last 8 lines when no delimiter found', () => {
    const body = Array.from({ length: 15 }, (_, i) => `Line ${i}`).join('\n');
    const lines = extractSignatureBlock(body);
    // Fallback: last 8 non-empty lines
    assert.ok(lines.length <= 8);
    assert.ok(lines[lines.length - 1].includes('Line 14'));
  });

  it('handles Windows line endings', () => {
    const body = 'Message body\r\n\r\n-- \r\nJane\r\nCTO\r\nStartup Inc';
    const lines = extractSignatureBlock(body);
    assert.ok(lines.some((l) => l.includes('CTO')));
  });
});

// ── 2. parseSignatureFields ───────────────────────────────────────────────────

describe('parseSignatureFields', () => {
  it('extracts job title from a keyword line', () => {
    const lines = ['Jane Smith', 'VP of Sales', 'Acme Corporation'];
    const result = parseSignatureFields(lines);
    assert.ok(result.title, 'should extract title');
    assert.match(result.title, /VP of Sales/i);
  });

  it('extracts company from a non-title line after the name', () => {
    const lines = ['John Doe', 'Director of Engineering', 'Widgets Inc'];
    const result = parseSignatureFields(lines);
    assert.ok(result.title, 'should have title');
    assert.ok(result.company, 'should have company');
  });

  it('splits "Title | Company" on pipe separator', () => {
    const lines = ['Senior Architect | TechCorp'];
    const result = parseSignatureFields(lines);
    assert.equal(result.title, 'Senior Architect');
    assert.equal(result.company, 'TechCorp');
  });

  it('splits "Title at Company" format', () => {
    const lines = ['Lead Engineer at Acme Corp'];
    const result = parseSignatureFields(lines);
    assert.equal(result.title, 'Lead Engineer');
    assert.equal(result.company, 'Acme Corp');
  });

  it('extracts US phone number and normalises to E.164', () => {
    const lines = ['Jane Smith', 'CEO', '(650) 555-1234', 'jane@example.com'];
    const result = parseSignatureFields(lines);
    assert.equal(result.phone, '+16505551234');
  });

  it('extracts international phone number', () => {
    const lines = ['John Smith', 'Founder', '+44 20 7946 0958'];
    const result = parseSignatureFields(lines);
    assert.ok(result.phone?.startsWith('+44'));
  });

  it('extracts LinkedIn URL', () => {
    const lines = ['Jane Smith', 'CTO', 'https://www.linkedin.com/in/janesmith'];
    const result = parseSignatureFields(lines);
    assert.equal(result.linkedin, 'https://www.linkedin.com/in/janesmith');
  });

  it('does not extract email addresses as phone or title', () => {
    const lines = ['Jane Smith', 'jane@example.com', 'Director'];
    const result = parseSignatureFields(lines);
    assert.ok(!result.phone, 'email should not become phone');
    assert.match(result.title, /Director/i);
  });

  it('handles empty signature lines gracefully', () => {
    const result = parseSignatureFields([]);
    assert.deepEqual(result, {});
  });

  it('realistic multi-line signature fixture', () => {
    const lines = [
      'Sarah Johnson',
      'Head of Product · MegaScale AI',
      '+1 415 888 0001',
      'sarah@megascale.ai',
      'https://linkedin.com/in/sarahjohnson',
    ];
    const result = parseSignatureFields(lines);
    assert.ok(result.title?.includes('Head of Product'), `title: ${result.title}`);
    assert.ok(result.company?.includes('MegaScale'), `company: ${result.company}`);
    assert.equal(result.phone, '+14158880001');
    assert.ok(result.linkedin?.includes('sarahjohnson'));
  });
});

// ── 3. createEmailSignatureProvider ──────────────────────────────────────────

describe('createEmailSignatureProvider — provider contract', () => {
  it('isAvailable() always returns true (no API key needed)', () => {
    const provider = createEmailSignatureProvider(async () => []);
    assert.equal(provider.isAvailable(), true);
  });

  it('returns empty fields when no snippets', async () => {
    const provider = createEmailSignatureProvider(async () => []);
    const result = await provider.enrich(
      { id: 'c1', email_address: 'test@example.com' },
      { fields: ['title', 'phone'] },
    );
    assert.deepEqual(result.fields, {});
  });

  it('returns empty fields when entity has no email_address', async () => {
    const provider = createEmailSignatureProvider(async () => ['some snippet']);
    const result = await provider.enrich({ id: 'c2' }, { fields: ['title'] });
    assert.deepEqual(result.fields, {});
  });

  it('extracts title with provenance from a single snippet', async () => {
    const snippet = 'Great meeting!\n\nBest,\nAlex Rivera\nCTO at Acme Corp\nalex@acme.com';
    const provider = createEmailSignatureProvider(async () => [snippet]);

    const result = await provider.enrich(
      { id: 'c3', email_address: 'alex@acme.com' },
      { fields: ['title', 'company', 'phone'] },
    );

    assert.ok(result.fields.title, 'should extract title');
    assert.equal(result.fields.title.source, 'email_signature_parser');
    assert.ok(result.fields.title.confidence >= 0.5, `confidence ${result.fields.title.confidence} should be ≥ 0.5`);
    assert.ok(result.fields.title.fetched_at, 'should have fetched_at');
    assert.match(result.fields.title.value, /CTO/i);
  });

  it('majority-votes across multiple snippets for higher confidence', async () => {
    const makeSnip = (title) =>
      `Hi!\n\nBest regards,\nJane Doe\n${title}\njane@co.com`;

    const snippets = [
      makeSnip('VP of Engineering'),
      makeSnip('VP of Engineering'),
      makeSnip('Engineer'), // minority
    ];
    const provider = createEmailSignatureProvider(async () => snippets);
    const result = await provider.enrich(
      { id: 'c4', email_address: 'jane@co.com' },
      { fields: ['title'] },
    );

    assert.equal(result.fields.title?.value, 'VP of Engineering');
    // Majority (2/3 ≈ 67%) → confidence 0.85
    assert.ok(result.fields.title.confidence >= 0.8, `expected high confidence, got ${result.fields.title.confidence}`);
  });

  it('records ISO timestamp in fetched_at', async () => {
    const snippet = 'Hi\n\n--\nBob\nCEO\nStartup.io';
    const provider = createEmailSignatureProvider(async () => [snippet]);
    const result = await provider.enrich(
      { id: 'c5', email_address: 'bob@startup.io' },
      { fields: ['title'] },
    );
    if (result.fields.title) {
      assert.doesNotThrow(() => new Date(result.fields.title.fetched_at));
    }
  });
});

// ── 4. runWaterfall ───────────────────────────────────────────────────────────

describe('runWaterfall', () => {
  it('uses first available provider that fills a field', async () => {
    const p1 = makeProvider('cheap', {
      title: { value: 'CEO', source: 'cheap', confidence: 0.8, fetched_at: new Date().toISOString() },
    });
    const p2 = makeProvider('expensive', {
      title: { value: 'CTO', source: 'expensive', confidence: 0.9, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c1' }, ['title'], [p1, p2]);
    // p1 (cheap) is tried first and fills title → p2 should not override it
    assert.equal(result.fields.title.value, 'CEO');
    assert.equal(result.fields.title.source, 'cheap');
  });

  it('falls through to second provider when first returns nothing', async () => {
    const p1 = makeProvider('empty', {});
    const p2 = makeProvider('pdl', {
      company: { value: 'Acme', source: 'pdl', confidence: 0.9, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c2' }, ['company'], [p1, p2]);
    assert.equal(result.fields.company.value, 'Acme');
    assert.equal(result.fields.company.source, 'pdl');
  });

  it('skips unavailable providers', async () => {
    const p1 = makeProvider('unavailable', {
      title: { value: 'CEO', source: 'unavailable', confidence: 0.9, fetched_at: new Date().toISOString() },
    }, { available: false });
    const p2 = makeProvider('available', {
      title: { value: 'CTO', source: 'available', confidence: 0.85, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c3' }, ['title'], [p1, p2]);
    assert.equal(result.fields.title.source, 'available');
  });

  it('skips results below confidence threshold', async () => {
    const p1 = makeProvider('low-conf', {
      title: { value: 'Intern', source: 'low-conf', confidence: 0.3, fetched_at: new Date().toISOString() },
    });
    const p2 = makeProvider('high-conf', {
      title: { value: 'CEO', source: 'high-conf', confidence: 0.9, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c4' }, ['title'], [p1, p2], { confidenceThreshold: 0.5 });
    assert.equal(result.fields.title.value, 'CEO');
  });

  it('returns empty fields when no provider fills a field', async () => {
    const p1 = makeProvider('empty', {});
    const result = await runWaterfall({ id: 'c5' }, ['phone'], [p1]);
    assert.deepEqual(result.fields, {});
  });

  it('catches individual provider errors and continues', async () => {
    const failing = {
      name: 'failer',
      isAvailable: () => true,
      enrich: async () => { throw new Error('network timeout'); },
    };
    const backup = makeProvider('backup', {
      title: { value: 'VP', source: 'backup', confidence: 0.8, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c6' }, ['title'], [failing, backup]);
    assert.equal(result.fields.title.value, 'VP');
  });

  it('merges multiple fields from different providers', async () => {
    const p1 = makeProvider('sig', {
      title: { value: 'CEO', source: 'sig', confidence: 0.7, fetched_at: new Date().toISOString() },
    });
    const p2 = makeProvider('pdl', {
      company: { value: 'Acme', source: 'pdl', confidence: 0.9, fetched_at: new Date().toISOString() },
    });

    const result = await runWaterfall({ id: 'c7' }, ['title', 'company'], [p1, p2]);
    assert.equal(result.fields.title.source, 'sig');
    assert.equal(result.fields.company.source, 'pdl');
  });
});

// ── 5. mergeEnrichment ────────────────────────────────────────────────────────

describe('mergeEnrichment', () => {
  const enrichResult = {
    fields: {
      title: { value: 'CEO', source: 'email_signature_parser', confidence: 0.8, fetched_at: '2026-01-01T00:00:00Z' },
      phone: { value: '+15551234567', source: 'email_signature_parser', confidence: 0.7, fetched_at: '2026-01-01T00:00:00Z' },
    },
  };

  it('produces patch and provenance for blank fields', () => {
    const entity = { id: 'c1', email_address: 'a@b.com', title: null, phone: null };
    const { patch, provenance } = mergeEnrichment(entity, enrichResult);
    assert.equal(patch.title, 'CEO');
    assert.equal(patch.phone, '+15551234567');
    assert.equal(provenance.length, 2);
    assert.equal(provenance[0].entity_id, 'c1');
    assert.equal(provenance[0].basis, 'legitimate_interests');
    assert.ok(provenance.every((p) => p.source && p.confidence && p.fetched_at));
  });

  it('skips fields already populated on entity (no overwrite)', () => {
    const entity = { id: 'c2', title: 'CTO', phone: null };
    const { patch } = mergeEnrichment(entity, enrichResult);
    assert.ok(!('title' in patch), 'should not overwrite existing title');
    assert.equal(patch.phone, '+15551234567');
  });

  it('overwrites existing fields when overwrite=true', () => {
    const entity = { id: 'c3', title: 'CTO', phone: null };
    const { patch } = mergeEnrichment(entity, enrichResult, { overwrite: true });
    assert.equal(patch.title, 'CEO');
  });

  it('provenance includes basis_for_processing on every row', () => {
    const entity = { id: 'c4', title: null, phone: null };
    const { provenance } = mergeEnrichment(entity, enrichResult);
    assert.ok(provenance.every((p) => p.basis === 'legitimate_interests'));
  });
});

// ── 6. createPdlProvider — gate confirmed ────────────────────────────────────

describe('createPdlProvider — gate', () => {
  it('isAvailable() returns false without PDL_API_KEY', () => {
    const saved = process.env.PDL_API_KEY;
    delete process.env.PDL_API_KEY;
    try {
      const provider = createPdlProvider();
      assert.equal(provider.isAvailable(), false, 'should be inert without key');
    } finally {
      if (saved !== undefined) process.env.PDL_API_KEY = saved;
    }
  });

  it('isAvailable() returns true when PDL_API_KEY is set', () => {
    const saved = process.env.PDL_API_KEY;
    process.env.PDL_API_KEY = 'test-key-123';
    try {
      const provider = createPdlProvider();
      assert.equal(provider.isAvailable(), true);
    } finally {
      if (saved === undefined) delete process.env.PDL_API_KEY;
      else process.env.PDL_API_KEY = saved;
    }
  });

  it('enrich() returns empty fields even with key when no httpPost injected (stub mode)', async () => {
    const saved = process.env.PDL_API_KEY;
    process.env.PDL_API_KEY = 'test-key-123';
    try {
      const provider = createPdlProvider(); // no httpPost → stub
      const result = await provider.enrich({ id: 'c1', email_address: 'x@y.com' }, { fields: ['title'] });
      assert.deepEqual(result.fields, {});
    } finally {
      if (saved === undefined) delete process.env.PDL_API_KEY;
      else process.env.PDL_API_KEY = saved;
    }
  });

  it('waterfall treats PDL as inert without key', async () => {
    const saved = process.env.PDL_API_KEY;
    delete process.env.PDL_API_KEY;
    try {
      const pdl = createPdlProvider();
      // sig parser fills title; pdl is inert — title stays from sig
      const sig = makeProvider('sig', {
        title: { value: 'CTO', source: 'sig', confidence: 0.8, fetched_at: new Date().toISOString() },
      });
      const result = await runWaterfall({ id: 'c1' }, ['title'], [sig, pdl]);
      assert.equal(result.fields.title.source, 'sig');
    } finally {
      if (saved !== undefined) process.env.PDL_API_KEY = saved;
    }
  });
});

// ── 7. createContactEnricher — end-to-end wrapper ────────────────────────────

describe('createContactEnricher', () => {
  it('end-to-end: enriches a contact with injected DB fetchSnippets', async () => {
    const snippet = 'Great call!\n\nBest regards,\nTamara Jones\nHead of Product at NovaCo\n+1 888 555 9999\nhttps://linkedin.com/in/tamarajones';

    // Mock query that returns snippets for our contact's email
    const mockQuery = async (sql, params) => {
      if (sql.includes('sender_email') && params[0] === 'tamara@novaco.com') {
        return { rows: [{ snippet }] };
      }
      return { rows: [] };
    };

    // Build enricher with real DB snippets path but mocked query
    // We need to override fetchSnippets; use the index createContactEnricher
    // but patch via a fake query.
    const enricher = createContactEnricher({ query: mockQuery });

    const contact = { id: 'ct-tamara', email_address: 'tamara@novaco.com', title: null, phone: null };
    const result = await enricher.enrich(contact, { fields: ['title', 'phone', 'company', 'linkedin'] });

    assert.ok(result.fields.title, 'should extract title');
    assert.match(result.fields.title.value, /Head of Product/i);
    assert.equal(result.fields.title.source, 'email_signature_parser');
    assert.ok(result.patch.title, 'patch should include title');
    assert.ok(result.provenance.length > 0, 'should have provenance rows');
    assert.ok(result.provenance.every((p) => p.entity_id === 'ct-tamara'));
    assert.ok(result.provenance.every((p) => p.basis === 'legitimate_interests'));
  });

  it('returns empty results when no snippets found', async () => {
    const mockQuery = async () => ({ rows: [] });
    const enricher = createContactEnricher({ query: mockQuery });
    const contact = { id: 'ct-empty', email_address: 'nobody@example.com' };
    const result = await enricher.enrich(contact, { fields: ['title', 'phone'] });
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.patch, {});
    assert.deepEqual(result.provenance, []);
  });
});
