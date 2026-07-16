import 'dotenv/config';
import { initializeDatabase, close, query } from '../src/db.js';
import { bootstrapSentEmails } from '../src/gmail/sent-analyzer.js';
import { buildGlobalProfile, buildRecipientProfiles } from '../src/voice/profile-builder.js';

/**
 * Bootstrap voice data from sent emails.
 * D3: Voice profiles derived from sent mail analysis.
 *
 * Steps:
 *   1. Pull up to 1000 sent emails from Gmail
 *   2. Build global voice profile
 *   3. Build per-recipient profiles (for contacts with 3+ sent emails)
 *
 * Estimated cost: ~$1 total (embedding generation).
 */
async function main() {
  console.log('AutoBot Inbox — Voice Bootstrap');
  console.log('===============================\n');

  // Verify env
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    console.error('GMAIL_REFRESH_TOKEN required for sent email access.');
    console.error('Run: npm run setup-gmail');
    process.exit(1);
  }

  // Initialize PGlite
  try {
    await initializeDatabase();
    await query('SELECT 1');
  } catch (err) {
    console.error(`Database initialization failed: ${err.message}`);
    process.exit(1);
  }

  // Step 1: Import sent emails
  console.log('Step 1: Importing sent emails from Gmail...');
  const count = await bootstrapSentEmails(1000);
  console.log(`  Imported ${count} sent emails\n`);

  // Step 2: Build global profile
  console.log('Step 2: Building global voice profile...');
  const globalProfile = await buildGlobalProfile();
  if (globalProfile) {
    console.log(`  Greetings: ${globalProfile.greetings.join(', ')}`);
    console.log(`  Closings: ${globalProfile.closings.join(', ')}`);
    console.log(`  Formality: ${globalProfile.formalityScore}`);
    console.log(`  Avg length: ${globalProfile.avgLength} words\n`);
  } else {
    console.log('  No emails to analyze\n');
  }

  // Step 3: Build per-recipient profiles
  console.log('Step 3: Building per-recipient profiles...');
  await buildRecipientProfiles();
  console.log('  Done\n');

  // Step 4: Generate embeddings for vector similarity search
  // Uses OpenAI text-embedding-3-small (~$0.02 per 1M tokens, ~$0.10 for 1000 emails)
  if (process.env.OPENAI_API_KEY) {
    console.log('Step 4: Generating embeddings for vector similarity...');
    try {
      const { generateEmbeddings } = await import('../src/voice/embeddings.js');
      const embedded = await generateEmbeddings(1000);
      console.log(`  Embedded ${embedded} emails\n`);
    } catch (err) {
      console.warn(`  Embedding generation failed: ${err.message}`);
      console.log('  (Voice system works without embeddings — uses trigram similarity fallback)\n');
    }
  } else {
    console.log('Step 4: Skipping embeddings (OPENAI_API_KEY not set)');
    console.log('  Set OPENAI_API_KEY in .env to enable vector similarity matching\n');
  }

  console.log('Voice bootstrap complete.');
  await close();
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
