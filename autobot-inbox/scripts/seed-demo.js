import 'dotenv/config';
import { readFileSync } from 'fs';
import { google } from 'googleapis';

/**
 * Demo Seeder: sends realistic emails from Steve and Bob into Jordan's inbox.
 *
 * Each sender account needs its own Gmail refresh token. Set them in .env:
 *   GMAIL_REFRESH_TOKEN_STEVE=...   (steve.white@example.com)
 *   GMAIL_REFRESH_TOKEN_BOB=...     (bob.johnson@example.com)
 *
 * The script uses the same OAuth client credentials (GMAIL_CLIENT_ID/SECRET)
 * but different refresh tokens per sender.
 *
 * Usage:
 *   npm run seed-demo              # send all seed emails
 *   npm run seed-demo -- --dry-run # preview without sending
 *   npm run seed-demo -- --delay 5 # 5 second delay between emails (default: 3)
 */

const accounts = JSON.parse(
  readFileSync(new URL('../fixtures/demo-accounts.json', import.meta.url), 'utf-8')
);
const seedEmails = JSON.parse(
  readFileSync(new URL('../fixtures/seed-emails.json', import.meta.url), 'utf-8')
);

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_IDX = process.argv.indexOf('--delay');
const DELAY_SEC = DELAY_IDX !== -1 ? parseInt(process.argv[DELAY_IDX + 1], 10) : 3;

const RECIPIENT = accounts.hitl.email;

// Map sender IDs to their config
const senderMap = {};
for (const s of accounts.senders) {
  senderMap[s.id] = s;
}

// Refresh tokens per sender (set in .env)
const TOKENS = {
  steve: process.env.GMAIL_REFRESH_TOKEN_STEVE,
  bob: process.env.GMAIL_REFRESH_TOKEN_BOB,
};

function getGmailClient(senderId) {
  const token = TOKENS[senderId];
  if (!token) {
    throw new Error(
      `Missing GMAIL_REFRESH_TOKEN_${senderId.toUpperCase()} in .env. ` +
      `Run: npm run setup-gmail   (log in as ${senderMap[senderId].email})`
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: token });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Build a raw RFC 2822 email and send it via Gmail API.
 */
async function sendEmail(gmail, { from, fromName, to, subject, body }) {
  const headers = [
    `From: ${fromName} <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <seed-${Date.now()}-${Math.random().toString(36).slice(2)}@gmail.com>`,
  ];

  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + body
  ).toString('base64url');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return result.data.id;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('AutoBot Inbox — Demo Seeder');
  console.log('===========================\n');
  console.log(`Recipient: ${RECIPIENT} (${accounts.hitl.name}, ${accounts.hitl.company})`);
  console.log(`Emails to send: ${seedEmails.length}`);
  console.log(`Delay between emails: ${DELAY_SEC}s`);
  if (DRY_RUN) console.log('** DRY RUN — no emails will be sent **');
  console.log('');

  // Verify credentials
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.error('Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env');
    console.error('Run: npm run setup');
    process.exit(1);
  }

  // Pre-validate all sender tokens
  const gmailClients = {};
  const senderIds = [...new Set(seedEmails.map(e => e.from))];

  for (const sid of senderIds) {
    if (!TOKENS[sid]) {
      console.error(`Missing GMAIL_REFRESH_TOKEN_${sid.toUpperCase()} in .env`);
      console.error(`Run: npm run setup-gmail   (log in as ${senderMap[sid].email})`);
      console.error('');
      console.error('You need a refresh token for each sender account.');
      console.error('Run setup-gmail once per account, logging into that Gmail when prompted.');
      process.exit(1);
    }

    if (!DRY_RUN) {
      try {
        const client = getGmailClient(sid);
        const profile = await client.users.getProfile({ userId: 'me' });
        console.log(`  ✓ ${senderMap[sid].name} (${profile.data.emailAddress})`);
        gmailClients[sid] = client;
      } catch (err) {
        console.error(`  ✗ ${senderMap[sid].name}: ${err.message}`);
        process.exit(1);
      }
    }
  }
  console.log('');

  // Send emails with delay to simulate realistic timing
  let sent = 0;
  let failed = 0;

  for (const email of seedEmails) {
    const sender = senderMap[email.from];
    if (!sender) {
      console.error(`Unknown sender: ${email.from}`);
      failed++;
      continue;
    }

    const label = `[${sender.company}] ${email.subject}`;

    if (DRY_RUN) {
      console.log(`  → ${label}`);
      console.log(`    From: ${sender.name} <${sender.email}>`);
      console.log(`    Category: ${email.category} (priority: ${email.priority})`);
      if (email.signals.length > 0) {
        console.log(`    Signals: ${email.signals.join(', ')}`);
      }
      console.log('');
      sent++;
      continue;
    }

    try {
      const msgId = await sendEmail(gmailClients[email.from], {
        from: sender.email,
        fromName: sender.name,
        to: RECIPIENT,
        subject: email.subject,
        body: email.body,
      });
      console.log(`  ✓ ${label} → ${msgId}`);
      sent++;
    } catch (err) {
      console.error(`  ✗ ${label}: ${err.message}`);
      failed++;
    }

    // Delay between sends to look realistic (not a spam burst)
    if (email !== seedEmails[seedEmails.length - 1]) {
      await sleep(DELAY_SEC * 1000);
    }
  }

  console.log('');
  console.log(`Done. ${sent} sent, ${failed} failed.`);

  if (!DRY_RUN && sent > 0) {
    console.log('');
    console.log('Emails are now in Jordan\'s inbox. Start AutoBot to process them:');
    console.log('  npm start');
  }
}

main().catch(err => {
  console.error('Seeder failed:', err.message);
  process.exit(1);
});
