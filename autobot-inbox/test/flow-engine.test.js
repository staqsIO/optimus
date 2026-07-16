import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FlowEngine,
  FlowDepthExceededError,
  FlowTimeoutError,
  TemplateResolutionError,
  resolveTemplates,
} from '../../lib/runtime/flow-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(overrides = {}) {
  const db = {
    query: async (sql, params) => {
      db._calls.push({ sql, params });
      if (overrides.query) return overrides.query(sql, params);
      return { rows: [], rowCount: 0 };
    },
    _calls: [],
  };
  return db;
}

function makeMockToolRegistry(overrides = {}) {
  const reg = {
    dispatch: async (toolId, config, payload) => {
      reg._calls.push({ toolId, config, payload });
      if (overrides.dispatch) return overrides.dispatch(toolId, config, payload);
      return { result: 'mock-output', toolId };
    },
    _calls: [],
  };
  return reg;
}

/** Minimal flow definition matching the DB schema shape. */
function makeFlowDef(overrides = {}) {
  return {
    id: 'flow-1',
    name: 'test-flow',
    trigger_signal_type: 'email.received',
    max_depth: 5,
    timeout_ms: 30000,
    retry_policy: { strategy: 'none' },
    steps: [
      { tool_id: 'tool-a', config: { key: 'val' } },
    ],
    ...overrides,
  };
}

function makeSignal(overrides = {}) {
  return {
    id: 'sig-1',
    signal_type: 'email.received',
    payload: { subject: 'hello' },
    source_adapter: 'gmail',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: Constructor
// ---------------------------------------------------------------------------

describe('FlowEngine — constructor', () => {
  it('creates instance with default maxGlobalDepth of 8', () => {
    const db = makeMockDb();
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });
    assert.equal(engine.maxGlobalDepth, 8);
  });

  it('accepts custom maxGlobalDepth', () => {
    const db = makeMockDb();
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry, maxGlobalDepth: 3 });
    assert.equal(engine.maxGlobalDepth, 3);
  });
});

// ---------------------------------------------------------------------------
// Group 2: onSignal
// ---------------------------------------------------------------------------

describe('FlowEngine — onSignal', () => {
  let db, toolRegistry, engine;

  beforeEach(() => {
    db = makeMockDb({
      query: async (sql, _params) => {
        // Return a matching flow when querying flow_definitions
        if (sql.includes('flow_definitions')) {
          return { rows: [makeFlowDef()], rowCount: 1 };
        }
        // Default: return an id for inserts
        if (sql.includes('INSERT')) {
          return { rows: [{ id: 'exec-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    toolRegistry = makeMockToolRegistry();
    engine = new FlowEngine({ db, toolRegistry });
  });

  it('calls getFlowsForSignalType with signal type', async () => {
    const signal = makeSignal();
    await engine.onSignal(signal);

    const flowQuery = db._calls.find(c => c.sql.includes('flow_definitions'));
    assert.ok(flowQuery, 'should query flow_definitions');
    assert.ok(
      flowQuery.params.includes('email.received'),
      'should pass signal type as param',
    );
  });

  it('executes matching flows', async () => {
    const signal = makeSignal();
    await engine.onSignal(signal);

    // Tool dispatch should have been called for the step in the flow
    assert.ok(toolRegistry._calls.length > 0, 'should dispatch tool for matched flow');
    assert.equal(toolRegistry._calls[0].toolId, 'tool-a');
  });

  it('skips flows where depth >= flow max_depth', async () => {
    const signal = makeSignal();
    // depth=5, flow max_depth=5 => should skip
    await engine.onSignal(signal, { depth: 5 });

    assert.equal(toolRegistry._calls.length, 0, 'should not dispatch when depth >= flow max_depth');
  });

  it('throws FlowDepthExceededError when depth >= maxGlobalDepth', async () => {
    const localEngine = new FlowEngine({ db, toolRegistry, maxGlobalDepth: 3 });
    const signal = makeSignal();

    await assert.rejects(
      () => localEngine.onSignal(signal, { depth: 3 }),
      (err) => {
        assert.ok(err instanceof FlowDepthExceededError);
        return true;
      },
    );
  });

  it('does nothing when no flows match', async () => {
    const emptyDb = makeMockDb({
      query: async () => ({ rows: [], rowCount: 0 }),
    });
    const localEngine = new FlowEngine({ db: emptyDb, toolRegistry });
    const signal = makeSignal();

    await localEngine.onSignal(signal);
    assert.equal(toolRegistry._calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Group 3: executeFlow
// ---------------------------------------------------------------------------

describe('FlowEngine — executeFlow', () => {
  let db, toolRegistry, engine;
  const insertedIds = [];

  beforeEach(() => {
    insertedIds.length = 0;
    db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT') && sql.includes('flow_executions')) {
          return { rows: [{ id: 'exec-42' }], rowCount: 1 };
        }
        if (sql.includes('INSERT') && sql.includes('step_executions')) {
          const id = `step-${insertedIds.length}`;
          insertedIds.push(id);
          return { rows: [{ id }], rowCount: 1 };
        }
        if (sql.includes('INSERT') && sql.includes('signals')) {
          return { rows: [{ id: 'sig-out-1' }], rowCount: 1 };
        }
        if (sql.includes('flow_definitions')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    toolRegistry = makeMockToolRegistry();
    engine = new FlowEngine({ db, toolRegistry });
  });

  it('creates a flow_execution record in DB', async () => {
    const flowDef = makeFlowDef();
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    const insertCall = db._calls.find(c => c.sql.includes('flow_executions') && c.sql.includes('INSERT'));
    assert.ok(insertCall, 'should INSERT into flow_executions');
  });

  it('executes each step through toolRegistry.dispatch', async () => {
    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'tool-a', config: {} },
        { tool_id: 'tool-b', config: {} },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.equal(toolRegistry._calls.length, 2);
    assert.equal(toolRegistry._calls[0].toolId, 'tool-a');
    assert.equal(toolRegistry._calls[1].toolId, 'tool-b');
  });

  it('records step_execution for each step (input + output)', async () => {
    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'tool-a', config: {} },
        { tool_id: 'tool-b', config: {} },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    const stepInserts = db._calls.filter(c => c.sql.includes('step_executions') && c.sql.includes('INSERT'));
    assert.equal(stepInserts.length, 2, 'should record one step_execution per step');
  });

  it('passes previous step output as next step input (chaining)', async () => {
    toolRegistry = makeMockToolRegistry({
      dispatch: async (toolId) => {
        if (toolId === 'tool-a') return { data: 'from-a' };
        return { data: 'from-b' };
      },
    });
    engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'tool-a', config: {} },
        { tool_id: 'tool-b', config: {} },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    // Second dispatch should receive first step's output
    assert.deepEqual(toolRegistry._calls[1].payload, { data: 'from-a' });
  });

  it('first step receives trigger signal payload as input', async () => {
    const flowDef = makeFlowDef();
    const signal = makeSignal({ payload: { subject: 'test-input' } });

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.deepEqual(toolRegistry._calls[0].payload, { subject: 'test-input' });
  });

  it('marks execution as completed on success', async () => {
    const flowDef = makeFlowDef();
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    const updateCall = db._calls.find(c =>
      c.sql.includes('flow_executions') && c.sql.includes('UPDATE') && c.params?.includes('completed'),
    );
    assert.ok(updateCall, 'should mark flow_execution as completed');
  });

  it('marks execution as failed on step error', async () => {
    toolRegistry = makeMockToolRegistry({
      dispatch: async () => { throw new Error('tool blew up'); },
    });
    engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef();
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false }).catch(() => {});

    const updateCall = db._calls.find(c =>
      c.sql.includes('flow_executions') && c.sql.includes('UPDATE') && c.params?.includes('failed'),
    );
    assert.ok(updateCall, 'should mark flow_execution as failed');
  });

  it('emits output signal when step has output_signal_type', async () => {
    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'tool-a', config: {}, output_signal_type: 'email.classified' },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    const signalInsert = db._calls.find(c =>
      c.sql.includes('signals') && c.sql.includes('INSERT'),
    );
    assert.ok(signalInsert, 'should insert output signal');
  });

  it('chains to onSignal recursively with depth+1 for output signals', async () => {
    // Track onSignal calls by spying on getFlowsForSignalType
    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'tool-a', config: {}, output_signal_type: 'email.classified' },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    // The recursive onSignal should query flow_definitions for the output signal type
    const chainQuery = db._calls.find(c =>
      c.sql.includes('flow_definitions') && c.params?.includes('email.classified'),
    );
    assert.ok(chainQuery, 'should recursively call onSignal for output signal type');
  });
});

// ---------------------------------------------------------------------------
// Group 4: Timeouts
// ---------------------------------------------------------------------------

describe('FlowEngine — timeouts', () => {
  it('aborts execution when timeout_ms is exceeded (marks as timed_out)', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT') && sql.includes('flow_executions')) {
          return { rows: [{ id: 'exec-timeout' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    // Slow tool that takes longer than timeout
    const toolRegistry = makeMockToolRegistry({
      dispatch: async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { result: 'late' };
      },
    });
    const engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({ timeout_ms: 50 });
    const signal = makeSignal();

    await assert.rejects(
      () => engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false }),
      (err) => {
        assert.ok(err instanceof FlowTimeoutError);
        return true;
      },
    );

    const updateCall = db._calls.find(c =>
      c.sql.includes('flow_executions') && c.sql.includes('UPDATE') && c.params?.includes('timed_out'),
    );
    assert.ok(updateCall, 'should mark execution as timed_out');
  });

  it('continues normally when within timeout', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-ok' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({ timeout_ms: 30000 });
    const signal = makeSignal();

    // Should not throw
    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });
    assert.equal(toolRegistry._calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Dry-run mode
// ---------------------------------------------------------------------------

describe('FlowEngine — dry-run mode', () => {
  let db, toolRegistry, engine;

  beforeEach(() => {
    db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-dry' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
    toolRegistry = makeMockToolRegistry();
    engine = new FlowEngine({ db, toolRegistry });
  });

  it('does not call toolRegistry.dispatch in dry-run', async () => {
    const flowDef = makeFlowDef();
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: true });

    assert.equal(toolRegistry._calls.length, 0, 'should not dispatch tools in dry-run');
  });

  it('records dry-run trace with would_dispatch info', async () => {
    const flowDef = makeFlowDef({
      steps: [{ tool_id: 'tool-a', config: { k: 'v' } }],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: true });

    const stepInsert = db._calls.find(c =>
      c.sql.includes('step_executions') && c.sql.includes('INSERT'),
    );
    assert.ok(stepInsert, 'should still record step execution in dry-run');
    // The dispatch_mode or output should indicate dry-run / would_dispatch
    const hasDryRunIndicator = stepInsert.params?.some(p =>
      typeof p === 'string' && (p.includes('dry_run') || p.includes('would_dispatch')),
    ) || stepInsert.params?.some(p =>
      typeof p === 'object' && p !== null && ('would_dispatch' in p || 'dry_run' in p),
    );
    assert.ok(hasDryRunIndicator, 'step execution should include would_dispatch info');
  });

  it('marks execution with dry_run=true', async () => {
    const flowDef = makeFlowDef();
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: true });

    const execInsert = db._calls.find(c =>
      c.sql.includes('flow_executions') && c.sql.includes('INSERT'),
    );
    assert.ok(execInsert, 'should create flow_execution');
    assert.ok(
      execInsert.params?.includes(true),
      'should pass dry_run=true when inserting flow_execution',
    );
  });
});

// ---------------------------------------------------------------------------
// Group 6: Retry policies
// ---------------------------------------------------------------------------

describe('FlowEngine — retry policies', () => {
  it('strategy=none: fails immediately on step error', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-retry' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
    let callCount = 0;
    const toolRegistry = makeMockToolRegistry({
      dispatch: async () => { callCount++; throw new Error('fail'); },
    });
    const engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({ retry_policy: { strategy: 'none' } });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false }).catch(() => {});

    assert.equal(callCount, 1, 'should only call dispatch once with strategy=none');
  });

  it('strategy=skip: marks step as skipped, continues to next', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-skip' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
    let callIndex = 0;
    const toolRegistry = makeMockToolRegistry({
      dispatch: async (toolId) => {
        callIndex++;
        if (toolId === 'tool-a') throw new Error('fail-a');
        return { result: 'ok' };
      },
    });
    const engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({
      retry_policy: { strategy: 'skip' },
      steps: [
        { tool_id: 'tool-a', config: {} },
        { tool_id: 'tool-b', config: {} },
      ],
    });
    const signal = makeSignal();

    // Should not throw — skips failed step and continues
    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.equal(callIndex, 2, 'should dispatch both steps (skipping first error)');

    const skippedStep = db._calls.find(c =>
      c.sql.includes('step_executions') && c.params?.includes('skipped'),
    );
    assert.ok(skippedStep, 'should mark failed step as skipped');
  });

  it('strategy=retry_step: retries up to max_retries times', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-retried' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
    let callCount = 0;
    const toolRegistry = makeMockToolRegistry({
      dispatch: async () => {
        callCount++;
        if (callCount <= 3) throw new Error('transient');
        return { result: 'finally' };
      },
    });
    const engine = new FlowEngine({ db, toolRegistry });

    const flowDef = makeFlowDef({
      retry_policy: { strategy: 'retry_step', max_retries: 3 },
    });
    const signal = makeSignal();

    // Should succeed on the 4th attempt (3 retries after initial failure)
    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.equal(callCount, 4, 'should retry 3 times after initial failure (4 total attempts)');
  });
});

// ---------------------------------------------------------------------------
// Group 7: DAG validation (static)
// ---------------------------------------------------------------------------

describe('FlowEngine — DAG validation', () => {
  it('accepts valid linear flow definitions', () => {
    const flows = [
      makeFlowDef({ trigger_signal_type: 'email.received', steps: [{ tool_id: 't1', output_signal_type: 'email.classified' }] }),
      makeFlowDef({ trigger_signal_type: 'email.classified', steps: [{ tool_id: 't2' }] }),
    ];

    // Should not throw
    const result = FlowEngine.validateFlowDAG(flows);
    assert.ok(result === undefined || result === true, 'should accept linear flows');
  });

  it('rejects flow definitions with circular signal chains (A triggers B triggers A)', () => {
    const flows = [
      makeFlowDef({
        trigger_signal_type: 'email.received',
        steps: [{ tool_id: 't1', output_signal_type: 'email.classified' }],
      }),
      makeFlowDef({
        trigger_signal_type: 'email.classified',
        steps: [{ tool_id: 't2', output_signal_type: 'email.received' }],
      }),
    ];

    assert.throws(
      () => FlowEngine.validateFlowDAG(flows),
      /cycle/i,
    );
  });

  it('accepts independent flows that do not form cycles', () => {
    const flows = [
      makeFlowDef({ trigger_signal_type: 'email.received', steps: [{ tool_id: 't1' }] }),
      makeFlowDef({ trigger_signal_type: 'slack.message', steps: [{ tool_id: 't2' }] }),
    ];

    // Should not throw
    const result = FlowEngine.validateFlowDAG(flows);
    assert.ok(result === undefined || result === true, 'should accept independent flows');
  });
});

// ---------------------------------------------------------------------------
// Group 8: createSignal
// ---------------------------------------------------------------------------

describe('FlowEngine — createSignal', () => {
  it('inserts signal record into agent_graph.signals', async () => {
    const db = makeMockDb({
      query: async (sql, params) => {
        if (sql.includes('INSERT') && sql.includes('signals')) {
          return { rows: [{ id: 'sig-new', signal_type: params[0], payload: params[1] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });

    await engine.createSignal('email.received', { subject: 'hi' }, 'gmail', {
      projectId: 'proj-1',
      createdBy: 'agent-x',
    });

    const insertCall = db._calls.find(c =>
      c.sql.includes('signals') && c.sql.includes('INSERT'),
    );
    assert.ok(insertCall, 'should INSERT into signals table');
    assert.ok(insertCall.sql.includes('agent_graph'), 'should target agent_graph schema');
  });

  it('returns the created signal with id', async () => {
    const db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT') && sql.includes('signals')) {
          return { rows: [{ id: 'sig-99', signal_type: 'email.received' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });

    const result = await engine.createSignal('email.received', {}, 'gmail');

    assert.ok(result, 'should return a result');
    assert.equal(result.id, 'sig-99');
    assert.equal(result.signal_type, 'email.received');
  });
});

// ---------------------------------------------------------------------------
// Group 9: resolveTemplates (pure function)
// ---------------------------------------------------------------------------

describe('resolveTemplates', () => {
  it('resolves {{stepN.field}} from a prior step output', () => {
    const stepOutputs = new Map([[1, { emailBody: 'hello world', subject: 'hi' }]]);
    const resolved = resolveTemplates(
      { text: '{{step1.emailBody}}' },
      { trigger: {}, stepOutputs, stepIndex: 2 },
    );
    assert.deepEqual(resolved, { text: 'hello world' });
  });

  it('preserves type for whole-string templates (arrays, numbers, objects)', () => {
    const stepOutputs = new Map([
      [1, { categories: ['urgent', 'billing'], count: 7, meta: { k: 'v' } }],
    ]);
    const resolved = resolveTemplates(
      {
        categories: '{{step1.categories}}',
        count: '{{step1.count}}',
        meta: '{{step1.meta}}',
      },
      { trigger: {}, stepOutputs, stepIndex: 2 },
    );
    assert.deepEqual(resolved.categories, ['urgent', 'billing']);
    assert.equal(typeof resolved.count, 'number');
    assert.equal(resolved.count, 7);
    assert.deepEqual(resolved.meta, { k: 'v' });
  });

  it('resolves {{trigger.field}} from the trigger payload', () => {
    const resolved = resolveTemplates(
      { subject: '{{trigger.subject}}' },
      { trigger: { subject: 'Weekly update' }, stepOutputs: new Map(), stepIndex: 1 },
    );
    assert.deepEqual(resolved, { subject: 'Weekly update' });
  });

  it('throws TemplateResolutionError for unknown step', () => {
    assert.throws(
      () =>
        resolveTemplates(
          { text: '{{step3.foo}}' },
          { trigger: {}, stepOutputs: new Map([[1, { foo: 'bar' }]]), stepIndex: 2 },
        ),
      (err) => {
        assert.ok(err instanceof TemplateResolutionError);
        assert.match(err.message, /step 2/);
        assert.match(err.message, /step3\.foo/);
        assert.match(err.message, /has not executed/);
        return true;
      },
    );
  });

  it('throws TemplateResolutionError for unknown field on an existing step', () => {
    assert.throws(
      () =>
        resolveTemplates(
          { text: '{{step1.missing}}' },
          { trigger: {}, stepOutputs: new Map([[1, { emailBody: 'x' }]]), stepIndex: 2 },
        ),
      (err) => {
        assert.ok(err instanceof TemplateResolutionError);
        assert.match(err.message, /output has no field "missing"/);
        return true;
      },
    );
  });

  it('interpolates mid-string references (string coercion)', () => {
    const resolved = resolveTemplates(
      { prefix: 'Re: {{trigger.subject}}' },
      { trigger: { subject: 'Launch' }, stepOutputs: new Map(), stepIndex: 1 },
    );
    assert.deepEqual(resolved, { prefix: 'Re: Launch' });
  });

  it('passes non-string config values through untouched', () => {
    const resolved = resolveTemplates(
      { flag: true, retries: 3, items: [1, 2, 3], nothing: null },
      { trigger: {}, stepOutputs: new Map(), stepIndex: 1 },
    );
    assert.deepEqual(resolved, { flag: true, retries: 3, items: [1, 2, 3], nothing: null });
  });

  it('walks nested objects and arrays', () => {
    const stepOutputs = new Map([[1, { body: 'B' }]]);
    const resolved = resolveTemplates(
      { options: { text: '{{step1.body}}', tags: ['plain', '{{step1.body}}'] } },
      { trigger: {}, stepOutputs, stepIndex: 2 },
    );
    assert.deepEqual(resolved, { options: { text: 'B', tags: ['plain', 'B'] } });
  });

  it('leaves strings without templates unchanged', () => {
    const resolved = resolveTemplates(
      { label: 'literal value', path: 'a/b/c' },
      { trigger: {}, stepOutputs: new Map(), stepIndex: 1 },
    );
    assert.deepEqual(resolved, { label: 'literal value', path: 'a/b/c' });
  });
});

// ---------------------------------------------------------------------------
// Group 10: executeFlow — template resolution at dispatch time
// ---------------------------------------------------------------------------

describe('FlowEngine — template resolution at dispatch', () => {
  let db;
  beforeEach(() => {
    db = makeMockDb({
      query: async (sql) => {
        if (sql.includes('INSERT')) return { rows: [{ id: 'exec-res' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });
  });

  it('resolves {{trigger.field}} in step.config before dispatch', async () => {
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });
    const flowDef = makeFlowDef({
      steps: [{ tool_id: 'summarize', config: { text: '{{trigger.subject}}' } }],
    });
    const signal = makeSignal({ payload: { subject: 'Quarterly review' } });

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.equal(toolRegistry._calls.length, 1);
    assert.deepEqual(toolRegistry._calls[0].config, { text: 'Quarterly review' });
  });

  it('resolves {{stepN.field}} from an earlier step output', async () => {
    const toolRegistry = makeMockToolRegistry({
      dispatch: async (toolId) => {
        if (toolId === 'gmail_fetch') return { emailBody: 'full body text' };
        return { summary: 'ok' };
      },
    });
    const engine = new FlowEngine({ db, toolRegistry });
    const flowDef = makeFlowDef({
      steps: [
        { tool_id: 'gmail_fetch', config: {} },
        { tool_id: 'summarize', config: { text: '{{step1.emailBody}}' } },
      ],
    });
    const signal = makeSignal();

    await engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false });

    assert.equal(toolRegistry._calls[1].config.text, 'full body text');
  });

  it('throws TemplateResolutionError when a reference cannot be resolved', async () => {
    const toolRegistry = makeMockToolRegistry();
    const engine = new FlowEngine({ db, toolRegistry });
    const flowDef = makeFlowDef({
      steps: [{ tool_id: 'summarize', config: { text: '{{step9.nope}}' } }],
    });
    const signal = makeSignal();

    await assert.rejects(
      () => engine.executeFlow(flowDef, signal, { depth: 0, parentExecutionId: null, dryRun: false }),
      (err) => {
        assert.ok(err instanceof TemplateResolutionError);
        return true;
      },
    );
    // Dispatch must not have been called — resolver failed first
    assert.equal(toolRegistry._calls.length, 0);
  });
});
