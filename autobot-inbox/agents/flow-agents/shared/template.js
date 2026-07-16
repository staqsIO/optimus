/**
 * Minimal {{placeholder}} template renderer for flow-agent prompts.
 *
 * No loops, no conditionals, no filters. If a prompt needs that, the author
 * should compute the value in input instead. Keeping this boring on purpose.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Render a template string by substituting {{name}} with values from context.
 * Throws if the template references a name not present in context.
 *
 * Array/object values are JSON-stringified. Numbers/booleans converted via String().
 */
export function render(template, context) {
  if (typeof template !== 'string') {
    throw new Error('Template must be a string');
  }

  // Collect missing keys first so the error message lists them all at once.
  const missing = [];
  const rendered = template.replace(PLACEHOLDER_RE, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(context, name)) {
      missing.push(name);
      return '';
    }
    const value = context[name];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    throw new Error(
      `Prompt references undeclared field(s): ${unique.join(', ')}. Declare them in inputSchema.`
    );
  }

  return rendered;
}
