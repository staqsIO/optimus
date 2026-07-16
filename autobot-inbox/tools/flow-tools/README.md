# flow-tools

Pure, deterministic utility tools for composing flows. No LLM, no DB writes,
no network calls. Think of them as the `lodash` of the flow engine — small,
predictable functions that transform data between agent steps.

Keep them boring. If a tool needs to call a network or touch a DB, it
belongs in `autobot-inbox/tools/registry.js` as a regular tool with its own
capability declarations, not here.

## Adding a new tool

1. Create `flow-tools/<your_tool>/index.js`:

   ```js
   export default {
     id: 'your_tool',
     description: 'What it does, one line.',
     inputSchema: {
       value: { type: 'string', required: true },
       option: { type: 'string', default: 'default' },
     },
     outputSchema: {
       // Optional. Omit (or use {}) if output is dynamic.
       result: 'string',
     },
     handler: ({ value, option }) => {
       return { result: `${option}:${value}` };
     },
   };
   ```

2. Register it in [`flow-tools/index.js`](./index.js):

   ```js
   import yourTool from './your_tool/index.js';
   export const flowTools = {
     // ...
     your_tool: yourTool,
   };
   ```

3. Register a tool entry in
   [`autobot-inbox/tools/registry.js`](../autobot-inbox/tools/registry.js)
   with `dispatch_mode: 'function'` and
   `handler: makeFlowToolHandler('your_tool')`.

4. Add an intent label in
   [`board/src/app/flows/builder/intent-labels.ts`](../board/src/app/flows/builder/intent-labels.ts).

5. Add a unit test in
   [`autobot-inbox/test/flow-tools.test.js`](../autobot-inbox/test/flow-tools.test.js).

## What the shared runner does

[`shared/runner.js`](./shared/runner.js) is minimal — it validates input
(filling defaults), calls the handler, and optionally validates output
against `outputSchema`. It uses the same schema validator as flow-agents for
consistency.

If `outputSchema` is omitted or empty (`{}`), output is passed through —
useful for tools like `json_pick` whose output shape depends on input.

## Current tools

- [`json_pick`](./json_pick/) — Extract a subset of fields from an object.
  Dynamic output shape.
- [`condition_check`](./condition_check/) — Evaluate a comparison
  (`equals`, `not_equals`, `greater_than`, `less_than`, `contains`,
  `exists`) and return `{ result, reason }`. Useful as a gate before
  expensive agents.

## What not to do

- **No network calls.** Use a proper tool with capabilities instead.
- **No DB writes.** Pure functions only.
- **No LLM.** That's what flow-agents are for.
- **No shared state.** Each invocation is independent.
