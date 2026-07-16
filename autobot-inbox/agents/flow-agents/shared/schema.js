/**
 * Schema validation for flow-agents.
 *
 * Schemas are flat objects mapping fieldName -> descriptor, where a descriptor is
 * either a type string (e.g., 'string', 'number', 'boolean', 'array', 'object')
 * OR a detailed object: { type, required, default, enum }.
 *
 * Intentionally minimal — no JSON Schema dependency, no dynamic type coercion.
 * If a flow-agent author needs more, they split into two agents.
 */

const TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

function normalizeField(descriptor) {
  if (typeof descriptor === 'string') {
    return { type: descriptor, required: true };
  }
  if (descriptor && typeof descriptor === 'object') {
    return {
      // type may be a string, an array of strings, or omitted (accept any type)
      type: descriptor.type,
      required: descriptor.required !== false && !('default' in descriptor),
      default: 'default' in descriptor ? descriptor.default : undefined,
      enum: descriptor.enum,
    };
  }
  throw new Error(`Invalid schema descriptor: ${JSON.stringify(descriptor)}`);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkType(value, expected) {
  // Missing `type` means "accept any". Callers use this when a field is
  // intentionally polymorphic (e.g., condition_check.right is string | number | null).
  if (expected === undefined || expected === null) return true;
  const expectedList = Array.isArray(expected) ? expected : [expected];
  for (const t of expectedList) {
    if (!TYPES.has(t) && t !== 'null') {
      throw new Error(`Unknown type in schema: "${t}"`);
    }
  }
  const actual = typeOf(value);
  return expectedList.includes(actual);
}

/**
 * Validate input against a schema and fill defaults for missing optional fields.
 * Returns a new object — does not mutate input.
 *
 * @throws Error on validation failure (descriptive message)
 */
export function validateInput(schema, input) {
  const out = {};
  const src = input || {};

  for (const [name, rawDescriptor] of Object.entries(schema)) {
    const field = normalizeField(rawDescriptor);
    const present = Object.prototype.hasOwnProperty.call(src, name) && src[name] !== undefined;

    if (!present) {
      if (field.required) {
        throw new Error(`Missing required field "${name}"`);
      }
      out[name] = field.default;
      continue;
    }

    const value = src[name];
    if (!checkType(value, field.type)) {
      throw new Error(
        `Field "${name}" has wrong type: expected ${Array.isArray(field.type) ? field.type.join('|') : field.type}, got ${typeOf(value)}`
      );
    }

    if (field.enum && !field.enum.includes(value)) {
      throw new Error(
        `Field "${name}" must be one of ${JSON.stringify(field.enum)}, got ${JSON.stringify(value)}`
      );
    }

    out[name] = value;
  }

  return out;
}

/**
 * Validate a structured LLM output against an output schema.
 * Differs from validateInput: no defaults, all declared fields required.
 */
export function validateOutput(schema, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`Output must be an object, got ${typeOf(output)}`);
  }

  const out = {};
  for (const [name, rawDescriptor] of Object.entries(schema)) {
    const field = normalizeField(rawDescriptor);
    if (!Object.prototype.hasOwnProperty.call(output, name) || output[name] === undefined) {
      throw new Error(`Output missing required field "${name}"`);
    }
    const value = output[name];
    if (!checkType(value, field.type)) {
      throw new Error(
        `Output field "${name}" has wrong type: expected ${Array.isArray(field.type) ? field.type.join('|') : field.type}, got ${typeOf(value)}`
      );
    }
    if (field.enum && !field.enum.includes(value)) {
      throw new Error(
        `Output field "${name}" must be one of ${JSON.stringify(field.enum)}, got ${JSON.stringify(value)}`
      );
    }
    out[name] = value;
  }
  return out;
}

/** Return true if any declared output field is non-primitive (array/object). */
export function schemaExpectsJsonOutput(schema) {
  if (!schema || Object.keys(schema).length === 0) return false;
  const fieldCount = Object.keys(schema).length;
  if (fieldCount > 1) return true;
  const only = normalizeField(Object.values(schema)[0]);
  return only.type !== 'string';
}
