#!/usr/bin/env node
/**
 * Mint a CUSTOMER (external, non-board) token — OPT-37.
 *
 * A customer token authenticates a customer's OWN agent system (Cursor, bespoke)
 * against the Optimus org-shared surface (KB ingest/search, artifact registry,
 * enrichment), scoped to ONE org and nothing else. It is NOT a board token and
 * can never reach admin / ops-control / viewer-scoped routes.
 *
 * Minting is a board control-plane act, so this authenticates as a BOARD MEMBER:
 *   - API_SECRET (from autobot-inbox/.env) as the Bearer, AND
 *   - --as <github-username> → X-Board-User header (the board ops-proxy pattern),
 *     so requireBoardHuman + assertCallerInOrg can resolve your identity.
 *
 * Usage:
 *   node issue-customer-token.js --org <slug-or-uuid> --label "Acme Cursor agent" --as <github-username> [api-url]
 *   node issue-customer-token.js --org umb-advisors --label "UMB on-prem agent" --as ecgang
 *
 * Prints the customer's OPTIMUS_TOKEN + OPTIMUS_API_URL export lines. Hand those
 * to the customer; they set them for their MCP/CLI client.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const org = arg('--org');
const label = arg('--label');
const asUser = arg('--as');
const apiUrl = arg('--api-url') || process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

if (!org || !label || !asUser) {
  console.error('Usage: node issue-customer-token.js --org <slug-or-uuid> --label "<label>" --as <github-username> [--api-url <url>]');
  process.exit(1);
}

// Load API_SECRET from env or autobot-inbox/.env
let apiSecret = process.env.API_SECRET;
if (!apiSecret) {
  const envPath = resolve(__dirname, '../../autobot-inbox/.env');
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, 'utf8').match(/^API_SECRET=(.+)$/m);
    if (match) apiSecret = match[1].trim();
  }
}
if (!apiSecret) {
  console.error('API_SECRET not found. Set it in env or autobot-inbox/.env');
  process.exit(1);
}

// A slug looks like a slug; a UUID has dashes in the 8-4-4-4-12 shape.
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org);
const orgField = isUuid ? { owner_org_id: org } : { org_slug: org };

console.log(`Minting customer token for org=${org} label="${label}" via ${apiUrl} (as ${asUser})...`);

const res = await fetch(`${apiUrl}/api/auth/customer-token`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiSecret}`,
    'X-Board-User': asUser,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ ...orgField, label }),
  signal: AbortSignal.timeout(10000),
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Error ${res.status}: ${data.error || 'Unknown'}${data.reason ? ` (${data.reason})` : ''}`);
  process.exit(1);
}

console.log(`\n✅ Customer principal created: ${data.principal.id}`);
console.log(`   org_id:  ${data.principal.org_id}`);
console.log(`   label:   ${data.principal.label}`);
console.log(`   scope:   ${(data.principal.scope || []).join(', ')}`);
console.log(`   expires: ${new Date(data.expiresAt).toISOString()}  (jti ${data.jti})`);
console.log(`\nHand these to the customer (their MCP/CLI client config):\n`);
console.log(`  export OPTIMUS_TOKEN="${data.token}"`);
console.log(`  export OPTIMUS_API_URL="${apiUrl}"`);
console.log(`\nRevoke later with:  node issue-customer-token.js  (see --revoke / board API /api/auth/customer-token/revoke)`);
console.log();
