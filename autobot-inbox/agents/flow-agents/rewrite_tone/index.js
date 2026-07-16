/**
 * Flow-agent: rewrite_tone
 *
 * Rewrite input text to match a target tone. Facts preserved, phrasing changed.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(resolve(__dirname, 'prompt.md'), 'utf8');

export default {
  id: 'rewrite_tone',
  description: 'Rewrite text in a target tone, preserving facts.',
  model: 'claude-haiku-4-5-20251001',
  maxCostUsd: 0.03,
  maxTokens: 1024,
  temperature: 0.4,
  inputSchema: {
    text: { type: 'string', required: true },
    tone: {
      type: 'string',
      required: true,
      enum: ['formal', 'casual', 'assertive', 'soft', 'concise'],
    },
    instructions: { type: 'string', default: '' },
  },
  outputSchema: {
    rewritten: 'string',
  },
  prompt,
};
