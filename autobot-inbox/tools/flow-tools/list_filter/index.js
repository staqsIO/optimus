/**
 * Flow-tool: list_filter
 *
 * Filter an array by comparing a field on each item against a value. Uses the
 * same operator vocabulary as `condition_check` for consistency.
 *
 * Item access: `field` picks a top-level property on each array item. For
 * nested fields, use `json_pick` / `condition_check` chained steps — we do
 * not support dotted paths here (same policy as the template resolver).
 */

const OPERATORS = new Set([
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'contains',
  'exists',
]);

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function compare(actual, operator, expected) {
  if (operator === 'exists') return !isEmpty(actual);

  if (operator === 'equals' || operator === 'not_equals') {
    const anyNumber = typeof actual === 'number' || typeof expected === 'number';
    let eq;
    if (anyNumber) {
      const L = Number(actual);
      const R = Number(expected);
      eq = !Number.isNaN(L) && !Number.isNaN(R) && L === R;
    } else {
      eq = String(actual) === String(expected);
    }
    return operator === 'equals' ? eq : !eq;
  }

  if (operator === 'greater_than' || operator === 'less_than') {
    const L = Number(actual);
    const R = Number(expected);
    if (Number.isNaN(L) || Number.isNaN(R)) return false;
    return operator === 'greater_than' ? L > R : L < R;
  }

  // contains
  if (Array.isArray(actual)) return actual.includes(expected);
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
  return false;
}

function listFilter({ list, field, operator, value }) {
  if (!OPERATORS.has(operator)) {
    throw new Error(`Unknown operator "${operator}". Supported: ${[...OPERATORS].join(', ')}`);
  }

  const kept = [];
  for (const item of list) {
    const actual =
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? item[field]
        : undefined;
    if (compare(actual, operator, value)) kept.push(item);
  }

  return { items: kept, count: kept.length };
}

export default {
  id: 'list_filter',
  description:
    'Filter an array by comparing a named field on each item against a value. '
    + 'Operators match condition_check: equals, not_equals, greater_than, less_than, contains, exists.',
  inputSchema: {
    list: { type: 'array', required: true },
    field: { type: 'string', required: true },
    operator: { type: 'string', required: true, enum: [...OPERATORS] },
    value: { type: ['string', 'number', 'boolean', 'null'], default: null },
  },
  outputSchema: {
    items: 'array',
    count: 'number',
  },
  handler: listFilter,
};
