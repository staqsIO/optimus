/**
 * @typedef {Object} OutputAdapter
 * @property {string} channel - Channel identifier ('email', 'slack', etc.)
 * @property {(draftId: string) => Promise<string|null>} createDraft - Create a platform draft (null if unsupported)
 * @property {(draftId: string) => Promise<string>} executeDraft - Send an approved draft
 */

const OUTPUT_ADAPTER_SPEC = {
  channel: 'string',
  createDraft: 'function',
  executeDraft: 'function',
};

/**
 * Validate that an object conforms to the OutputAdapter interface.
 * @param {any} adapter
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateOutputAdapter(adapter) {
  const errors = [];

  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, errors: ['adapter must be a non-null object'] };
  }

  for (const [key, expectedType] of Object.entries(OUTPUT_ADAPTER_SPEC)) {
    if (!(key in adapter)) {
      errors.push(`missing required property: ${key}`);
    } else if (typeof adapter[key] !== expectedType) {
      errors.push(`${key} must be a ${expectedType}, got ${typeof adapter[key]}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
