#!/usr/bin/env node
/**
 * Extract org infrastructure from autobot-inbox/src/ to lib/
 * Creates re-export shims at original locations for zero-breakage migration.
 *
 * Usage: node scripts/extract-lib.js [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'autobot-inbox', 'src');
const LIB = join(ROOT, 'lib');

const DRY_RUN = process.argv.includes('--dry-run');

// Directories to extract (relative to autobot-inbox/src/)
const DIRS_TO_EXTRACT = [
  'runtime',
  'adapters',
  'graph',
  'audit',
  'llm',
  'comms',
  'rag',
];

// Individual files to extract (relative to autobot-inbox/src/)
const FILES_TO_EXTRACT = [
  'db.js',
];

let movedCount = 0;
let shimCount = 0;

/**
 * Parse a JS file's exports to generate a proper re-export shim.
 * Handles: export function, export class, export const/let/var, export default, export { }
 */
function parseExports(content) {
  const exports = new Set();
  let hasDefault = false;

  // Named exports: export function/class/const/let/var name
  const namedPattern = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+(\w+)/g;
  let match;
  while ((match = namedPattern.exec(content)) !== null) {
    exports.add(match[1]);
  }

  // Re-exports: export { foo, bar } or export { foo as bar }
  const reexportPattern = /export\s*\{([^}]+)\}/g;
  while ((match = reexportPattern.exec(content)) !== null) {
    // Skip "export { x } from '...'" — those are pass-through re-exports
    const afterBrace = content.slice(match.index + match[0].length).trimStart();
    if (afterBrace.startsWith('from')) continue; // Already a re-export, skip

    const names = match[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    }).filter(Boolean);
    names.forEach(n => exports.add(n));
  }

  // Default export
  if (/export\s+default\s/.test(content)) {
    hasDefault = true;
  }

  return { named: [...exports], hasDefault };
}

/**
 * Generate a re-export shim for a moved file.
 */
function generateShim(originalPath, libPath) {
  const content = readFileSync(libPath, 'utf-8');
  const { named, hasDefault } = parseExports(content);

  // Calculate relative path from original location to lib location
  const originalDir = dirname(originalPath);
  let relPath = relative(originalDir, libPath);
  if (!relPath.startsWith('.')) relPath = './' + relPath;
  // Normalize to forward slashes
  relPath = relPath.replace(/\\/g, '/');

  const lines = [];
  lines.push(`// Re-export shim — real implementation in ${relative(ROOT, libPath)}`);

  if (named.length > 0) {
    // Group into lines of ~4 exports each for readability
    const chunks = [];
    for (let i = 0; i < named.length; i += 4) {
      chunks.push(named.slice(i, i + 4).join(', '));
    }
    if (chunks.length === 1) {
      lines.push(`export { ${chunks[0]} } from '${relPath}';`);
    } else {
      lines.push(`export {`);
      chunks.forEach((chunk, i) => {
        lines.push(`  ${chunk}${i < chunks.length - 1 ? ',' : ''}`);
      });
      lines.push(`} from '${relPath}';`);
    }
  }

  if (hasDefault) {
    lines.push(`export { default } from '${relPath}';`);
  }

  // Fallback: if we couldn't detect any exports, use a wildcard re-export
  if (named.length === 0 && !hasDefault) {
    lines.push(`export * from '${relPath}';`);
  }

  return lines.join('\n') + '\n';
}

function processFile(srcRelPath) {
  const originalPath = join(SRC, srcRelPath);
  const libPath = join(LIB, srcRelPath);

  if (!existsSync(originalPath)) {
    console.log(`  SKIP (missing): ${srcRelPath}`);
    return;
  }

  // Only process .js files
  if (!originalPath.endsWith('.js')) {
    console.log(`  SKIP (not .js): ${srcRelPath}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`  WOULD MOVE: ${srcRelPath}`);
    movedCount++;
    return;
  }

  // Ensure lib target directory exists
  mkdirSync(dirname(libPath), { recursive: true });

  // Copy to lib/
  copyFileSync(originalPath, libPath);
  movedCount++;

  // Generate and write shim at original location
  const shim = generateShim(originalPath, libPath);
  writeFileSync(originalPath, shim);
  shimCount++;

  console.log(`  MOVED: ${srcRelPath} → lib/${srcRelPath}`);
}

function processDir(dirRelPath) {
  const fullDir = join(SRC, dirRelPath);
  if (!existsSync(fullDir)) {
    console.log(`  SKIP DIR (missing): ${dirRelPath}`);
    return;
  }

  const entries = readdirSync(fullDir);
  for (const entry of entries) {
    const entryRelPath = join(dirRelPath, entry);
    const fullPath = join(SRC, entryRelPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      processDir(entryRelPath);
    } else if (entry.endsWith('.js')) {
      processFile(entryRelPath);
    }
  }
}

// --- Main ---
console.log(`\nOptimus lib/ extraction${DRY_RUN ? ' (DRY RUN)' : ''}`);
console.log(`Source: ${SRC}`);
console.log(`Target: ${LIB}\n`);

for (const dir of DIRS_TO_EXTRACT) {
  console.log(`Processing ${dir}/`);
  processDir(dir);
}

for (const file of FILES_TO_EXTRACT) {
  console.log(`Processing ${file}`);
  processFile(file);
}

console.log(`\n${DRY_RUN ? 'Would move' : 'Moved'}: ${movedCount} files`);
console.log(`${DRY_RUN ? 'Would create' : 'Created'}: ${shimCount} shims`);
