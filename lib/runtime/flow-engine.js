// Re-export shim (STAQPRO-560): file relocated to ./state/flow-engine.js.
// NOTE: this file carries the richer flow-engine (template resolution); the
// names it declares below shadow the re-export, so `export *` only forwards any
// symbols this file does not itself define.
export * from './state/flow-engine.js';

import { createLogger } from '../logger.js';
import { gateFlowCompletion } from './verifier.js';
const log = createLogger('runtime/flow-engine');

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class FlowDepthExceededError extends Error {
  constructor(depth, maxGlobalDepth) {
    super(`Flow depth ${depth} exceeds global maximum ${maxGlobalDepth}`);
    this.name = 'FlowDepthExceededError';
    this.depth = depth;
    this.maxGlobalDepth = maxGlobalDepth;
  }
}

export class FlowTimeoutError extends Error {
  constructor(executionId, timeoutMs) {
    super(`Flow execution ${executionId} timed out after ${timeoutMs}ms`);
    this.name = 'FlowTimeoutError';
    this.executionId = executionId;
    this.timeoutMs = timeoutMs;
  }
}

export class ToolNotFoundError extends Error {
  constructor(toolId) {
    super(`Tool not found: ${toolId}`);
    this.name = 'ToolNotFoundError';
    this.toolId = toolId;
  }
}

export class TemplateResolutionError extends Error {
  constructor(stepIndex, source, field, reason) {
    super(`Flow step ${stepIndex} references unknown source "${source}.${field}": ${reason}`);
    this.name = 'TemplateResolutionError';
    this.stepIndex = stepIndex;
    this.source = source;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{(trigger|step\d+)\.(\w+)\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{(trigger|step\d+)\.(\w+)\}\}$/;

/**
 * Resolve {{trigger.field}} and {{stepN.field}} references inside a config
 * object against a context of { trigger, stepOutputs: Map<number, object> }.
 *
 * Rules:
 *  - String that is a single template → replaced with raw upstream value (type preserved)
 *  - String with embedded template(s) → string interpolation (value coerced to string)
 *  - Non-string values walk recursively (arrays, nested objects); primitives untouched
 *  - Unresolvable reference → throws TemplateResolutionError
 */
export function resolveTemplates(config, { trigger, stepOutputs, stepIndex }) {
  const lookup = (source, field) => {
    let bag;
    if (source === 'trigger') {
      bag = trigger;
      if (bag == null) {
        throw new TemplateResolutionError(stepIndex, source, field, 'no trigger payload available');
      }
    } else {
      const n = Number(source.slice(4));
      if (!stepOutputs.has(n)) {
        throw new TemplateResolutionError(stepIndex, source, field, `step ${n} has not executed yet`);
      }
      bag = stepOutputs.get(n);
      if (bag == null || typeof bag !== 'object') {
        throw new TemplateResolutionError(stepIndex, source, field, `step ${n} output is not an object`);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(bag, field)) {
      throw new TemplateResolutionError(stepIndex, source, field, `output has no field "${field}"`);
    }
    return bag[field];
  };

  const walk = (value) => {
    if (typeof value === 'string') {
      const whole = value.match(WHOLE_TEMPLATE_RE);
      if (whole) {
        return lookup(whole[1], whole[2]);
      }
      if (value.includes('{{')) {
        return value.replace(TEMPLATE_RE, (_m, source, field) => {
          const resolved = lookup(source, field);
          return resolved == null ? '' : String(resolved);
        });
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };

  return walk(config);
}

// ---------------------------------------------------------------------------
// FlowEngine
// ---------------------------------------------------------------------------

export class FlowEngine {
  constructor({ db, toolRegistry, maxGlobalDepth = 8, signalHandlers = {} }) {
    this.db = db;
    this.toolRegistry = toolRegistry;
    this.maxGlobalDepth = maxGlobalDepth;
    // Dedicated signal handlers (STAQPRO-612). flow_definitions steps are linear
    // + templated and cannot branch; a handler is a code module that runs on the
    // same onSignal path for a given signal_type. Map: signal_type -> async
    // (signal, { depth, query }) => any. Runs IN ADDITION to any matching
    // flow_definitions, and failures are isolated (logged, never thrown) so a
    // handler bug can't break the signal's flows or the emitting hot path.
    this.signalHandlers = signalHandlers || {};
  }

  // -------------------------------------------------------------------------
  // onSignal — entry point
  // -------------------------------------------------------------------------

  async onSignal(signal, { depth = 0, parentExecutionId = null, dryRun = false } = {}) {
    if (depth >= this.maxGlobalDepth) {
      throw new FlowDepthExceededError(depth, this.maxGlobalDepth);
    }

    // Dedicated signal handlers (STAQPRO-612) run alongside flow_definitions.
    // Isolated: a handler throwing must not abort matching flows or the caller.
    const handler = this.signalHandlers[signal.signal_type];
    if (typeof handler === 'function') {
      try {
        await handler(signal, { depth, query: this.db.query.bind(this.db) });
      } catch (err) {
        log.error(`signal handler for ${signal.signal_type} failed: ${err.message}`);
      }
    }

    const flows = await this.getFlowsForSignalType(signal.signal_type);
    const results = [];

    for (const flowDef of flows) {
      const effectiveMaxDepth = Math.min(flowDef.max_depth ?? this.maxGlobalDepth, this.maxGlobalDepth);
      if (depth >= effectiveMaxDepth) {
        log.info(`Skipping flow ${flowDef.id}: depth ${depth} >= max_depth ${effectiveMaxDepth}`);
        continue;
      }
      const result = await this.executeFlow(flowDef, signal, { depth, parentExecutionId, dryRun });
      results.push(result);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // getFlowsForSignalType
  // -------------------------------------------------------------------------

  async getFlowsForSignalType(signalType) {
    const { rows } = await this.db.query(
      `SELECT * FROM agent_graph.flow_definitions WHERE trigger_signal_type = $1 AND is_active = true`,
      [signalType],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // createSignal
  // -------------------------------------------------------------------------

  async createSignal(signalType, payload, sourceAdapter, { projectId = null, createdBy = null } = {}) {
    // STAQPRO-612: lift meeting provenance from the payload into dedicated
    // columns (migration 151) when present, so signals are queryable by meeting
    // without JSONB digging. The payload still carries them too (the classifier
    // reads the payload). Non-meeting signals leave both columns NULL.
    const p = payload && typeof payload === 'object' ? payload : {};
    const sourceMeetingId = p.source_meeting_id ?? null;
    const origin = p.origin ?? null;
    const { rows } = await this.db.query(
      `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, project_id, created_by, source_meeting_id, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [signalType, sourceAdapter, payload, projectId, createdBy, sourceMeetingId, origin],
    );
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // emitSignal — convenience: create + trigger
  // -------------------------------------------------------------------------

  async emitSignal(signalType, payload, sourceAdapter) {
    const signal = await this.createSignal(signalType, payload, sourceAdapter);
    return this.onSignal(signal);
  }

  // -------------------------------------------------------------------------
  // executeFlow
  // -------------------------------------------------------------------------

  async executeFlow(flowDef, triggerSignal, { depth, parentExecutionId, dryRun }) {
    const timeoutMs = flowDef.timeout_ms ?? 30000;
    const timeoutAt = Date.now() + timeoutMs;

    // Create flow execution record
    const { rows: [execution] } = await this.db.query(
      `INSERT INTO agent_graph.flow_executions (flow_definition_id, trigger_signal_id, status, depth, parent_execution_id, input_payload, dry_run)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING *`,
      [flowDef.id, triggerSignal.id, depth, parentExecutionId, triggerSignal.payload, dryRun],
    );

    const steps = flowDef.steps || [];
    let lastOutput = triggerSignal.payload;
    // 1-indexed map of step outputs, matching the UI's {{stepN.field}} labels
    const stepOutputs = new Map();

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepLabel = i + 1;
        const resolvedConfig = resolveTemplates(step.config ?? {}, {
          trigger: triggerSignal.payload,
          stepOutputs,
          stepIndex: stepLabel,
        });

        // Timeout check before each step
        if (Date.now() > timeoutAt) {
          await this.db.query(
            `UPDATE agent_graph.flow_executions SET status = $2, error = $3, completed_at = now() WHERE id = $1`,
            [execution.id, 'timed_out', `Timed out after ${timeoutMs}ms`],
          );
          throw new FlowTimeoutError(execution.id, timeoutMs);
        }

        // Create step execution record
        const dispatchMode = dryRun ? 'dry_run' : 'live';
        const { rows: [stepExec] } = await this.db.query(
          `INSERT INTO agent_graph.step_executions (flow_execution_id, step_index, tool_id, dispatch_mode, input_payload, status)
           VALUES ($1, $2, $3, $4, $5, 'running') RETURNING *`,
          [execution.id, i, step.tool_id, dispatchMode, lastOutput],
        );

        if (dryRun) {
          // Dry-run: don't dispatch, record what would happen
          const dryRunResult = { dry_run: true, would_dispatch: step.tool_id, input: lastOutput };
          await this.db.query(
            `UPDATE agent_graph.step_executions SET status = 'completed', output_payload = $2, completed_at = now() WHERE id = $1`,
            [stepExec.id, dryRunResult],
          );
          lastOutput = dryRunResult;
          stepOutputs.set(stepLabel, dryRunResult);
        } else {
          // Live execution
          try {
            if (!this.toolRegistry) {
              throw new ToolNotFoundError(step.tool_id, 'No tool registry configured — use --dry-run or provide a toolRegistry');
            }
            const result = await this.toolRegistry.dispatch(step.tool_id, resolvedConfig, lastOutput);

            // Timeout check after dispatch
            if (Date.now() > timeoutAt) {
              await this.db.query(
                `UPDATE agent_graph.flow_executions SET status = $2, error = $3, completed_at = now() WHERE id = $1`,
                [execution.id, 'timed_out', `Timed out after ${timeoutMs}ms`],
              );
              throw new FlowTimeoutError(execution.id, timeoutMs);
            }

            await this.db.query(
              `UPDATE agent_graph.step_executions SET status = 'completed', output_payload = $2, completed_at = now() WHERE id = $1`,
              [stepExec.id, result],
            );
            lastOutput = result;
            stepOutputs.set(stepLabel, result);
          } catch (stepError) {
            if (stepError instanceof FlowTimeoutError) throw stepError;
            await this.db.query(
              `UPDATE agent_graph.step_executions SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
              [stepExec.id, stepError.message],
            );
            const handled = await this.handleStepFailure(execution, flowDef, i, stepError, lastOutput, stepExec.id, resolvedConfig);
            if (!handled) {
              // Fail the entire execution
              await this.db.query(
                `UPDATE agent_graph.flow_executions SET status = $2, error = $3, completed_at = now() WHERE id = $1`,
                [execution.id, 'failed', stepError.message],
              );
              throw stepError;
            }
            // If strategy is retry_step and it succeeded, update lastOutput
            if (handled.retried && handled.result !== undefined) {
              lastOutput = handled.result;
              stepOutputs.set(stepLabel, handled.result);
            }
            // If strategy is skip, lastOutput stays the same
          }
        }

        // Output signal chaining
        if (step.output_signal_type) {
          const outputSignal = await this.createSignal(
            step.output_signal_type,
            lastOutput,
            'flow-engine',
          );
          // Ensure signal_type is set even if DB doesn't return it
          if (!outputSignal.signal_type) outputSignal.signal_type = step.output_signal_type;
          await this.onSignal(outputSignal, {
            depth: depth + 1,
            parentExecutionId: execution.id,
            dryRun,
          });
        }
      }

      // OPT-3 — context-isolated completion gate (USE SITE 1). The verifier
      // sees ONLY the flow's declared success_criteria + its final output, never
      // the step implementations that produced it. gateFlowCompletion is a pure
      // pass-through when success_criteria is null/empty (the default for every
      // existing flow — migration 170 defaults the column to '[]'), so this
      // changes nothing for flows that have not opted in. A flow that DOES carry
      // criteria and fails them is parked in 'verification_failed' instead of
      // 'completed', surfacing failureMode for retry / board review.
      const gate = await gateFlowCompletion({
        successCriteria: flowDef.success_criteria,
        outputPayload: lastOutput,
      });
      if (!gate.passed) {
        log.warn(
          `Flow ${flowDef.id} execution ${execution.id} failed verification: ${gate.failureMode}`,
        );
        await this.db.query(
          `UPDATE agent_graph.flow_executions SET status = $2, error = $3, completed_at = now() WHERE id = $1`,
          [execution.id, 'verification_failed', gate.failureMode],
        );
        return { executionId: execution.id, output: lastOutput, verificationFailed: true };
      }

      // Mark execution as completed
      await this.db.query(
        `UPDATE agent_graph.flow_executions SET status = $2, output_payload = $3, completed_at = now() WHERE id = $1`,
        [execution.id, 'completed', lastOutput],
      );

      return { executionId: execution.id, output: lastOutput };
    } catch (err) {
      // Re-throw after ensuring execution is marked (if not already marked)
      if (!(err instanceof FlowTimeoutError) && !(err instanceof FlowDepthExceededError)) {
        // Only mark as failed if not already marked by step handler
        const alreadyMarked = err._flowMarked;
        if (!alreadyMarked) {
          err._flowMarked = true;
        }
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // handleStepFailure
  // -------------------------------------------------------------------------

  async handleStepFailure(execution, flowDef, stepIndex, error, lastOutput, stepExecId, resolvedConfig) {
    const policy = flowDef.retry_policy || { strategy: 'none' };
    const strategy = policy.strategy || 'none';

    if (strategy === 'none') {
      return false;
    }

    if (strategy === 'skip') {
      // Update the step from failed to skipped
      await this.db.query(
        `UPDATE agent_graph.step_executions SET status = $2, completed_at = now() WHERE id = $1`,
        [stepExecId, 'skipped'],
      );
      const step = flowDef.steps[stepIndex];
      log.info(`Skipping failed step ${stepIndex} (${step.tool_id}) in flow ${flowDef.id}`);
      return { skipped: true };
    }

    if (strategy === 'retry_step') {
      const maxRetries = policy.max_retries || 3;
      const step = flowDef.steps[stepIndex];
      const configForDispatch = resolvedConfig ?? step.config;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await this.toolRegistry.dispatch(step.tool_id, configForDispatch, lastOutput);
          return { retried: true, result };
        } catch (retryError) {
          log.warn(`Retry ${attempt + 1}/${maxRetries} failed for step ${stepIndex}: ${retryError.message}`);
          if (attempt === maxRetries - 1) {
            return false;
          }
        }
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // DAG validation (static)
  // -------------------------------------------------------------------------

  static validateFlowDAG(flowDefinitions) {
    // Build adjacency list: signal_type -> [output_signal_types]
    const graph = new Map();
    const allNodes = new Set();

    for (const flow of flowDefinitions) {
      const trigger = flow.trigger_signal_type;
      allNodes.add(trigger);

      if (!graph.has(trigger)) graph.set(trigger, []);

      for (const step of (flow.steps || [])) {
        if (step.output_signal_type) {
          allNodes.add(step.output_signal_type);
          graph.get(trigger).push(step.output_signal_type);
        }
      }
    }

    // Topological sort via Kahn's algorithm
    const inDegree = new Map();
    for (const node of allNodes) {
      inDegree.set(node, 0);
    }
    for (const [, targets] of graph) {
      for (const t of targets) {
        inDegree.set(t, (inDegree.get(t) || 0) + 1);
      }
    }

    const queue = [];
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node);
    }

    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift();
      visited++;
      for (const neighbor of (graph.get(node) || [])) {
        const newDeg = inDegree.get(neighbor) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (visited < allNodes.size) {
      throw new Error('Cycle detected in flow signal graph');
    }

    return true;
  }
}
