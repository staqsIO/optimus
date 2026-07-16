/**
 * Flow-agent: summarize
 *
 * Pure declarative config. Execution goes through flow-agents/shared/runner.js.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(resolve(__dirname, 'prompt.md'), 'utf8');

export default {
  id: 'summarize',
  description: 'Produce a concise summary of input text.',
  model: 'claude-haiku-4-5-20251001',
  maxCostUsd: 0.02,
  maxTokens: 512,
  temperature: 0.3,
  inputSchema: {
    text: { type: 'string', required: true },
    maxWords: { type: 'number', default: 100 },
    style: { type: 'string', default: 'concise', enum: ['concise', 'bullet-points', 'technical'] },
  },
  outputSchema: {
    summary: 'string',
  },
  prompt,
};
