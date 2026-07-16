#!/usr/bin/env node
/**
 * Obsidian Vault → RAG Ingestion Script
 *
 * Walks ~/vault (iCloud-synced), ingests all .md files into the knowledge base.
 * Tracks mtime for incremental sync — only re-ingests modified files.
 *
 * Usage:
 *   node scripts/ingest-vault.js                  # Incremental (default)
 *   node scripts/ingest-vault.js --full            # Full re-ingest
 *   node scripts/ingest-vault.js --dry-run         # Preview without ingesting
 *
 * Exclusions:
 *   - _templates/ (Obsidian template files)
 *   - .trash/ (Obsidian trash)
 *   - Untitled.* (canvas/base files)
 *   - Files < 50 chars (empty/stub notes)
 */

import 'dotenv/config';
import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import { glob } from 'glob';
import { ingestDocument } from '../../lib/rag/ingest.js';
import { query } from '../src/db.js';

const VAULT_PATH = process.env.VAULT_PATH || join(process.env.HOME, 'Library/Mobile Documents/iCloud~md~obsidian/Documents');
const STATE_FILE = join(dirname(new URL(import.meta.url).pathname), '..', 'data', 'vault-ingest-state.json');
const MIN_CONTENT_LENGTH = 50;

// Directories to skip
const EXCLUDE_DIRS = new Set(['_templates', '.trash', '.obsidian', 'node_modules']);

// Classification overrides by directory
const DIR_CLASSIFICATIONS = {
  'Clients': 'CONFIDENTIAL',      // Client info is sensitive
  'People': 'CONFIDENTIAL',       // Personal contact info
  'Organizations': 'INTERNAL',
  // STAQPRO-310: ~/vault/Memory/ contains MEMORY.md (production
  // credentials topology, Railway/Supabase deploy details, board
  // strategy, RLS architecture) — RESTRICTED keeps it out of all
  // agent retrieval (Q1-Q4 all cap at CONFIDENTIAL per the
  // classification policy in plan let-me-pause-and-magical-codd.md).
  // Still searchable by humans via /knowledge-base.
  // Existing rows need re-classification post-merge: run
  //   node scripts/ingest-vault.js --full
  // against prod.
  'Memory': 'RESTRICTED',
  'Daily Notes': 'INTERNAL',      // Session logs
  'Research': 'INTERNAL',
  'Ideas': 'INTERNAL',
  'Inbox': 'INTERNAL',
  'Architecture': 'INTERNAL',
  'Projects': 'INTERNAL',
};

function getClassification(relativePath) {
  const topDir = relativePath.split('/')[0];
  return DIR_CLASSIFICATIONS[topDir] || 'INTERNAL';
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { lastRun: null, files: {} };
  }
}

function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const fullReIngest = args.includes('--full');
  const dryRun = args.includes('--dry-run');

  console.log(`[vault-ingest] Starting ${fullReIngest ? 'FULL' : 'incremental'} ingestion from ${VAULT_PATH}`);
  if (dryRun) console.log('[vault-ingest] DRY RUN — no changes will be made');

  // Find all markdown files
  const files = await glob('**/*.md', {
    cwd: VAULT_PATH,
    ignore: EXCLUDE_DIRS.has('_templates')
      ? ['_templates/**', '.trash/**', '.obsidian/**', 'node_modules/**']
      : [],
  });

  console.log(`[vault-ingest] Found ${files.length} markdown files`);

  const state = fullReIngest ? { lastRun: null, files: {} } : loadState();
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    // Skip excluded directories
    const topDir = file.split('/')[0];
    if (EXCLUDE_DIRS.has(topDir)) { skipped++; continue; }

    const fullPath = join(VAULT_PATH, file);
    const stat = statSync(fullPath);
    const mtime = stat.mtimeMs;

    // Incremental: skip if not modified since last ingest
    if (!fullReIngest && state.files[file] && state.files[file] >= mtime) {
      skipped++;
      continue;
    }

    const content = readFileSync(fullPath, 'utf-8');
    if (content.trim().length < MIN_CONTENT_LENGTH) {
      skipped++;
      continue;
    }

    const classification = getClassification(file);
    const title = file.replace(/\.md$/, '').replace(/\//g, ' — ');

    if (dryRun) {
      console.log(`  [DRY] ${file} (${(content.length / 1024).toFixed(1)}KB, ${classification})`);
      ingested++;
      continue;
    }

    try {
      const result = await ingestDocument({
        source: 'vault',
        sourceId: `vault:${file}`,
        title,
        rawText: content,
        format: 'obsidian',
        metadata: { vault_path: file, classification },
        classification,
        forceUpdate: fullReIngest || !!state.files[file], // Re-ingest if modified
      });

      if (result && result.chunkCount > 0) {
        console.log(`  ✓ ${file} → ${result.chunkCount} chunks (${classification})`);
        ingested++;
      } else if (result) {
        skipped++; // Dedup hit
      }

      state.files[file] = mtime;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
      errors++;
    }
  }

  if (!dryRun) {
    state.lastRun = new Date().toISOString();
    saveState(state);
  }

  console.log(`[vault-ingest] Done: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
}

main().catch(err => {
  console.error('[vault-ingest] Fatal:', err);
  process.exit(1);
});
