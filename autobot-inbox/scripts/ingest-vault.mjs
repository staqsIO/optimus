#!/usr/bin/env node
/**
 * Ingest an Obsidian vault into Optimus.
 *
 * Walks the vault, POSTs each .md file to /api/documents/ingest with
 * format='obsidian'. Idempotent: tracks content hashes in a local
 * JSON cache so re-runs only re-ingest changed files.
 *
 * Usage:
 *   OPTIMUS_API_URL=https://preview.staqs.io \
 *   OPTIMUS_API_SECRET=... \
 *   VAULT_PATH=~/vault VAULT_OWNER=eric \
 *   node scripts/ingest-vault.mjs
 *
 * CLI flags override env:
 *   --vault-path=~/vault
 *   --owner=eric
 *   --api-url=https://...
 *   --dry-run            (don't post, just list what would change)
 *   --force              (re-ingest everything, ignore cache)
 *   --concurrency=4
 *
 * Cache file: ~/.optimus-vault-sync-<owner>.json
 *
 * Skips: .obsidian/, .trash/, .git/, node_modules/, files >1MB,
 *        non-.md files.
 *
 * For ongoing sync, run via launchd / cron every 15 min, OR move to
 * the GitHub-webhook flow once the vault is a private repo.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const argv = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
);

const VAULT_PATH = expandHome(argv['vault-path'] ?? process.env.VAULT_PATH ?? '~/vault');
const VAULT_OWNER = argv.owner ?? process.env.VAULT_OWNER ?? 'unknown';
const API_URL = (argv['api-url'] ?? process.env.OPTIMUS_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const API_SECRET = process.env.OPTIMUS_API_SECRET || '';
const DRY = !!argv['dry-run'];
const FORCE = !!argv.force;
const CONCURRENCY = Number(argv.concurrency ?? 4);
const MAX_FILE_BYTES = 1_000_000;
const CACHE_PATH = join(homedir(), `.optimus-vault-sync-${VAULT_OWNER}.json`);
const SKIP_DIR = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

async function walk(root, acc = []) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

async function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}

async function saveCache(cache) {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function titleFromPath(relPath) {
  const base = relPath.split(sep).pop() ?? 'untitled';
  return base.replace(/\.md$/, '');
}

async function postIngest({ relPath, content, hash, mtime }) {
  const sourceId = `obsidian:${VAULT_OWNER}:${relPath.split(sep).join('/')}`;
  const body = {
    source: 'obsidian',
    sourceId,
    title: titleFromPath(relPath),
    rawText: content,
    format: 'obsidian',
    // Vault content is org-internal, not personally owned. This bypasses
    // the auth-sub→owner_id resolution path which rejects the legacy
    // Bearer auth's non-UUID 'sub' value.
    sharedWithOrg: true,
    metadata: {
      vault: VAULT_OWNER,
      path: relPath.split(sep).join('/'),
      hash,
      modifiedAt: new Date(mtime).toISOString(),
      vaultRoot: VAULT_PATH,
    },
  };
  const res = await fetch(`${API_URL}/api/documents/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(API_SECRET && { authorization: `Bearer ${API_SECRET}` }),
      'x-board-user': `vault-watcher:${VAULT_OWNER}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function processFile(absPath, cache, stats) {
  const relPath = relative(VAULT_PATH, absPath);
  const fileStat = await stat(absPath);
  if (fileStat.size > MAX_FILE_BYTES) {
    stats.skippedTooLarge++;
    return;
  }
  const content = await readFile(absPath, 'utf8');
  if (!content.trim()) { stats.skippedEmpty++; return; }
  const hash = createHash('sha256').update(content).digest('hex');
  const cached = cache[relPath];
  if (!FORCE && cached?.hash === hash) {
    stats.unchanged++;
    return;
  }
  if (DRY) {
    console.log(`  WOULD INGEST ${relPath} (${cached ? 'changed' : 'new'})`);
    stats.wouldIngest++;
    return;
  }
  try {
    await postIngest({ relPath, content, hash, mtime: fileStat.mtimeMs });
    cache[relPath] = { hash, ingestedAt: new Date().toISOString(), size: fileStat.size };
    stats.ingested++;
    process.stdout.write('.');
  } catch (err) {
    console.error(`\n  FAILED ${relPath}: ${err.message}`);
    stats.failed++;
  }
}

async function main() {
  if (!existsSync(VAULT_PATH)) {
    console.error(`vault path not found: ${VAULT_PATH}`);
    process.exit(1);
  }
  if (!DRY && !API_SECRET) {
    console.error('OPTIMUS_API_SECRET is required (or pass --dry-run)');
    process.exit(1);
  }

  console.log(`vault:       ${VAULT_PATH}`);
  console.log(`owner:       ${VAULT_OWNER}`);
  console.log(`api:         ${API_URL}`);
  console.log(`mode:        ${DRY ? 'DRY RUN' : FORCE ? 'FORCE' : 'incremental'}`);
  console.log(`cache:       ${CACHE_PATH}`);

  const files = await walk(VAULT_PATH);
  console.log(`found:       ${files.length} markdown files\n`);

  const cache = FORCE ? {} : await loadCache();
  const stats = { ingested: 0, unchanged: 0, skippedEmpty: 0, skippedTooLarge: 0, failed: 0, wouldIngest: 0 };

  // Concurrency-limited processing
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const i = cursor++;
      await processFile(files[i], cache, stats);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (!DRY) await saveCache(cache);
  console.log(`\n\nstats: ${JSON.stringify(stats)}`);
  if (stats.failed > 0) process.exit(2);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
