#!/usr/bin/env node
/**
 * Extract org-level agents from autobot-inbox/src/agents/ to root agents/
 * Creates re-export shims at original locations.
 * Fixes imports to point to ../lib/ instead of ../runtime/ etc.
 *
 * Usage: node scripts/extract-agents.js [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_AGENTS = join(ROOT, 'autobot-inbox', 'src', 'agents');
const DST_AGENTS = join(ROOT, 'agents');

const DRY_RUN = process.argv.includes('--dry-run');

// Org-level agents to move (files and directories)
const ORG_AGENTS = [
  'executor-intake.js',
  'executor-coder.js',
  'executor-blueprint.js',
  'executor-redesign.js',
  'executor-research.js',
  'executor-ticket.js',
  'reviewer.js',
  'architect.js',
  'redesign-strategy.js',
  'claw-workshop',       // directory
  'claw-campaigner',     // directory
  'research',            // directory
];

// Import path mappings: old prefix → new prefix (from agents/ perspective)
// Old: agents import from ../runtime/, ../db.js etc (shims in autobot-inbox/src/)
// New: agents import from ../lib/runtime/, ../lib/db.js (direct to lib/)
const IMPORT_REWRITES = [
  // Shim paths → lib/ direct paths
  { from: /from\s+['"]\.\.\/runtime\//g, to: "from '../lib/runtime/" },
  { from: /from\s+['"]\.\.\/db\.js/g, to: "from '../lib/db.js" },
  { from: /from\s+['"]\.\.\/adapters\//g, to: "from '../lib/adapters/" },
  { from: /from\s+['"]\.\.\/graph\//g, to: "from '../lib/graph/" },
  { from: /from\s+['"]\.\.\/comms\//g, to: "from '../lib/comms/" },
  { from: /from\s+['"]\.\.\/rag\//g, to: "from '../lib/rag/" },
  { from: /from\s+['"]\.\.\/audit\//g, to: "from '../lib/audit/" },
  { from: /from\s+['"]\.\.\/llm\//g, to: "from '../lib/llm/" },
  // Product-specific paths need to go through autobot-inbox/src/
  { from: /from\s+['"]\.\.\/gmail\//g, to: "from '../autobot-inbox/src/gmail/" },
  { from: /from\s+['"]\.\.\/voice\//g, to: "from '../autobot-inbox/src/voice/" },
  { from: /from\s+['"]\.\.\/signal\//g, to: "from '../autobot-inbox/src/signal/" },
  { from: /from\s+['"]\.\.\/slack\//g, to: "from '../autobot-inbox/src/slack/" },
  { from: /from\s+['"]\.\.\/linear\//g, to: "from '../autobot-inbox/src/linear/" },
  { from: /from\s+['"]\.\.\/github\//g, to: "from '../autobot-inbox/src/github/" },
  { from: /from\s+['"]\.\.\/drive\//g, to: "from '../autobot-inbox/src/drive/" },
  { from: /from\s+['"]\.\.\/telegram\//g, to: "from '../autobot-inbox/src/telegram/" },
  { from: /from\s+['"]\.\.\/outlook\//g, to: "from '../autobot-inbox/src/outlook/" },
  // Config paths via new URL
  { from: /new URL\('\.\.\/\.\.\/config\//g, to: "new URL('../autobot-inbox/config/" },
];

// For files inside subdirectories (claw-workshop/, claw-campaigner/, research/)
// they use ../../ prefix instead of ../
const SUBDIR_IMPORT_REWRITES = [
  { from: /from\s+['"]\.\.\/\.\.\/runtime\//g, to: "from '../../lib/runtime/" },
  { from: /from\s+['"]\.\.\/\.\.\/db\.js/g, to: "from '../../lib/db.js" },
  { from: /from\s+['"]\.\.\/\.\.\/adapters\//g, to: "from '../../lib/adapters/" },
  { from: /from\s+['"]\.\.\/\.\.\/graph\//g, to: "from '../../lib/graph/" },
  { from: /from\s+['"]\.\.\/\.\.\/comms\//g, to: "from '../../lib/comms/" },
  { from: /from\s+['"]\.\.\/\.\.\/rag\//g, to: "from '../../lib/rag/" },
  { from: /from\s+['"]\.\.\/\.\.\/llm\//g, to: "from '../../lib/llm/" },
  { from: /from\s+['"]\.\.\/\.\.\/linear\//g, to: "from '../../autobot-inbox/src/linear/" },
  { from: /from\s+['"]\.\.\/\.\.\/github\//g, to: "from '../../autobot-inbox/src/github/" },
  { from: /from\s+['"]\.\.\/\.\.\/gmail\//g, to: "from '../../autobot-inbox/src/gmail/" },
  { from: /from\s+['"]\.\.\/\.\.\/voice\//g, to: "from '../../autobot-inbox/src/voice/" },
  { from: /from\s+['"]\.\.\/\.\.\/signal\//g, to: "from '../../autobot-inbox/src/signal/" },
  { from: /from\s+['"]\.\.\/\.\.\/slack\//g, to: "from '../../autobot-inbox/src/slack/" },
  // Config paths via new URL
  { from: /new URL\('\.\.\/\.\.\/\.\.\/config\//g, to: "new URL('../../autobot-inbox/config/" },
  { from: /new URL\('\.\.\/\.\.\/config\//g, to: "new URL('../../autobot-inbox/config/" },
  // __dirname based config paths
  { from: /join\(__dirname,\s*['"]\.\.['"],\s*['"]\.\.['"],\s*['"]config['"]/g, to: "join(__dirname, '..', 'autobot-inbox', 'config'" },
];

function parseExports(content) {
  const exports = new Set();
  let hasDefault = false;
  const namedPattern = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+(\w+)/g;
  let match;
  while ((match = namedPattern.exec(content)) !== null) exports.add(match[1]);
  const reexportPattern = /export\s*\{([^}]+)\}/g;
  while ((match = reexportPattern.exec(content)) !== null) {
    const afterBrace = content.slice(match.index + match[0].length).trimStart();
    if (afterBrace.startsWith('from')) continue;
    match[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean).forEach(n => exports.add(n));
  }
  if (/export\s+default\s/.test(content)) hasDefault = true;
  return { named: [...exports], hasDefault };
}

function generateShim(originalPath, destPath) {
  const content = readFileSync(destPath, 'utf-8');
  const { named, hasDefault } = parseExports(content);
  let relPath = relative(dirname(originalPath), destPath).replace(/\\/g, '/');
  if (!relPath.startsWith('.')) relPath = './' + relPath;
  const lines = [`// Re-export shim — real implementation in ${relative(ROOT, destPath)}`];
  if (named.length > 0) lines.push(`export { ${named.join(', ')} } from '${relPath}';`);
  if (hasDefault) lines.push(`export { default } from '${relPath}';`);
  if (named.length === 0 && !hasDefault) lines.push(`export * from '${relPath}';`);
  return lines.join('\n') + '\n';
}

function rewriteImports(content, isSubdir) {
  const rewrites = isSubdir ? SUBDIR_IMPORT_REWRITES : IMPORT_REWRITES;
  let result = content;
  for (const { from, to } of rewrites) {
    result = result.replace(from, to);
  }
  return result;
}

function processFile(srcPath, dstPath, isSubdir = false) {
  if (DRY_RUN) {
    console.log(`  WOULD MOVE: ${relative(ROOT, srcPath)} → ${relative(ROOT, dstPath)}`);
    return;
  }
  mkdirSync(dirname(dstPath), { recursive: true });
  const content = readFileSync(srcPath, 'utf-8');
  const rewritten = rewriteImports(content, isSubdir);
  writeFileSync(dstPath, rewritten);
  // Create shim at original location
  const shim = generateShim(srcPath, dstPath);
  writeFileSync(srcPath, shim);
  console.log(`  MOVED: ${relative(ROOT, srcPath)} → ${relative(ROOT, dstPath)}`);
}

function processDir(name) {
  const srcDir = join(SRC_AGENTS, name);
  const dstDir = join(DST_AGENTS, name);
  if (!existsSync(srcDir)) { console.log(`  SKIP DIR: ${name}`); return; }
  const entries = readdirSync(srcDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    if (statSync(srcPath).isDirectory()) continue;
    if (!entry.endsWith('.js')) continue;
    const dstPath = join(dstDir, entry);
    processFile(srcPath, dstPath, true);
  }
}

// --- Main ---
console.log(`\nAgent extraction${DRY_RUN ? ' (DRY RUN)' : ''}\n`);
let count = 0;

for (const agent of ORG_AGENTS) {
  const srcPath = join(SRC_AGENTS, agent);
  if (!existsSync(srcPath)) { console.log(`  SKIP: ${agent}`); continue; }
  if (statSync(srcPath).isDirectory()) {
    console.log(`Processing ${agent}/`);
    processDir(agent);
  } else {
    console.log(`Processing ${agent}`);
    processFile(srcPath, join(DST_AGENTS, agent), false);
  }
  count++;
}

console.log(`\n${DRY_RUN ? 'Would process' : 'Processed'}: ${count} agents`);
