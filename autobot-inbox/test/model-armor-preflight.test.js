import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertModelArmorProductionReady } from '../../lib/runtime/governance/model-armor-preflight.js';

// The preflight reads Model Armor config at call time from process.env
// (MODEL_ARMOR_MODE / MODEL_ARMOR_TEMPLATE). We control the production signal
// via the explicit `nodeEnv` option so we never have to mutate the real
// process.env.NODE_ENV (which other modules key off of).

describe('assertModelArmorProductionReady (G8 startup preflight)', () => {
  const saved = {};
  beforeEach(() => {
    saved.mode = process.env.MODEL_ARMOR_MODE;
    saved.template = process.env.MODEL_ARMOR_TEMPLATE;
    delete process.env.MODEL_ARMOR_MODE;
    delete process.env.MODEL_ARMOR_TEMPLATE;
  });
  afterEach(() => {
    if (saved.mode === undefined) delete process.env.MODEL_ARMOR_MODE;
    else process.env.MODEL_ARMOR_MODE = saved.mode;
    if (saved.template === undefined) delete process.env.MODEL_ARMOR_TEMPLATE;
    else process.env.MODEL_ARMOR_TEMPLATE = saved.template;
  });

  it('THROWS in production when agents enabled and Model Armor is unset (default warn, no template)', () => {
    // mode + template both unset → getModelArmorConfig() defaults to warn/null.
    assert.throws(
      () => assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: 'production' }),
      /preflight:G8.*Refusing to start agents in production/s
    );
  });

  it('THROWS in production when mode is explicitly warn even if a template is set', () => {
    process.env.MODEL_ARMOR_MODE = 'warn';
    process.env.MODEL_ARMOR_TEMPLATE = 'projects/x/locations/us/templates/t';
    assert.throws(
      () => assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: 'production' }),
      /MODEL_ARMOR_MODE is 'warn'/
    );
  });

  it('THROWS in production when mode=block but template is missing', () => {
    process.env.MODEL_ARMOR_MODE = 'block';
    // template unset
    assert.throws(
      () => assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: 'production' }),
      /MODEL_ARMOR_TEMPLATE is unset/
    );
  });

  it('PASSES in production when mode=block AND template is set (fully armed)', () => {
    process.env.MODEL_ARMOR_MODE = 'block';
    process.env.MODEL_ARMOR_TEMPLATE = 'projects/x/locations/us/templates/optimus-email-guard';
    const result = assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: 'production' });
    assert.deepEqual(result, { ok: true, mode: 'block' });
  });

  it('is a NO-OP in non-production (dev boot unaffected even with agents enabled + unset Model Armor)', () => {
    const result = assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: 'development' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'not-production');
  });

  it('is a NO-OP when NODE_ENV is undefined (bare `node` / test boot)', () => {
    const result = assertModelArmorProductionReady({ agentsEnabled: true, nodeEnv: undefined });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'not-production');
  });

  it('is a NO-OP in production when the process runs NO agents (api/ingestion-only role)', () => {
    // Even with Model Armor unset, an agent-less process is not gated.
    const result = assertModelArmorProductionReady({ agentsEnabled: false, nodeEnv: 'production' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'agents-disabled');
  });
});
