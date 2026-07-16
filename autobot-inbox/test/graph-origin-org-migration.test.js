import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * STAQPRO-359: regression guard for the origin_org migration on Neo4j writes.
 *
 * After 460fe4b (STAQPRO-356), lib/graph/client.js emits a runtime warning
 * for any CREATE / MERGE statement that lacks origin_org tagging. This test
 * pins the post-migration state of the 5 enricher files: every
 * `runCypher(` call with a node-create pattern must reference $origin_org
 * (either directly in CREATE props or via ON CREATE SET).
 *
 * Files that DO write nodes but use the new helper (runCypherCreate) are
 * exempt — that helper auto-injects the param so the Cypher author just
 * has to reference $origin_org. The detector below counts violations of
 * EITHER form: any runCypher(...) with a CREATE/MERGE node pattern whose
 * Cypher body doesn't mention origin_org.
 */
describe('STAQPRO-359 — origin_org migration regression guard', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(__dirname, '..', '..');

  const MIGRATED_FILES = [
    'lib/graph/sync.js',
    'lib/graph/claw-learning.js',
    'lib/graph/governance-sync.js',
    'lib/graph/seed.js',
    'lib/graph/spec-seed.js',
  ];

  // Match the regex used in client.js#runCypher for node-create detection,
  // ignoring DDL (CREATE INDEX / CONSTRAINT) which is schema-level.
  const NODE_CREATE_OR_MERGE = /(?:CREATE|MERGE)\s+\([a-z_][\w]*\s*:/i;
  const DDL_CREATE = /CREATE\s+(?:FULLTEXT|VECTOR|RANGE|TEXT|POINT|LOOKUP)?\s*(?:INDEX|CONSTRAINT)\b/i;

  /**
   * Walk a JS file's source, find every `await runCypher(` or
   * `await runCypherCreate(` call. For each call, extract its first arg
   * (the Cypher string) and return { kind, body, line }.
   */
  function findCypherCalls(source) {
    const lines = source.split('\n');
    const calls = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/\b(runCypher|runCypherCreate)\s*\(/);
      if (!m) continue;
      // Cypher body usually starts on the next line as a template literal.
      // We collect everything until the matching backtick closes — bounded
      // search across the next 40 lines (the longest queries in these
      // files don't exceed that).
      let body = '';
      let inTemplate = false;
      let started = false;
      const end = Math.min(i + 40, lines.length);
      for (let j = i; j < end; j += 1) {
        const ln = lines[j];
        if (!started) {
          const tickIdx = ln.indexOf('`');
          if (tickIdx >= 0) {
            started = true;
            inTemplate = true;
            body += ln.slice(tickIdx + 1) + '\n';
            continue;
          }
        } else if (inTemplate) {
          const closeIdx = ln.indexOf('`');
          if (closeIdx >= 0) {
            body += ln.slice(0, closeIdx);
            break;
          }
          body += ln + '\n';
        }
      }
      calls.push({ kind: m[1], body, line: i + 1 });
    }
    return calls;
  }

  for (const relPath of MIGRATED_FILES) {
    it(`${relPath}: every node CREATE/MERGE references origin_org`, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
      const calls = findCypherCalls(source);
      const violations = [];
      for (const call of calls) {
        if (DDL_CREATE.test(call.body)) continue;
        if (!NODE_CREATE_OR_MERGE.test(call.body)) continue;
        if (call.body.includes('origin_org')) continue;
        violations.push(`  line ${call.line} (${call.kind}): ${call.body.slice(0, 120).replace(/\s+/g, ' ')}…`);
      }
      assert.equal(
        violations.length,
        0,
        `${relPath} has ${violations.length} un-migrated node CREATE/MERGE call(s):\n${violations.join('\n')}`,
      );
    });
  }

  it('client.js helpers are exported', async () => {
    const mod = await import('../../lib/graph/client.js');
    assert.equal(typeof mod.getOriginOrg, 'function');
    assert.equal(typeof mod.runCypherCreate, 'function');
    assert.equal(typeof mod.runCypher, 'function');
  });
});
