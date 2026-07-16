/**
 * Playbook Loader
 *
 * Reads playbook markdown files from config/playbooks/.
 * Parses YAML frontmatter (simple key-value, no dependency needed)
 * and returns { meta, systemPrompt }.
 *
 * P4: Boring infrastructure — string splitting, not a YAML library.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = join(__dirname, '..', '..', '..', 'config', 'playbooks');

/**
 * Load a playbook by ID.
 *
 * @param {string} playbookId - e.g. 'implement-feature', 'fix-bug'
 * @returns {Promise<{ meta: Object, systemPrompt: string }>}
 * @throws {Error} if playbook not found or malformed
 */
export async function loadPlaybook(playbookId) {
  const filePath = join(PLAYBOOKS_DIR, `${playbookId}.md`);

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Playbook "${playbookId}" not found at ${filePath}: ${err.message}`);
  }

  return parsePlaybook(content, playbookId);
}

/**
 * Parse a playbook markdown string into { meta, systemPrompt }.
 *
 * Frontmatter format:
 *   ---
 *   key: value
 *   ---
 *   <body>
 *
 * Numeric values are auto-parsed. Everything else is a string.
 */
export function parsePlaybook(content, playbookId = 'unknown') {
  const trimmed = content.trim();

  if (!trimmed.startsWith('---')) {
    throw new Error(`Playbook "${playbookId}" missing YAML frontmatter (must start with ---)`);
  }

  // Find the closing ---
  const secondDelim = trimmed.indexOf('---', 3);
  if (secondDelim === -1) {
    throw new Error(`Playbook "${playbookId}" has unclosed frontmatter (missing closing ---)`);
  }

  const frontmatterBlock = trimmed.slice(3, secondDelim).trim();
  const body = trimmed.slice(secondDelim + 3).trim();

  // Parse simple key: value pairs
  const meta = {};
  for (const line of frontmatterBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Auto-parse numbers
    if (/^\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    }

    meta[key] = value;
  }

  // Validate required fields
  const required = ['id', 'default_budget_usd', 'max_turns'];
  for (const field of required) {
    if (meta[field] === undefined) {
      throw new Error(`Playbook "${playbookId}" missing required frontmatter field: ${field}`);
    }
  }

  return { meta, systemPrompt: body };
}

/**
 * List available playbook IDs.
 *
 * @returns {Promise<string[]>}
 */
export async function listPlaybooks() {
  const { readdir } = await import('fs/promises');
  const entries = await readdir(PLAYBOOKS_DIR);
  return entries
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}
