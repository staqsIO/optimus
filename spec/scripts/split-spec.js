#!/usr/bin/env node

/**
 * split-spec.js
 *
 * Reads SPEC.md and splits it into per-section files under spec/.
 * Also generates spec/_index.yaml with metadata.
 *
 * Usage: node scripts/split-spec.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPEC_PATH = join(ROOT, 'SPEC.md');
const SPEC_DIR = join(ROOT, 'spec');

// Section ID -> filename slug mapping
const SLUG_MAP = {
  '0': '00-design-principles',
  '1': '01-core-idea',
  '2': '02-architecture-overview',
  '3': '03-task-graph',
  '4': '04-agent-runtime',
  '5': '05-guardrails',
  '6': '06-tool-integrity',
  '7': '07-communication-gateway',
  '8': '08-audit-observability',
  '9': '09-kill-switch',
  '10': '10-cost-tracking',
  '11': '11-failure-modes',
  '12': '12-database-architecture',
  '13': '13-constitution',
  '14': '14-phased-execution',
  '15': '15-operating-cost-model',
  '16': '16-resolved-questions',
  '17': '17-legal-compliance',
  '18': '18-autonomous-composition',
  '19': '19-strategy-evaluation',
  '20': '20-not-covered',
  '21': '21-changelog',
};

// Domain and metadata mapping
const SECTION_META = {
  '0':  { domain: 'foundations',     status: 'stable', phase: 1 },
  '1':  { domain: 'foundations',     status: 'stable', phase: 0 },
  '2':  { domain: 'foundations',     status: 'stable', phase: 1 },
  '3':  { domain: 'runtime',        status: 'stable', phase: 1 },
  '4':  { domain: 'runtime',        status: 'stable', phase: 1 },
  '5':  { domain: 'runtime',        status: 'stable', phase: 1 },
  '6':  { domain: 'runtime',        status: 'stable', phase: 1 },
  '7':  { domain: 'infrastructure', status: 'stable', phase: 1 },
  '8':  { domain: 'infrastructure', status: 'stable', phase: 1 },
  '9':  { domain: 'infrastructure', status: 'stable', phase: 1 },
  '10': { domain: 'infrastructure', status: 'stable', phase: 1 },
  '11': { domain: 'infrastructure', status: 'stable', phase: 1 },
  '12': { domain: 'infrastructure', status: 'stable', phase: 1 },
  '13': { domain: 'governance',     status: 'stable', phase: 3 },
  '14': { domain: 'governance',     status: 'active', phase: 1 },
  '15': { domain: 'governance',     status: 'stable', phase: 1 },
  '16': { domain: 'governance',     status: 'stable', phase: 1 },
  '17': { domain: 'governance',     status: 'stable', phase: 3 },
  '18': { domain: 'strategy',       status: 'stable', phase: 3 },
  '19': { domain: 'strategy',       status: 'stable', phase: 2 },
  '20': { domain: 'strategy',       status: 'stable', phase: 0 },
  '21': { domain: 'strategy',       status: 'stable', phase: 0 },
};

function main() {
  const content = readFileSync(SPEC_PATH, 'utf-8');
  const lines = content.split('\n');

  mkdirSync(SPEC_DIR, { recursive: true });

  // Find all ## headings and the --- separators before them
  const sectionStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionStarts.push(i);
    }
  }

  // Extract preamble: everything before the first ---\n\n## pattern
  // Find the --- that precedes the first ## heading
  let preambleEnd = sectionStarts[0];
  // Walk backwards from the first ## to find the ---
  for (let i = sectionStarts[0] - 1; i >= 0; i--) {
    if (lines[i] === '---') {
      preambleEnd = i;
      break;
    }
  }

  // Preamble is lines 0..preambleEnd-1, trimmed of trailing whitespace
  const preambleLines = lines.slice(0, preambleEnd);
  // Remove trailing empty lines
  while (preambleLines.length > 0 && preambleLines[preambleLines.length - 1].trim() === '') {
    preambleLines.pop();
  }
  const preambleContent = preambleLines.join('\n') + '\n';
  writeFileSync(join(SPEC_DIR, '_preamble.md'), preambleContent);
  console.log(`Wrote _preamble.md (${preambleLines.length} lines)`);

  // Extract each section
  const sections = [];
  for (let idx = 0; idx < sectionStarts.length; idx++) {
    const start = sectionStarts[idx];
    // Section ends at the --- before the next ## heading, or at EOF
    let end;
    if (idx + 1 < sectionStarts.length) {
      // Find the --- before the next section heading
      end = sectionStarts[idx + 1];
      for (let i = sectionStarts[idx + 1] - 1; i > start; i--) {
        if (lines[i] === '---') {
          end = i;
          break;
        }
      }
    } else {
      end = lines.length;
    }

    // Extract section lines, trim trailing empty lines
    const sectionLines = lines.slice(start, end);
    while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
      sectionLines.pop();
    }

    // Parse section ID from heading like "## 0. Design Principles" or "## 21. Changelog"
    const heading = lines[start];
    const match = heading.match(/^## (\d+)\./);
    if (!match) {
      console.error(`Could not parse section ID from: ${heading}`);
      process.exit(1);
    }
    const sectionId = match[1];
    const slug = SLUG_MAP[sectionId];
    if (!slug) {
      console.error(`No slug mapping for section ${sectionId}`);
      process.exit(1);
    }

    const filename = `${slug}.md`;
    const sectionContent = sectionLines.join('\n') + '\n';
    writeFileSync(join(SPEC_DIR, filename), sectionContent);
    console.log(`Wrote ${filename} (${sectionLines.length} lines)`);

    sections.push({ id: sectionId, file: filename, ...SECTION_META[sectionId] });
  }

  // Generate _index.yaml
  const yamlLines = [
    'version: "1.0.0"',
    'generated_from: "SPEC.md"',
    '',
    'domains:',
    '  foundations:',
    '    color: "zinc"',
    '    label: "Foundations"',
    '  runtime:',
    '    color: "blue"',
    '    label: "Runtime"',
    '  infrastructure:',
    '    color: "teal"',
    '    label: "Infrastructure"',
    '  governance:',
    '    color: "amber"',
    '    label: "Governance"',
    '  strategy:',
    '    color: "purple"',
    '    label: "Strategy"',
    '',
    'sections:',
  ];

  for (const s of sections) {
    yamlLines.push(`  - id: "${s.id}"`);
    yamlLines.push(`    file: "${s.file}"`);
    yamlLines.push(`    domain: ${s.domain}`);
    yamlLines.push(`    status: ${s.status}`);
    yamlLines.push(`    phase: ${s.phase}`);
  }

  writeFileSync(join(SPEC_DIR, '_index.yaml'), yamlLines.join('\n') + '\n');
  console.log('Wrote _index.yaml');

  console.log(`\nDone. Split ${sections.length} sections + preamble into spec/`);
}

main();
