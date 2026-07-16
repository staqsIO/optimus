import 'dotenv/config';
import { initializeDatabase, close, query } from '../src/db.js';
import { generateDraftEmbeddings, hasEmbeddingProvider } from '../src/voice/embeddings.js';

/**
 * One-shot backfill: embed all email-draft action_proposals that don't
 * yet have an embedding. Drains the queue in 50-row batches.
 *
 * STAQPRO-301: feeds the M3 voice-similarity metric. The runtime sweep in
 * src/index.js handles ongoing embedding every 5 min; this script is for
 * the initial backfill after migration 103 lands, or for catching up after
 * a long Voyage outage.
 *
 * Mirrors bootstrap-voice.js — embeds the sent-email side; this script
 * embeds the AI-draft side. Same Voyage model, same 1024-dim space.
 */
async function main() {
  console.log('AutoBot Inbox — Draft Embedding Backfill (STAQPRO-301)');
  console.log('========================================================\n');

  if (!hasEmbeddingProvider()) {
    console.error('No embedding provider configured (set VOYAGE_API_KEY or OPENAI_API_KEY).');
    process.exit(1);
  }

  await initializeDatabase();

  const queueResult = await query(
    `SELECT count(*) AS cnt
       FROM agent_graph.action_proposals
      WHERE action_type = 'email_draft' AND embedding IS NULL`
  );
  const queueDepth = parseInt(queueResult.rows[0]?.cnt || '0', 10);
  console.log(`Queue depth: ${queueDepth} drafts pending embedding\n`);

  if (queueDepth === 0) {
    console.log('Nothing to do.');
    await close();
    return;
  }

  let totalProcessed = 0;
  let lastBatchProcessed = 0;
  do {
    lastBatchProcessed = await generateDraftEmbeddings(50);
    totalProcessed += lastBatchProcessed;
    if (lastBatchProcessed > 0) {
      console.log(`Progress: ${totalProcessed}/${queueDepth}`);
    }
  } while (lastBatchProcessed > 0);

  const remainingResult = await query(
    `SELECT count(*) AS cnt
       FROM agent_graph.action_proposals
      WHERE action_type = 'email_draft' AND embedding IS NULL`
  );
  const remaining = parseInt(remainingResult.rows[0]?.cnt || '0', 10);

  console.log(`\nDone. Embedded ${totalProcessed} drafts; ${remaining} still unembedded`);
  if (remaining > 0) {
    console.log('(probably hit Voyage rate-limit on a batch; re-run to retry)');
  }

  await close();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
