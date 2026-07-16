#!/usr/bin/env node
import 'dotenv/config';
import { initializeDatabase, close, query } from '../src/db.js';
import { sendWeeklyRecaps } from '../src/signal/weekly-recap.js';

/**
 * Standalone runner for manual weekly-recap testing.
 *
 * Defaults: --email carlos@staqs.io, --dry-run (writes HTML to /tmp), --window-days 7.
 * Drop --dry-run to actually send. The recap sender is the Gmail account that
 * owns that email in inbox.accounts; recipient is the same address.
 *
 * Usage:
 *   node scripts/test-weekly-recap.js                                  # dry-run for carlos@staqs.io, last 7 days
 *   node scripts/test-weekly-recap.js --email eric@staqs.io            # dry-run for eric
 *   node scripts/test-weekly-recap.js --window-days 14                 # wider window
 *   node scripts/test-weekly-recap.js --no-dry-run                     # actually send
 *   node scripts/test-weekly-recap.js --email x@y.com --no-dry-run     # real send, single recipient
 */

function parseArgs(argv) {
  const args = { email: 'carlos@staqs.io', windowDays: 7, dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') args.email = argv[++i];
    else if (a === '--window-days') args.windowDays = Number(argv[++i]);
    else if (a === '--no-dry-run' || a === '--send') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function resolveRecipient(email) {
  const { rows } = await query(
    `SELECT a.id AS account_id, a.identifier, a.label, a.owner_id,
            bm.display_name, bm.email AS member_email
       FROM inbox.accounts a
       LEFT JOIN agent_graph.board_members bm ON bm.id = a.owner_id
      WHERE a.channel = 'email' AND a.is_active = true
        AND lower(a.identifier) = lower($1)
      LIMIT 1`,
    [email]
  );
  if (rows.length === 0) {
    throw new Error(
      `No active Gmail account with identifier=${email}. ` +
      `Connect it via Settings (or check inbox.accounts.is_active).`
    );
  }
  const r = rows[0];
  return {
    email,
    displayName: r.display_name || r.label || email,
    accountId: r.account_id,
    memberId: r.owner_id || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/test-weekly-recap.js [--email <addr>] [--window-days N] [--no-dry-run]');
    return;
  }

  await initializeDatabase();
  const recipient = await resolveRecipient(args.email);

  console.log(`[test-weekly-recap] ${args.dryRun ? 'DRY RUN' : 'LIVE SEND'} to ${recipient.email} (account ${recipient.accountId})`);
  console.log(`[test-weekly-recap] Window: last ${args.windowDays} days`);

  const result = await sendWeeklyRecaps({
    now: new Date(),
    windowDays: args.windowDays,
    overrideRecipients: [recipient],
    dryRun: args.dryRun,
  });

  console.log('\n[test-weekly-recap] Result:', result);
  if (args.dryRun && result.sent > 0) {
    const safe = recipient.email.replace(/[^a-zA-Z0-9]/g, '_');
    console.log(`\nPreview file: /tmp/weekly-recap-${safe}-${result.weekStart}.html`);
    console.log('Open it in a browser to verify formatting before running with --no-dry-run.');
  }
}

main()
  .catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
  })
  .finally(() => close());
