#!/usr/bin/env node
/**
 * CLI: run a synth pass for one engagement.
 *
 *   node scripts/synth-engagement.js <engagementId> [--dry-run] [--model=claude-sonnet-4-6]
 *
 * Loads .env, initializes the DB, calls lib/engagements/synth.js, prints
 * a summary. Use --dry-run to see the proposed sections without writing.
 */

import 'dotenv/config';
import { initializeDatabase, close } from '../src/db.js';
import { synthesizeEngagementSpec } from '../../lib/engagements/synth.js';

async function main() {
  const args = process.argv.slice(2);
  const engagementId = args.find((a) => !a.startsWith('--'));
  if (!engagementId) {
    console.error('Usage: synth-engagement.js <engagementId> [--dry-run] [--model=<key>]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const modelArg = args.find((a) => a.startsWith('--model='));
  const modelKey = modelArg ? modelArg.split('=')[1] : undefined;

  await initializeDatabase();

  console.log(`Synthesizing engagement ${engagementId}${dryRun ? ' (dry-run)' : ''}...`);
  const result = await synthesizeEngagementSpec(engagementId, {
    modelKey,
    actor: process.env.USER ? `${process.env.USER}@cli` : 'cli',
    dryRun,
  });

  if (dryRun) {
    console.log('\n=== DRY-RUN: proposed spec ===');
    for (const s of result.proposed.sections) {
      console.log(`\n## ${s.title} [${s.key}] ordinal=${s.ordinal}${s.is_core ? ' (core)' : ''}`);
      console.log(s.body || '(empty)');
      if (s.provenance.length) console.log(`  provenance: ${s.provenance.join(', ')}`);
    }
    if (result.proposed.conflicts.length) {
      console.log('\n=== Conflicts ===');
      for (const c of result.proposed.conflicts) console.log(`  - ${c.summary}`);
    }
    console.log(`\ncost: $${result.costUsd.toFixed(4)} model: ${result.modelKey}`);
  } else {
    console.log('\n=== Synth applied ===');
    console.log(`  version:                ${result.version}`);
    console.log(`  sections added:         ${result.sectionsAdded}`);
    console.log(`  sections updated:       ${result.sectionsUpdated}`);
    console.log(`  sections skipped (pin): ${result.sectionsSkippedPin}`);
    console.log(`  sections removed:       ${result.sectionsRemoved}`);
    console.log(`  conflicts added:        ${result.conflictsAdded}`);
    console.log(`  cost:                   $${result.costUsd.toFixed(4)}`);
    console.log(`  model:                  ${result.modelKey}`);
  }
}

main()
  .then(() => close())
  .catch(async (err) => {
    console.error('synth failed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    await close().catch(() => {});
    process.exit(1);
  });
