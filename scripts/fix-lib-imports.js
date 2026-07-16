#!/usr/bin/env node

/**
 * fix-lib-imports.js
 *
 * After moving ~80 files from autobot-inbox/src/ to lib/, the relative import
 * paths inside lib/ files are still written as if they live under autobot-inbox/src/.
 *
 * This script:
 *   1. Scans all .js files in lib/ recursively
 *   2. For each relative import/require, resolves where the OLD path pointed
 *      (i.e. what it would resolve to from autobot-inbox/src/<same-relative-path>)
 *   3. Checks whether the target file now lives in lib/ (was moved) or still
 *      lives in autobot-inbox/src/ (was not moved)
 *   4. Computes the correct new relative path from the file's lib/ location
 *   5. Rewrites the import if it changed
 *
 * Usage:
 *   node scripts/fix-lib-imports.js            # apply fixes
 *   node scripts/fix-lib-imports.js --dry-run   # preview only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, relative, dirname, join } from 'path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const LIB_DIR = join(REPO_ROOT, 'lib');
const OLD_SRC_DIR = join(REPO_ROOT, 'autobot-inbox', 'src');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Collect all .js files in lib/ recursively ──────────────────────────────

function collectJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ── Compute the "old location" of a lib/ file ─────────────────────────────
// lib/runtime/agent-loop.js  →  autobot-inbox/src/runtime/agent-loop.js

function oldLocationOf(libFilePath) {
  const rel = relative(LIB_DIR, libFilePath); // e.g. "runtime/agent-loop.js"
  return join(OLD_SRC_DIR, rel);
}

// ── Regex to match import specifiers ───────────────────────────────────────
// Handles:
//   import ... from './foo.js'
//   import ... from "../bar.js"
//   import('./baz.js')
//   await import("../qux.js")
//   export ... from './foo.js'

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\1/g;

// ── Resolve an import target ───────────────────────────────────────────────

function resolveImport(importPath, fromDir) {
  return resolve(fromDir, importPath);
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const files = collectJsFiles(LIB_DIR);
  let totalFiles = 0;
  let totalFixes = 0;
  const changes = []; // { file, line, old, new }

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const fileDir = dirname(filePath);

    // Where this file USED to live
    const oldFilePath = oldLocationOf(filePath);
    const oldFileDir = dirname(oldFilePath);

    let fileChanged = false;
    const newLines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      let lineChanged = false;

      // Reset regex state
      IMPORT_RE.lastIndex = 0;

      line = line.replace(IMPORT_RE, (match, quote, importPath) => {
        // Skip non-relative imports (shouldn't match our regex, but be safe)
        if (!importPath.startsWith('.')) return match;

        // What did the OLD import resolve to?
        const oldTarget = resolveImport(importPath, oldFileDir);

        // Check: does the target file exist in lib/?
        // Map the old target (autobot-inbox/src/X) to lib/X
        const relFromOldSrc = relative(OLD_SRC_DIR, oldTarget);

        // If the old target is outside autobot-inbox/src/ entirely, skip it
        if (relFromOldSrc.startsWith('..')) {
          // Already points outside src — could be node_modules or something weird
          // Check if the current relative path still resolves from the new location
          const currentTarget = resolveImport(importPath, fileDir);
          if (existsSync(currentTarget)) return match; // still works, leave it
          // Otherwise we can't fix it automatically
          return match;
        }

        const potentialLibTarget = join(LIB_DIR, relFromOldSrc);

        let newTarget;
        if (existsSync(potentialLibTarget)) {
          // Target was moved to lib/ — point to it in lib/
          newTarget = potentialLibTarget;
        } else if (existsSync(oldTarget)) {
          // Target still lives in autobot-inbox/src/ — point there
          newTarget = oldTarget;
        } else {
          // Target doesn't exist in either location — leave alone
          // (could be a build artifact, optional dep, etc.)
          return match;
        }

        // Compute new relative path from current file's directory in lib/
        let newRelPath = relative(fileDir, newTarget);

        // Ensure it starts with ./ or ../
        if (!newRelPath.startsWith('.')) {
          newRelPath = './' + newRelPath;
        }

        // Normalize to forward slashes (for Windows compat, though we're on macOS)
        newRelPath = newRelPath.replace(/\\/g, '/');

        if (newRelPath === importPath) {
          // No change needed
          return match;
        }

        lineChanged = true;
        fileChanged = true;

        // Reconstruct the match with the new path
        // We need to figure out the prefix (from or import()
        const prefixMatch = match.match(/^((?:from\s+|import\s*\(\s*)['"])/);
        const suffixMatch = match.match(/(['"](?:\s*\))?)$/);

        changes.push({
          file: relative(REPO_ROOT, filePath),
          line: i + 1,
          old: importPath,
          new: newRelPath,
        });

        return match.replace(importPath, newRelPath);
      });

      newLines.push(line);
      if (lineChanged) totalFixes++;
    }

    if (fileChanged) {
      totalFiles++;
      if (!DRY_RUN) {
        writeFileSync(filePath, newLines.join('\n'), 'utf-8');
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(70)}`);
  console.log(DRY_RUN ? '  DRY RUN — no files modified' : '  APPLIED — files modified');
  console.log(`${'='.repeat(70)}\n`);

  if (changes.length === 0) {
    console.log('No import changes needed.\n');
    return;
  }

  // Group by file
  const byFile = {};
  for (const c of changes) {
    (byFile[c.file] ??= []).push(c);
  }

  for (const [file, fileChanges] of Object.entries(byFile)) {
    console.log(`📄 ${file}`);
    for (const c of fileChanges) {
      console.log(`   L${c.line}: ${c.old}`);
      console.log(`      → ${c.new}`);
    }
    console.log('');
  }

  console.log(`Summary: ${totalFixes} imports fixed across ${totalFiles} files.\n`);
}

main();
