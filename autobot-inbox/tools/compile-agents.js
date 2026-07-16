#!/usr/bin/env node

/**
 * agents.md compiler — Phase A foundation (Issue #36)
 *
 * Compiles agent definition markdown files (YAML frontmatter + markdown body)
 * into validated JSON configuration objects.
 *
 * Usage:
 *   node tools/compile-agents.js                          # compile all agents/*.md
 *   node tools/compile-agents.js agents/orchestrator.md   # compile single agent
 *   node tools/compile-agents.js --validate               # validate only, no output
 *   node tools/compile-agents.js --diff                   # compile and diff against config/agents.json
 *
 * Design principles enforced:
 *   P1 — Deny by default (tools.forbidden always explicit)
 *   P2 — Infrastructure enforces (compiler validates, never emits partial output)
 *   P3 — Transparency by structure (source_hash + config_hash pair)
 *   P4 — Boring infrastructure (only built-in modules + js-yaml)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Utility: deterministic JSON
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys for deterministic serialization.
 * Arrays preserve order; only object keys are sorted.
 */
function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * Canonical JSON: sorted keys, no trailing whitespace, deterministic.
 */
function canonicalJSON(obj) {
  return JSON.stringify(sortKeys(obj), null, 2);
}

/**
 * SHA256 hex digest of a string.
 */
function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns { frontmatter: object, body: string }.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid format: missing YAML frontmatter delimiters (---). File must start with --- and have a closing ---.');
  }
  const frontmatter = yaml.load(match[1]);
  if (typeof frontmatter !== 'object' || frontmatter === null) {
    throw new Error('Invalid frontmatter: YAML must parse to an object');
  }
  const body = match[2].trim();
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Markdown body parser
// ---------------------------------------------------------------------------

/**
 * Extract structured sections from the markdown body.
 * Recognizes: ## Description, ## Anti-Patterns, ## Behavioral Boundaries
 */
function parseBody(body) {
  const result = { description: null, antiPatterns: [], behavioralBoundaries: null };
  if (!body) return result;

  const sections = {};
  let currentSection = null;
  let currentLines = [];

  for (const line of body.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) {
        sections[currentSection] = currentLines.join('\n').trim();
      }
      currentSection = headerMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentLines.join('\n').trim();
  }

  if (sections['description']) {
    result.description = sections['description'];
  }

  if (sections['anti-patterns']) {
    result.antiPatterns = sections['anti-patterns']
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(line => line.length > 0);
  }

  if (sections['behavioral-boundaries']) {
    result.behavioralBoundaries = sections['behavioral-boundaries'];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schema validation (lightweight, no external validator)
// ---------------------------------------------------------------------------

const SCHEMA = JSON.parse(readFileSync(join(PROJECT_ROOT, 'schemas', 'agent-config.schema.json'), 'utf8'));

function validateAgent(agent, filename) {
  const errors = [];

  // Required fields
  for (const field of SCHEMA.required) {
    if (agent[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // schema_version
  if (agent.schema_version !== '3.0') {
    errors.push(`schema_version must be "3.0", got "${agent.schema_version}"`);
  }

  // id format
  if (agent.id && !/^[a-z][a-z0-9-]*$/.test(agent.id)) {
    errors.push(`id must be kebab-case, got "${agent.id}"`);
  }

  // type enum
  const validTypes = ['orchestrator', 'strategist', 'executor', 'reviewer', 'architect', 'utility'];
  if (agent.type && !validTypes.includes(agent.type)) {
    errors.push(`type must be one of ${validTypes.join(', ')}, got "${agent.type}"`);
  }

  // tools: must have allowed and forbidden
  if (agent.tools) {
    if (typeof agent.tools !== 'object' || Array.isArray(agent.tools)) {
      errors.push('tools must be an object with "allowed" and "forbidden" arrays');
    } else {
      if (!Array.isArray(agent.tools.allowed)) {
        errors.push('tools.allowed must be an array (security-critical: P1 deny by default)');
      }
      if (!Array.isArray(agent.tools.forbidden)) {
        errors.push('tools.forbidden must be an explicit array, even if empty (security-critical: P1 deny by default)');
      }
    }
  }

  // guardrails: G1-G7
  if (agent.guardrails) {
    for (const g of agent.guardrails) {
      if (!/^G[1-7]$/.test(g)) {
        errors.push(`Invalid guardrail "${g}" — must match G1-G7`);
      }
    }
  }

  // hierarchy required fields
  if (agent.hierarchy) {
    for (const field of ['canDelegate', 'reportsTo', 'escalatesTo']) {
      if (agent.hierarchy[field] === undefined) {
        errors.push(`hierarchy.${field} is required`);
      }
    }
  }

  // config_hash and source_hash format
  for (const hashField of ['config_hash', 'source_hash']) {
    if (agent[hashField] && !/^[a-f0-9]{64}$/.test(agent[hashField])) {
      errors.push(`${hashField} must be a 64-character hex SHA256 hash`);
    }
  }

  // temperature range
  if (agent.temperature !== undefined && (agent.temperature < 0 || agent.temperature > 2)) {
    errors.push(`temperature must be between 0 and 2, got ${agent.temperature}`);
  }

  // maxTokens positive integer
  if (agent.maxTokens !== undefined && (!Number.isInteger(agent.maxTokens) || agent.maxTokens < 1)) {
    errors.push(`maxTokens must be a positive integer, got ${agent.maxTokens}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Compiler: .md → v3.0 config
// ---------------------------------------------------------------------------

function getCompilerVersion() {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * Compile a single agent .md file into a v3.0 config object.
 * NEVER emits partial output — errors abort with specific messages.
 */
function compileAgent(filePath) {
  const rawContent = readFileSync(filePath, 'utf8');
  const sourceHash = sha256(rawContent);
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const bodyParsed = parseBody(body);

  // Build the v3.0 object from frontmatter
  const agent = { ...frontmatter };

  // Ensure tools is in v3.0 format { allowed, forbidden }
  if (Array.isArray(agent.tools)) {
    agent.tools = { allowed: agent.tools, forbidden: [] };
  } else if (!agent.tools) {
    agent.tools = { allowed: [], forbidden: [] };
  }

  // Merge anti-patterns from body into outputConstraints if present
  if (bodyParsed.antiPatterns.length > 0) {
    if (!agent.outputConstraints) {
      agent.outputConstraints = {};
    }
    agent.outputConstraints.antiPatterns = bodyParsed.antiPatterns;
  }

  // Add computed fields
  agent.schema_version = '3.0';
  agent.compiler_version = getCompilerVersion();
  agent.source_hash = sourceHash;

  // Compute config_hash: hash the canonical JSON of the agent WITHOUT config_hash itself
  const { config_hash: _, ...agentWithoutHash } = agent;
  agent.config_hash = sha256(canonicalJSON(agentWithoutHash));

  // Validate
  const errors = validateAgent(agent, filePath);
  if (errors.length > 0) {
    throw new Error(
      `Validation failed for ${basename(filePath)}:\n` +
      errors.map(e => `  - ${e}`).join('\n')
    );
  }

  return agent;
}

// ---------------------------------------------------------------------------
// Compat format: convert v3.0 → agents.json shape for diff comparison
// ---------------------------------------------------------------------------

/**
 * Convert a v3.0 compiled agent back to the agents.json format.
 * Strips v3.0-only fields and converts tools back to flat array.
 */
function toCompatFormat(agent) {
  const compat = { ...agent };

  // Remove v3.0-only fields
  delete compat.schema_version;
  delete compat.config_hash;
  delete compat.source_hash;
  delete compat.compiler_version;

  // Convert tools back to flat array
  if (compat.tools && typeof compat.tools === 'object' && !Array.isArray(compat.tools)) {
    compat.tools = compat.tools.allowed;
  }

  return compat;
}

// ---------------------------------------------------------------------------
// Deep diff utility
// ---------------------------------------------------------------------------

function deepDiff(a, b, path = '') {
  const diffs = [];

  if (a === b) return diffs;
  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push({ path: path || '(root)', expected: a, actual: b });
    return diffs;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= a.length) {
        diffs.push({ path: `${path}[${i}]`, expected: undefined, actual: b[i] });
      } else if (i >= b.length) {
        diffs.push({ path: `${path}[${i}]`, expected: a[i], actual: undefined });
      } else {
        diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
      }
    }
    return diffs;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const newPath = path ? `${path}.${key}` : key;
      if (!(key in a)) {
        diffs.push({ path: newPath, expected: undefined, actual: b[key] });
      } else if (!(key in b)) {
        diffs.push({ path: newPath, expected: a[key], actual: undefined });
      } else {
        diffs.push(...deepDiff(a[key], b[key], newPath));
      }
    }
    return diffs;
  }

  if (a !== b) {
    diffs.push({ path: path || '(root)', expected: a, actual: b });
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function getAgentFiles() {
  const agentsDir = join(PROJECT_ROOT, 'agents');
  if (!existsSync(agentsDir)) {
    throw new Error(`Agents directory not found: ${agentsDir}`);
  }
  return readdirSync(agentsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => join(agentsDir, f));
}

function loadAgentsJson() {
  const path = join(PROJECT_ROOT, 'config', 'agents.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const validateOnly = args.includes('--validate');
  const diffMode = args.includes('--diff');
  const fileArgs = args.filter(a => !a.startsWith('--'));

  let files;
  if (fileArgs.length > 0) {
    files = fileArgs.map(f => resolve(PROJECT_ROOT, f));
    for (const f of files) {
      if (!existsSync(f)) {
        console.error(`ERROR: File not found: ${f}`);
        process.exit(1);
      }
    }
  } else {
    files = getAgentFiles();
  }

  if (files.length === 0) {
    console.error('ERROR: No agent .md files found in agents/ directory');
    process.exit(1);
  }

  const compiled = {};
  let hasErrors = false;

  for (const file of files) {
    const name = basename(file, '.md');
    try {
      const agent = compileAgent(file);
      compiled[agent.id] = agent;
      if (validateOnly) {
        console.log(`  PASS  ${name} (${agent.id})`);
      }
    } catch (err) {
      console.error(`  FAIL  ${name}: ${err.message}`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('\nCompilation failed. No output emitted.');
    process.exit(1);
  }

  if (validateOnly) {
    console.log(`\nAll ${files.length} agents passed validation.`);
    process.exit(0);
  }

  if (diffMode) {
    const agentsJson = loadAgentsJson();
    let totalDiffs = 0;

    for (const [id, agent] of Object.entries(compiled)) {
      const compat = toCompatFormat(agent);
      const reference = agentsJson.agents[id];

      if (!reference) {
        console.log(`\n${id}: NOT FOUND in agents.json`);
        totalDiffs++;
        continue;
      }

      const diffs = deepDiff(reference, compat);
      if (diffs.length > 0) {
        console.log(`\n${id}: ${diffs.length} difference(s)`);
        for (const d of diffs) {
          console.log(`  ${d.path}:`);
          console.log(`    agents.json: ${JSON.stringify(d.expected)}`);
          console.log(`    compiled:    ${JSON.stringify(d.actual)}`);
        }
        totalDiffs += diffs.length;
      } else {
        console.log(`  MATCH  ${id}`);
      }
    }

    // Check for agents in agents.json not covered by .md files
    for (const id of Object.keys(agentsJson.agents)) {
      if (!compiled[id]) {
        console.log(`\n${id}: EXISTS in agents.json but no .md file found`);
        totalDiffs++;
      }
    }

    if (totalDiffs === 0) {
      console.log(`\nAll ${Object.keys(compiled).length} agents match agents.json. Zero differences.`);
      process.exit(0);
    } else {
      console.log(`\n${totalDiffs} total difference(s) found.`);
      process.exit(1);
    }
  }

  // Default mode: compile and output
  const output = {};
  for (const [id, agent] of Object.entries(compiled)) {
    output[id] = agent;
  }
  const json = canonicalJSON(output);
  console.log(json);
}

main();
