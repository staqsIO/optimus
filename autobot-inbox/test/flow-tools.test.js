import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import jsonPickDef from '../tools/flow-tools/json_pick/index.js';
import conditionCheckDef from '../tools/flow-tools/condition_check/index.js';
import htmlToTextDef from '../tools/flow-tools/html_to_text/index.js';
import listFilterDef from '../tools/flow-tools/list_filter/index.js';
import { runFlowTool } from '../tools/flow-tools/shared/runner.js';
import { getFlowTool, makeFlowToolHandler } from '../tools/flow-tools/index.js';

// ---------------------------------------------------------------------------
// json_pick
// ---------------------------------------------------------------------------

describe('json_pick', () => {
  it('extracts requested fields', async () => {
    const out = await runFlowTool({
      definition: jsonPickDef,
      input: { source: { a: 1, b: 2, c: 3 }, fields: ['a', 'c'] },
    });
    assert.deepEqual(out, { a: 1, c: 3 });
  });

  it('silently omits fields not present in source', async () => {
    const out = await runFlowTool({
      definition: jsonPickDef,
      input: { source: { a: 1 }, fields: ['a', 'b'] },
    });
    assert.deepEqual(out, { a: 1 });
  });

  it('returns empty object when no fields match', async () => {
    const out = await runFlowTool({
      definition: jsonPickDef,
      input: { source: { a: 1 }, fields: ['x', 'y'] },
    });
    assert.deepEqual(out, {});
  });

  it('preserves nested values (shallow pick)', async () => {
    const out = await runFlowTool({
      definition: jsonPickDef,
      input: { source: { meta: { nested: true }, n: 5 }, fields: ['meta'] },
    });
    assert.deepEqual(out, { meta: { nested: true } });
  });

  it('rejects missing required input', async () => {
    await assert.rejects(
      runFlowTool({ definition: jsonPickDef, input: { fields: ['a'] } }),
      /Missing required field "source"/
    );
    await assert.rejects(
      runFlowTool({ definition: jsonPickDef, input: { source: {} } }),
      /Missing required field "fields"/
    );
  });

  it('rejects wrong-typed source', async () => {
    await assert.rejects(
      runFlowTool({ definition: jsonPickDef, input: { source: 'not-obj', fields: ['a'] } }),
      /wrong type: expected object/
    );
  });
});

// ---------------------------------------------------------------------------
// condition_check
// ---------------------------------------------------------------------------

describe('condition_check', () => {
  it('equals: numeric comparison when at least one side is a number', async () => {
    const a = await runFlowTool({ definition: conditionCheckDef, input: { left: 5, operator: 'equals', right: '5' } });
    assert.equal(a.result, true);
    const b = await runFlowTool({ definition: conditionCheckDef, input: { left: 5, operator: 'equals', right: 6 } });
    assert.equal(b.result, false);
  });

  it('equals: string comparison when neither side is numeric', async () => {
    const a = await runFlowTool({ definition: conditionCheckDef, input: { left: 'foo', operator: 'equals', right: 'foo' } });
    assert.equal(a.result, true);
    const b = await runFlowTool({ definition: conditionCheckDef, input: { left: 'foo', operator: 'equals', right: 'bar' } });
    assert.equal(b.result, false);
  });

  it('not_equals inverts equals', async () => {
    const r = await runFlowTool({ definition: conditionCheckDef, input: { left: 5, operator: 'not_equals', right: 6 } });
    assert.equal(r.result, true);
  });

  it('greater_than / less_than coerce via Number()', async () => {
    const gt = await runFlowTool({ definition: conditionCheckDef, input: { left: '10', operator: 'greater_than', right: 5 } });
    assert.equal(gt.result, true);
    const lt = await runFlowTool({ definition: conditionCheckDef, input: { left: 3, operator: 'less_than', right: 5 } });
    assert.equal(lt.result, true);
  });

  it('greater_than returns false with reason when input is non-numeric', async () => {
    const r = await runFlowTool({ definition: conditionCheckDef, input: { left: 'abc', operator: 'greater_than', right: 5 } });
    assert.equal(r.result, false);
    assert.match(r.reason, /not numeric/);
  });

  it('contains: works for arrays', async () => {
    const hit = await runFlowTool({ definition: conditionCheckDef, input: { left: ['urgent', 'fyi'], operator: 'contains', right: 'urgent' } });
    assert.equal(hit.result, true);
    const miss = await runFlowTool({ definition: conditionCheckDef, input: { left: ['a', 'b'], operator: 'contains', right: 'z' } });
    assert.equal(miss.result, false);
  });

  it('contains: works for substring match', async () => {
    const r = await runFlowTool({ definition: conditionCheckDef, input: { left: 'hello world', operator: 'contains', right: 'world' } });
    assert.equal(r.result, true);
  });

  it('exists: true for non-empty, false for null/undefined/empty-string', async () => {
    const a = await runFlowTool({ definition: conditionCheckDef, input: { left: 'x', operator: 'exists' } });
    assert.equal(a.result, true);
    const b = await runFlowTool({ definition: conditionCheckDef, input: { left: null, operator: 'exists' } });
    assert.equal(b.result, false);
    const c = await runFlowTool({ definition: conditionCheckDef, input: { left: '', operator: 'exists' } });
    assert.equal(c.result, false);
    const d = await runFlowTool({ definition: conditionCheckDef, input: { left: 0, operator: 'exists' } });
    assert.equal(d.result, true);  // 0 is a valid value
  });

  it('rejects unknown operator (enum)', async () => {
    await assert.rejects(
      runFlowTool({ definition: conditionCheckDef, input: { left: 'a', operator: 'bogus', right: 'b' } }),
      /must be one of/
    );
  });

  it('fills default null when right is omitted', async () => {
    // For exists operator, right is ignored — this should work.
    const r = await runFlowTool({ definition: conditionCheckDef, input: { left: 'x', operator: 'exists' } });
    assert.equal(r.result, true);
  });
});

// ---------------------------------------------------------------------------
// html_to_text
// ---------------------------------------------------------------------------

describe('html_to_text', () => {
  it('strips basic tags', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '<p>Hello <b>world</b></p>' },
    });
    assert.equal(out.text, 'Hello world');
  });

  it('decodes named and numeric entities', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '&amp; &lt; &gt; &quot; &#39; &#x2014; &nbsp;end' },
    });
    // Whitespace collapses: &nbsp; becomes a space, then runs of spaces fold to one.
    assert.equal(out.text, '& < > " \' — end');
  });

  it('converts <br>, <p>, <div> to newlines (block elements produce blank-line separation)', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '<div>one</div><div>two</div><p>three<br>four</p>' },
    });
    // Block closers + openers combine to double-newline between blocks; <br> is a single newline.
    assert.equal(out.text, 'one\n\ntwo\n\nthree\nfour');
  });

  it('removes <script> and <style> blocks entirely', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: {
        html: '<div>visible<script>alert("bad")</script><style>.x{}</style>end</div>',
      },
    });
    assert.equal(out.text, 'visibleend');
  });

  it('collapses whitespace and trims', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '   <p>  lots   of   space  </p>   ' },
    });
    assert.equal(out.text, 'lots of space');
  });

  it('truncates with ellipsis when maxLength exceeded', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '<p>abcdefghij</p>', maxLength: 5 },
    });
    assert.equal(out.text, 'abcde…');
  });

  it('maxLength=0 means no truncation (default behavior)', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: '<p>abcdefghij</p>' },
    });
    assert.equal(out.text, 'abcdefghij');
  });

  it('empty input returns empty string without error', async () => {
    const out = await runFlowTool({ definition: htmlToTextDef, input: { html: '' } });
    assert.equal(out.text, '');
  });

  it('strips HTML comments', async () => {
    const out = await runFlowTool({
      definition: htmlToTextDef,
      input: { html: 'before<!-- a comment -->after' },
    });
    assert.equal(out.text, 'beforeafter');
  });
});

// ---------------------------------------------------------------------------
// list_filter
// ---------------------------------------------------------------------------

describe('list_filter', () => {
  const items = [
    { name: 'a', score: 0.9, tag: 'urgent' },
    { name: 'b', score: 0.5, tag: 'fyi' },
    { name: 'c', score: 0.95, tag: 'urgent' },
    { name: 'd', score: 0.2 },  // no tag field
  ];

  it('filters by greater_than', async () => {
    const out = await runFlowTool({
      definition: listFilterDef,
      input: { list: items, field: 'score', operator: 'greater_than', value: 0.8 },
    });
    assert.equal(out.count, 2);
    assert.deepEqual(out.items.map(i => i.name), ['a', 'c']);
  });

  it('filters by equals with string coercion', async () => {
    const out = await runFlowTool({
      definition: listFilterDef,
      input: { list: items, field: 'tag', operator: 'equals', value: 'urgent' },
    });
    assert.equal(out.count, 2);
  });

  it('filters by exists — item d lacks tag and is dropped', async () => {
    const out = await runFlowTool({
      definition: listFilterDef,
      input: { list: items, field: 'tag', operator: 'exists' },
    });
    assert.equal(out.count, 3);
    assert.ok(!out.items.some(i => i.name === 'd'));
  });

  it('returns empty list + count=0 when nothing matches', async () => {
    const out = await runFlowTool({
      definition: listFilterDef,
      input: { list: items, field: 'score', operator: 'greater_than', value: 10 },
    });
    assert.deepEqual(out.items, []);
    assert.equal(out.count, 0);
  });

  it('rejects non-array list at input validation', async () => {
    await assert.rejects(
      runFlowTool({
        definition: listFilterDef,
        input: { list: 'not an array', field: 'x', operator: 'equals', value: 'y' },
      }),
      /wrong type: expected array/
    );
  });

  it('rejects unknown operator', async () => {
    await assert.rejects(
      runFlowTool({
        definition: listFilterDef,
        input: { list: items, field: 'score', operator: 'nope', value: 1 },
      }),
      /must be one of/
    );
  });

  it('skips non-object items gracefully (returns false for them)', async () => {
    const out = await runFlowTool({
      definition: listFilterDef,
      input: {
        list: [{ a: 1 }, 'not-an-object', null, { a: 2 }],
        field: 'a',
        operator: 'exists',
      },
    });
    assert.equal(out.count, 2);
  });
});

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

describe('flow-tools registry', () => {
  it('getFlowTool resolves by id', () => {
    assert.equal(getFlowTool('json_pick')?.id, 'json_pick');
    assert.equal(getFlowTool('condition_check')?.id, 'condition_check');
    assert.equal(getFlowTool('html_to_text')?.id, 'html_to_text');
    assert.equal(getFlowTool('list_filter')?.id, 'list_filter');
    assert.equal(getFlowTool('bogus'), null);
  });

  it('makeFlowToolHandler returns a callable that validates input', async () => {
    const handler = makeFlowToolHandler('json_pick');
    const result = await handler({ source: { a: 1, b: 2 }, fields: ['b'] });
    assert.deepEqual(result, { b: 2 });
  });

  it('makeFlowToolHandler throws for unknown tool', () => {
    assert.throws(() => makeFlowToolHandler('nope'), /Unknown flow-tool/);
  });
});
