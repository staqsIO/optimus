import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import summarizeDef from '../agents/flow-agents/summarize/index.js';
import classifyTextDef from '../agents/flow-agents/classify_text/index.js';
import extractEntitiesDef from '../agents/flow-agents/extract_entities/index.js';
import rewriteToneDef from '../agents/flow-agents/rewrite_tone/index.js';
import { runFlowAgent } from '../agents/flow-agents/shared/runner.js';
import { setLLMImpl, resetLLMImpl } from '../agents/flow-agents/shared/llm.js';
import { validateInput, validateOutput } from '../agents/flow-agents/shared/schema.js';
import { render } from '../agents/flow-agents/shared/template.js';
import { getFlowAgent } from '../agents/flow-agents/index.js';

// ---------------------------------------------------------------------------
// LLM mock — records the last call, returns a scripted response per test.
// ---------------------------------------------------------------------------

function mockLLM(script) {
  const calls = [];
  setLLMImpl(async (args) => {
    calls.push(args);
    const next = typeof script === 'function' ? script(args, calls.length - 1) : script;
    // Default cost/tokens to trivial values if not provided by the script.
    return {
      text: next.text ?? '',
      inputTokens: next.inputTokens ?? 100,
      outputTokens: next.outputTokens ?? 50,
      costUsd: next.costUsd ?? 0.0001,
      model: args.model,
    };
  });
  return calls;
}

afterEach(() => resetLLMImpl());

// ---------------------------------------------------------------------------
// schema.js — input validation + default filling + output validation
// ---------------------------------------------------------------------------

describe('schema.validateInput', () => {
  it('fills defaults for missing optional fields', () => {
    const schema = {
      text: { type: 'string', required: true },
      maxWords: { type: 'number', default: 100 },
      style: { type: 'string', default: 'concise' },
    };
    const result = validateInput(schema, { text: 'hello' });
    assert.equal(result.text, 'hello');
    assert.equal(result.maxWords, 100);
    assert.equal(result.style, 'concise');
  });

  it('throws on missing required field', () => {
    const schema = { text: 'string' };
    assert.throws(() => validateInput(schema, {}), /Missing required field "text"/);
  });

  it('throws on wrong type', () => {
    const schema = { maxWords: { type: 'number', default: 100 } };
    assert.throws(
      () => validateInput(schema, { maxWords: 'not-a-number' }),
      /wrong type: expected number, got string/
    );
  });

  it('enforces enum constraint', () => {
    const schema = { style: { type: 'string', default: 'concise', enum: ['concise', 'bullet-points'] } };
    assert.throws(
      () => validateInput(schema, { style: 'weird' }),
      /must be one of/
    );
  });

  it('accepts multi-type fields', () => {
    const schema = { v: { type: ['string', 'number', 'null'], default: null } };
    assert.equal(validateInput(schema, { v: 'hi' }).v, 'hi');
    assert.equal(validateInput(schema, { v: 5 }).v, 5);
    assert.equal(validateInput(schema, { v: null }).v, null);
    assert.throws(() => validateInput(schema, { v: true }), /wrong type: expected string\|number\|null/);
  });
});

describe('schema.validateOutput', () => {
  it('requires every declared field', () => {
    const schema = { a: 'string', b: 'number' };
    assert.deepEqual(validateOutput(schema, { a: 'x', b: 1 }), { a: 'x', b: 1 });
    assert.throws(() => validateOutput(schema, { a: 'x' }), /Output missing required field "b"/);
  });

  it('rejects wrong-typed output', () => {
    assert.throws(
      () => validateOutput({ n: 'number' }, { n: 'nope' }),
      /Output field "n" has wrong type/
    );
  });
});

// ---------------------------------------------------------------------------
// template.js — placeholder substitution
// ---------------------------------------------------------------------------

describe('template.render', () => {
  it('substitutes simple placeholders', () => {
    assert.equal(render('Hello {{name}}', { name: 'world' }), 'Hello world');
  });

  it('stringifies arrays and objects', () => {
    const result = render('List: {{xs}}', { xs: ['a', 'b'] });
    assert.equal(result, 'List: ["a","b"]');
  });

  it('throws when template references unknown field', () => {
    assert.throws(
      () => render('Hi {{missing}}', { name: 'a' }),
      /undeclared field\(s\): missing/
    );
  });
});

// ---------------------------------------------------------------------------
// runFlowAgent — summarize path (single-string output)
// ---------------------------------------------------------------------------

describe('summarize flow-agent', () => {
  it('executes end-to-end with mocked LLM and fills defaults', async () => {
    const calls = mockLLM({ text: 'This is a short summary.' });

    const { output, metadata } = await runFlowAgent({
      definition: summarizeDef,
      input: { text: 'Long input text that needs summarizing...' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-haiku-4-5-20251001');
    // Defaults filled into prompt
    assert.match(calls[0].prompt, /at most 100 words/);
    assert.match(calls[0].prompt, /concise style/);
    assert.equal(output.summary, 'This is a short summary.');
    assert.equal(metadata.model, 'claude-haiku-4-5-20251001');
    assert.ok(metadata.durationMs >= 0);
  });

  it('passes custom maxWords and style through to prompt', async () => {
    const calls = mockLLM({ text: '- bullet one\n- bullet two' });
    await runFlowAgent({
      definition: summarizeDef,
      input: { text: 'x', maxWords: 30, style: 'bullet-points' },
    });
    assert.match(calls[0].prompt, /at most 30 words/);
    assert.match(calls[0].prompt, /bullet-points style/);
  });

  it('rejects invalid style (enum violation)', async () => {
    mockLLM({ text: 'unused' });
    await assert.rejects(
      runFlowAgent({ definition: summarizeDef, input: { text: 'x', style: 'weird' } }),
      /must be one of/
    );
  });

  it('rejects missing required text', async () => {
    mockLLM({ text: 'unused' });
    await assert.rejects(
      runFlowAgent({ definition: summarizeDef, input: {} }),
      /Missing required field "text"/
    );
  });

  it('rejects when estimated cost exceeds maxCostUsd', async () => {
    // Use an artificially low ceiling and a huge input to blow past it.
    const def = { ...summarizeDef, maxCostUsd: 0.000001 };
    const calls = mockLLM({ text: 'never-called' });
    await assert.rejects(
      runFlowAgent({ definition: def, input: { text: 'x'.repeat(100000) } }),
      /estimated cost .* exceeds maxCostUsd/
    );
    assert.equal(calls.length, 0, 'LLM must not be called when cost gate trips');
  });
});

// ---------------------------------------------------------------------------
// runFlowAgent — classify_text path (JSON output + validation + retry)
// ---------------------------------------------------------------------------

describe('classify_text flow-agent', () => {
  it('parses JSON output and validates all fields', async () => {
    mockLLM({
      text: JSON.stringify({ category: 'urgent', confidence: 0.9, rationale: 'contains deadline' }),
    });

    const { output } = await runFlowAgent({
      definition: classifyTextDef,
      input: { text: 'respond by EOD', categories: ['urgent', 'normal', 'fyi'] },
    });

    assert.equal(output.category, 'urgent');
    assert.equal(output.confidence, 0.9);
    assert.equal(output.rationale, 'contains deadline');
  });

  it('strips markdown fences around JSON', async () => {
    mockLLM({
      text: '```json\n{"category":"fyi","confidence":0.6,"rationale":"just info"}\n```',
    });
    const { output } = await runFlowAgent({
      definition: classifyTextDef,
      input: { text: 't', categories: ['fyi'] },
    });
    assert.equal(output.category, 'fyi');
  });

  it('retries once with a JSON nudge when first response is unparseable', async () => {
    let call = 0;
    const calls = mockLLM(() => {
      call += 1;
      if (call === 1) return { text: 'sorry, I cannot produce JSON here' };
      return { text: JSON.stringify({ category: 'x', confidence: 0.5, rationale: 'ok' }) };
    });

    const { output } = await runFlowAgent({
      definition: classifyTextDef,
      input: { text: 't', categories: ['x'] },
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Return ONLY a JSON object/);
    assert.equal(output.category, 'x');
  });

  it('throws when retry also fails', async () => {
    mockLLM({ text: 'garbage non-json response' });
    await assert.rejects(
      runFlowAgent({ definition: classifyTextDef, input: { text: 't', categories: ['a'] } }),
      /Could not parse JSON|Output missing|wrong type/
    );
  });

  it('fills the context default when omitted', async () => {
    const calls = mockLLM({
      text: JSON.stringify({ category: 'a', confidence: 0.7, rationale: 'r' }),
    });
    await runFlowAgent({
      definition: classifyTextDef,
      input: { text: 't', categories: ['a'] },
    });
    // Default context is "" — prompt should render without throwing on undeclared field.
    assert.match(calls[0].prompt, /Additional context/);
  });
});

// ---------------------------------------------------------------------------
// runFlowAgent — extract_entities (single-field array output)
// ---------------------------------------------------------------------------

describe('extract_entities flow-agent', () => {
  it('parses an entities array and validates type', async () => {
    mockLLM({
      text: JSON.stringify({
        entities: [
          { type: 'date', value: '2026-05-01', snippet: 'on May 1' },
          { type: 'amount', value: '5000', snippet: '$5,000' },
        ],
      }),
    });

    const { output } = await runFlowAgent({
      definition: extractEntitiesDef,
      input: { text: 'Deadline on May 1, budget $5,000.', entityTypes: ['date', 'amount'] },
    });

    assert.ok(Array.isArray(output.entities));
    assert.equal(output.entities.length, 2);
    assert.equal(output.entities[0].type, 'date');
  });

  it('accepts an empty entities array (nothing found)', async () => {
    mockLLM({ text: JSON.stringify({ entities: [] }) });
    const { output } = await runFlowAgent({
      definition: extractEntitiesDef,
      input: { text: 'hello', entityTypes: ['date'] },
    });
    assert.deepEqual(output.entities, []);
  });

  it('passes entityTypes into the rendered prompt', async () => {
    const calls = mockLLM({ text: JSON.stringify({ entities: [] }) });
    await runFlowAgent({
      definition: extractEntitiesDef,
      input: { text: 't', entityTypes: ['person', 'url'] },
    });
    assert.match(calls[0].prompt, /\["person","url"\]/);
  });

  it('rejects when entityTypes is not an array', async () => {
    mockLLM({ text: 'unused' });
    await assert.rejects(
      runFlowAgent({ definition: extractEntitiesDef, input: { text: 't', entityTypes: 'date' } }),
      /wrong type: expected array/
    );
  });

  it('rejects when output is not an array (type mismatch)', async () => {
    mockLLM({ text: JSON.stringify({ entities: 'oops not an array' }) });
    await assert.rejects(
      runFlowAgent({ definition: extractEntitiesDef, input: { text: 't', entityTypes: ['x'] } }),
      /Output field "entities" has wrong type/
    );
  });
});

// ---------------------------------------------------------------------------
// runFlowAgent — rewrite_tone (single-string output, enum on tone)
// ---------------------------------------------------------------------------

describe('rewrite_tone flow-agent', () => {
  it('returns the rewritten text as a trimmed string', async () => {
    mockLLM({ text: '  Hello, this is more formal.  \n' });
    const { output } = await runFlowAgent({
      definition: rewriteToneDef,
      input: { text: 'hey whats up', tone: 'formal' },
    });
    assert.equal(output.rewritten, 'Hello, this is more formal.');
  });

  it('passes tone through to the prompt', async () => {
    const calls = mockLLM({ text: 'rewritten' });
    await runFlowAgent({
      definition: rewriteToneDef,
      input: { text: 'x', tone: 'assertive' },
    });
    assert.match(calls[0].prompt, /Target tone: assertive/);
  });

  it('rejects unknown tone (enum violation)', async () => {
    mockLLM({ text: 'unused' });
    await assert.rejects(
      runFlowAgent({ definition: rewriteToneDef, input: { text: 'x', tone: 'dramatic' } }),
      /must be one of/
    );
  });

  it('fills default instructions when omitted', async () => {
    const calls = mockLLM({ text: 'y' });
    await runFlowAgent({
      definition: rewriteToneDef,
      input: { text: 'x', tone: 'casual' },
    });
    assert.match(calls[0].prompt, /Additional instructions/);
  });
});

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

describe('flow-agents registry', () => {
  it('resolves prefixed agent ids', () => {
    assert.equal(getFlowAgent('flow:summarize')?.id, 'summarize');
    assert.equal(getFlowAgent('flow:classify_text')?.id, 'classify_text');
    assert.equal(getFlowAgent('flow:extract_entities')?.id, 'extract_entities');
    assert.equal(getFlowAgent('flow:rewrite_tone')?.id, 'rewrite_tone');
  });

  it('returns null for unknown or unprefixed ids', () => {
    assert.equal(getFlowAgent('summarize'), null);       // no prefix
    assert.equal(getFlowAgent('flow:bogus'), null);      // unknown
    assert.equal(getFlowAgent('executor-intake'), null); // pipeline agent, not a flow-agent
  });
});
