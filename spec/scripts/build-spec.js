#!/usr/bin/env node

/**
 * build-spec.js
 *
 * Concatenates spec/_preamble.md + all section files (in order) back into SPEC.md.
 * Adds --- separators between sections, matching the original format.
 *
 * Usage: node scripts/build-spec.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPEC_PATH = join(ROOT, 'SPEC.md');
const SPEC_DIR = join(ROOT, 'spec');

// Ordered list of section files (must match split output)
const SECTION_FILES = [
  '00-design-principles.md',
  '01-core-idea.md',
  '02-architecture-overview.md',
  '03-task-graph.md',
  '04-agent-runtime.md',
  '05-guardrails.md',
  '06-tool-integrity.md',
  '07-communication-gateway.md',
  '08-audit-observability.md',
  '09-kill-switch.md',
  '10-cost-tracking.md',
  '11-failure-modes.md',
  '12-database-architecture.md',
  '13-constitution.md',
  '14-phased-execution.md',
  '15-operating-cost-model.md',
  '16-resolved-questions.md',
  '17-legal-compliance.md',
  '18-autonomous-composition.md',
  '19-strategy-evaluation.md',
  '20-not-covered.md',
  '21-changelog.md',
];

function main() {
  const comment = '<!-- AUTO-GENERATED from spec/ directory. Do not edit directly. Run: node scripts/build-spec.js -->\n';

  // Read preamble
  const preamble = readFileSync(join(SPEC_DIR, '_preamble.md'), 'utf-8').trimEnd();

  const parts = [comment, preamble];

  for (const file of SECTION_FILES) {
    const section = readFileSync(join(SPEC_DIR, file), 'utf-8').trimEnd();
    parts.push('\n\n---\n\n' + section);
  }

  const output = parts.join('') + '\n';
  writeFileSync(SPEC_PATH, output);
  console.log(`Built SPEC.md (${output.split('\n').length} lines)`);
}

main();
