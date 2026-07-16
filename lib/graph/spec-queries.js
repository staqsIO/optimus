// graph/spec-queries.js — Spec graph queries for impact analysis, agent awareness, cross-refs.
// P2: All data from these queries is advisory only — never use for enforcement decisions.
import { runCypher, isGraphAvailable } from './client.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/spec-queries');

/**
 * Impact analysis: what's affected if a spec section changes?
 * Returns referenced/referencing sections, linked agents, gates, principles, tables.
 *
 * @param {string} sectionId - Spec section ID (e.g., "3", "5")
 * @returns {Promise<Object|null>} Impact data or null if unavailable
 */
export async function getSpecImpact(sectionId) {
  if (!isGraphAvailable()) return null;
  try {
    // Outgoing references (this section references...)
    const outRefs = await runCypher(
      `MATCH (s:SpecSection {id: $id})-[r:REFERENCES]->(t:SpecSection)
       RETURN t.id as id, t.heading as heading, r.context as context`,
      { id: sectionId },
      { readOnly: true }
    );

    // Incoming references (...references this section)
    const inRefs = await runCypher(
      `MATCH (s:SpecSection)-[r:REFERENCES]->(t:SpecSection {id: $id})
       RETURN s.id as id, s.heading as heading, r.context as context`,
      { id: sectionId },
      { readOnly: true }
    );

    // Agents defined in this section
    const agents = await runCypher(
      `MATCH (a:Agent)-[:SPEC_DEFINED_IN]->(s:SpecSection {id: $id})
       RETURN a.id as id, a.tier as tier`,
      { id: sectionId },
      { readOnly: true }
    );

    // Gates defined or linked via this section
    const gates = await runCypher(
      `MATCH (s:SpecSection {id: $id})-[:DEFINES_GATE]->(g:ConstitutionalGate)
       RETURN g.id as id, g.name as name`,
      { id: sectionId },
      { readOnly: true }
    );

    // Principles defined in this section
    const principles = await runCypher(
      `MATCH (s:SpecSection {id: $id})-[:DEFINES_PRINCIPLE]->(p:DesignPrinciple)
       RETURN p.id as id, p.name as name`,
      { id: sectionId },
      { readOnly: true }
    );

    // Tables defined in this section
    const tables = await runCypher(
      `MATCH (s:SpecSection {id: $id})-[:DEFINES_TABLE]->(t:DbTable)
       RETURN t.name as name, t.schema_name as schema`,
      { id: sectionId },
      { readOnly: true }
    );

    return {
      sectionId,
      referencesOut: outRefs?.map(r => r.toObject()) || [],
      referencesIn: inRefs?.map(r => r.toObject()) || [],
      agents: agents?.map(r => r.toObject()) || [],
      gates: gates?.map(r => r.toObject()) || [],
      principles: principles?.map(r => r.toObject()) || [],
      tables: tables?.map(r => r.toObject()) || [],
    };
  } catch (err) {
    log.warn('getSpecImpact error:', err.message);
    return null;
  }
}

/**
 * Agent spec context: what spec sections, gates, and principles govern this agent?
 * Used for prompt injection (Phase B).
 *
 * @param {string} agentId - Agent ID (e.g., "orchestrator")
 * @returns {Promise<Object|null>} Spec context or null if unavailable
 */
export async function getAgentSpecContext(agentId) {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (a:Agent {id: $agentId})
       OPTIONAL MATCH (a)-[:GOVERNED_BY]->(g:ConstitutionalGate)
       OPTIONAL MATCH (g)-[:ENFORCES_PRINCIPLE]->(p:DesignPrinciple)
       OPTIONAL MATCH (a)-[:SPEC_DEFINED_IN]->(s:SpecSection)
       OPTIONAL MATCH (g)<-[:DEFINES_GATE]-(gs:SpecSection)
       RETURN a.id as agentId,
              collect(DISTINCT {id: g.id, name: g.name, section: gs.id}) as gates,
              collect(DISTINCT {id: p.id, name: p.name}) as principles,
              collect(DISTINCT {id: s.id, heading: s.heading}) as sections`,
      { agentId },
      { readOnly: true }
    );

    if (!records || records.length === 0) return null;
    const row = records[0].toObject();

    // Filter out null entries from OPTIONAL MATCH
    row.gates = row.gates.filter(g => g.id != null);
    row.principles = row.principles.filter(p => p.id != null);
    row.sections = row.sections.filter(s => s.id != null);

    return row;
  } catch (err) {
    log.warn('getAgentSpecContext error:', err.message);
    return null;
  }
}

/**
 * Format spec context into compact prompt text.
 * Tier caps: haiku=200, sonnet=400, opus=800 chars.
 *
 * @param {Object|null} specCtx - From getAgentSpecContext()
 * @param {string} agentTier - Agent tier: 'haiku', 'sonnet', 'opus' or model string
 * @returns {string|null} Formatted prompt section or null
 */
export function formatSpecContext(specCtx, agentTier) {
  if (!specCtx) return null;
  if (!specCtx.gates.length && !specCtx.principles.length && !specCtx.sections.length) return null;

  const parts = [];

  if (specCtx.gates.length > 0) {
    const gateStr = specCtx.gates
      .map(g => `${g.id} (${g.name}${g.section ? ', §' + g.section : ''})`)
      .join(', ');
    parts.push(`Gates: ${gateStr}.`);
  }

  if (specCtx.principles.length > 0) {
    const princStr = specCtx.principles
      .map(p => `${p.id} (${p.name})`)
      .join(', ');
    parts.push(`Principles: ${princStr}.`);
  }

  if (specCtx.sections.length > 0) {
    const secStr = specCtx.sections
      .map(s => `§${s.id} ${s.heading}`)
      .join(', ');
    parts.push(`Defined in: ${secStr}.`);
  }

  if (parts.length === 0) return null;

  // Determine tier cap
  const tierCaps = { haiku: 200, sonnet: 400, opus: 800 };
  let tier = agentTier;
  // Normalize model strings to tier names
  if (typeof tier === 'string') {
    if (tier.includes('haiku')) tier = 'haiku';
    else if (tier.includes('sonnet')) tier = 'sonnet';
    else if (tier.includes('opus')) tier = 'opus';
  }
  const cap = tierCaps[tier] || 400;

  const full = `## Spec Alignment\n${parts.join('\n')}`;
  if (full.length <= cap) return full;

  // Truncate at newline boundary
  const cutPoint = full.lastIndexOf('\n', cap - 3);
  return (cutPoint > 0 ? full.slice(0, cutPoint) : full.slice(0, cap - 3)) + '...';
}

/**
 * Cross-references for a spec section: incoming and outgoing §N links.
 * Dashboard renders these as clickable navigation.
 *
 * @param {string} sectionId - Spec section ID
 * @returns {Promise<Object|null>} Cross-ref data or null if unavailable
 */
export async function getSpecCrossRefs(sectionId) {
  if (!isGraphAvailable()) return null;
  try {
    const outgoing = await runCypher(
      `MATCH (s:SpecSection {id: $id})-[r:REFERENCES]->(t:SpecSection)
       RETURN t.id as id, t.heading as heading, t.domain as domain, r.context as context`,
      { id: sectionId },
      { readOnly: true }
    );

    const incoming = await runCypher(
      `MATCH (s:SpecSection)-[r:REFERENCES]->(t:SpecSection {id: $id})
       RETURN s.id as id, s.heading as heading, s.domain as domain, r.context as context`,
      { id: sectionId },
      { readOnly: true }
    );

    return {
      sectionId,
      outgoing: outgoing?.map(r => r.toObject()) || [],
      incoming: incoming?.map(r => r.toObject()) || [],
    };
  } catch (err) {
    log.warn('getSpecCrossRefs error:', err.message);
    return null;
  }
}

/**
 * Implementation status: per-section count of linked artifacts.
 * Dashboard shows coverage as green/yellow/gray badges.
 *
 * @returns {Promise<Array|null>} Section status array or null if unavailable
 */
export async function getSpecImplementationStatus() {
  if (!isGraphAvailable()) return null;
  try {
    const records = await runCypher(
      `MATCH (s:SpecSection)
       OPTIONAL MATCH (a:Agent)-[:SPEC_DEFINED_IN]->(s)
       OPTIONAL MATCH (s)-[:DEFINES_GATE]->(g:ConstitutionalGate)
       OPTIONAL MATCH (s)-[:DEFINES_TABLE]->(t:DbTable)
       OPTIONAL MATCH (s)-[:DEFINES_PRINCIPLE]->(p:DesignPrinciple)
       RETURN s.id as id, s.heading as heading, s.domain as domain,
              s.status as status, s.phase as phase,
              count(DISTINCT a) as agentCount,
              count(DISTINCT g) as gateCount,
              count(DISTINCT t) as tableCount,
              count(DISTINCT p) as principleCount,
              count(DISTINCT a) + count(DISTINCT g) + count(DISTINCT t) + count(DISTINCT p) as totalArtifacts
       ORDER BY toInteger(s.id)`,
      {},
      { readOnly: true }
    );
    return records?.map(r => r.toObject()) || [];
  } catch (err) {
    log.warn('getSpecImplementationStatus error:', err.message);
    return null;
  }
}
