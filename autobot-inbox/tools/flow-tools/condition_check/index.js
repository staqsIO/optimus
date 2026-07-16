/**
 * Flow-tool: condition_check
 *
 * Evaluate a simple comparison. Useful as a gate before expensive agents.
 *
 * Comparison rules:
 *   - equals / not_equals: if both left and right are numbers (or numeric
 *     strings where at least one side is already a number), compare numerically.
 *     Otherwise String-equal. This is the one consistent rule — document it
 *     in the description so operators aren't surprised.
 *   - greater_than / less_than: coerced via Number(); NaN on either side fails
 *     with reason="left or right is not numeric".
 *   - contains: Array.includes for arrays; String.includes for strings;
 *     otherwise false.
 *   - exists: true iff left is not null/undefined/empty-string. `right` ignored.
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

function numericCompare(left, right) {
  // If at least one side is already a number, try numeric comparison.
  const anyNumber = typeof left === 'number' || typeof right === 'number';
  if (!anyNumber) return null;
  const L = Number(left);
  const R = Number(right);
  if (Number.isNaN(L) || Number.isNaN(R)) return null;
  return { L, R };
}

function evaluate({ left, operator, right }) {
  if (!OPERATORS.has(operator)) {
    throw new Error(`Unknown operator "${operator}". Supported: ${[...OPERATORS].join(', ')}`);
  }

  if (operator === 'exists') {
    const result = !isEmpty(left);
    return { result, reason: result ? 'left is present' : 'left is null/undefined/empty' };
  }

  if (operator === 'equals' || operator === 'not_equals') {
    const numeric = numericCompare(left, right);
    let eq;
    if (numeric) {
      eq = numeric.L === numeric.R;
    } else {
      eq = String(left) === String(right);
    }
    const result = operator === 'equals' ? eq : !eq;
    return {
      result,
      reason: `${JSON.stringify(left)} ${operator} ${JSON.stringify(right)} → ${result}`,
    };
  }

  if (operator === 'greater_than' || operator === 'less_than') {
    const L = Number(left);
    const R = Number(right);
    if (Number.isNaN(L) || Number.isNaN(R)) {
      return { result: false, reason: 'left or right is not numeric' };
    }
    const result = operator === 'greater_than' ? L > R : L < R;
    return { result, reason: `${L} ${operator} ${R} → ${result}` };
  }

  // contains
  if (Array.isArray(left)) {
    const result = left.includes(right);
    return { result, reason: `array ${result ? 'contains' : 'does not contain'} ${JSON.stringify(right)}` };
  }
  if (typeof left === 'string' && typeof right === 'string') {
    const result = left.includes(right);
    return { result, reason: `string ${result ? 'contains' : 'does not contain'} ${JSON.stringify(right)}` };
  }
  return { result: false, reason: 'contains requires left to be array or string with matching right' };
}

export default {
  id: 'condition_check',
  description:
    'Evaluate a comparison (equals/not_equals/greater_than/less_than/contains/exists) and return a boolean. '
    + 'Numeric comparison is used when either side is a number; otherwise string equality.',
  inputSchema: {
    left: { type: ['string', 'number', 'boolean', 'array', 'null'], required: true },
    operator: { type: 'string', required: true, enum: [...OPERATORS] },
    right: { type: ['string', 'number', 'boolean', 'null'], default: null },
  },
  outputSchema: {
    result: 'boolean',
    reason: 'string',
  },
  handler: evaluate,
};
