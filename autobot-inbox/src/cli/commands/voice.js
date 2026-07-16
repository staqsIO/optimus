import chalk from 'chalk';
import { query } from '../../db.js';
import { getEditRate } from '../../voice/edit-tracker.js';
import { rebuildAllProfiles } from '../../voice/profile-builder.js';

/**
 * Voice command: voice profile management and training stats.
 */
export async function voiceCommand(args) {
  const sub = args[0]; // 'status', 'profiles', 'edits'

  if (sub === 'profiles' || !sub) {
    // Show voice profiles
    const profiles = await query(
      `SELECT scope, scope_key, greetings, closings, formality_score, avg_length, sample_count, last_updated
       FROM voice.profiles
       ORDER BY scope, scope_key`
    );

    console.log(chalk.bold('\n  Voice Profiles'));
    console.log(chalk.gray('  ' + '─'.repeat(60)));

    if (profiles.rows.length === 0) {
      console.log(chalk.gray('  No profiles built yet. Run "npm run bootstrap-voice" first.'));
    } else {
      for (const p of profiles.rows) {
        const key = p.scope === 'global' ? 'GLOBAL' : p.scope_key;
        console.log(chalk.bold(`\n  ${p.scope.toUpperCase()}: ${key}`));
        console.log(`    Samples:    ${p.sample_count}`);
        console.log(`    Formality:  ${p.formality_score}`);
        console.log(`    Avg length: ${p.avg_length} words`);
        console.log(`    Greetings:  ${(p.greetings || []).join(', ') || '(none)'}`);
        console.log(`    Closings:   ${(p.closings || []).join(', ') || '(none)'}`);
        console.log(chalk.gray(`    Updated:    ${new Date(p.last_updated).toLocaleDateString()}`));
      }
    }
  } else if (sub === 'edits') {
    // Show recent edit deltas
    const edits = await query(
      `SELECT edit_type, edit_magnitude, recipient, subject, created_at
       FROM voice.edit_deltas
       ORDER BY created_at DESC
       LIMIT 20`
    );

    console.log(chalk.bold('\n  Recent Edit Deltas (G4 Training Data)'));
    console.log(chalk.gray('  ' + '─'.repeat(60)));

    const editRate = await getEditRate(14);
    console.log(`  14-day edit rate: ${(editRate.rate * 100).toFixed(1)}% (${editRate.edited}/${editRate.total})\n`);

    if (edits.rows.length === 0) {
      console.log(chalk.gray('  No edits recorded yet.'));
    } else {
      for (const e of edits.rows) {
        const mag = (parseFloat(e.edit_magnitude) * 100).toFixed(0);
        const type = (e.edit_type || '?').padEnd(10);
        const recipient = (e.recipient || '').slice(0, 25).padEnd(25);
        const date = new Date(e.created_at).toLocaleDateString();
        console.log(`  ${type} ${chalk.gray(mag + '%')} ${recipient} ${date}`);
      }
    }
  } else if (sub === 'status') {
    // Sent email corpus stats
    const sentCount = await query(`SELECT COUNT(*) FROM voice.sent_emails`);
    const embeddedCount = await query(`SELECT COUNT(*) FROM voice.sent_emails WHERE embedding IS NOT NULL`);
    const profileCount = await query(`SELECT COUNT(*) FROM voice.profiles`);
    const deltaCount = await query(`SELECT COUNT(*) FROM voice.edit_deltas`);

    console.log(chalk.bold('\n  Voice Learning Status'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));
    console.log(`  Sent emails imported:  ${sentCount.rows[0].count}`);
    console.log(`  With embeddings:       ${embeddedCount.rows[0].count}`);
    console.log(`  Voice profiles:        ${profileCount.rows[0].count}`);
    console.log(`  Edit deltas (G4):      ${deltaCount.rows[0].count}`);
  } else if (sub === 'rebuild') {
    console.log(chalk.bold('\n  Rebuilding Voice Profiles...'));
    console.log(chalk.gray('  Analyzing edit deltas and applying corrections.\n'));

    const stats = await rebuildAllProfiles();

    console.log(chalk.green('  Rebuild complete.'));
    console.log(`  Profiles rebuilt:  ${stats.profilesRebuilt}`);
    console.log(`  Deltas analyzed:   ${stats.deltasAnalyzed}`);
    console.log(`  Global profile:    ${stats.globalProfile ? 'yes' : 'no'}`);
    console.log(chalk.gray(`  Elapsed:           ${stats.elapsedMs}ms`));
  } else {
    console.log(chalk.yellow('  Usage: voice [profiles|edits|status|rebuild]'));
  }

  console.log();
}
