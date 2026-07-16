import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRequiredEnvReady,
  REQUIRED_ENV_KEYS,
} from '../../lib/runtime/governance/required-env-preflight.js';

// Silent logger so warn paths don't pollute test output; captures messages.
function makeLogger() {
  const messages = [];
  return { messages, warn: (m) => messages.push(String(m)) };
}

const fullEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-placeholder',
  OPENROUTER_API_KEY: 'sk-or-placeholder',
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
};

test('production + a required key missing → throws listing it', () => {
  const logger = makeLogger();
  const env = { ...fullEnv };
  delete env.DATABASE_URL;
  assert.throws(
    () => assertRequiredEnvReady({ nodeEnv: 'production', env, logger }),
    (err) => {
      assert.match(err.message, /Refusing to start in production/);
      assert.match(err.message, /DATABASE_URL/);
      return true;
    }
  );
});

test('production + OPENROUTER_API_KEY missing → throws (BYO-key: OSS tiers route through OpenRouter)', () => {
  const logger = makeLogger();
  const env = { ...fullEnv };
  delete env.OPENROUTER_API_KEY;
  assert.throws(
    () => assertRequiredEnvReady({ nodeEnv: 'production', env, logger }),
    (err) => {
      assert.match(err.message, /Refusing to start in production/);
      assert.match(err.message, /OPENROUTER_API_KEY/);
      return true;
    }
  );
});

test('production + multiple required missing → single error lists all', () => {
  const logger = makeLogger();
  assert.throws(
    () => assertRequiredEnvReady({ nodeEnv: 'production', env: {}, logger }),
    (err) => {
      for (const k of REQUIRED_ENV_KEYS) assert.match(err.message, new RegExp(k));
      return true;
    }
  );
});

test('production + all required present → passes (no throw)', () => {
  const logger = makeLogger();
  const result = assertRequiredEnvReady({
    nodeEnv: 'production',
    env: { ...fullEnv },
    logger,
  });
  assert.equal(result.ok, true);
});

test('production + missing only RECOMMENDED (optional) → no throw, warns', () => {
  const logger = makeLogger();
  const result = assertRequiredEnvReady({
    nodeEnv: 'production',
    env: { ...fullEnv }, // required present, all recommended absent
    logger,
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.length > 0, 'expected a recommended-keys warning');
  assert.ok(logger.messages.some((m) => /recommended production env vars/.test(m)));
});

test('production + recommended satisfied by PEM-vs-PATH alternate → not warned for it', () => {
  const logger = makeLogger();
  const env = { ...fullEnv, AGENT_JWT_KEY_PATH: '/secrets/agent.pem' };
  const result = assertRequiredEnvReady({ nodeEnv: 'production', env, logger });
  assert.equal(result.ok, true);
  const warned = logger.messages.join('\n');
  assert.ok(!/AGENT_JWT_KEY_PEM/.test(warned), 'alternate PATH key should satisfy the group');
});

test('dev/test mode + required missing → does NOT throw (warns only)', () => {
  const logger = makeLogger();
  const result = assertRequiredEnvReady({ nodeEnv: 'development', env: {}, logger });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'not-production');
  assert.ok(logger.messages.some((m) => /non-production, not fatal/.test(m)));
});

test('undefined NODE_ENV (CI default) + required missing → no throw', () => {
  const logger = makeLogger();
  const result = assertRequiredEnvReady({ nodeEnv: undefined, env: {}, logger });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'not-production');
});

test('demo mode in production → required keys skipped, no throw', () => {
  const logger = makeLogger();
  const result = assertRequiredEnvReady({
    nodeEnv: 'production',
    demoMode: true,
    env: {},
    logger,
  });
  assert.equal(result.ok, true);
});
