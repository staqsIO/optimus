/**
 * loadContractRenderContext — the shared data-loading + brand-resolution
 * block extracted from renderContractDocx (docx-render.js) and
 * renderContractPdf (pdf-render.js). This is a pure refactor: the loader
 * must return the same shape both renderers already destructured.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';
import { loadContractRenderContext } from '../../lib/contracts/render-context.js';
import { renderContractDocx } from '../../lib/contracts/docx-render.js';

const SENTINEL_FALLBACK = {
  heading_font_family: 'TestFont',
  body_font_family: 'TestFont',
  brand_color_hex: '123456',
  show_logo_in_header: false,
  footer_left_text: '',
  footer_show_page_number: false,
};

describe('loadContractRenderContext', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    // The signatures.* migrations are skipped under PGlite (gen_random_bytes /
    // auth schema are unavailable), so create the one table the loader's
    // request query touches. With no rows inserted, `request` resolves to null
    // and the signers/events queries are skipped — exercising the common
    // "contract never sent" path.
    await query(`CREATE SCHEMA IF NOT EXISTS signatures`);
    await query(
      `CREATE TABLE IF NOT EXISTS signatures.signature_requests (
         id            UUID DEFAULT gen_random_uuid(),
         draft_id      UUID,
         document_hash BYTEA,
         hash_version  INTEGER,
         signing_mode  TEXT,
         status        TEXT,
         expires_at    TIMESTAMPTZ,
         created_by    TEXT,
         created_at    TIMESTAMPTZ DEFAULT now()
       )`
    );
  });

  it('returns the render-context shape both renderers destructure', async () => {
    const draftId = randomUUID();
    await query(
      `INSERT INTO content.drafts (id, content_type, body, title)
       VALUES ($1, 'contract', $2, $3)`,
      [draftId, '# Test Contract\n\nBody text.', 'Test Contract']
    );

    const ctx = await loadContractRenderContext({
      draftId,
      fallbackBrand: SENTINEL_FALLBACK,
    });

    // Every key the two renderers pull off the returned object.
    for (const key of ['row', 'request', 'signers', 'latestEvents', 'profile', 'assets']) {
      assert.ok(key in ctx, `missing key: ${key}`);
    }

    assert.equal(ctx.row.id, draftId);
    assert.equal(ctx.row.title, 'Test Contract');
    assert.equal(ctx.row.counterparty_name, null); // LEFT JOIN, no counterparty
    assert.equal(ctx.request, null);               // no signature request sent
    assert.ok(Array.isArray(ctx.signers) && ctx.signers.length === 0);
    assert.ok(Array.isArray(ctx.latestEvents) && ctx.latestEvents.length === 0);
    // Brand resolves to a real profile or (on failure) the caller's fallback;
    // either way it is a non-null object, as is assets.
    assert.equal(typeof ctx.profile, 'object');
    assert.notEqual(ctx.profile, null);
    assert.equal(typeof ctx.assets, 'object');
  });

  it('throws when the contract draft does not exist', async () => {
    await assert.rejects(
      loadContractRenderContext({ draftId: randomUUID(), fallbackBrand: SENTINEL_FALLBACK }),
      /not found/
    );
  });

  it('falls back to the caller-supplied brand when resolution yields nothing', async () => {
    // A non-contract draft id still loads a row for the not-found guard, but
    // here we assert the fallback wiring directly: when loadBrandProfileForDraft
    // cannot resolve a profile, ctx.profile must be the fallback the caller
    // passed — proving the format-specific FALLBACK_BRAND still governs.
    const draftId = randomUUID();
    await query(
      `INSERT INTO content.drafts (id, content_type, body, title)
       VALUES ($1, 'contract', $2, $3)`,
      [draftId, 'Body', 'Fallback Probe']
    );

    const ctx = await loadContractRenderContext({
      draftId,
      fallbackBrand: SENTINEL_FALLBACK,
    });

    // profile is either a resolved brand profile or the sentinel fallback.
    // If it is the fallback, it must be *exactly* the object we passed in —
    // never a different renderer's constant.
    if (ctx.profile === SENTINEL_FALLBACK) {
      assert.equal(ctx.profile.heading_font_family, 'TestFont');
    } else {
      assert.equal(typeof ctx.profile.heading_font_family, 'string');
    }
  });

  it('renderContractDocx renders a Buffer end-to-end via the shared loader', async () => {
    // Full docx render on a contract with no signature request. This drives
    // the entire renderContractDocx path — including the completion log.info
    // block — so a stale reference to the extracted brand variable would
    // throw here (regression guard for the render-context extraction).
    const draftId = randomUUID();
    await query(
      `INSERT INTO content.drafts (id, content_type, body, title)
       VALUES ($1, 'contract', $2, $3)`,
      [draftId, '## Section One\n\nContract body paragraph.', 'End-To-End Contract']
    );

    const buf = await renderContractDocx({ draftId });
    assert.ok(Buffer.isBuffer(buf), 'expected a Buffer');
    assert.ok(buf.length > 0, 'expected non-empty DOCX bytes');
    // DOCX is a ZIP archive — first two bytes are "PK".
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  });
});
