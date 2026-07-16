#!/usr/bin/env node
/**
 * Optimus CLI — `optimus`
 *
 * Push your everyday work into the Optimus shared brain from the terminal, and
 * (via the `capture-session` backend + a Claude Code SessionEnd hook) capture
 * every Claude session passively so the team's work compounds into Optimus.
 *
 * Auth model is identical to tools/optimus-mcp: a Bearer token in OPTIMUS_TOKEN,
 * base URL in OPTIMUS_API_URL (default https://preview.staqs.io). Ownership
 * (your user + org) is derived server-side from the token — the CLI never sends
 * an owner/org parameter.
 *
 * Prereq: mint a token once with tools/optimus-mcp/issue-token.js, which writes
 * ~/.nemoclaw-env (source it from your shell profile so OPTIMUS_TOKEN is set).
 *
 * Env vars:
 *   OPTIMUS_TOKEN    — Board member JWT (required)
 *   OPTIMUS_API_URL  — Board API base URL (default https://preview.staqs.io)
 *
 * Commands:
 *   optimus ingest <file|->                      POST /api/ingest (mcp-upload)
 *   optimus artifact add --kind K [--title T] <file|->   POST /api/artifacts
 *   optimus capture <url>                        POST /api/artifacts {url}
 *   optimus push-summary [file|-]                POST /api/ingest (daily-summary)
 *   optimus search <query>                       POST /api/search
 *   optimus enrich contact|project <id>          GET  /api/artifacts/enrich/...
 *   optimus watch <folder>                       fs.watch -> artifact add
 *   optimus capture-session                      SessionEnd hook backend (stdin)
 */

import { readFileSync } from 'fs';
import fs from 'fs';
import path from 'path';
import { buildSessionDigest } from './digest.js';

const API_URL = process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

const ARTIFACT_KINDS = [
  'prd', 'proposal', 'spec', 'adr', 'brief', 'deck',
  'transcript', 'summary', 'doc', 'other',
];

const TOKEN_HELP =
  'OPTIMUS_TOKEN env var required.\n' +
  'Mint one with: node tools/optimus-mcp/issue-token.js <github-username>\n' +
  '(it writes ~/.nemoclaw-env — source it from your shell profile).';

// ============================================================
// HTTP client — mirrors tools/optimus-mcp/index.js api()
// ============================================================

function requireToken() {
  const token = process.env.OPTIMUS_TOKEN;
  if (!token) {
    const err = new Error(TOKEN_HELP);
    err.noToken = true;
    throw err;
  }
  return token;
}

async function api(method, path, body = null) {
  const headers = {
    'Authorization': `Bearer ${requireToken()}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

// ============================================================
// Helpers
// ============================================================

/** Read a file path, or stdin when path is '-' or omitted. */
function readInput(maybePath) {
  if (!maybePath || maybePath === '-') {
    return fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  }
  return readFileSync(maybePath, 'utf8');
}

/** Tiny flag parser: pulls --key value pairs out, returns { flags, positionals }. */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

/** Infer an artifact kind from a file path (extension / dir hints). */
function inferKind(filePath) {
  if (!filePath || filePath === '-') return 'doc';
  const base = path.basename(filePath).toLowerCase();
  const dir = filePath.toLowerCase();
  if (/(^|[-_/])adr|decision/.test(dir)) return 'adr';
  if (/(^|[-_/])prd/.test(dir)) return 'prd';
  if (/proposal/.test(dir)) return 'proposal';
  if (/spec/.test(dir)) return 'spec';
  if (/brief/.test(dir)) return 'brief';
  if (/transcript/.test(dir)) return 'transcript';
  if (/summary/.test(dir)) return 'summary';
  if (/\.(key|pptx|deck)$/.test(base) || /deck/.test(dir)) return 'deck';
  return 'doc';
}

/** Pretty-print the write receipt the API returns. */
function printReceipt(data) {
  // Real response shapes: POST /api/artifacts → {artifactId, documentId, deduped,
  // enrichment:'pending'|'skipped', ...}; POST /api/ingest → {documentId, deduped, ...}.
  const id = data.artifactId || data.documentId || data.artifact_id || data.document_id || data.id;
  const enrichment =
    (typeof data.enrichment === 'string' ? data.enrichment : null) ||
    data.enrichment_status ||
    (data.version ? `version ${data.version}` : 'n/a');
  const noop = data.deduped ? ' (deduped — no-op)' : '';
  console.log(`stored · ${id || '(id n/a)'} · enrichment: ${enrichment}${noop}`);
  // Keep the full server response available for scripting.
  if (process.env.OPTIMUS_VERBOSE) console.log(JSON.stringify(data, null, 2));
}

// ============================================================
// Commands
// ============================================================

async function cmdIngest(args) {
  const { positionals } = parseArgs(args);
  const raw = readInput(positionals[0]);
  const title = positionals[0] && positionals[0] !== '-' ? path.basename(positionals[0]) : 'Untitled';
  const data = await api('POST', '/api/ingest', {
    source: 'mcp-upload', title, raw, format: 'markdown',
  });
  printReceipt(data);
}

async function cmdArtifactAdd(args) {
  const { flags, positionals } = parseArgs(args);
  const file = positionals[0];
  const raw = readInput(file);
  const kind = flags.kind || inferKind(file);
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new Error(`Invalid --kind "${kind}". Allowed: ${ARTIFACT_KINDS.join('|')}`);
  }
  const title = flags.title || (file && file !== '-' ? path.basename(file) : 'Untitled');
  const data = await api('POST', '/api/artifacts', { raw, kind, title });
  printReceipt(data);
}

async function cmdCapture(args) {
  const { flags, positionals } = parseArgs(args);
  const url = positionals[0];
  if (!url) throw new Error('Usage: optimus capture <url> [--kind K]');
  const kind = flags.kind || 'doc';
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new Error(`Invalid --kind "${kind}". Allowed: ${ARTIFACT_KINDS.join('|')}`);
  }
  const data = await api('POST', '/api/artifacts', { url, kind });
  printReceipt(data);
}

async function cmdPushSummary(args) {
  const { positionals } = parseArgs(args);
  const raw = readInput(positionals[0]);
  const title = `Daily summary — ${new Date().toISOString().slice(0, 10)}`;
  const data = await api('POST', '/api/ingest', {
    source: 'daily-summary', title, raw, format: 'markdown',
  });
  printReceipt(data);
}

async function cmdSearch(args) {
  const { positionals } = parseArgs(args);
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('Usage: optimus search <query>');
  const data = await api('POST', '/api/search', { query, limit: 5 });
  const hits = data.results || data.rows || data.hits || (Array.isArray(data) ? data : []);
  if (!hits.length) {
    console.log('No results.');
    return;
  }
  hits.forEach((h, i) => {
    const title = h.title || h.source || h.document_title || '(untitled)';
    const score = h.score != null ? ` [${Number(h.score).toFixed(3)}]` : '';
    const snippet = (h.snippet || h.text || h.content || '').toString().replace(/\s+/g, ' ').slice(0, 200);
    console.log(`${i + 1}. ${title}${score}\n   ${snippet}`);
  });
}

async function cmdEnrich(args) {
  const { positionals } = parseArgs(args);
  const [type, id] = positionals;
  if ((type !== 'contact' && type !== 'project') || !id) {
    throw new Error('Usage: optimus enrich contact|project <id>');
  }
  const data = await api('GET', `/api/artifacts/enrich/${type}/${id}`);
  const links = data.links || data.artifact_links || [];
  const facts = data.facts || data.derived_facts || [];
  console.log(`Links (${links.length}):`);
  links.forEach((l) => {
    console.log(`  - ${l.title || l.artifact_title || l.artifact_id || l.id} [${l.status || l.link_status || '?'}]`);
  });
  console.log(`Facts (${facts.length}):`);
  facts.forEach((f) => {
    const val = f.value ?? f.fact ?? JSON.stringify(f);
    console.log(`  - ${f.key || f.name || 'fact'}: ${val}`);
  });
}

async function cmdWatch(args) {
  const { positionals } = parseArgs(args);
  const folder = positionals[0];
  if (!folder) throw new Error('Usage: optimus watch <folder>');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(`Not a directory: ${folder}`);
  }
  requireToken(); // fail fast before watching
  console.error(`Watching ${folder} — new/changed files push as artifacts. Ctrl-C to stop.`);

  const debounce = new Map(); // filename -> timer
  fs.watch(folder, (eventType, filename) => {
    if (!filename) return;
    const full = path.join(folder, filename);
    if (debounce.has(filename)) clearTimeout(debounce.get(filename));
    debounce.set(filename, setTimeout(async () => {
      debounce.delete(filename);
      try {
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
        const raw = fs.readFileSync(full, 'utf8');
        if (!raw.trim()) return;
        const kind = inferKind(full);
        const data = await api('POST', '/api/artifacts', { raw, kind, title: filename });
        process.stdout.write(`[${new Date().toISOString()}] `);
        printReceipt(data);
      } catch (e) {
        console.error(`watch: ${filename}: ${e.message}`);
      }
    }, 400)); // debounce rapid editor save events
  });

  // Keep the process alive.
  await new Promise(() => {});
}

/**
 * capture-session — Claude Code SessionEnd hook backend.
 * Reads the hook payload JSON on stdin, opens transcript_path, builds a cleaned
 * digest, and pushes it as a summary artifact. MUST never throw / block / break
 * the user's session: every failure path exits 0 and logs to stderr.
 */
async function cmdCaptureSession() {
  let payload;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    payload = JSON.parse(stdin);
  } catch (e) {
    console.error(`capture-session: could not read hook payload: ${e.message}`);
    return; // exit 0
  }

  try {
    if (!process.env.OPTIMUS_TOKEN) {
      console.error('capture-session: no OPTIMUS_TOKEN — skipping capture.');
      return;
    }
    const transcriptPath = payload.transcript_path;
    const cwd = payload.cwd || process.cwd();
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      console.error('capture-session: no transcript_path — skipping.');
      return;
    }
    const jsonl = fs.readFileSync(transcriptPath, 'utf8');
    const digest = buildSessionDigest(jsonl);
    if (!digest) {
      console.error('capture-session: empty digest — skipping.');
      return;
    }
    const title = `Claude session — ${path.basename(cwd)} — ${new Date().toISOString().slice(0, 10)}`;
    const data = await api('POST', '/api/artifacts', {
      kind: 'summary',
      source_system: 'claude-code',
      title,
      raw: digest,
    });
    console.error(`capture-session: ${title}`);
    if (process.env.OPTIMUS_VERBOSE) printReceipt(data);
  } catch (e) {
    // Swallow — never break the session.
    console.error(`capture-session: push failed (non-fatal): ${e.message}`);
  }
}

// ============================================================
// Dispatch
// ============================================================

const USAGE = `optimus — push your work into the Optimus shared brain

Usage:
  optimus ingest <file|->                          Ingest a doc into the KB
  optimus artifact add --kind <kind> [--title T] <file|->   Add a typed artifact
  optimus capture <url> [--kind K]                 Capture a web/Drive URL
  optimus push-summary [file|-]                    Push a daily summary
  optimus search <query>                           Search the knowledge base
  optimus enrich contact|project <id>              Show captured links + facts
  optimus watch <folder>                           Auto-push new/changed files
  optimus capture-session                          SessionEnd hook backend (stdin)

Artifact kinds: ${ARTIFACT_KINDS.join(' | ')}
Env: OPTIMUS_TOKEN (required), OPTIMUS_API_URL (default ${API_URL})`;

async function main() {
  const [, , command, ...rest] = process.argv;

  // capture-session is the hook backend: it must NEVER exit non-zero.
  if (command === 'capture-session') {
    await cmdCaptureSession();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'ingest': await cmdIngest(rest); break;
      case 'artifact':
        if (rest[0] === 'add') { await cmdArtifactAdd(rest.slice(1)); }
        else throw new Error('Usage: optimus artifact add --kind <kind> [--title T] <file|->');
        break;
      case 'capture': await cmdCapture(rest); break;
      case 'push-summary': await cmdPushSummary(rest); break;
      case 'search': await cmdSearch(rest); break;
      case 'enrich': await cmdEnrich(rest); break;
      case 'watch': await cmdWatch(rest); break;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(USAGE);
        break;
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(e.noToken ? e.message : `Error: ${e.message}`);
    process.exit(1);
  }
}

main();
