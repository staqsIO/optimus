/**
 * @typedef {Object} PromptContext
 * @property {string} channel - 'email', 'slack', etc.
 * @property {string|null} body - Full message body (may be null if unavailable)
 * @property {string} contentLabel - Label for untrusted content ('untrusted_email', 'untrusted_message')
 * @property {string} contentType - Human-readable type ('email', 'message')
 * @property {{ name: string, address: string }} sender
 * @property {{ threadId: string|null, inReplyTo: string|null, subject: string|null, toAddresses: string[], ccAddresses: string[] }|null} threading
 * @property {string} channelHint - Channel-specific prompt hint (empty string if none)
 */

/**
 * @typedef {Object} InputAdapter
 * @property {string} channel - Channel identifier ('email', 'slack', etc.)
 * @property {(message: Object) => Promise<string|null>} fetchContent - Fetch full message body
 * @property {(message: Object, body: string|null) => PromptContext} buildPromptContext - Build structured context for agent prompts
 */

const INPUT_ADAPTER_SPEC = {
  channel: 'string',
  fetchContent: 'function',
  buildPromptContext: 'function',
};

/**
 * Validate that an object conforms to the InputAdapter interface.
 * @param {any} adapter
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateInputAdapter(adapter) {
  const errors = [];

  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, errors: ['adapter must be a non-null object'] };
  }

  for (const [key, expectedType] of Object.entries(INPUT_ADAPTER_SPEC)) {
    if (!(key in adapter)) {
      errors.push(`missing required property: ${key}`);
    } else if (typeof adapter[key] !== expectedType) {
      errors.push(`${key} must be a ${expectedType}, got ${typeof adapter[key]}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
