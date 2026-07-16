import { query } from '../../db.js';
import { FlowEngine } from '../../../../lib/runtime/flow-engine.js';
import { FlowToolRegistry } from '../../../../lib/runtime/tool-registry.js';
import { tools } from '../../../tools/registry.js';
import { attachFlowWrappers } from '../../flow-wrappers/index.js';

function buildDefaultEngine(db) {
  const registry = new FlowToolRegistry(tools);
  attachFlowWrappers(registry);
  // Built-in passthrough tool for testing flows
  registry.register('echo', { mode: 'function', handler: async (payload) => payload });
  return new FlowEngine({ db: { query: db }, toolRegistry: registry });
}

// ---------------------------------------------------------------------------
// Core functions (testable — accept a `db` query function)
// ---------------------------------------------------------------------------

/**
 * flow:create <name> <trigger_type> <steps_json>
 */
export async function flowCreateCore(db, args) {
  if (args.length < 3) {
    console.log('Usage: flow:create <name> <trigger_type> <steps_json>');
    return;
  }
  const [name, triggerType, ...rest] = args;
  const stepsRaw = rest.join(' ');

  let steps;
  try {
    steps = JSON.parse(stepsRaw);
    if (!Array.isArray(steps)) throw new Error('steps must be an array');
  } catch (e) {
    console.log(`Invalid steps JSON: ${e.message}`);
    return;
  }

  const { rows } = await db(
    `INSERT INTO agent_graph.flow_definitions (name, trigger_signal_type, steps, created_by)
     VALUES ($1, $2, $3, 'cli') RETURNING id, name, version`,
    [name, triggerType, JSON.stringify(steps)],
  );
  const flow = rows[0];

  // Validate DAG — reject circular flows
  try {
    const { rows: allFlows } = await db(
      `SELECT * FROM agent_graph.flow_definitions WHERE is_active = true`,
    );
    FlowEngine.validateFlowDAG(allFlows);
  } catch (err) {
    await db(`DELETE FROM agent_graph.flow_definitions WHERE id = $1`, [flow.id]);
    console.log(`Flow creates a cycle: ${err.message}`);
    return;
  }

  console.log(`Created flow "${flow.name}" (id: ${flow.id}, version: ${flow.version})`);
}

/**
 * flow:list
 */
export async function flowListCore(db) {
  const { rows } = await db(
    `SELECT id, name, version, trigger_signal_type, steps, is_active
     FROM agent_graph.flow_definitions ORDER BY created_at DESC`,
  );

  if (rows.length === 0) {
    console.log('No flow definitions found.');
    return;
  }

  console.log('');
  console.log('  ID                                    Name                 Ver  Trigger                Steps  Active');
  console.log('  ' + '─'.repeat(100));
  for (const r of rows) {
    const stepCount = Array.isArray(r.steps) ? r.steps.length : 0;
    console.log(
      `  ${String(r.id).substring(0, 36).padEnd(38)} ${r.name.padEnd(20)} ${String(r.version).padStart(3)}  ${r.trigger_signal_type.padEnd(22)} ${String(stepCount).padStart(5)}  ${r.is_active ? 'yes' : 'no'}`,
    );
  }
  console.log('');
}

/**
 * flow:inspect <execution_id>
 */
export async function flowInspectCore(db, args) {
  if (!args || args.length < 1) {
    console.log('Usage: flow:inspect <execution_id>');
    return;
  }
  const [executionId] = args;

  const { rows: execRows } = await db(
    `SELECT fe.*, fd.name AS flow_name
     FROM agent_graph.flow_executions fe
     JOIN agent_graph.flow_definitions fd ON fd.id = fe.flow_definition_id
     WHERE fe.id = $1`,
    [executionId],
  );

  if (execRows.length === 0) {
    console.log(`Execution not found: ${executionId}`);
    return;
  }

  const exec = execRows[0];
  console.log('');
  console.log(`  Flow Execution: ${exec.id}`);
  console.log(`  Flow:           ${exec.flow_name}`);
  console.log(`  Status:         ${exec.status}`);
  console.log(`  Depth:          ${exec.depth}`);
  console.log(`  Dry Run:        ${exec.dry_run}`);
  console.log(`  Started:        ${exec.started_at}`);
  console.log(`  Completed:      ${exec.completed_at || '—'}`);
  console.log(`  Duration:       ${exec.duration_ms != null ? exec.duration_ms + 'ms' : '—'}`);
  console.log(`  Input:          ${JSON.stringify(exec.input_payload)}`);
  console.log(`  Output:         ${JSON.stringify(exec.output_payload)}`);
  if (exec.error) console.log(`  Error:          ${exec.error}`);

  const { rows: stepRows } = await db(
    `SELECT step_index, tool_id, status, dispatch_mode, input_payload, output_payload, duration_ms
     FROM agent_graph.step_executions WHERE flow_execution_id = $1 ORDER BY step_index`,
    [executionId],
  );

  if (stepRows.length > 0) {
    console.log('');
    console.log('  Steps:');
    console.log('  ' + '─'.repeat(80));
    for (const s of stepRows) {
      console.log(`    [${s.step_index}] ${s.tool_id} — ${s.status} (${s.dispatch_mode}) ${s.duration_ms != null ? s.duration_ms + 'ms' : ''}`);
      console.log(`        Input:  ${JSON.stringify(s.input_payload)}`);
      console.log(`        Output: ${JSON.stringify(s.output_payload)}`);
    }
  }
  console.log('');
}

/**
 * flow:run <flow_name> <payload_json> [--dry-run]
 */
export async function flowRunCore(db, args, { flowEngine } = {}) {
  if (!args || args.length < 2) {
    console.log('Usage: flow:run <flow_name> <payload_json> [--dry-run]');
    return;
  }

  const dryRun = args.includes('--dry-run');
  const filtered = args.filter(a => a !== '--dry-run');
  const [flowName, ...payloadParts] = filtered;
  const payloadRaw = payloadParts.join(' ');

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    console.log(`Invalid payload JSON: ${e.message}`);
    return;
  }

  // Find flow definition by name
  const { rows } = await db(
    `SELECT * FROM agent_graph.flow_definitions WHERE name = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
    [flowName],
  );

  if (rows.length === 0) {
    console.log(`Flow not found: ${flowName}`);
    return;
  }

  const flowDef = rows[0];

  // Create synthetic signal
  const { rows: sigRows } = await db(
    `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by)
     VALUES ($1, 'cli', $2, 'cli') RETURNING *`,
    [flowDef.trigger_signal_type, payload],
  );
  const signal = sigRows[0];

  // Resolve engine
  const engine = flowEngine || buildDefaultEngine(db);

  console.log(`Running flow "${flowDef.name}" (v${flowDef.version})${dryRun ? ' [DRY RUN]' : ''}...`);

  const results = await engine.onSignal(signal, { dryRun });

  for (const r of results) {
    console.log(`  Execution: ${r.executionId}`);
    console.log(`  Output:    ${JSON.stringify(r.output)}`);
  }
  console.log('');
}

/**
 * signal:emit <type> <payload_json>
 */
export async function signalEmitCore(db, args, { flowEngine } = {}) {
  if (!args || args.length < 2) {
    console.log('Usage: signal:emit <type> <payload_json>');
    return;
  }

  const [signalType, ...payloadParts] = args;
  const payloadRaw = payloadParts.join(' ');

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    console.log(`Invalid payload JSON: ${e.message}`);
    return;
  }

  const { rows } = await db(
    `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, created_by)
     VALUES ($1, 'cli', $2, 'cli') RETURNING *`,
    [signalType, payload],
  );
  const signal = rows[0];
  console.log(`Signal created: ${signal.id} (${signal.signal_type})`);

  const engine = flowEngine || buildDefaultEngine(db);
  const results = await engine.onSignal(signal);
  console.log(`Triggered ${results.length} flow(s).`);

  for (const r of results) {
    console.log(`  Flow execution: ${r.executionId}`);
  }
}

/**
 * signal:list [--type <type>] [--since <timestamp>]
 */
export async function signalListCore(db, args) {
  const conditions = [];
  const params = [];
  let paramIdx = 0;

  for (let i = 0; i < (args || []).length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      paramIdx++;
      conditions.push(`signal_type = $${paramIdx}`);
      params.push(args[i + 1]);
      i++;
    } else if (args[i] === '--since' && args[i + 1]) {
      paramIdx++;
      conditions.push(`created_at >= $${paramIdx}`);
      params.push(args[i + 1]);
      i++;
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db(
    `SELECT id, signal_type, source_adapter, created_at
     FROM agent_graph.signals ${where} ORDER BY created_at DESC LIMIT 50`,
    params,
  );

  if (rows.length === 0) {
    console.log('No signals found.');
    return;
  }

  console.log('');
  console.log('  ID                                    Type                  Source     Created At');
  console.log('  ' + '─'.repeat(95));
  for (const r of rows) {
    console.log(
      `  ${String(r.id).substring(0, 36).padEnd(38)} ${(r.signal_type || '').padEnd(21)} ${(r.source_adapter || '').padEnd(10)} ${r.created_at}`,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI command wrappers (use real db)
// ---------------------------------------------------------------------------

export async function flowCreate(args) {
  await flowCreateCore(query, args);
}

export async function flowList() {
  await flowListCore(query);
}

export async function flowInspect(args) {
  await flowInspectCore(query, args);
}

export async function flowRun(args) {
  await flowRunCore(query, args);
}

export async function signalEmit(args) {
  await signalEmitCore(query, args);
}

export async function signalList(args) {
  await signalListCore(query, args);
}
