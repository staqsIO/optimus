import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  flowCreateCore,
  flowListCore,
  flowInspectCore,
  flowRunCore,
  signalEmitCore,
  signalListCore,
} from '../src/cli/commands/flow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.log = original; } };
}

function makeQuery(results) {
  return mock.fn(async () => ({ rows: results }));
}

function makeQueryMulti(resultSets) {
  let callIdx = 0;
  return mock.fn(async () => {
    const rows = resultSets[callIdx] || [];
    callIdx++;
    return { rows, rowCount: rows.length };
  });
}

// ---------------------------------------------------------------------------
// flowCreateCore
// ---------------------------------------------------------------------------

describe('flowCreateCore', () => {
  it('inserts a flow definition and prints result', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const flow = { id, name: 'my-flow', version: 1, trigger_signal_type: 'email.received', steps: [{ tool_id: 'echo' }], is_active: true };
    // Call 1: INSERT returns the new flow; Call 2: SELECT active flows for DAG validation
    const db = makeQueryMulti([[flow], [flow]]);
    const cap = captureLog();
    try {
      await flowCreateCore(db, ['my-flow', 'email.received', '[{"tool_id":"echo"}]']);
      assert.equal(db.mock.callCount(), 2);
      const call = db.mock.calls[0];
      assert.equal(call.arguments[1][0], 'my-flow');
      assert.equal(call.arguments[1][1], 'email.received');
      assert.deepEqual(call.arguments[1][2], JSON.stringify([{ tool_id: 'echo' }]));
      assert.ok(cap.lines.some(l => l.includes(id)));
    } finally {
      cap.restore();
    }
  });

  it('prints error on missing args', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowCreateCore(db, ['only-name']);
      assert.ok(cap.lines.some(l => l.includes('Usage')));
      assert.equal(db.mock.callCount(), 0);
    } finally {
      cap.restore();
    }
  });

  it('prints error on invalid JSON steps', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowCreateCore(db, ['my-flow', 'email.received', 'not-json']);
      assert.ok(cap.lines.some(l => l.includes('Invalid')));
      assert.equal(db.mock.callCount(), 0);
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// flowListCore
// ---------------------------------------------------------------------------

describe('flowListCore', () => {
  it('prints a table of flow definitions', async () => {
    const db = makeQuery([
      { id: 'id-1', name: 'flow-a', version: 1, trigger_signal_type: 'email.received', steps: [{ tool_id: 'x' }], is_active: true },
      { id: 'id-2', name: 'flow-b', version: 2, trigger_signal_type: 'slack.message', steps: [], is_active: false },
    ]);
    const cap = captureLog();
    try {
      await flowListCore(db);
      assert.equal(db.mock.callCount(), 1);
      assert.ok(cap.lines.some(l => l.includes('flow-a')));
      assert.ok(cap.lines.some(l => l.includes('flow-b')));
    } finally {
      cap.restore();
    }
  });

  it('prints message when no flows exist', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowListCore(db);
      assert.ok(cap.lines.some(l => l.includes('No flow definitions')));
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// flowInspectCore
// ---------------------------------------------------------------------------

describe('flowInspectCore', () => {
  it('prints execution details and steps', async () => {
    let callIndex = 0;
    const db = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return { rows: [{
          id: 'exec-1', status: 'completed', depth: 0, dry_run: false,
          input_payload: { foo: 1 }, output_payload: { bar: 2 },
          started_at: '2026-04-06T00:00:00Z', completed_at: '2026-04-06T00:00:01Z',
          duration_ms: 1000, flow_name: 'my-flow',
        }] };
      }
      return { rows: [{
        step_index: 0, tool_id: 'echo', status: 'completed', dispatch_mode: 'live',
        input_payload: { foo: 1 }, output_payload: { bar: 2 },
        duration_ms: 500,
      }] };
    });
    const cap = captureLog();
    try {
      await flowInspectCore(db, ['exec-1']);
      assert.equal(db.mock.callCount(), 2);
      assert.ok(cap.lines.some(l => l.includes('completed')));
      assert.ok(cap.lines.some(l => l.includes('echo')));
    } finally {
      cap.restore();
    }
  });

  it('prints error on missing execution_id', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowInspectCore(db, []);
      assert.ok(cap.lines.some(l => l.includes('Usage')));
      assert.equal(db.mock.callCount(), 0);
    } finally {
      cap.restore();
    }
  });

  it('prints not found for unknown execution', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowInspectCore(db, ['no-such-id']);
      assert.ok(cap.lines.some(l => l.includes('not found')));
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// flowRunCore
// ---------------------------------------------------------------------------

describe('flowRunCore', () => {
  it('runs a flow by name and prints result', async () => {
    let callIndex = 0;
    const flowDef = { id: 'fd-1', name: 'my-flow', steps: [{ tool_id: 'echo' }], trigger_signal_type: 'manual' };
    const db = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [flowDef] }; // find flow
      if (callIndex === 2) return { rows: [{ id: 'sig-1', signal_type: 'manual', payload: { x: 1 } }] }; // create signal
      return { rows: [] };
    });

    const mockEngine = {
      onSignal: mock.fn(async () => [{ executionId: 'exec-1', output: { result: 'ok' } }]),
    };

    const cap = captureLog();
    try {
      await flowRunCore(db, ['my-flow', '{"x":1}'], { flowEngine: mockEngine });
      assert.ok(cap.lines.some(l => l.includes('exec-1')));
    } finally {
      cap.restore();
    }
  });

  it('prints error on missing args', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowRunCore(db, []);
      assert.ok(cap.lines.some(l => l.includes('Usage')));
    } finally {
      cap.restore();
    }
  });

  it('prints not found for unknown flow name', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await flowRunCore(db, ['nope', '{}']);
      assert.ok(cap.lines.some(l => l.includes('not found')));
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// signalEmitCore
// ---------------------------------------------------------------------------

describe('signalEmitCore', () => {
  it('creates a signal and triggers flows', async () => {
    let callIndex = 0;
    const db = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) return { rows: [{ id: 'sig-1', signal_type: 'email.received', payload: {} }] };
      return { rows: [] };
    });
    const mockEngine = {
      onSignal: mock.fn(async () => [{ executionId: 'exec-1', output: {} }]),
    };
    const cap = captureLog();
    try {
      await signalEmitCore(db, ['email.received', '{"subject":"hi"}'], { flowEngine: mockEngine });
      assert.equal(db.mock.callCount(), 1);
      assert.ok(cap.lines.some(l => l.includes('sig-1')));
      assert.ok(cap.lines.some(l => l.includes('1 flow')));
    } finally {
      cap.restore();
    }
  });

  it('prints error on missing args', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await signalEmitCore(db, []);
      assert.ok(cap.lines.some(l => l.includes('Usage')));
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// signalListCore
// ---------------------------------------------------------------------------

describe('signalListCore', () => {
  it('lists signals with no filters', async () => {
    const db = makeQuery([
      { id: 'sig-1', signal_type: 'email.received', source_adapter: 'email', created_at: '2026-04-06T00:00:00Z' },
    ]);
    const cap = captureLog();
    try {
      await signalListCore(db, []);
      assert.equal(db.mock.callCount(), 1);
      const call = db.mock.calls[0];
      assert.equal(call.arguments[1].length, 0); // no params
      assert.ok(cap.lines.some(l => l.includes('sig-1')));
    } finally {
      cap.restore();
    }
  });

  it('filters by --type', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await signalListCore(db, ['--type', 'slack.message']);
      const call = db.mock.calls[0];
      assert.ok(call.arguments[0].includes('signal_type'));
      assert.equal(call.arguments[1][0], 'slack.message');
    } finally {
      cap.restore();
    }
  });

  it('filters by --since', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await signalListCore(db, ['--since', '2026-04-01']);
      const call = db.mock.calls[0];
      assert.ok(call.arguments[0].includes('created_at'));
      assert.equal(call.arguments[1][0], '2026-04-01');
    } finally {
      cap.restore();
    }
  });

  it('filters by both --type and --since', async () => {
    const db = makeQuery([]);
    const cap = captureLog();
    try {
      await signalListCore(db, ['--type', 'email.received', '--since', '2026-04-01']);
      const call = db.mock.calls[0];
      assert.equal(call.arguments[1].length, 2);
    } finally {
      cap.restore();
    }
  });
});
