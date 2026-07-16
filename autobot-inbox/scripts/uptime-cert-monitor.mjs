#!/usr/bin/env node
/**
 * Standalone uptime + TLS-cert-expiry check (STAQPRO-606).
 *
 * Runs the same monitor as the in-process scheduler, but as a one-shot suitable
 * for an EXTERNAL cron or CI job — which, unlike the in-process version, keeps
 * working even if the API host itself is down. Prints a summary and exits
 * non-zero when any surface is down or any cert is within the warning window, so
 * a cron wrapper / CI step can alert on the exit code.
 *
 * Usage:
 *   node scripts/uptime-cert-monitor.mjs
 *   MONITOR_TARGETS="board=https://board.staqs.io/,api=https://preview.staqs.io/api/health" \
 *   MONITOR_CERT_WARN_DAYS=21 node scripts/uptime-cert-monitor.mjs
 *
 * Set TELEGRAM_BOARD_USER_IDS (+ bot token) to also DM the board on failure.
 */
import { runUptimeCertMonitor, certWarnDays } from '../src/monitoring/uptime-cert-monitor.js';

let notify = null;
if (process.env.TELEGRAM_BOARD_USER_IDS) {
  try {
    ({ notifyBoard: notify } = await import('../src/telegram/sender.js'));
  } catch {
    /* telegram optional — fall through to stdout only */
  }
}

const { summary, alerts } = await runUptimeCertMonitor({ notify });

console.log(`uptime/cert monitor (warn < ${certWarnDays()}d):`);
for (const s of summary) {
  console.log(`  ${s.name.padEnd(8)} status=${String(s.status).padEnd(6)} cert=${s.certDays === null ? '?' : s.certDays + 'd'}`);
}
if (alerts.length) {
  console.error(`\n${alerts.length} ALERT(S):`);
  for (const a of alerts) console.error(`  • ${a}`);
  process.exit(1);
}
console.log('\nall green ✅');
process.exit(0);
