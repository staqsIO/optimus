import { createLogger } from '../../logger.js';
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

// ---------------------------------------------------------------------------
// FlowEngine
// ---------------------------------------------------------------------------

export class FlowEngine {
  constructor({ db, toolRegistry, maxGlobalDepth = 8 }) {
    this.db = db;
    this.toolRegistry = toolRegistry;
    this.maxGlobalDepth = maxGlobalDepth;
  }

  // -------------------------------------------------------------------------
  // onSignal — entry point
  // -------------------------------------------------------------------------

  async onSignal(signal, { depth = 0, parentExecutionId = null, dryRun = false } = {}) {
    if (depth >= this.maxGlobalDepth) {
      throw new FlowDepthExceededError(depth, this.maxGlobalDepth);
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
    const { rows } = await this.db.query(
      `INSERT INTO agent_graph.signals (signal_type, source_adapter, payload, project_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [signalType, sourceAdapter, payload, projectId, createdBy],
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

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

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
        } else {
          // Live execution
          try {
            if (!this.toolRegistry) {
              throw new ToolNotFoundError(step.tool_id, 'No tool registry configured — use --dry-run or provide a toolRegistry');
            }
            const result = await this.toolRegistry.dispatch(step.tool_id, step.config, lastOutput);

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
          } catch (stepError) {
            if (stepError instanceof FlowTimeoutError) throw stepError;
            await this.db.query(
              `UPDATE agent_graph.step_executions SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
              [stepExec.id, stepError.message],
            );
            const handled = await this.handleStepFailure(execution, flowDef, i, stepError, lastOutput, stepExec.id);
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

  async handleStepFailure(execution, flowDef, stepIndex, error, lastOutput, stepExecId) {
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

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await this.toolRegistry.dispatch(step.tool_id, step.config, lastOutput);
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
