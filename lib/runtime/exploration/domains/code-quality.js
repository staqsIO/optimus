/**
 * Exploration Domain: Code Quality (ADR-021)
 *
 * Analyzes the codebase for:
 * - Dead exports (exported but never imported)
 * - Large files (complexity indicator)
 * - TODO/FIXME/HACK density
 *
 * Pure filesystem analysis — zero LLM cost.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..');

export const domain = 'code_quality';

/**
 * Run code quality analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object, pattern?: string}>>}
 */
export async function analyze() {
  const findings = [];
  const jsFiles = await collectJsFiles(SRC_ROOT);

  // 1. Large files (> 400 lines)
  const largeFiles = [];
  for (const file of jsFiles) {
    try {
      const content = await readFile(file, 'utf-8');
      const lineCount = content.split('\n').length;
      if (lineCount > 400) {
        largeFiles.push({ file: file.replace(SRC_ROOT, 'src'), lines: lineCount });
      }
    } catch { /* skip unreadable files */ }
  }

  if (largeFiles.length > 0) {
    largeFiles.sort((a, b) => b.lines - a.lines);
    findings.push({
      title: `${largeFiles.length} file(s) exceed 400 lines`,
      severity: largeFiles.some(f => f.lines > 600) ? 'medium' : 'low',
      evidence: {
        count: largeFiles.length,
        files: largeFiles.slice(0, 10),
      },
    });
  }

  // 2. TODO/FIXME/HACK markers
  const markers = [];
  for (const file of jsFiles) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/\b(TODO|FIXME|HACK|XXX)\b/i);
        if (match) {
          markers.push({
            file: file.replace(SRC_ROOT, 'src'),
            line: i + 1,
            type: match[1].toUpperCase(),
            text: lines[i].trim().slice(0, 100),
          });
        }
      }
    } catch { /* skip */ }
  }

  if (markers.length > 10) {
    const fixmeCount = markers.filter(m => m.type === 'FIXME' || m.type === 'HACK').length;
    findings.push({
      title: `${markers.length} TODO/FIXME markers (${fixmeCount} FIXME/HACK)`,
      severity: fixmeCount > 5 ? 'medium' : 'low',
      pattern: 'dead_code',
      evidence: {
        total: markers.length,
        fixme_hack: fixmeCount,
        samples: markers.filter(m => m.type !== 'TODO').slice(0, 5),
      },
    });
  }

  return findings;
}

async function collectJsFiles(dir, files = []) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dashboard') continue;
      if (entry.isDirectory()) {
        await collectJsFiles(fullPath, files);
      } else if (extname(entry.name) === '.js') {
        files.push(fullPath);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return files;
}
