/**
 * Unit tests for the claudeCode provider in lib/llm/provider.js.
 *
 * Validation tests run pure (no subprocess). The dispatch test points
 * CLAUDE_BIN at a fake shell script that returns canned JSON in the same
 * shape as `claude -p --output-format json`. This exercises the full CLI
 * invocation pipeline without needing a real subscription token.
 *
 * Run: node --test test/llm-provider-claude-code.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLLMClient, callProvider, assertRequiredProvider } from '../../lib/llm/provider.js';

const MODELS = {
  'claude-code:sonnet': {
    provider: 'claudeCode',
    cliModel: 'sonnet',
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 200000,
    maxOutput: 64000,
  },
  'claude-code:no-cli-model': {
    provider: 'claudeCode',
    inputCostPer1M: 0,
    outputCostPer1M: 0,
  },
};

describe('claudeCode provider — validation', () => {
  let originalToken;

  before(() => {
    originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  after(() => {
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  });

  it('throws when CLAUDE_CODE_OAUTH_TOKEN is missing', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.throws(
      () => createLLMClient('claude-code:sonnet', MODELS),
      /CLAUDE_CODE_OAUTH_TOKEN required/
    );
  });

  it('throws when modelConfig.cliModel is missing', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    assert.throws(
      () => createLLMClient('claude-code:no-cli-model', MODELS),
      /missing required "cliModel"/
    );
  });

  it('returns a client with provider=claudeCode when valid', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    const llm = createLLMClient('claude-code:sonnet', MODELS);
    assert.equal(llm.provider, 'claudeCode');
    assert.equal(llm.modelId, 'claude-code:sonnet');
    assert.equal(llm.modelConfig.cliModel, 'sonnet');
    assert.equal(llm.client, null);
  });
});

describe('claudeCode provider — callProvider', () => {
  let llm;
  let originalClaudeBin;
  let originalToken;
  let tempDir;
  let fakeBinPath;
  let argLogPath;

  before(() => {
    originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalClaudeBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

    tempDir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    fakeBinPath = join(tempDir, 'fake-claude.sh');
    argLogPath = join(tempDir, 'last-args.txt');

    // Fake `claude` binary: writes args to a log file, returns canned JSON
    // in the same shape as `claude -p --output-format json`.
    const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argLogPath}"
cat <<'EOF'
{"result": "{\\"trends\\": [\\"agents\\", \\"voice\\"]}", "cost_usd": 0, "num_turns": 1, "duration_ms": 42, "is_error": false}
EOF
`;
    writeFileSync(fakeBinPath, script);
    chmodSync(fakeBinPath, 0o755);

    process.env.CLAUDE_BIN = fakeBinPath;
    llm = createLLMClient('claude-code:sonnet', MODELS);
  });

  after(() => {
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    if (originalClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = originalClaudeBin;
    try { unlinkSync(fakeBinPath); } catch {}
    try { unlinkSync(argLogPath); } catch {}
  });

  it('rejects tool calls (subscription path is text/JSON only)', async () => {
    await assert.rejects(
      callProvider(llm, {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [{ name: 'test_tool', input_schema: {} }],
      }),
      /does not support tool calls/
    );
  });

  it('rejects when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      callProvider(llm, {
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: controller.signal,
      }),
      /aborted/
    );
  });

  it('assertRequiredProvider passes when provider matches', () => {
    assert.doesNotThrow(() =>
      assertRequiredProvider(llm, 'claudeCode', 'executor-research', 'claude-code:sonnet')
    );
  });

  it('assertRequiredProvider passes when required is undefined (opt-in)', () => {
    assert.doesNotThrow(() =>
      assertRequiredProvider(llm, undefined, 'some-agent', 'some-model')
    );
  });

  it('assertRequiredProvider throws when provider does NOT match (catches API drift)', () => {
    // Simulate: someone edits researcher.model from claude-code:sonnet to
    // claude-sonnet-4-6 without removing requireProvider:"claudeCode".
    // Resolved provider would be "anthropic" → must throw.
    const fakeAnthropicClient = { provider: 'anthropic', modelId: 'claude-sonnet-4-6' };
    assert.throws(
      () => assertRequiredProvider(fakeAnthropicClient, 'claudeCode', 'executor-research', 'claude-sonnet-4-6'),
      /requires provider="claudeCode".*resolved to provider="anthropic".*Refusing to run/s
    );
  });

  it('invokes the CLI with the right args + normalizes the JSON response', async () => {
    const response = await callProvider(llm, {
      system: 'You are a researcher.',
      messages: [{ role: 'user', content: 'Find me 3 trends in AI.' }],
      maxTokens: 1024,
    });

    // Normalized response shape
    assert.equal(response.text, '{"trends": ["agents", "voice"]}');
    assert.equal(response.inputTokens, 0);
    assert.equal(response.outputTokens, 0);
    assert.equal(response.stopReason, 'end_turn');
    assert.deepEqual(response.toolCalls, []);

    // Verify the CLI was invoked with the right args (read from arg log)
    const { readFileSync } = await import('fs');
    const args = readFileSync(argLogPath, 'utf-8');
    assert.match(args, /-p\nFind me 3 trends in AI\./);
    assert.match(args, /--model\nsonnet/);
    assert.match(args, /--max-turns\n1/);
    assert.match(args, /--system-prompt\nYou are a researcher\./);
    // No --allowedTools flag (empty allowedTools array → no tools passed)
    assert.doesNotMatch(args, /--allowedTools/);
  });
});
