#!/usr/bin/env node
// Guided first-run setup for Ephor.
//
// Steps a self-hoster through every account/credential the system can use —
// with signup links — and writes autobot-inbox/.env. Everything except the
// Anthropic key is skippable: integrations with missing credentials disable
// themselves cleanly at boot, so you can re-run this any time to add more.
//
// Usage:  npm run setup     (from the repo root)
//
// Design constraints:
// - Zero dependencies (node:readline only), Node >= 20.
// - Never echoes secrets: key input is masked on a TTY, and existing values
//   are only ever shown redacted (first/last few characters).
// - Re-runnable: existing non-empty values in .env are kept unless you paste
//   a replacement. .env is backed up to .env.bak before rewriting.
// - Keys are NOT validated against provider APIs (no network calls from here).

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_EXAMPLE = resolve(ROOT, 'autobot-inbox/.env.example');
const ENV_FILE = resolve(ROOT, 'autobot-inbox/.env');

const isTTY = process.stdout.isTTY && process.stdin.isTTY;
const c = {
  cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Non-TTY (piped) input: readline delivers every buffered line immediately,
// but rl.question only captures the one pending — later lines would be lost.
// Queue them so scripted/piped runs work; EOF resolves remaining asks as ''.
const lineQueue = [];
const lineWaiters = [];
let stdinClosed = false;
if (!isTTY) {
  rl.on('line', (l) => {
    const w = lineWaiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (lineWaiters.length) lineWaiters.shift()('');
  });
}

function askPiped(prompt) {
  process.stdout.write(prompt);
  if (lineQueue.length) {
    process.stdout.write('\n');
    return Promise.resolve(lineQueue.shift());
  }
  if (stdinClosed) {
    process.stdout.write('\n');
    return Promise.resolve('');
  }
  return new Promise((res) => lineWaiters.push((l) => {
    process.stdout.write('\n');
    res(l);
  }));
}

function ask(prompt, { secret = false } = {}) {
  if (!isTTY) return askPiped(prompt).then((a) => a.trim());
  return new Promise((res) => {
    if (secret && typeof rl._writeToOutput === 'function') {
      const original = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (str) => {
        // Echo the prompt itself; mask everything typed after it.
        if (str.startsWith(prompt)) original(prompt);
        else if (str.includes('\n')) original(str); // pass through newlines
        else original('*'.repeat(str.length));
      };
      rl.question(prompt, (answer) => {
        rl._writeToOutput = original;
        process.stdout.write('\n');
        res(answer.trim());
      });
    } else {
      rl.question(prompt, (answer) => res(answer.trim()));
    }
  });
}

async function yesNo(prompt, dflt = false) {
  const hint = dflt ? 'Y/n' : 'y/N';
  const a = (await ask(`${prompt} ${c.dim(`[${hint}]`)} `)).toLowerCase();
  if (a === '') return dflt;
  return a === 'y' || a === 'yes';
}

function redact(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}

// --- .env read/write -----------------------------------------------------
// setVar rewrites the FIRST matching line. An uncommented `KEY=` wins; else
// a commented pure assignment (`# KEY=value` with nothing after the value —
// prose comments that merely mention `KEY=` are never touched); else the
// var is appended at the end of the file.
function setVar(content, key, value) {
  const lines = content.split(/\r?\n/);
  const live = new RegExp(`^${key}=`);
  const commented = new RegExp(`^#\\s*${key}=\\S*$`);
  let idx = lines.findIndex((l) => live.test(l));
  if (idx === -1) idx = lines.findIndex((l) => commented.test(l));
  if (idx === -1) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '# Added by scripts/setup.js', `${key}=${value}`, '');
    return lines.join('\n');
  }
  lines[idx] = `${key}=${value}`;
  // dotenv is last-wins within a file: a later duplicate would silently
  // override the value we just wrote, so neutralize any that exist.
  for (let i = idx + 1; i < lines.length; i++) {
    if (live.test(lines[i])) lines[i] = `# ${lines[i]}  # duplicate superseded by scripts/setup.js`;
  }
  return lines.join('\n');
}

// Effective value under dotenv semantics (last uncommented assignment wins).
function getVar(content, key) {
  const matches = [...content.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))];
  return matches.length ? matches[matches.length - 1][1].trim() : '';
}

// --- wizard state ----------------------------------------------------------
let env; // working copy of the .env content
const summary = []; // [label, status]
const afterSteps = []; // printed at the end
const set = (key, value) => { env = setVar(env, key, value); };

// Prompt for one credential. Returns the effective value ('' if skipped).
async function credential({ key, label, lines = [], secret = true, placeholder = 'paste key, Enter to skip' }) {
  const existing = getVar(env, key);
  console.log(`\n${c.bold(label)}`);
  for (const l of lines) console.log(`  ${l}`);
  if (existing) {
    const a = await ask(`  ${key} ${c.dim(`already set (${redact(existing)}) — Enter to keep, or paste new:`)} `, { secret });
    if (a) set(key, a);
    summary.push([label, c.green('configured')]);
    return a || existing;
  }
  const a = await ask(`  ${key} ${c.dim(`(${placeholder}):`)} `, { secret });
  if (a) {
    set(key, a);
    summary.push([label, c.green('configured')]);
  } else {
    summary.push([label, c.dim('skipped')]);
  }
  return a;
}

// --- extra-service catalog -------------------------------------------------
// Everything beyond the core six steps. Drives both the interactive
// "additional integrations" step and the reference cheat-sheet, so the two
// can never drift. A field is a secret unless `secret: false`.
const EXTRA_SERVICES = [
  {
    id: 'outlook', label: 'Outlook (beta)',
    blurb: 'A second email channel via Microsoft Graph.',
    links: ['https://portal.azure.com — Azure AD → App registrations'],
    fields: [
      { key: 'OUTLOOK_CLIENT_ID', secret: false, placeholder: 'application (client) ID' },
      { key: 'OUTLOOK_CLIENT_SECRET', placeholder: 'client secret value' },
      { key: 'OUTLOOK_TENANT_ID', secret: false, placeholder: 'directory (tenant) ID' },
    ],
    after: 'npm --prefix autobot-inbox run setup-outlook  # browser OAuth — completes the Outlook connection',
  },
  {
    id: 'google-workspace', label: 'Google Drive / Calendar',
    blurb: 'Drive + Calendar via a Google service account with domain-wide delegation.',
    links: ['https://console.cloud.google.com — create a service account, enable DWD'],
    note: 'Paste the PATH to the downloaded service-account JSON (not the JSON itself).',
    fields: [
      { key: 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH', secret: false, placeholder: '/abs/path/to/service-account.json' },
      { key: 'GOOGLE_IMPERSONATE_EMAIL', secret: false, placeholder: 'user@yourdomain.com to impersonate' },
    ],
  },
  {
    id: 'brave', label: 'Brave Search',
    blurb: 'Primary web-search provider for the research agents.',
    links: ['https://brave.com/search/api'],
    fields: [{ key: 'BRAVE_API_KEY', placeholder: 'BSA…' }],
  },
  {
    id: 'firecrawl', label: 'Firecrawl',
    blurb: 'Page scraping / crawling for research + URL capture.',
    links: ['https://firecrawl.dev'],
    fields: [{ key: 'FIRECRAWL_API_KEY', placeholder: 'fc-…' }],
  },
  {
    id: 'resend', label: 'Resend (outbound email)',
    blurb: 'Sends outbound email (proposals, notifications).',
    links: ['https://resend.com/api-keys'],
    fields: [
      { key: 'RESEND_API_KEY', placeholder: 're_…' },
      { key: 'RESEND_FROM', secret: false, placeholder: 'Your Name <you@yourdomain.com>' },
    ],
  },
  {
    id: 'boldsign', label: 'BoldSign (e-signature)',
    blurb: 'E-signature for contracts and engagement documents.',
    links: ['https://boldsign.com — Settings → API'],
    fields: [{ key: 'BOLDSIGN_API_KEY', placeholder: 'paste key' }],
  },
  {
    id: 'assemblyai', label: 'AssemblyAI (transcription)',
    blurb: 'Speech-to-text for voice notes and audio.',
    links: ['https://www.assemblyai.com'],
    fields: [{ key: 'ASSEMBLYAI_API_KEY', placeholder: 'paste key' }],
  },
  {
    id: 'picovoice', label: 'Picovoice (wake word)',
    blurb: 'On-device wake-word / voice trigger.',
    links: ['https://console.picovoice.ai'],
    fields: [{ key: 'PICOVOICE_ACCESS_KEY', placeholder: 'paste access key' }],
  },
  {
    id: 'tldv', label: 'tl;dv (meeting transcripts)',
    blurb: 'Ingests meeting recordings and transcripts.',
    links: ['https://tldv.io — Settings → API'],
    fields: [{ key: 'TLDV_API_KEY', placeholder: 'paste key' }],
  },
  {
    id: 'aws', label: 'File storage (S3 / R2)',
    blurb: 'Object storage for generated artifacts (AWS S3 or Cloudflare R2).',
    links: ['https://aws.amazon.com/s3  ·  https://developers.cloudflare.com/r2'],
    fields: [
      { key: 'AWS_ACCESS_KEY_ID', placeholder: 'AKIA… / R2 access key' },
      { key: 'AWS_SECRET_ACCESS_KEY', placeholder: 'secret access key' },
      { key: 'AWS_S3_BUCKET', secret: false, placeholder: 'bucket name' },
      { key: 'AWS_S3_REGION', secret: false, placeholder: 'us-east-1 (or "auto" for R2)' },
    ],
  },
  {
    id: 'neo4j', label: 'Neo4j (knowledge graph)',
    blurb: 'Graph store for entity/relationship memory. Docker Compose provides Neo4j — set a password to enable it.',
    links: [],
    fields: [{ key: 'NEO4J_PASSWORD', placeholder: 'choose a password' }],
  },
  {
    id: 'model-armor', label: 'Model Armor (prompt-injection screening)',
    blurb: 'Gate G8 — screens inbound content for prompt injection. Recommended for production; needs a GCP Model Armor template.',
    links: ['https://cloud.google.com/security-command-center/docs/model-armor-overview'],
    fields: [{ key: 'MODEL_ARMOR_TEMPLATE', secret: false, placeholder: 'projects/…/locations/…/templates/…' }],
  },
  {
    id: 'railway', label: 'Railway (auto-deploy)',
    blurb: 'Lets deploy agents ship services to Railway.',
    links: ['https://railway.app — Account → Tokens'],
    fields: [{ key: 'RAILWAY_TOKEN', placeholder: 'paste token' }],
  },
  {
    id: 'vercel', label: 'Vercel (auto-deploy)',
    blurb: 'Lets deploy agents ship front-ends to Vercel.',
    links: ['https://vercel.com/account/tokens'],
    fields: [{ key: 'VERCEL_TOKEN', placeholder: 'paste token' }],
  },
];

// Configure one catalog service (possibly multi-field). Pushes exactly one
// summary row; returns true if its primary (first) field ended up set.
async function configureService(entry) {
  console.log(`\n${c.bold(entry.label)}`);
  if (entry.blurb) console.log(`  ${entry.blurb}`);
  for (const link of entry.links || []) console.log(`  ${c.bold(link)}`);
  if (entry.note) console.log(`  ${c.dim(entry.note)}`);
  let primarySet = false;
  for (let i = 0; i < entry.fields.length; i++) {
    const f = entry.fields[i];
    const secret = f.secret !== false;
    const existing = getVar(env, f.key);
    let val;
    if (existing) {
      const shown = secret ? redact(existing) : existing;
      const a = await ask(`  ${f.key} ${c.dim(`already set (${shown}) — Enter to keep, or paste new:`)} `, { secret });
      if (a) set(f.key, a);
      val = a || existing;
    } else {
      const a = await ask(`  ${f.key} ${c.dim(`(${f.placeholder}, Enter to skip):`)} `, { secret });
      if (a) set(f.key, a);
      val = a;
    }
    if (i === 0) primarySet = Boolean(val);
  }
  summary.push([entry.label, primarySet ? c.green('configured') : c.dim('skipped')]);
  if (primarySet && entry.after) afterSteps.push(entry.after);
  return primarySet;
}

// Parse a pick-list like "1,3,5", "2-4", "all" into 0-based indices.
function parseSelection(input, max) {
  if (/^(a|all)$/i.test(input.trim())) return [...Array(max).keys()];
  const out = new Set();
  for (const part of input.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let lo = Number(range[1]);
      let hi = Number(range[2]);
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let n = lo; n <= hi; n++) if (n >= 1 && n <= max) out.add(n - 1);
    } else if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n >= 1 && n <= max) out.add(n - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// --- main ------------------------------------------------------------------
async function main() {
  if (!existsSync(ENV_EXAMPLE)) {
    console.error(`Cannot find ${ENV_EXAMPLE} — run this from a full checkout.`);
    process.exit(1);
  }
  const envExisted = existsSync(ENV_FILE);
  env = readFileSync(envExisted ? ENV_FILE : ENV_EXAMPLE, 'utf8');

  console.log(`
${c.cyan(c.bold('Ephor setup'))} — governed agent organization
${c.dim('─'.repeat(60))}
This wizard walks you through every account Ephor can use and
writes ${c.bold('autobot-inbox/.env')}. Only one thing is required: an LLM key.
Everything else is optional — skipped integrations disable
themselves cleanly, and you can re-run ${c.bold('npm run setup')} any time.
${envExisted ? c.yellow('Found an existing .env — your current values are kept unless you replace them.') : ''}`);

  // ── Step 1: the brain ────────────────────────────────────────────────────
  console.log(`\n${c.cyan('Step 1/7 — LLM provider (required)')}`);
  const anthropic = await credential({
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    lines: [
      'The baseline model provider — every agent tier can run on this alone.',
      `Sign up / get a key: ${c.bold('https://console.anthropic.com')} → API Keys`,
    ],
    placeholder: 'sk-ant-…',
  });
  if (!anthropic) {
    console.log(c.yellow('\n  No LLM key — the org cannot think without one. You can paste it into'));
    console.log(c.yellow('  autobot-inbox/.env later (ANTHROPIC_API_KEY=…), but nothing will boot until then.'));
  }

  const demo = await yesNo('\nJust exploring? Demo mode boots the whole org on synthetic mail —\nno database, no Gmail, nothing else needed. Enable demo mode?', !envExisted);
  if (demo) {
    set('DEMO_MODE', '1');
  } else if (getVar(env, 'DEMO_MODE')) {
    set('DEMO_MODE', '');
    console.log(c.dim('  → cleared the existing DEMO_MODE flag.'));
  }

  // ── Step 2: database ─────────────────────────────────────────────────────
  console.log(`\n${c.cyan('Step 2/7 — Database')}`);
  console.log(`  Ephor's task graph, audit log, and RAG store live in Postgres (with pgvector).
  1) ${c.bold('Docker')} — \`docker compose up -d\` provides Postgres for you  ${c.dim('(default)')}
  2) ${c.bold('Ephemeral')} — in-process PGlite, no persistence (fine for demo mode)
  3) ${c.bold('My own Postgres')} — paste a connection URL (e.g. a free ${c.bold('https://supabase.com')} project; pgvector required)`);
  let dbChoice = (await ask(`  Choice ${c.dim('[1/2/3, Enter=1]')}: `)) || '1';
  if (!['1', '2', '3'].includes(dbChoice)) {
    console.log(c.dim(`  → unrecognized choice "${dbChoice}" — defaulting to Docker.`));
    dbChoice = '1';
  }
  if (dbChoice === '3') {
    const url = await ask(`  DATABASE_URL ${c.dim('(postgresql://…):')} `, { secret: true });
    if (url) set('DATABASE_URL', url);
    summary.push(['Database', url ? c.green('own Postgres') : c.dim('skipped')]);
  } else {
    if (dbChoice === '2' && getVar(env, 'DATABASE_URL')) {
      set('DATABASE_URL', '');
      console.log(c.dim('  → cleared the existing DATABASE_URL so the PGlite fallback engages.'));
    } else if (getVar(env, 'DATABASE_URL')) {
      console.log(c.dim('  → existing DATABASE_URL kept (Docker services use the compose-provided Postgres).'));
    }
    summary.push(['Database', dbChoice === '2' ? c.dim('ephemeral (PGlite)') : c.green('Docker Postgres')]);
  }

  // ── Step 3: more model providers ─────────────────────────────────────────
  console.log(`\n${c.cyan('Step 3/7 — More model providers (recommended, all skippable)')}`);
  const openrouter = await credential({
    key: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    lines: [
      'The production default routes high-volume agent tiers to cheap open-weight',
      'models (Qwen, DeepSeek) — an order of magnitude cheaper than running',
      `everything on one premium model. Get a key: ${c.bold('https://openrouter.ai/keys')}`,
    ],
    placeholder: 'sk-or-…',
  });
  if (!openrouter && anthropic && !getVar(env, 'LLM_SINGLE_PROVIDER')) {
    set('LLM_SINGLE_PROVIDER', 'anthropic');
    console.log(c.dim('  → No OpenRouter key: set LLM_SINGLE_PROVIDER=anthropic so every tier'));
    console.log(c.dim('    runs on your Anthropic key. Delete that line later if you add OpenRouter.'));
  }
  await credential({
    key: 'OPENAI_API_KEY',
    label: 'OpenAI',
    lines: [
      'Used for RAG embeddings (the knowledge base) and web-search research.',
      `Get a key: ${c.bold('https://platform.openai.com/api-keys')}`,
    ],
  });
  await credential({
    key: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    lines: [
      'Direct Gemini access for the strategist/architect tiers (otherwise these',
      `route via OpenRouter or your single provider). Get a key: ${c.bold('https://aistudio.google.com/apikey')}`,
    ],
  });

  // ── Step 4: channels ─────────────────────────────────────────────────────
  console.log(`\n${c.cyan('Step 4/7 — Channels (how work reaches the org)')}`);

  if (await yesNo(`\n${c.bold('Gmail')} — the flagship channel: the org manages a real inbox.\n  Needs your own Google Cloud OAuth app (heaviest setup, ~15 min). Set up Gmail?`)) {
    await credential({
      key: 'GMAIL_USER_EMAIL',
      label: 'Gmail',
      lines: ['The mailbox the org will manage.'],
      secret: false,
      placeholder: 'you@yourdomain.com, Enter to skip',
    });
    afterSteps.push(
      `${c.bold('Gmail OAuth')} (two commands, run from the repo root after this wizard):
     1. npm --prefix autobot-inbox run setup        ${c.dim('# Google Cloud project + OAuth consent helper (needs gcloud CLI)')}
        ${c.dim('…or do it by hand at https://console.cloud.google.com (enable Gmail API, create OAuth client)')}
     2. npm --prefix autobot-inbox run setup-gmail  ${c.dim('# browser OAuth flow — fills GMAIL_* into .env for you')}`
    );
  } else {
    summary.push(['Gmail', c.dim('skipped')]);
  }

  if (await yesNo(`\n${c.bold('Slack')} — a workspace bot (Socket Mode). Set up Slack?`)) {
    console.log(`  Create an app at ${c.bold('https://api.slack.com/apps')} → enable Socket Mode →`);
    console.log('  install to your workspace. You need three values:');
    await credential({ key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', lines: [], placeholder: 'xoxb-…' });
    await credential({ key: 'SLACK_SIGNING_SECRET', label: 'Slack signing secret', lines: [] });
    await credential({ key: 'SLACK_APP_TOKEN', label: 'Slack app token', lines: [], placeholder: 'xapp-…' });
  } else {
    summary.push(['Slack', c.dim('skipped')]);
  }

  if (await yesNo(`\n${c.bold('Telegram')} — board alerts + a chat interface. Set up Telegram?`)) {
    console.log(`  Message ${c.bold('https://t.me/botfather')} → /newbot → copy the token.`);
    await credential({ key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', lines: [], placeholder: '123456:ABC-…' });
    await credential({
      key: 'TELEGRAM_BOARD_USER_IDS',
      label: 'Telegram board user IDs',
      lines: [`Comma-separated numeric user IDs allowed to talk to the bot ${c.dim('(get yours from @userinfobot)')}.`],
      secret: false,
      placeholder: '12345678,87654321 — Enter to skip',
    });
  } else {
    summary.push(['Telegram', c.dim('skipped')]);
  }

  // ── Step 5: work integrations ────────────────────────────────────────────
  console.log(`\n${c.cyan('Step 5/7 — Work integrations')}`);
  await credential({
    key: 'GITHUB_TOKEN',
    label: 'GitHub',
    lines: [
      'Lets executor agents open PRs and file issues on your repos.',
      `Create a token (repo scope): ${c.bold('https://github.com/settings/tokens')}`,
      c.dim('(A GitHub App is also supported — see GITHUB_APP_* in .env.example.)'),
    ],
    placeholder: 'ghp_… / github_pat_…',
  });
  await credential({
    key: 'LINEAR_API_KEY',
    label: 'Linear',
    lines: [
      'Issue mirroring and ticket-driven implementation.',
      `Get a key: ${c.bold('https://linear.app')} → Settings → Security & access → API`,
    ],
    placeholder: 'lin_api_…',
  });

  // ── Step 6: ops secrets ──────────────────────────────────────────────────
  console.log(`\n${c.cyan('Step 6/7 — Internal secrets')}`);
  console.log(`  Four random secrets Ephor uses internally (credential encryption at rest,
  agent action signing, ops/cron API auth). Nothing to sign up for.`);
  const OPS_KEYS = ['CREDENTIALS_ENCRYPTION_KEY', 'AGENT_SIGNING_KEY', 'API_SECRET', 'CRON_SECRET'];
  const missing = OPS_KEYS.filter((k) => !getVar(env, k));
  if (missing.length === 0) {
    console.log(c.green('  All already set — keeping your existing values.'));
    summary.push(['Internal secrets', c.green('configured')]);
  } else if (await yesNo(`  Auto-generate the ${missing.length} missing one(s) now?`, true)) {
    for (const k of missing) set(k, randomBytes(32).toString('hex'));
    summary.push(['Internal secrets', c.green('generated')]);
  } else {
    summary.push(['Internal secrets', c.dim('skipped — see .env.example § Auth & Identity')]);
  }

  // ── Step 7: additional integrations ──────────────────────────────────────
  console.log(`\n${c.cyan('Step 7/7 — Additional integrations (all optional)')}`);
  console.log(`  Ephor supports ${EXTRA_SERVICES.length} more services — web search, e-signature,
  transcription, file storage, auto-deploy, and more. Step through all of them
  now, pick just the ones you want, or skip and add them later by hand.`);
  const extrasMode = (await ask(
    `  ${c.bold('[a]')} all · ${c.bold('[p]')} pick from a list · ${c.bold('[s]')} skip ${c.dim('[a/p/s, Enter=s]')}: `,
  )).trim().toLowerCase();
  let chosen = [];
  if (extrasMode === 'a' || extrasMode === 'all') {
    chosen = EXTRA_SERVICES.map((_, i) => i);
  } else if (extrasMode === 'p' || extrasMode === 'pick') {
    console.log('');
    EXTRA_SERVICES.forEach((s, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${c.bold(s.label)} ${c.dim('— ' + s.blurb)}`),
    );
    const sel = await ask(`\n  Which? ${c.dim("(e.g. 1,3,5 or 2-4 or 'all', Enter to skip):")} `);
    chosen = parseSelection(sel, EXTRA_SERVICES.length);
    if (!chosen.length) console.log(c.dim('  Nothing selected — skipping.'));
  }
  for (const i of chosen) {
    await configureService(EXTRA_SERVICES[i]);
  }

  // ── write ────────────────────────────────────────────────────────────────
  if (envExisted) copyFileSync(ENV_FILE, `${ENV_FILE}.bak`);
  writeFileSync(ENV_FILE, env);
  chmodSync(ENV_FILE, 0o600);
  console.log(`\n${c.green('✓')} Wrote ${c.bold('autobot-inbox/.env')}${envExisted ? c.dim(' (previous version saved as .env.bak)') : ''}`);

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\n${c.cyan(c.bold('Summary'))}`);
  const width = Math.max(...summary.map(([l]) => l.length));
  for (const [label, status] of summary) console.log(`  ${label.padEnd(width)}  ${status}`);

  // ── still-unconfigured integrations (reference cheat-sheet) ───────────────
  // Derive from actual .env state, not this run's choices — a service set in a
  // prior run must not reappear here just because it wasn't revisited now.
  const remaining = EXTRA_SERVICES.filter((s) => !getVar(env, s.fields[0].key));
  if (remaining.length) {
    console.log(`\n${c.cyan(c.bold('More integrations'))} ${c.dim('— not configured; add any time in autobot-inbox/.env')}`);
    const ew = Math.max(...remaining.map((s) => s.label.length));
    for (const s of remaining) {
      const keys = s.fields.map((f) => f.key).join(', ');
      const url = (s.links[0] || '').split(' — ')[0];
      console.log(`  ${c.bold(s.label.padEnd(ew))}  ${c.dim(keys)}${url ? c.dim('  ' + url) : ''}`);
    }
  } else {
    console.log(`\n${c.green('✓')} All optional integrations configured.`);
  }

  // ── next steps ───────────────────────────────────────────────────────────
  console.log(`\n${c.cyan(c.bold('Next steps'))}`);
  let n = 1;
  for (const s of afterSteps) console.log(`  ${n++}. ${s}`);
  if (demo) {
    console.log(`  ${n++}. ${c.bold('cd autobot-inbox && npm install && npm run demo')}   ${c.dim('# watch the org triage synthetic mail end-to-end')}`);
  }
  if (dbChoice === '1') {
    console.log(`  ${n++}. ${c.bold('docker compose up -d')}   ${c.dim('# full stack — board workstation at http://localhost:3200')}`);
  } else if (!demo) {
    console.log(`  ${n++}. ${c.bold('npm install && cd autobot-inbox && npm run migrate && npm start')}   ${c.dim('# bare-metal boot')}`);
  }
  console.log(`\n  ${c.dim('Deeper configuration: SELF_HOSTING.md · every variable: autobot-inbox/.env.example')}\n`);

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
