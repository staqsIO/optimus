# flow-agents

Declarative, single-shot LLM agents built for the Optimus flow engine.

Each flow-agent is **pure config** — an object describing input/output
schemas, a model, a cost ceiling, and a prompt template. All execution goes
through a single [shared runner](./shared/runner.js) so behavior is
consistent and easy to reason about.

This library is deliberately separate from the pipeline agents in `/agents/`
and the flow wrappers in `/flow-wrappers/`. Pipeline agents are multi-step,
coupled to work_items and DB side effects. Flow-agents are stateless leaves:
one input → one LLM call → one validated output.

## Design rules

- **Single-shot only.** No looping, no tool-use within an agent, no
  multi-step reasoning. If a task needs more, split it into multiple agents
  and let the flow orchestrate.
- **Declarative only.** An agent is `{ id, inputSchema, outputSchema,
  model, maxCostUsd, prompt }`. No handler function. If you're tempted to
  write imperative logic, stop — that probably belongs in a `flow-tools/`
  utility, or as two separate flow-agents.
- **Defaults required.** Every optional input field declares a `default`.
  No silent skip-logic.
- **Costs declared.** `maxCostUsd` is enforced pre-call by the runner; G1
  (daily budget) still applies on top.

## Adding a new agent (5-minute recipe)

1. Create `flow-agents/<your_agent>/index.js` exporting a definition:

   ```js
   import { readFileSync } from 'node:fs';
   import { dirname, resolve } from 'node:path';
   import { fileURLToPath } from 'node:url';

   const __dirname = dirname(fileURLToPath(import.meta.url));
   const prompt = readFileSync(resolve(__dirname, 'prompt.md'), 'utf8');

   export default {
     id: 'your_agent',
     description: 'What it does, one line.',
     model: 'claude-haiku-4-5-20251001',
     maxCostUsd: 0.02,
     maxTokens: 512,
     temperature: 0.2,
     inputSchema: {
       text: { type: 'string', required: true },
       mode: { type: 'string', default: 'default', enum: ['default', 'strict'] },
     },
     outputSchema: {
       // Single string field → runner returns raw text trimmed.
       // Multi-field or non-string → runner parses JSON and validates.
       result: 'string',
     },
     prompt,
   };
   ```

2. Create `flow-agents/<your_agent>/prompt.md`. Use `{{placeholder}}` to
   reference fields declared in `inputSchema`. The runner will throw if the
   prompt references a field you haven't declared.

3. Register the agent in [`flow-agents/index.js`](./index.js):

   ```js
   import yourAgent from './your_agent/index.js';
   export const flowAgents = {
     // ...
     your_agent: yourAgent,
   };
   ```

4. Register a tool entry in
   [`autobot-inbox/tools/registry.js`](../autobot-inbox/tools/registry.js)
   with `dispatch_mode: 'agent'` and `agentId: 'flow:your_agent'`. The
   `flow:` prefix is what tells the dispatcher to route to the shared runner
   instead of a pipeline wrapper.

5. Add an intent label in
   [`board/src/app/flows/builder/intent-labels.ts`](../board/src/app/flows/builder/intent-labels.ts)
   under `TOOL_LABELS`.

6. Add a unit test in
   [`autobot-inbox/test/flow-agents.test.js`](../autobot-inbox/test/flow-agents.test.js).
   Mock the LLM via `setLLMImpl()` — do not hit a live provider.

## Schema cheatsheet

Input/output fields use a compact descriptor format:

```js
// Shorthand: required, type only
text: 'string'

// Full form: with default, enum, or multi-type
maxWords: { type: 'number', default: 100 }
style:    { type: 'string', default: 'concise', enum: ['concise', 'technical'] }
value:    { type: ['string', 'number', 'null'], default: null }
```

Supported primitive types: `string`, `number`, `boolean`, `array`, `object`,
plus `null` (only valid inside a multi-type array, or as a `default` value).

The runner decides whether to parse the LLM response as JSON based on the
output schema: a single `string` field is returned as-is (trimmed); anything
else (multiple fields, or a non-string single field) is JSON-parsed,
validated, and returned as an object. If the first JSON parse fails, the
runner retries once with a "Return ONLY a JSON object with fields X, Y, Z"
nudge before giving up.

## Infrastructure reuse

- **LLM calls** go through [`lib/llm/provider.js`](../lib/llm/provider.js)
  via a thin wrapper in [`shared/llm.js`](./shared/llm.js) that adds a
  single transient retry and exposes `setLLMImpl()` for tests.
- **Cost** is computed from token usage in `agents.json` — no separate cost
  table for flow-agents.
- **Audit** logging is handled by the tool-registry's existing
  `tool_invocations` path when called through the flow engine.
  Additionally, if the host wires `setAuditWriter()` on
  [`shared/runner.js`](./shared/runner.js), every runner call emits a
  fire-and-forget audit row with `toolName: 'flow:<id>'`.

## What not to do

- Don't add an imperative escape hatch "just in case." If no current agent
  needs one, we'll add one when a real use case shows up — not before.
- Don't call other tools or agents from inside a flow-agent. The flow is
  the composer; the agent is a leaf.
- Don't copy code from pipeline agents. Read them for prompt ideas, write
  the prompt fresh for the flow-shaped contract.
