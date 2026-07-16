/**
 * STAQPRO-522 — Nightly tier-resolution job.
 *
 * Auto-promotes signal.contacts.tier from deterministic signals (calendar
 * attendance, outbound email count, domain affinity). Pure SQL, no LLM.
 *
 * Background: executor-responder (2026-05-07, eca8500) skips drafting for any
 * sender whose tier is not in {inner_circle, active}. Without this job, every
 * new contact lands at 'unknown' and stays there forever — drafts effectively
 * stop for everyone outside the 13 manually-curated inner_circle contacts.
 *
 * Rules:
 *   1. Domain affinity → inner_circle (@staqs.io, @umbadvisors.com)
 *   2. ≥2 distinct accepted/tentative calendar events in 90d → active
 *   3. ≥2 outbound emails sent → active
 *   4. Decay: tier='active' with no two-way interaction in 180d → unknown
 *
 * Sticky tiers (newsletter, automated, marketing, inbound_only, inner_circle)
 * are never auto-demoted by rules 2 & 3. Manual review is required to leave
 * those tiers.
 *
 * Safety: each rule is wrapped in the same transaction. If any single rule
 * would mutate more than SAFETY_LIMIT rows, the entire transaction aborts —
 * that count is the signature of a query bug, not a real production day.
 */

import { withTransaction, query } from '../../db.js';

// If a single statement touches more rows than this, we abort.
// Total active addressable population is in the hundreds; a four-figure
// mutation count means the WHERE clause regressed.
const SAFETY_LIMIT = 1000;

const DOMAIN_AFFINITY_REGEX = '@(staqs\\.io|umbadvisors\\.com)$';

/**
 * Run the four tier-resolution rules in a single transaction. Returns the
 * per-rule row counts and writes a single audit row to
 * signal.tier_resolution_runs.
 *
 * @returns {Promise<{
 *   promoted_inner_circle: number,
 *   promoted_active_calendar: number,
 *   promoted_active_email: number,
 *   demoted_active_unknown: number,
 *   duration_ms: number,
 * }>}
 */
export async function runTierResolution() {
  const startedAt = Date.now();

  const counts = await withTransaction(async (client) => {
    // Rule 1: domain affinity → inner_circle
    const r1 = await client.query(
      `UPDATE signal.contacts
         SET tier = 'inner_circle', updated_at = now()
       WHERE email_address ~* $1
         AND (tier IS NULL OR tier NOT IN ('newsletter','automated','inbound_only','inner_circle'))`,
      [DOMAIN_AFFINITY_REGEX]
    );
    assertSafe('inner_circle', r1.rowCount);

    // Rule 2: ≥2 distinct accepted/tentative calendar events in 90d → active
    const r2 = await client.query(
      `WITH cal_active AS (
         SELECT lower(att->>'email') AS email
           FROM inbox.calendar_events ce,
                jsonb_array_elements(ce.attendees) AS att
          WHERE ce.start_at > now() - interval '90 days'
            AND att->>'responseStatus' IN ('accepted','tentative')
            AND COALESCE((att->>'self')::bool, false) = false
            AND COALESCE((att->>'resource')::bool, false) = false
            AND att->>'email' IS NOT NULL
          GROUP BY 1
         HAVING count(DISTINCT ce.id) >= 2
       )
       UPDATE signal.contacts c
          SET tier = 'active', updated_at = now()
         FROM cal_active ca
        WHERE lower(c.email_address) = ca.email
          AND c.tier IN ('unknown','inbound_only')`
    );
    assertSafe('active_calendar', r2.rowCount);

    // Rule 3: ≥2 outbound emails sent → active
    const r3 = await client.query(
      `UPDATE signal.contacts
          SET tier = 'active', updated_at = now()
        WHERE emails_sent >= 2
          AND tier IN ('unknown','inbound_only')`
    );
    assertSafe('active_email', r3.rowCount);

    // Rule 4: decay active → unknown after 180d cold.
    //
    // Important: only decay if we have *positive evidence* the contact has
    // gone cold. A contact with both timestamps NULL has no signal yet —
    // typically because rule 2 (calendar attendance) or rule 3 (outbound
    // count) just promoted them and the counters haven't been backfilled.
    // COALESCE-to-epoch on a NULL would falsely demote those.
    const r4 = await client.query(
      `UPDATE signal.contacts
          SET tier = 'unknown', updated_at = now()
        WHERE tier = 'active'
          AND (last_sent_at IS NOT NULL OR last_received_at IS NOT NULL)
          AND GREATEST(COALESCE(last_sent_at, 'epoch'::timestamptz),
                       COALESCE(last_received_at, 'epoch'::timestamptz))
              < now() - interval '180 days'`
    );
    assertSafe('demoted', r4.rowCount);

    return {
      promoted_inner_circle: r1.rowCount ?? 0,
      promoted_active_calendar: r2.rowCount ?? 0,
      promoted_active_email: r3.rowCount ?? 0,
      demoted_active_unknown: r4.rowCount ?? 0,
    };
  });

  const duration_ms = Date.now() - startedAt;

  // Audit row — fire-and-forget on failure so a logging hiccup doesn't crash
  // the scheduled job. The transaction above already committed.
  try {
    await query(
      `INSERT INTO signal.tier_resolution_runs
         (promoted_inner_circle, promoted_active_calendar,
          promoted_active_email, demoted_active_unknown, duration_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        counts.promoted_inner_circle,
        counts.promoted_active_calendar,
        counts.promoted_active_email,
        counts.demoted_active_unknown,
        duration_ms,
      ]
    );
  } catch (err) {
    console.error('[tier-resolution] failed to write audit row:', err.message);
  }

  console.log(
    `[tier-resolution] rule1=${counts.promoted_inner_circle} ` +
      `rule2=${counts.promoted_active_calendar} ` +
      `rule3=${counts.promoted_active_email} ` +
      `rule4=${counts.demoted_active_unknown} ` +
      `duration_ms=${duration_ms}`
  );

  return { ...counts, duration_ms };
}

function assertSafe(ruleName, rowCount) {
  if ((rowCount ?? 0) > SAFETY_LIMIT) {
    throw new Error(
      `[tier-resolution] rule ${ruleName} would mutate ${rowCount} rows ` +
        `(limit ${SAFETY_LIMIT}) — aborting transaction. Likely query bug.`
    );
  }
}

// Exported for unit tests that want to exercise the guard without an LLM.
export const __test = { SAFETY_LIMIT, DOMAIN_AFFINITY_REGEX };
