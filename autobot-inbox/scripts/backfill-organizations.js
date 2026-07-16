/**
 * One-shot backfill: promote signal.contacts.organization (free text) to
 * real signal.organizations rows, link contacts via organization_id.
 *
 * Run once after migration 080 lands, and any time you've imported a batch
 * of contacts with new free-text orgs. Idempotent — re-running won't create
 * duplicates because we look up by slug before inserting.
 *
 * Strategy:
 *   1. Group contacts by lower(trim(organization)).
 *   2. For each non-empty slug, find or create an org row.
 *   3. Seed an alias row of (alias=slug, alias_type='name').
 *   4. Update every contact in the group to point at that org.
 *
 * Ambiguous cases (multiple existing orgs whose slug is a substring of the
 * input) get logged into signal.organization_review_log instead of
 * auto-merging.
 *
 *   $ node --env-file=.env scripts/backfill-organizations.js [--dry]
 */

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry');

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function guessDomain(orgText) {
  // If the org text already contains a domain-ish token, use it.
  const m = orgText.match(/\b([a-z0-9-]+\.[a-z]{2,})\b/i);
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`[backfill-organizations] dry=${DRY_RUN}`);

  const grouped = await client.query(`
    SELECT trim(organization) AS org_text, count(*) AS contact_count, array_agg(id) AS contact_ids
      FROM signal.contacts
     WHERE organization IS NOT NULL
       AND trim(organization) <> ''
       AND organization_id IS NULL
     GROUP BY trim(organization)
     ORDER BY count(*) DESC, trim(organization)
  `);

  console.log(`[backfill-organizations] ${grouped.rows.length} distinct org strings to process`);

  let created = 0;
  let linked = 0;
  let aliased = 0;
  let reviewQueued = 0;

  for (const row of grouped.rows) {
    const orgText = row.org_text;
    const slug = slugify(orgText);
    if (!slug || slug.length < 2) continue;

    const existing = await client.query(
      `SELECT o.id, o.name FROM signal.organizations o WHERE o.slug = $1
       UNION
       SELECT o.id, o.name FROM signal.organization_aliases a
        JOIN signal.organizations o ON o.id = a.organization_id
       WHERE a.alias = $1`,
      [slug],
    );

    let orgId;
    if (existing.rows.length === 1) {
      orgId = existing.rows[0].id;
    } else if (existing.rows.length > 1) {
      // Multiple candidates — log for review, skip auto-link.
      reviewQueued += 1;
      if (!DRY_RUN) {
        await client.query(
          `INSERT INTO signal.organization_review_log
             (contact_id, organization_text, candidate_org_ids, status)
           SELECT id, $1, $2, 'pending' FROM unnest($3::text[]) AS id`,
          [orgText, existing.rows.map((r) => r.id), row.contact_ids],
        );
      }
      console.log(`  ? "${orgText}" → ${existing.rows.length} candidates, queued for review`);
      continue;
    } else {
      // Create new org.
      const domain = guessDomain(orgText);
      if (!DRY_RUN) {
        const ins = await client.query(
          `INSERT INTO signal.organizations (name, slug, primary_domain, org_type)
           VALUES ($1, $2, $3, 'unknown')
           RETURNING id`,
          [orgText, slug, domain],
        );
        orgId = ins.rows[0].id;
      } else {
        orgId = '<would-create>';
      }
      created += 1;
    }

    // Seed canonical alias (idempotent).
    if (!DRY_RUN && orgId !== '<would-create>') {
      const aliasResult = await client.query(
        `INSERT INTO signal.organization_aliases (organization_id, alias, alias_type)
         VALUES ($1, $2, 'name')
         ON CONFLICT (alias, alias_type) DO NOTHING
         RETURNING id`,
        [orgId, slug],
      );
      if (aliasResult.rows.length > 0) aliased += 1;
    }

    // Link contacts to org.
    if (!DRY_RUN && orgId !== '<would-create>') {
      const upd = await client.query(
        `UPDATE signal.contacts SET organization_id = $1
          WHERE id = ANY($2::text[]) AND organization_id IS NULL`,
        [orgId, row.contact_ids],
      );
      linked += upd.rowCount;
    } else {
      linked += row.contact_ids.length;
    }
  }

  console.log(`[backfill-organizations] done`);
  console.log(`  organizations created : ${created}`);
  console.log(`  contacts linked       : ${linked}`);
  console.log(`  aliases seeded        : ${aliased}`);
  console.log(`  review queued         : ${reviewQueued}`);

  // Final sanity counts.
  const totals = await client.query(`
    SELECT
      (SELECT count(*) FROM signal.organizations) AS orgs,
      (SELECT count(*) FROM signal.contacts WHERE organization_id IS NOT NULL) AS linked_contacts,
      (SELECT count(*) FROM signal.contacts WHERE organization IS NOT NULL AND trim(organization) <> '' AND organization_id IS NULL) AS unlinked_with_text
  `);
  console.log('  final state:', totals.rows[0]);

  await client.end();
}

main().catch((e) => {
  console.error('[backfill-organizations] FATAL', e);
  process.exit(1);
});
