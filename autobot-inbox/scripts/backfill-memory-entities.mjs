#!/usr/bin/env node
// Feature 010-C (OPT-131) — one-time backfill: tag existing agent_memories with
// metadata.entities so 010-D's relevance recall is demonstrable immediately
// rather than waiting weeks for memories to age in (OQ-3, board-deferred default).
//
// Idempotent: only touches rows where metadata->'entities' is absent. Safe to
// re-run. DRY-RUN BY DEFAULT — pass --apply to write.
//
// Must run from inside autobot-inbox/ (ESM resolves pg relative to this file).
//   node scripts/backfill-memory-entities.mjs --limit 200            # dry run
//   node scripts/backfill-memory-entities.mjs --limit 200 --apply    # write
//
// Requires DATABASE_URL + an Anthropic-capable model in config (same cheap Haiku
// pass the live extraction uses).

import { query } from '../src/db.js';
import { loadMergedConfig } from '../../lib/runtime/config-loader.js';
import { createLLMClient, callProvider } from '../src/llm/provider.js';
import { normalizeEntities, pickCheapModel } from '../src/commands/agent-chat.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Math.max(1, parseInt(process.argv[limitArg + 1], 10) || 200) : 200;

const ENTITY_SYSTEM =
  'Given a stored memory about a board member or their organization, output ONLY a JSON array of the specific people or organizations the memory is ABOUT: ' +
  '[{"kind":"person"|"org","name":"...","email":"..."}]. Include "email" only if it appears in the text; otherwise just "name". ' +
  'If the memory references no specific person or org, output [].';

async function extractEntities(llm, content) {
  const resp = await callProvider(llm, {
    system: ENTITY_SYSTEM,
    messages: [{ role: 'user', content: String(content).slice(0, 1500) }],
    maxTokens: 200,
    temperature: 0,
  });
  const m = String(resp.text || '').match(/\[[\s\S]*\]/);
  if (!m) return { entities: [], resp };
  try {
    return { entities: normalizeEntities(JSON.parse(m[0])), resp };
  } catch {
    return { entities: [], resp };
  }
}

async function main() {
  const config = await loadMergedConfig();
  const modelKey = pickCheapModel(config);
  if (!modelKey) {
    console.error('No cheap (Haiku-class) model available in config — aborting.');
    process.exit(1);
  }
  const llm = createLLMClient(modelKey, config.models);

  // Only rows that have not been tagged yet (idempotent).
  const { rows } = await query(
    `SELECT id, agent_id, content
       FROM agent_graph.agent_memories
      WHERE metadata->'entities' IS NULL
        AND length(content) >= 10
      ORDER BY created_at DESC
      LIMIT $1`,
    [LIMIT]
  );

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} · model=${modelKey} · ${rows.length} untagged memories (limit ${LIMIT})`);
  let tagged = 0;
  let withEntities = 0;
  for (const r of rows) {
    const { entities } = await extractEntities(llm, r.content);
    tagged++;
    if (entities.length > 0) withEntities++;
    if (APPLY) {
      // Stamp entities (even []) so the row is marked processed and we never re-pay.
      await query(
        `UPDATE agent_graph.agent_memories
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('entities', $2::jsonb)
          WHERE id = $1`,
        [r.id, JSON.stringify(entities)]
      );
    }
    if (tagged % 25 === 0) console.log(`  …${tagged}/${rows.length} processed (${withEntities} with entities)`);
  }
  console.log(`Done: ${tagged} processed, ${withEntities} carried ≥1 entity.${APPLY ? '' : ' (dry run — no writes)'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});
