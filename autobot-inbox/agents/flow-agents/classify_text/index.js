/**
 * Flow-agent: classify_text
 *
 * Pure declarative config. Execution goes through flow-agents/shared/runner.js.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(resolve(__dirname, 'prompt.md'), 'utf8');

export default {
  id: 'classify_text',
  description: 'Classify input text into one of a provided set of categories.',
  model: 'claude-haiku-4-5-20251001',
  maxCostUsd: 0.02,
  maxTokens: 256,
  temperature: 0.1,
  inputSchema: {
    text: { type: 'string', required: true },
    categories: { type: 'array', required: true },
    context: { type: 'string', default: '' },
  },
  outputSchema: {
    category: 'string',
    confidence: 'number',
    rationale: 'string',
  },
  prompt,
};
