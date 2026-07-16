/**
 * Template handler registry for DETERMINISTIC tasks (spec §4).
 * P4: Boring infrastructure — simple string templates, no LLM.
 *
 * DETERMINISTIC tasks must never hit an LLM. This registry provides
 * template functions keyed by task type that produce output at zero cost.
 *
 * Addresses Figma findings: executor wastefully invoked LLM for tasks
 * that had fully deterministic outputs (acknowledgments, status updates).
 */

const templates = new Map();

/**
 * Register a template handler for a task type.
 * @param {string} taskType - The event_type or task_type to handle
 * @param {(workItem: object, context: object) => { success: boolean, result: string, reason: string }} fn
 */
export function registerTemplate(taskType, fn) {
  templates.set(taskType, fn);
}

/**
 * Check if a work item can be handled deterministically.
 * @param {object} workItem - The work item from the task graph
 * @returns {boolean}
 */
export function canHandle(workItem) {
  if (workItem.routing_class !== 'DETERMINISTIC') return false;
  return templates.has(workItem.event_type);
}

/**
 * Execute a deterministic template handler.
 * @param {object} workItem - The work item
 * @param {object} context - Loaded context
 * @returns {{ success: boolean, result: string, reason: string, costUsd: number }}
 */
export function execute(workItem, context) {
  const handler = templates.get(workItem.event_type);
  if (!handler) {
    return { success: false, result: null, reason: `No template for ${workItem.event_type}`, costUsd: 0 };
  }

  try {
    const output = handler(workItem, context);
    return {
      success: true,
      result: output.result,
      reason: output.reason || `Template: ${workItem.event_type}`,
      costUsd: 0,
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      reason: `Template error: ${err.message}`,
      costUsd: 0,
    };
  }
}

// ============================================================
// Built-in templates
// ============================================================

// Acknowledgment receipts — "Got it, will process"
registerTemplate('acknowledgment', (workItem) => ({
  result: `Acknowledged: ${workItem.event_data?.subject || workItem.event_type}`,
  reason: 'Deterministic acknowledgment',
}));

// Status confirmations — relay current state
registerTemplate('status_confirmation', (workItem) => ({
  result: JSON.stringify({
    work_item_id: workItem.work_item_id || workItem.id,
    status: workItem.state || 'unknown',
    updated_at: new Date().toISOString(),
  }),
  reason: 'Deterministic status confirmation',
}));

// Simple forwarding — pass through content unchanged
registerTemplate('forward', (workItem, context) => ({
  result: context?.email?.body || workItem.event_data?.content || '',
  reason: 'Deterministic forward',
}));

// ============================================================
// PR #82 (3E): Extended deterministic handlers
// ============================================================

// HTML boilerplate — skeleton page from template
registerTemplate('html_boilerplate', (workItem) => {
  const title = workItem.metadata?.title || workItem.title || 'Untitled';
  return {
    result: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
</body>
</html>`,
    reason: 'Deterministic HTML boilerplate',
  };
});

// JSON schema — structured output from metadata fields
registerTemplate('json_schema', (workItem) => {
  const schema = workItem.metadata?.schema || {};
  return {
    result: JSON.stringify(schema, null, 2),
    reason: 'Deterministic JSON schema output',
  };
});

// Format conversion — pass-through with format tag
registerTemplate('format_conversion', (workItem, context) => {
  const content = context?.content || workItem.metadata?.content || '';
  const targetFormat = workItem.metadata?.target_format || 'text';
  return {
    result: content,
    reason: `Deterministic format conversion to ${targetFormat}`,
  };
});

// SQL DDL echo — return migration SQL from metadata
registerTemplate('sql_ddl', (workItem) => {
  const ddl = workItem.metadata?.sql || workItem.metadata?.ddl || '';
  return {
    result: ddl,
    reason: 'Deterministic SQL DDL output',
  };
});

// Archive confirmation — mark-as-done for noise/fyi
registerTemplate('archive_confirmation', (workItem) => ({
  result: JSON.stringify({
    action: 'archived',
    work_item_id: workItem.work_item_id || workItem.id,
    reason: workItem.metadata?.archive_reason || 'noise/fyi — no action required',
    timestamp: new Date().toISOString(),
  }),
  reason: 'Deterministic archive confirmation',
}));

// ============================================================
// Helpers
// ============================================================

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
