/**
 * Flow-agent: extract_entities
 *
 * Pull structured entities (dates, amounts, names, URLs, etc.) out of free-form
 * text. The caller declares which entity types they want; the agent returns an
 * array of { type, value, snippet } — zero or more per type.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(resolve(__dirname, 'prompt.md'), 'utf8');

export default {
  id: 'extract_entities',
  description: 'Extract structured entities (dates, amounts, names, URLs, ...) from text.',
  model: 'claude-haiku-4-5-20251001',
  maxCostUsd: 0.03,
  maxTokens: 1024,
  temperature: 0.1,
  inputSchema: {
    text: { type: 'string', required: true },
    entityTypes: { type: 'array', required: true },
    context: { type: 'string', default: '' },
  },
  outputSchema: {
    entities: 'array',
  },
  prompt,
};
