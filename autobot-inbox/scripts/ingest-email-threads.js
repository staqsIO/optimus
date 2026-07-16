#!/usr/bin/env node
/**
 * Bulk ingest email threads into the RAG knowledge base.
 *
 * Finds all threads where the specified account has sent messages,
 * fetches full thread content, and ingests each as a document.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/ingest-email-threads.js <account-identifier>
 *
 * Example:
 *   DATABASE_URL=... node scripts/ingest-email-threads.js eric@staqs.io
 *
 * Must run where Gmail OAuth credentials are available (Railway or local with DATABASE_URL).
 * The script reads credentials from inbox.accounts and writes documents to content.documents.
 */

import { google } from 'googleapis';
import { query, initializeDatabase } from '../src/db.js';
import { getAuthForAccount } from '../src/gmail/auth.js';
import { ingestDocument } from '../src/rag/ingest.js';

const BATCH_SIZE = 50;       // Threads per Gmail API page
const MAX_THREADS = 5000;    // Safety cap
const DELAY_MS = 200;        // Rate limit courtesy

async function main() {
  const identifier = process.argv[2];
  if (!identifier) {
    console.error('Usage: node scripts/ingest-email-threads.js <email-address>');
    console.error('Example: node scripts/ingest-email-threads.js eric@staqs.io');
    process.exit(1);
  }

  console.log(`[ingest-email] Starting bulk ingestion for ${identifier}`);

  // Initialize DB connection
  await initializeDatabase();

  // Find account
  const accountResult = await query(
    `SELECT id, identifier, owner_id FROM inbox.accounts WHERE identifier = $1 AND is_active = true`,
    [identifier]
  );
  if (accountResult.rows.length === 0) {
    console.error(`[ingest-email] No active account found for ${identifier}`);
    console.error('[ingest-email] Available accounts:');
    const all = await query(`SELECT identifier, is_active FROM inbox.accounts`);
    all.rows.forEach(r => console.error(`  ${r.identifier} (active: ${r.is_active})`));
    process.exit(1);
  }

  const account = accountResult.rows[0];
  console.log(`[ingest-email] Account: ${account.identifier} (${account.id})`);

  // Get Gmail auth
  const auth = await getAuthForAccount(account.id);
  const gmail = google.gmail({ version: 'v1', auth });

  // Find all threads where we sent messages
  let pageToken = undefined;
  let totalThreads = 0;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  console.log(`[ingest-email] Searching for sent threads...`);

  do {
    const listResult = await gmail.users.threads.list({
      userId: 'me',
      q: `from:${identifier}`,
      maxResults: BATCH_SIZE,
      pageToken,
    });

    const threads = listResult.data.threads || [];
    totalThreads += threads.length;
    pageToken = listResult.data.nextPageToken;

    console.log(`[ingest-email] Found ${threads.length} threads (total: ${totalThreads}, page token: ${pageToken ? 'yes' : 'done'})`);

    for (const threadStub of threads) {
      try {
        // Check dedup
        const existing = await query(
          `SELECT id FROM content.documents WHERE source = 'email' AND source_id = $1`,
          [threadStub.id]
        );
        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Fetch full thread
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadStub.id,
          format: 'full',
        });

        const messages = thread.data.messages || [];
        if (messages.length === 0) {
          skipped++;
          continue;
        }

        // Build thread text
        const subject = getHeader(messages[0], 'Subject') || '(no subject)';
        const participants = new Set();
        const threadParts = [];

        for (const msg of messages) {
          const from = getHeader(msg, 'From') || 'Unknown';
          const to = getHeader(msg, 'To') || '';
          const date = getHeader(msg, 'Date') || '';
          const body = extractBody(msg);

          participants.add(from);
          if (to) to.split(',').forEach(t => participants.add(t.trim()));

          threadParts.push(`From: ${from}\nDate: ${date}\n\n${body}`);
        }

        const rawText = `Subject: ${subject}\nParticipants: ${Array.from(participants).join(', ')}\nMessages: ${messages.length}\n\n${threadParts.join('\n\n---\n\n')}`;

        // Ingest
        const result = await ingestDocument({
          source: 'email',
          sourceId: threadStub.id,
          title: subject,
          rawText,
          format: 'plain',
          metadata: {
            threadId: threadStub.id,
            messageCount: messages.length,
            participants: Array.from(participants),
            account: identifier,
            firstDate: getHeader(messages[0], 'Date'),
            lastDate: getHeader(messages[messages.length - 1], 'Date'),
          },
          ownerId: account.owner_id || null,
        });

        if (result && result.chunkCount > 0) {
          ingested++;
          if (ingested % 25 === 0) {
            console.log(`[ingest-email] Progress: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
          }
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        console.warn(`[ingest-email] Thread ${threadStub.id} error: ${err.message.slice(0, 100)}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (totalThreads >= MAX_THREADS) {
      console.log(`[ingest-email] Safety cap reached (${MAX_THREADS})`);
      break;
    }
  } while (pageToken);

  console.log('\n[ingest-email] === COMPLETE ===');
  console.log(`[ingest-email] Total threads found: ${totalThreads}`);
  console.log(`[ingest-email] Ingested: ${ingested}`);
  console.log(`[ingest-email] Skipped (duplicate/empty): ${skipped}`);
  console.log(`[ingest-email] Errors: ${errors}`);

  // Verify
  const docCount = await query(`SELECT count(*) as c FROM content.documents WHERE source = 'email'`);
  const chunkCount = await query(`SELECT count(*) as c FROM content.chunks c JOIN content.documents d ON d.id = c.document_id WHERE d.source = 'email'`);
  console.log(`[ingest-email] DB totals: ${docCount.rows[0].c} email documents, ${chunkCount.rows[0].c} chunks`);

  process.exit(0);
}

/** Extract a header value from a Gmail message */
function getHeader(message, name) {
  const headers = message?.payload?.headers || [];
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

/** Extract plain text body from a Gmail message */
function extractBody(message) {
  const payload = message?.payload;
  if (!payload) return '';

  // Simple: body.data on the payload itself
  if (payload.body?.data) {
    return decodeBase64(payload.body.data);
  }

  // Multipart: find text/plain part
  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decodeBase64(part.body.data);
    }
    // Nested multipart
    if (part.parts) {
      for (const sub of part.parts) {
        if (sub.mimeType === 'text/plain' && sub.body?.data) {
          return decodeBase64(sub.body.data);
        }
      }
    }
  }

  // Fallback: snippet
  return message.snippet || '';
}

function decodeBase64(data) {
  return Buffer.from(data, 'base64url').toString('utf8');
}

main().catch(err => {
  console.error('[ingest-email] FATAL:', err.message);
  process.exit(1);
});
