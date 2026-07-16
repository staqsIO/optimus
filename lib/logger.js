/**
 * Structured logger for Optimus lib/ infrastructure.
 *
 * Pino-compatible API (object-first, message-second) backed by console.*
 * so we add zero new dependencies (P4 — boring infrastructure).
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('module-name');
 *   log.info('simple message');
 *   log.info({ taskId, duration }, 'task completed');
 *   log.warn({ err }, 'something went wrong');
 *   log.error({ err }, 'fatal failure');
 */

function formatMsg(module, objOrMsg, maybeMsg) {
  const prefix = `[${module}]`;
  if (typeof objOrMsg === 'string') {
    return { msg: `${prefix} ${objOrMsg}`, data: undefined };
  }
  const msg = maybeMsg ? `${prefix} ${maybeMsg}` : prefix;
  return { msg, data: objOrMsg };
}

/**
 * Create a child logger scoped to a module name.
 * @param {string} module — short label, e.g. 'db', 'rag/embedder', 'runtime/agent-loop'
 */
export function createLogger(module) {
  return {
    info(objOrMsg, maybeMsg) {
      const { msg, data } = formatMsg(module, objOrMsg, maybeMsg);
      data !== undefined ? console.log(msg, data) : console.log(msg);
    },
    warn(objOrMsg, maybeMsg) {
      const { msg, data } = formatMsg(module, objOrMsg, maybeMsg);
      data !== undefined ? console.warn(msg, data) : console.warn(msg);
    },
    error(objOrMsg, maybeMsg) {
      const { msg, data } = formatMsg(module, objOrMsg, maybeMsg);
      data !== undefined ? console.error(msg, data) : console.error(msg);
    },
    debug(objOrMsg, maybeMsg) {
      if (!process.env.DEBUG) return;
      const { msg, data } = formatMsg(module, objOrMsg, maybeMsg);
      data !== undefined ? console.log(msg, data) : console.log(msg);
    },
  };
}

/**
 * Convenience alias — accepts either a string or pino-style bindings object.
 * createChildLogger('module') or createChildLogger({ agent: 'name' })
 */
export function createChildLogger(nameOrBindings) {
  if (typeof nameOrBindings === 'string') return createLogger(nameOrBindings);
  // Extract a readable label from bindings: { agent: 'x' } → 'x', { module: 'y' } → 'y'
  const label = nameOrBindings.agent || nameOrBindings.module || nameOrBindings.name || 'unknown';
  return createLogger(label);
}

/** Default root logger (no module prefix) */
const logger = createLogger('optimus');
export default logger;
