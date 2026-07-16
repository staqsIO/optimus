#!/usr/bin/env node
/**
 * optimus-cli — direct command-line access to the Optimus company brain (OPT-37).
 *
 * The non-MCP transport. Same auth (OPTIMUS_TOKEN), same Board API surface, same
 * operations as the MCP server — but a plain CLI you script with, pipe into, and
 * get tight, predictable control over (when the call fires, what args go, how
 * errors surface). For a customer token, only the org-shared "company brain"
 * commands are reachable; the customer ceiling on the Board API is the real
 * boundary (a board-only call 403s regardless).
 *
 * Auth:
 *   OPTIMUS_TOKEN    — board or customer JWT (issue customer tokens with
 *                      `node issue-customer-token.js …`)
 *   OPTIMUS_API_URL  — Board API base URL (default https://preview.staqs.io)
 *
 * Usage:
 *   optimus-cli <command> [args] [--flags] [--json]
 *   optimus-cli search "voicerail pricing" --limit 3
 *   optimus-cli ingest-doc --title "Q3 PRD" --file ./prd.md
 *   cat notes.md | optimus-cli push-summary --date 2026-06-08
 *   optimus-cli list-artifacts --kind prd --json
 *   optimus-cli help
 */

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { createApi, isCustomerToken, CUSTOMER_OPERATIONS, findOperation } from './client.js';

export { parseArgs, resolveArgs, validate };

const TOKEN = process.env.OPTIMUS_TOKEN;
const API_URL = process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

// Parse argv after the command into { positionals: [], flags: {} }. `--json` and
// `--file` are global-ish; everything else maps to the operation's arg spec.
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function usage() {
  const lines = [
    'optimus-cli — direct CLI access to the Optimus company brain.',
    '',
    'Usage: optimus-cli <command> [args] [--flags] [--json]',
    '',
    'Commands:',
  ];
  const width = Math.max(...CUSTOMER_OPERATIONS.map((o) => o.command.length));
  for (const op of CUSTOMER_OPERATIONS) {
    lines.push(`  ${op.command.padEnd(width)}  ${op.summary}`);
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push('  --json   Print the raw JSON response (default: pretty JSON).');
  lines.push('  --file   For content commands: read the body from a file path.');
  lines.push('  (content commands also accept piped stdin)');
  lines.push('');
  lines.push('Env: OPTIMUS_TOKEN (required), OPTIMUS_API_URL (default https://preview.staqs.io)');
  lines.push('');
  lines.push('Run `optimus-cli help <command>` for per-command arguments.');
  return lines.join('\n');
}

function commandHelp(op) {
  const lines = [`optimus-cli ${op.command} — ${op.summary}`, '', 'Arguments:'];
  for (const arg of op.args) {
    const form = arg.positional ? `<${arg.name}>` : `--${arg.name} <value>`;
    const tags = [
      arg.required ? 'required' : 'optional',
      arg.enum ? `one of: ${arg.enum.join('|')}` : null,
      arg.default !== undefined ? `default: ${arg.default}` : null,
    ].filter(Boolean).join(', ');
    lines.push(`  ${form.padEnd(22)} ${arg.describe}${tags ? `  [${tags}]` : ''}`);
  }
  lines.push('', `MCP-tool equivalent: ${op.tool}`);
  return lines.join('\n');
}

// Resolve the operation's declared args from parsed CLI input. Positionals fill
// positional args in order; remaining args come from flags. `--file`/stdin
// satisfy a `raw`/`text` body arg when present.
function resolveArgs(op, { positionals, flags }) {
  const out = {};
  const positionalSpecs = op.args.filter((a) => a.positional);
  positionalSpecs.forEach((spec, idx) => {
    if (positionals[idx] !== undefined) out[spec.name] = positionals[idx];
  });

  for (const spec of op.args) {
    if (spec.positional) continue;
    if (flags[spec.name] !== undefined && flags[spec.name] !== true) {
      out[spec.name] = flags[spec.name];
    } else if (spec.default !== undefined) {
      out[spec.name] = spec.default;
    }
  }

  // Body content: a `--file <path>` reads the file; otherwise piped stdin fills
  // the first body-shaped arg (`raw` or `text`) when it wasn't given inline.
  const bodyArg = op.args.find((a) => a.name === 'raw' || a.name === 'text');
  if (bodyArg) {
    if (flags.file && flags.file !== true) {
      out[bodyArg.name] = readFileSync(flags.file, 'utf-8');
    } else if (out[bodyArg.name] === undefined && !process.stdin.isTTY) {
      const piped = readStdin();
      if (piped.trim()) out[bodyArg.name] = piped;
    }
  }

  // Coerce declared number args.
  for (const spec of op.args) {
    if (spec.type === 'number' && out[spec.name] !== undefined) {
      out[spec.name] = Number(out[spec.name]);
    }
  }
  return out;
}

function validate(op, args) {
  const errors = [];
  for (const spec of op.args) {
    const val = args[spec.name];
    if (spec.required && (val === undefined || val === '')) {
      errors.push(`missing required ${spec.positional ? `<${spec.name}>` : `--${spec.name}`}`);
    }
    if (spec.enum && val !== undefined && !spec.enum.includes(val)) {
      errors.push(`--${spec.name} must be one of: ${spec.enum.join(', ')}`);
    }
    if (spec.type === 'number' && val !== undefined && Number.isNaN(val)) {
      errors.push(`--${spec.name} must be a number`);
    }
  }
  return errors;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const sub = rest[0] && findOperation(rest[0]);
    console.log(sub ? commandHelp(sub) : usage());
    process.exit(0);
  }

  const op = findOperation(command);
  if (!op) {
    console.error(`Unknown command: ${command}\n`);
    console.error(usage());
    process.exit(1);
  }

  if (!TOKEN) {
    console.error('OPTIMUS_TOKEN env var required. Issue a customer token with: node issue-customer-token.js …');
    process.exit(1);
  }

  const parsed = parseArgs(rest);
  if (parsed.flags.help) {
    console.log(commandHelp(op));
    process.exit(0);
  }

  const args = resolveArgs(op, parsed);
  const errors = validate(op, args);
  if (errors.length) {
    console.error(`Invalid arguments for \`${command}\`:`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${commandHelp(op)}`);
    process.exit(1);
  }

  const api = createApi({ token: TOKEN, apiUrl: API_URL });
  if (process.env.OPTIMUS_CLI_DEBUG) {
    console.error(`[optimus-cli] ${isCustomerToken(TOKEN) ? 'customer' : 'board'} token → ${API_URL} :: ${op.command}`);
  }

  try {
    const data = await op.run(api, args);
    const pretty = !parsed.flags.json;
    process.stdout.write(JSON.stringify(data, null, pretty ? 2 : 0) + '\n');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (so tests can import the pure helpers).
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
