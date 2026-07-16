/**
 * Plan 036 guard — the migrated text-LLM callers must route through the
 * lib/llm/provider.js abstraction, not instantiate a provider SDK directly.
 *
 * This mirrors the per-file source guard used by push-prompt.test.js. eslint in
 * this repo only scans `src test` and eslint isn't wired into CI, so a test is
 * the enforcement mechanism that actually runs (`npm run test:ci`). It also
 * covers migrated files outside `src/` (agents/, tools/, scripts/) that eslint
 * would never see.
 *
 * NOT asserted here (deliberate, documented exceptions):
 *   - src/images/generator.js — image generation via @google/generative-ai; the
 *     text abstraction can't represent it (plan 036 Step 3b sanctioned exception).
 *
 * src/front-door/enrich.js and src/api-routes/governance.js were migrated in
 * issue #512 (repointed to the dated in-config models `claude-haiku-4-5-20251001`
 * / `claude-sonnet-4-6` — option (b) from the follow-up) and are now included
 * in MIGRATED below, fully closing Plan 036.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { computeCost } from '../../lib/llm/provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const abs = (p) => resolve(__dirname, p);

// Migrated site → the model constant it routes through the abstraction.
const MIGRATED = [
  { file: '../src/linear/issue-classifier.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../../agents/issue-triage/triage-evaluator.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../src/linear/v2-wiring.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../tools/front-door/seed-corpus.js', model: 'claude-sonnet-4-6' },
  { file: '../scripts/enrich-contacts.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../src/front-door/enrich.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../src/api-routes/governance.js', model: 'claude-haiku-4-5-20251001' },
  { file: '../src/api-routes/governance.js', model: 'claude-sonnet-4-6' },
];

const models = JSON.parse(readFileSync(abs('../config/agents.json'), 'utf8')).models;

test('migrated callers do not import a provider SDK directly', () => {
  for (const { file } of MIGRATED) {
    const src = readFileSync(abs(file), 'utf8');
    for (const needle of ['@anthropic-ai/sdk', '@google/generative-ai']) {
      assert.ok(
        !new RegExp(`from\\s+['"\`][^'"\`]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^'"\`]*['"\`]`).test(src),
        `${file} must not import "${needle}" — route through lib/llm/provider.js`,
      );
      assert.ok(!src.includes(`import('${needle}')`), `${file} must not dynamic-import "${needle}"`);
    }
    assert.ok(
      /lib\/llm\/provider\.js/.test(src),
      `${file} must import lib/llm/provider.js`,
    );
  }
});

test('every migrated model exists in the central agents.json model config', () => {
  for (const { file, model } of MIGRATED) {
    assert.ok(models[model], `${file} routes model "${model}" — must be present in agents.json models`);
  }
});

test('computeCost reproduces the rates the migrated sites previously hardcoded', () => {
  // enrich-contacts.js / issue routing used Haiku 4.5 at $1/$5 per MTok.
  const haiku = models['claude-haiku-4-5-20251001'];
  assert.equal(computeCost(1_000_000, 0, haiku), 1);
  assert.equal(computeCost(0, 1_000_000, haiku), 5);
  // seed-corpus.js used Sonnet at $3/$15 per MTok.
  const sonnet = models['claude-sonnet-4-6'];
  assert.equal(computeCost(1_000_000, 0, sonnet), 3);
  assert.equal(computeCost(0, 1_000_000, sonnet), 15);
});
