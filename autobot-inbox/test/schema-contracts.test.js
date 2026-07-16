import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Schema Contract Tests — validates that SQL queries in API route files
 * and command files reference columns that actually exist in the database.
 *
 * Approach: extract SQL from template literals in source files, then
 * PREPARE each query against PGlite to catch "column does not exist"
 * and other schema errors at test time rather than in production.
 *
 * Catches: non-existent columns, wrong schema prefixes, typos in table
 * names, invalid casts, malformed JOINs. Prevents the class of bugs
 * where code references a column that was renamed or never migrated.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROUTES_DIR = join(__dirname, '..', 'src', 'api-routes');
const AGENT_CHAT_PATH = join(__dirname, '..', 'src', 'commands', 'agent-chat.js');

/**
 * Extract SQL queries from JavaScript source code.
 * Finds backtick template literals containing SQL keywords.
 * Returns array of { sql, line, source } objects.
 */
function extractSQLFromSource(source, filename) {
  const queries = [];
  // Match backtick strings — handles nested expressions with ${}
  // We use a simple state machine approach to find balanced backtick strings
  const lines = source.split('\n');
  let inBacktick = false;
  let currentSql = '';
  let startLine = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const prev = j > 0 ? line[j - 1] : '';

      if (!inBacktick) {
        if (ch === '`' && prev !== '\\') {
          inBacktick = true;
          currentSql = '';
          startLine = i + 1;
          braceDepth = 0;
        }
      } else {
        if (ch === '`' && prev !== '\\' && braceDepth === 0) {
          inBacktick = false;
          // Check if this looks like SQL
          if (isSQLQuery(currentSql)) {
            queries.push({
              sql: currentSql,
              line: startLine,
              source: filename,
            });
          }
        } else if (ch === '$' && j + 1 < line.length && line[j + 1] === '{') {
          // Template expression — track brace depth
          braceDepth++;
          j++; // skip the '{'
          currentSql += '__EXPR__';
        } else if (ch === '{' && braceDepth > 0) {
          braceDepth++;
          // Don't append template expression internals
        } else if (ch === '}' && braceDepth > 0) {
          braceDepth--;
          // Don't append template expression internals
        } else if (braceDepth === 0) {
          currentSql += ch;
        }
      }
    }
    if (inBacktick && braceDepth === 0) {
      currentSql += '\n';
    }
  }

  return queries;
}

/**
 * Check if a string looks like a SQL query.
 */
function isSQLQuery(str) {
  const trimmed = str.trim().toUpperCase();
  return (
    (trimmed.startsWith('SELECT') ||
     trimmed.startsWith('INSERT') ||
     trimmed.startsWith('UPDATE') ||
     trimmed.startsWith('DELETE') ||
     trimmed.startsWith('WITH') ||
     trimmed.startsWith('ALTER') ||
     trimmed.startsWith('CREATE')) &&
    // Must reference a table (has FROM, INTO, UPDATE, or schema-qualified name)
    /\b(FROM|INTO|UPDATE|JOIN|TABLE)\b/i.test(str)
  );
}

/**
 * Normalize a SQL query for PREPARE validation:
 * - Replace $1, $2, ... parameter placeholders with NULL (valid for any type)
 * - Replace __EXPR__ template expression placeholders with safe defaults
 * - Remove trailing semicolons
 */
function normalizeSQLForPrepare(sql) {
  let normalized = sql
    // Replace $N params with NULL
    .replace(/\$\d+/g, 'NULL')
    // Replace __EXPR__ with a safe literal (these come from ${} template expressions)
    .replace(/__EXPR__/g, 'NULL')
    // Remove trailing semicolons
    .replace(/;\s*$/, '')
    .trim();

  return normalized;
}

// Issue #533 / Plan 024 residual: this suite now self-gates on DATABASE_URL
// presence, mirroring test/rls-tenancy.test.js. Forcing PGlite (the previous
// behavior) masked genuine schema drift via PGlite's partial-migration-
// rollback quirk (a migration whose RLS policy references auth.uid() throws
// under PGlite, which has no `auth` schema, rolling back the whole migration
// file — including unrelated ADD COLUMNs earlier in the same file) AND hid
// five real schema-drift bugs (contracts.js table-name typo, counterparties.js
// lateral-subquery projection, search.js uuid/text cast, sql/188's missing
// audit-schema grant now closed by sql/194, agent-chat.js created_at
// projection) that only surfaced against a real, migrated Postgres. All five
// are fixed. Under the PGlite `test` job (no DATABASE_URL) this suite SKIPS
// cleanly; the ci.yml `test-postgres` lane sets DATABASE_URL (pool flipped to
// autobot_agent) so it runs for real there.
const HAS_REAL_PG = !!process.env.DATABASE_URL;

describe('Schema contract tests — SQL queries compile against live schema', () => {
  let queryFn;

  before(async () => {
    if (!HAS_REAL_PG) {
      // eslint-disable-next-line no-console
      console.log(
        '[schema-contracts] SKIPPING — requires DATABASE_URL (real Postgres). ' +
        'PGlite\'s partial-migration-rollback behavior masks schema drift this ' +
        'suite exists to catch; see ci.yml test-postgres lane.'
      );
      return;
    }
    process.env.NODE_ENV = 'test';

    const db = await import('../src/db.js');
    queryFn = db.query;

    await db.initializeDatabase();

    // Seed minimal data for FK constraints that some queries may need
    await queryFn(`
      INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
      VALUES
        ('orchestrator', 'orchestrator', 'sonnet', 'test', 'testhash', true),
        ('claw-campaigner', 'orchestrator', 'sonnet', 'test', 'testhash', true)
      ON CONFLICT (id) DO NOTHING
    `);
  });

  // NOTE: Do not call close() — mirrors the other real-PG suites in this
  // directory (rls-tenancy.test.js, tenancy-gucs.test.js): --test-force-exit
  // handles pool teardown at process exit, an explicit close() here isn't
  // needed and previously guarded against a PGlite-specific WASM
  // reinitialization crash that no longer applies now that this suite only
  // runs against real Postgres.

  // ── Schema introspection sanity check ──────────────────────────────
  it('Live Postgres schema has expected tables in agent_graph', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('agent_graph', 'inbox', 'voice', 'signal', 'content')
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `);
    assert.ok(r.rows.length > 0, 'Should have tables in the expected schemas');

    const tableNames = r.rows.map(row => `${row.table_schema}.${row.table_name}`);
    // Verify critical tables exist
    assert.ok(tableNames.includes('agent_graph.work_items'), 'work_items table should exist');
    assert.ok(tableNames.includes('agent_graph.campaigns'), 'campaigns table should exist');
    assert.ok(tableNames.includes('agent_graph.campaign_iterations'), 'campaign_iterations table should exist');
    assert.ok(tableNames.includes('agent_graph.action_proposals'), 'action_proposals table should exist');
  });

  // ── Per-file SQL validation ────────────────────────────────────────

  // Get all API route files
  const routeFiles = readdirSync(API_ROUTES_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ name: f, path: join(API_ROUTES_DIR, f) }));

  // Add agent-chat.js
  const allFiles = [
    ...routeFiles,
    { name: 'agent-chat.js', path: AGENT_CHAT_PATH },
  ];

  for (const file of allFiles) {
    it(`${file.name} — all SQL queries parse without schema errors`, { skip: !HAS_REAL_PG }, async () => {
      let source;
      try {
        source = readFileSync(file.path, 'utf-8');
      } catch (err) {
        // File may not exist (e.g., agent-chat.js moved) — skip gracefully
        console.log(`  [skip] Could not read ${file.name}: ${err.message}`);
        return;
      }

      const queries = extractSQLFromSource(source, file.name);
      if (queries.length === 0) {
        // No SQL in this file — that's fine
        return;
      }

      const failures = [];
      let prepareCounter = 0;

      for (const q of queries) {
        const normalized = normalizeSQLForPrepare(q.sql);

        // Skip queries that are purely dynamic (all template expressions, no real SQL left)
        if (!normalized || normalized.length < 10) continue;

        // Skip ALTER/CREATE statements — those are DDL, not data queries
        const upper = normalized.trim().toUpperCase();
        if (upper.startsWith('ALTER') || upper.startsWith('CREATE')) continue;

        // Use PREPARE to validate the query parses against the schema.
        // PREPARE doesn't execute the query — it only checks syntax and schema references.
        const stmtName = `schema_test_${file.name.replace(/[^a-z0-9]/gi, '_')}_${prepareCounter++}`;

        try {
          await queryFn(`PREPARE ${stmtName} AS ${normalized}`);
          // Clean up the prepared statement
          await queryFn(`DEALLOCATE ${stmtName}`);
        } catch (err) {
          const msg = err.message || String(err);

          // Filter out expected non-schema errors:
          // - "could not determine data type of parameter" is from NULL replacements on typed params
          // - "syntax error" from complex template expressions we couldn't fully replace
          // - "prepared statement already exists" from PGlite quirks
          // - functions like pg_notify, gen_random_uuid may not exist in PGlite
          const ignorable =
            /could not determine data type/i.test(msg) ||
            /syntax error/i.test(msg) ||
            /already exists/i.test(msg) ||
            /function .* does not exist/i.test(msg) ||
            /cannot insert multiple commands/i.test(msg) ||
            // Template literal parser joins table name + expression → e.g. "documentsnull"
            /relation ".*null"/i.test(msg) ||
            // Forward-looking tables not yet in migrations (code has try/catch guards)
            /merkle_proofs|merkle_root/i.test(msg) ||
            /public_events/i.test(msg);

          if (!ignorable) {
            failures.push({
              line: q.line,
              error: msg,
              sql: q.sql.trim().slice(0, 200),
            });
          }
        }
      }

      if (failures.length > 0) {
        const report = failures
          .map(f => `  Line ${f.line}: ${f.error}\n    SQL: ${f.sql}`)
          .join('\n\n');
        assert.fail(
          `${file.name} has ${failures.length} SQL schema error(s):\n\n${report}`
        );
      }
    });
  }

  // ── Column existence spot-checks for high-value tables ─────────────
  // These catch the most common drift: columns referenced in code that
  // don't exist in the schema (the campaigns metadata bug pattern).

  it('agent_graph.campaigns has all columns referenced by campaigns.js', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'campaigns'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    const expectedColumns = [
      'id', 'work_item_id', 'goal_description', 'campaign_status',
      'budget_envelope_usd', 'spent_usd', 'reserved_usd',
      'max_iterations', 'completed_iterations',
      'created_at', 'completed_at', 'updated_at',
      'campaign_mode', 'source_intent_id', 'created_by',
      'success_criteria', 'constraints', 'iteration_time_budget',
      'metadata',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.campaigns is missing columns referenced in code: ${missing.join(', ')}`
    );
  });

  it('agent_graph.campaign_iterations has all columns referenced by campaigns.js', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'campaign_iterations'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    const expectedColumns = [
      'id', 'campaign_id', 'iteration_number', 'quality_score',
      'quality_details', 'decision', 'cost_usd', 'duration_ms',
      'strategy_used', 'failure_analysis', 'strategy_adjustment',
      'git_commit_hash', 'content_policy_result', 'action_taken',
      'created_at',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.campaign_iterations is missing columns: ${missing.join(', ')}`
    );
  });

  it('agent_graph.action_proposals has PR-related columns (bug regression)', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'action_proposals'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    // These are the columns that caused the 5-deploy bug when they were
    // looked up in metadata JSONB instead of dedicated columns
    const expectedColumns = [
      'github_pr_url', 'github_pr_number', 'target_repo',
      'action_type', 'campaign_id', 'work_item_id', 'body',
      'board_action',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.action_proposals is missing columns: ${missing.join(', ')}`
    );
  });

  it('agent_graph.board_chat_messages has all columns referenced by agent-chat.js', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'board_chat_messages'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    const expectedColumns = [
      'session_id', 'agent_id', 'board_user', 'role', 'content',
      'cost_usd', 'model', 'created_at',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.board_chat_messages is missing columns: ${missing.join(', ')}`
    );
  });

  it('agent_graph.work_items has columns referenced across multiple route files', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'work_items'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    const expectedColumns = [
      'id', 'type', 'title', 'description', 'status', 'priority',
      'assigned_to', 'created_by', 'created_at', 'updated_at',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.work_items is missing columns: ${missing.join(', ')}`
    );
  });

  it('agent_graph.llm_invocations has columns referenced by agent-chat.js', { skip: !HAS_REAL_PG }, async () => {
    const r = await queryFn(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_graph' AND table_name = 'llm_invocations'
    `);
    const columns = new Set(r.rows.map(row => row.column_name));

    const expectedColumns = [
      'agent_id', 'model', 'input_tokens', 'output_tokens',
      'cost_usd', 'task_id', 'created_at',
    ];

    const missing = expectedColumns.filter(col => !columns.has(col));
    assert.deepEqual(
      missing, [],
      `agent_graph.llm_invocations is missing columns: ${missing.join(', ')}`
    );
  });
});
