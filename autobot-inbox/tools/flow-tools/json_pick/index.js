/**
 * Flow-tool: json_pick
 *
 * Extract a subset of fields from an object. Narrows upstream output before
 * passing to the next step. Missing fields are silently omitted (not errored).
 */

export default {
  id: 'json_pick',
  description: 'Extract a subset of fields from an object.',
  inputSchema: {
    source: { type: 'object', required: true },
    fields: { type: 'array', required: true },
  },
  // outputSchema intentionally omitted — output is dynamic based on `fields`.
  handler: ({ source, fields }) => {
    const out = {};
    for (const name of fields) {
      if (typeof name !== 'string') continue;
      if (Object.prototype.hasOwnProperty.call(source, name)) {
        out[name] = source[name];
      }
    }
    return out;
  },
};
