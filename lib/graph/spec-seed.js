// graph/spec-seed.js — Seed spec structure into Neo4j knowledge graph.
// Parses _index.yaml, spec markdown files, and curated mappings.
// All operations use MERGE (idempotent). Full reseed <1s for ~76 nodes.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runCypher, runCypherCreate, isGraphAvailable } from './client.js';
import { createLogger } from '../logger.js';
import { getConfigPath } from '../config/loader.js';
const log = createLogger('graph/spec-seed');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = join(__dirname, '../../spec/spec');
const MAPPINGS_PATH = getConfigPath('spec-mappings.yaml');
const AGENTS_PATH = getConfigPath('agents.json');

/**
 * Parse _index.yaml manually. It's simple key-value + list-of-objects —
 * no js-yaml dependency needed (P4: boring infrastructure).
 */
function parseIndexYaml(text) {
  const sections = [];
  let inSections = false;
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('sections:')) { inSections = true; continue; }
    if (!inSections) continue;

    const itemMatch = line.match(/^\s+-\s+id:\s*"(.+)"/);
    if (itemMatch) {
      if (current) sections.push(current);
      current = { id: itemMatch[1] };
      continue;
    }
    if (!current) continue;

    const kvMatch = line.match(/^\s+(\w+):\s*"?([^"]+)"?\s*$/);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      if (key === 'phase') current[key] = parseInt(val, 10);
      else current[key] = val;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Parse spec-mappings.yaml (simple nested key: [values] structure).
 */
function parseMappingsYaml(text) {
  const result = {};
  let currentBlock = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('#') || line.trim() === '') continue;

    // Top-level block (no indentation, ends with ':')
    const blockMatch = line.match(/^(\w+):\s*$/);
    if (blockMatch) {
      currentBlock = blockMatch[1];
      result[currentBlock] = {};
      continue;
    }
    if (!currentBlock) continue;

    // Entry: key: ["val1", "val2"] or key: [val1, val2]
    const entryMatch = line.match(/^\s+"?([^":\s]+)"?\s*:\s*\[(.+)\]\s*$/);
    if (entryMatch) {
      const [, key, valStr] = entryMatch;
      result[currentBlock][key] = valStr
        .split(',')
        .map(v => v.trim().replace(/^["']|["']$/g, ''));
    }
  }
  return result;
}

/**
 * Extract section heading from first markdown heading in a spec file.
 */
function extractHeading(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^#+\s*\d*\.?\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extract §N cross-references from a spec markdown file.
 * Returns array of { target, context } where context is ~100 chars around the match.
 */
function extractCrossRefs(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const refs = [];
    const seen = new Set();
    const regex = /§(\d+(?:\.\d+)?[a-z]?)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const target = match[1].replace(/\.\d+[a-z]?$/, ''); // normalize §5.2a → 5
      if (seen.has(target)) continue;
      seen.add(target);
      // Extract context snippet (~100 chars centered on match)
      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + 50);
      const context = content.slice(start, end).replace(/\n/g, ' ').trim();
      refs.push({ target, context });
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Extract P1-P6 design principles from 00-design-principles.md.
 */
function extractPrinciples(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const principles = [];
    const regex = /\*\*P(\d)[\.:]\s*(.+?)\.\*\*/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      principles.push({ id: `P${match[1]}`, name: match[2].trim() });
    }
    return principles;
  } catch {
    return [];
  }
}

/**
 * Extract G1-G8 constitutional gates from CLAUDE.md gate table + spec.
 * We use the known gate names since the spec format varies.
 */
function getGates() {
  return [
    { id: 'G1', name: 'Financial' },
    { id: 'G2', name: 'Legal' },
    { id: 'G3', name: 'Reputational' },
    { id: 'G4', name: 'Autonomy' },
    { id: 'G5', name: 'Reversibility' },
    { id: 'G6', name: 'Stakeholder' },
    { id: 'G7', name: 'Precedent' },
    { id: 'G8', name: 'Factual Accuracy' },
  ];
}

/**
 * Seed the entire spec graph. Idempotent (all MERGE).
 * Call on startup after seedGraph() and on manual reseed.
 */
export async function seedSpecGraph() {
  if (!isGraphAvailable()) return;

  const start = performance.now();

  // 1. Parse _index.yaml → SpecSection nodes
  const indexText = readFileSync(join(SPEC_DIR, '_index.yaml'), 'utf-8');
  const sections = parseIndexYaml(indexText);

  for (const s of sections) {
    const heading = extractHeading(join(SPEC_DIR, s.file)) || s.file.replace(/\.md$/, '');
    await runCypherCreate(
      `MERGE (s:SpecSection {id: $id})
       ON CREATE SET s.origin_org = $origin_org
       SET s.heading = $heading, s.domain = $domain, s.status = $status,
           s.phase = $phase, s.file = $file`,
      { id: s.id, heading, domain: s.domain, status: s.status, phase: s.phase, file: s.file }
    );
  }

  // 2. Cross-references: §N → §M REFERENCES edges
  let refCount = 0;
  for (const s of sections) {
    const refs = extractCrossRefs(join(SPEC_DIR, s.file));
    // Filter out self-references
    const externalRefs = refs.filter(r => r.target !== s.id);
    for (const ref of externalRefs) {
      await runCypher(
        `MATCH (from:SpecSection {id: $fromId})
         MATCH (to:SpecSection {id: $toId})
         MERGE (from)-[r:REFERENCES]->(to)
         SET r.context = $context`,
        { fromId: s.id, toId: ref.target, context: ref.context }
      );
      refCount++;
    }
  }

  // 3. Design Principles from 00-design-principles.md
  const principles = extractPrinciples(join(SPEC_DIR, '00-design-principles.md'));
  for (const p of principles) {
    await runCypherCreate(
      `MERGE (p:DesignPrinciple {id: $id})
       ON CREATE SET p.origin_org = $origin_org
       SET p.name = $name`,
      { id: p.id, name: p.name }
    );
    // DEFINES_PRINCIPLE: §0 → P*
    await runCypher(
      `MATCH (s:SpecSection {id: "0"})
       MATCH (p:DesignPrinciple {id: $pid})
       MERGE (s)-[:DEFINES_PRINCIPLE]->(p)`,
      { pid: p.id }
    );
  }

  // 4. Constitutional Gates
  const gates = getGates();
  for (const g of gates) {
    await runCypherCreate(
      `MERGE (g:ConstitutionalGate {id: $id})
       ON CREATE SET g.origin_org = $origin_org
       SET g.name = $name`,
      { id: g.id, name: g.name }
    );
    // DEFINES_GATE: §5 → G*
    await runCypher(
      `MATCH (s:SpecSection {id: "5"})
       MATCH (g:ConstitutionalGate {id: $gid})
       MERGE (s)-[:DEFINES_GATE]->(g)`,
      { gid: g.id }
    );
  }

  // 5. Load curated mappings
  const mappingsText = readFileSync(MAPPINGS_PATH, 'utf-8');
  const mappings = parseMappingsYaml(mappingsText);

  // SPEC_DEFINED_IN: Agent → SpecSection
  if (mappings.agent_sections) {
    for (const [agentId, sectionIds] of Object.entries(mappings.agent_sections)) {
      for (const sectionId of sectionIds) {
        await runCypher(
          `MATCH (a:Agent {id: $agentId})
           MATCH (s:SpecSection {id: $sectionId})
           MERGE (a)-[:SPEC_DEFINED_IN]->(s)`,
          { agentId, sectionId }
        );
      }
    }
  }

  // ENFORCES_PRINCIPLE: ConstitutionalGate → DesignPrinciple
  if (mappings.gate_principles) {
    for (const [gateId, principleIds] of Object.entries(mappings.gate_principles)) {
      for (const pid of principleIds) {
        await runCypher(
          `MATCH (g:ConstitutionalGate {id: $gateId})
           MATCH (p:DesignPrinciple {id: $pid})
           MERGE (g)-[:ENFORCES_PRINCIPLE]->(p)`,
          { gateId, pid }
        );
      }
    }
  }

  // DEFINES_TABLE: SpecSection → DbTable
  if (mappings.section_tables) {
    for (const [sectionId, tableNames] of Object.entries(mappings.section_tables)) {
      for (const tableName of tableNames) {
        // Infer schema from table name patterns
        let schemaName = 'agent_graph';
        if (['action_proposals'].includes(tableName)) schemaName = 'agent_graph';
        else if (tableName.startsWith('kill_')) schemaName = 'agent_graph';

        await runCypherCreate(
          `MERGE (t:DbTable {name: $tableName})
           ON CREATE SET t.origin_org = $origin_org
           SET t.schema_name = $schemaName`,
          { tableName, schemaName }
        );
        await runCypher(
          `MATCH (s:SpecSection {id: $sectionId})
           MATCH (t:DbTable {name: $tableName})
           MERGE (s)-[:DEFINES_TABLE]->(t)`,
          { sectionId, tableName }
        );
      }
    }
  }

  // 6. GOVERNED_BY edges from agents.json guardrails arrays
  try {
    const agentsConfig = JSON.parse(readFileSync(AGENTS_PATH, 'utf-8'));
    for (const [agentId, config] of Object.entries(agentsConfig.agents)) {
      if (!config.guardrails) continue;
      for (const gateId of config.guardrails) {
        await runCypher(
          `MATCH (a:Agent {id: $agentId})
           MATCH (g:ConstitutionalGate {id: $gateId})
           MERGE (a)-[:GOVERNED_BY]->(g)`,
          { agentId, gateId }
        );
      }
    }
  } catch (err) {
    log.warn('Could not load agents.json for GOVERNED_BY edges:', err.message);
  }

  const durationMs = Math.round(performance.now() - start);
  const nodeCount = sections.length + principles.length + gates.length;
  log.info(`Seeded: ${sections.length} sections, ${principles.length} principles, ${gates.length} gates, ${refCount} cross-refs (${durationMs}ms)`);
}
