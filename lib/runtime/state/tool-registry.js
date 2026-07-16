import { ToolNotFoundError } from '../flow-engine.js';

/**
 * FlowToolRegistry — wraps an existing tool registry (Map or object with
 * get/has) and adds flow-specific dispatch modes: function, agent, hybrid.
 *
 * Does NOT replace the existing registry — extends it with routing logic
 * for the Signal→Tool→Output Flow Engine.
 */
export class FlowToolRegistry {
  /** @param {Map|object|null} existingRegistry */
  constructor(existingRegistry) {
    this._existing = existingRegistry ?? null;
    this._flowTools = new Map();
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  /**
   * @param {string} toolId
   * @param {object} opts
   * @param {'function'|'agent'|'hybrid'} opts.mode
   * @param {Function}  [opts.handler]             — required for function/hybrid
   * @param {string}    [opts.agentId]             — required for agent/hybrid
   * @param {number}    [opts.confidenceThreshold] — hybrid only, default 0.7
   */
  register(toolId, { mode, handler, agentId, confidenceThreshold }) {
    this._flowTools.set(toolId, {
      mode,
      handler,
      agentId,
      confidenceThreshold: mode === 'hybrid' ? (confidenceThreshold ?? 0.7) : confidenceThreshold,
    });
  }

  // -------------------------------------------------------------------------
  // dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch a tool call. Flow tools checked first, then existing registry.
   * @param {string} toolId
   * @param {object} config
   * @param {object} payload
   * @returns {Promise<*>}
   */
  async dispatch(toolId, config, payload) {
    // Flow tools take precedence
    const flowTool = this._flowTools.get(toolId);
    if (flowTool) {
      return this._dispatchFlow(flowTool, config, payload);
    }

    // Fallback to existing registry
    const existing = this._getExisting(toolId);
    if (existing) {
      return existing.handler(payload, config);
    }

    throw new ToolNotFoundError(toolId);
  }

  /** @private */
  async _dispatchFlow(tool, config, payload) {
    switch (tool.mode) {
      case 'function':
        return tool.handler(payload, config);

      case 'agent':
        return this.dispatchToAgent(tool.agentId, payload, config);

      case 'hybrid': {
        const result = await tool.handler(payload, config);
        if (result && result.confidence >= tool.confidenceThreshold) {
          return result;
        }
        return this.dispatchToAgent(tool.agentId, payload, config);
      }

      default:
        throw new Error(`Unknown tool mode: ${tool.mode}`);
    }
  }

  // -------------------------------------------------------------------------
  // dispatchToAgent — override hook
  // -------------------------------------------------------------------------

  /**
   * Hook for agent dispatch. Override after construction or subclass.
   * @param {string} agentId
   * @param {object} payload
   * @param {object} config
   */
  async dispatchToAgent(_agentId, _payload, _config) {
    throw new Error('Agent dispatch not configured');
  }

  // -------------------------------------------------------------------------
  // has / list
  // -------------------------------------------------------------------------

  /** Check if a tool exists in either registry. */
  has(toolId) {
    if (this._flowTools.has(toolId)) return true;
    return this._hasExisting(toolId);
  }

  /** Return array of { toolId, mode, source } for all tools. */
  list() {
    const result = [];

    for (const [toolId, def] of this._flowTools) {
      result.push({ toolId, mode: def.mode, source: 'flow' });
    }

    if (this._existing) {
      const keys = typeof this._existing.keys === 'function'
        ? [...this._existing.keys()]
        : Object.keys(this._existing);

      for (const toolId of keys) {
        // Don't duplicate tools already listed from flow
        if (!this._flowTools.has(toolId)) {
          result.push({ toolId, mode: undefined, source: 'existing' });
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers for existing registry access
  // -------------------------------------------------------------------------

  /** @private */
  _getExisting(toolId) {
    if (!this._existing) return undefined;
    if (typeof this._existing.get === 'function') return this._existing.get(toolId);
    return this._existing[toolId];
  }

  /** @private */
  _hasExisting(toolId) {
    if (!this._existing) return false;
    if (typeof this._existing.has === 'function') return this._existing.has(toolId);
    return toolId in this._existing;
  }
}
