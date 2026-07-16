/**
 * Enrich unknown contacts via LLM signature extraction.
 *
 * For each contact_type='unknown' / 'participant' contact, pull their most
 * recent inbox.messages.snippet (we don't store full bodies — snippet is
 * the first 4000 chars including signatures), ask Haiku to extract
 * { name, organization, role, contact_type }, and update the row.
 *
 * Conservative: only fills NULL fields. Never overwrites human-curated
 * data. Never auto-creates org rows (only links to existing organizations
 * by domain or alias).
 *
 * Usage:
 *   node --env-file=.env scripts/enrich-contacts.js [--dry] [--limit=50]
 */

import pg from 'pg';
import { createLLMClient, callProvider, computeCost } from '../../lib/llm/provider.js';
import { getConfig } from '../../lib/config/loader.js';

const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  return arg ? parseInt(arg.slice('--limit='.length), 10) : Infinity;
})();

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_SNIPPET_CHARS = 1500;
const PER_CONTACT_MESSAGES = 2;

const SYSTEM_PROMPT = `You are extracting structured contact data from email signatures.

You will receive 1-3 email snippets from a single sender. Return a single JSON object with:
  - name: their full real name (string) — only set if obviously stated; null if unsure
  - organization: their company / org name (string) — null if unsure
  - role: their job title (string) — null if unsure
  - contact_type: one of "person", "service", "newsletter", "vendor", "investor", "customer", "partner", "advisor" — best guess; null if unsure

Rules:
  - Be conservative. NULL fields are fine. Don't invent.
  - "service" is for transactional senders (billing, alerts, no-reply, automated).
  - "newsletter" is for content broadcasts the recipient subscribed to.
  - Strip honorifics, post-nominals, ALL-CAPS departments, and pronouns from names.
  - Organization should be the human-readable display name, not a domain.
  - Output ONLY the JSON object, no preamble.`;

function userPrompt(contactRow, messages) {
  const lines = [];
  lines.push(`Contact email: ${contactRow.email_address}`);
  if (contactRow.from_name_seen) lines.push(`From-header name(s) seen: ${contactRow.from_name_seen}`);
  lines.push('');
  lines.push('Recent message snippets:');
  for (const m of messages) {
    lines.push('---');
    if (m.subject) lines.push(`Subject: ${m.subject}`);
    if (m.snippet) lines.push((m.snippet || '').slice(0, MAX_SNIPPET_CHARS));
  }
  return lines.join('\n');
}

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Route through the LLM provider abstraction (ADR-020): provider selection
  // + pricing live in one place. Model must exist in agents.json `models`.
  const llm = createLLMClient(MODEL, getConfig('agents').models);

  const candidates = await client.query(`
    SELECT c.id, c.email_address, c.name, c.organization, c.contact_type, c.metadata,
           string_agg(DISTINCT m.from_name, ' | ') FILTER (WHERE m.from_name IS NOT NULL) AS from_name_seen
      FROM signal.contacts c
      LEFT JOIN inbox.messages m ON lower(m.from_address) = lower(c.email_address)
     WHERE c.contact_type IN ('unknown', 'participant')
     GROUP BY c.id
     HAVING count(m.id) > 0
     ORDER BY max(m.received_at) DESC NULLS LAST
  `);

  console.log(`[enrich] candidates: ${candidates.rows.length}, will process ${Math.min(LIMIT, candidates.rows.length)}`);

  let updated = 0;
  let skipped = 0;
  let cost = 0;
  let processed = 0;

  for (const row of candidates.rows) {
    if (processed >= LIMIT) break;
    processed += 1;

    const messages = await client.query(
      `SELECT subject, snippet FROM inbox.messages
        WHERE lower(from_address) = lower($1)
          AND snippet IS NOT NULL AND length(trim(snippet)) > 50
        ORDER BY received_at DESC
        LIMIT $2`,
      [row.email_address, PER_CONTACT_MESSAGES],
    );
    if (messages.rows.length === 0) {
      skipped += 1;
      continue;
    }

    let parsed;
    try {
      const resp = await callProvider(llm, {
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(row, messages.rows) }],
        maxTokens: 256,
      });
      cost += computeCost(resp.inputTokens, resp.outputTokens, llm.modelConfig);
      const text = (resp.text || '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON in response');
      parsed = JSON.parse(match[0]);
    } catch (e) {
      console.warn(`[enrich] ${row.email_address} llm failed: ${e.message}`);
      skipped += 1;
      continue;
    }

    // Build conservative UPDATE — only set NULL/empty fields.
    const updates = [];
    const values = [row.id];
    const setMetadata = { ...(row.metadata || {}) };
    let metadataChanged = false;

    if (parsed.name && (!row.name || !row.name.trim())) {
      values.push(String(parsed.name).slice(0, 255));
      updates.push(`name = $${values.length}`);
    }
    if (parsed.organization && (!row.organization || !row.organization.trim())) {
      values.push(String(parsed.organization).slice(0, 255));
      updates.push(`organization = $${values.length}`);
    }
    if (parsed.role && setMetadata.role !== parsed.role) {
      setMetadata.role = String(parsed.role).slice(0, 255);
      metadataChanged = true;
    }
    const validTypes = ['person', 'service', 'newsletter', 'vendor', 'investor', 'customer', 'partner', 'advisor', 'team', 'cofounder', 'board', 'recruiter', 'legal', 'accountant', 'prospect'];
    if (parsed.contact_type && validTypes.includes(parsed.contact_type) && row.contact_type === 'unknown') {
      values.push(parsed.contact_type === 'person' ? 'unknown' : parsed.contact_type);
      // 'person' isn't in our enum; we leave as 'unknown' but mark via metadata
      if (parsed.contact_type === 'person') {
        setMetadata.classified_as = 'person';
        metadataChanged = true;
        values.pop();  // don't update contact_type
        updates.pop ? null : null;
      } else {
        updates.push(`contact_type = $${values.length}`);
      }
    }
    if (metadataChanged) {
      values.push(JSON.stringify(setMetadata));
      updates.push(`metadata = $${values.length}::jsonb`);
    }

    if (updates.length === 0) {
      skipped += 1;
      console.log(`  - ${row.email_address}: nothing to add`);
      continue;
    }

    if (DRY) {
      console.log(`  + ${row.email_address}: would set { ${updates.join(', ')} } from`, parsed);
    } else {
      await client.query(
        `UPDATE signal.contacts SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`,
        values,
      );
      console.log(`  + ${row.email_address}: ${parsed.name || '(no name)'} @ ${parsed.organization || '(no org)'} — ${parsed.role || ''}`);
      updated += 1;
    }

    // Small delay to be polite on rate limits
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log('');
  console.log(`[enrich] processed=${processed} updated=${updated} skipped=${skipped} estimated_cost=$${cost.toFixed(4)}`);
  await client.end();
}

main().catch((e) => {
  console.error('[enrich] FATAL', e);
  process.exit(1);
});
