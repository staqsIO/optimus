import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setSignalEmitter,
  clearSignalEmitter,
  emitAdapterSignal,
} from '../../lib/adapters/registry.js';
import { FlowEngine } from '../../lib/runtime/flow-engine.js';
import { FlowToolRegistry } from '../../lib/runtime/tool-registry.js';

// Mock DB that captures flow-engine SQL writes.
function makeMockDb() {
  const signals = [];
  const flows = [];
  const executions = [];
  const stepExecs = [];
  let signalId = 0;
  let execId = 0;
  let stepId = 0;

  const query = async (sql, params = []) => {
    if (/INSERT INTO agent_graph\.signals/i.test(sql)) {
      const [signal_type, source_adapter, payload] = params;
      const row = { id: `sig-${++signalId}`, signal_type, source_adapter, payload };
      signals.push(row);
      return { rows: [row] };
    }
    if (/SELECT \* FROM agent_graph\.flow_definitions WHERE trigger_signal_type/i.test(sql)) {
      const [type] = params;
      return { rows: flows.filter(f => f.trigger_signal_type === type && f.is_active) };
    }
    if (/INSERT INTO agent_graph\.flow_executions/i.test(sql)) {
      const row = { id: `exec-${++execId}` };
      executions.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO agent_graph\.step_executions/i.test(sql)) {
      const row = { id: `step-${++stepId}` };
      stepExecs.push(row);
      return { rows: [row] };
    }
    if (/UPDATE agent_graph\.(flow|step)_executions/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  return { query, signals, flows, executions, stepExecs };
}

describe('Adapter signal → flow engine wiring', () => {
  let db;
  let engine;

  beforeEach(() => {
    db = makeMockDb();
    const registry = new FlowToolRegistry();
    registry.register('echo', { mode: 'function', handler: async (p) => ({ echoed: p }) });
    engine = new FlowEngine({ db: { query: db.query }, toolRegistry: registry });

    // Wire the emitter exactly as src/index.js does.
    setSignalEmitter(async (signalType, payload, sourceAdapter) => {
      const signal = await engine.createSignal(signalType, payload, sourceAdapter);
      await engine.onSignal(signal);
      return signal;
    });
  });

  afterEach(() => clearSignalEmitter());

  it('emitAdapterSignal persists a signal row', async () => {
    const sig = await emitAdapterSignal('email.received', { provider_msg_id: 'abc' }, 'gmail');
    assert.ok(sig);
    assert.equal(sig.signal_type, 'email.received');
    assert.equal(sig.source_adapter, 'gmail');
    assert.equal(db.signals.length, 1);
  });

  it('fires a matching flow when an email.received signal arrives', async () => {
    db.flows.push({
      id: 'flow-1',
      trigger_signal_type: 'email.received',
      is_active: true,
      steps: [{ tool_id: 'echo' }],
      max_depth: 8,
      timeout_ms: 5000,
    });

    await emitAdapterSignal('email.received', { provider_msg_id: 'abc' }, 'gmail');

    assert.equal(db.executions.length, 1, 'flow execution recorded');
    assert.equal(db.stepExecs.length, 1, 'step execution recorded');
  });

  it('does not fire flows bound to other signal types', async () => {
    db.flows.push({
      id: 'flow-slack',
      trigger_signal_type: 'slack.message',
      is_active: true,
      steps: [{ tool_id: 'echo' }],
      max_depth: 8,
      timeout_ms: 5000,
    });

    await emitAdapterSignal('email.received', {}, 'gmail');

    assert.equal(db.executions.length, 0, 'no slack flow fired for email signal');
  });
});
