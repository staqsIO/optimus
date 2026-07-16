// graph/seed.js — Populate graph from Postgres (agent_configs, tool_registry, etc.)
import { runCypher, runCypherCreate, isGraphAvailable } from './client.js';
import { query } from '../db.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/seed');

export async function seedGraph() {
  if (!isGraphAvailable()) return;

  // 1. Agent nodes from agent_configs
  const agents = await query('SELECT id, agent_type, model, is_active FROM agent_graph.agent_configs');
  for (const a of agents.rows) {
    await runCypherCreate(
      `MERGE (agent:Agent {id: $id})
       ON CREATE SET agent.origin_org = $origin_org
       SET agent.tier = $tier, agent.model = $model, agent.is_active = $isActive`,
      { id: a.id, tier: a.agent_type, model: a.model, isActive: a.is_active }
    );
  }

  // 2. Capability nodes from tool_registry
  const tools = await query('SELECT tool_name, description FROM agent_graph.tool_registry WHERE is_active = true');
  for (const t of tools.rows) {
    await runCypherCreate(
      `MERGE (c:Capability {name: $name})
       ON CREATE SET c.origin_org = $origin_org
       SET c.description = $desc, c.domain = 'tool'`,
      { name: t.tool_name, desc: t.description }
    );
  }

  // 3. HAS_CAPABILITY edges — link agents to their configured tools (not permission_grants).
  // P2: permission_grants are enforcement data and must stay in Postgres only (Linus review).
  // We link agents to tool capabilities by name for learning/visualization purposes.
  const agentTools = await query(
    `SELECT DISTINCT ac.id as agent_id, tr.tool_name
     FROM agent_graph.agent_configs ac
     JOIN agent_graph.permission_grants pg ON pg.agent_id = ac.id AND pg.resource_type = 'tool' AND pg.revoked_at IS NULL
     JOIN agent_graph.tool_registry tr ON tr.tool_name = pg.resource_name AND tr.is_active = true`
  );
  for (const at of agentTools.rows) {
    await runCypher(
      `MATCH (a:Agent {id: $agentId})
       MATCH (c:Capability {name: $toolName})
       MERGE (a)-[:HAS_CAPABILITY]->(c)`,
      { agentId: at.agent_id, toolName: at.tool_name }
    );
  }

  // 4. CAN_DELEGATE_TO edges from assignment_rules
  const rules = await query('SELECT agent_id, can_assign FROM agent_graph.agent_assignment_rules');
  for (const r of rules.rows) {
    await runCypher(
      `MATCH (from:Agent {id: $fromId})
       MATCH (to:Agent {id: $toId})
       MERGE (from)-[rel:CAN_DELEGATE_TO]->(to)
       SET rel.from_rules = true`,
      { fromId: r.agent_id, toId: r.can_assign }
    );
  }

  log.info(`Seeded: ${agents.rows.length} agents, ${tools.rows.length} tools, ${agentTools.rows.length} capabilities, ${rules.rows.length} delegation rules`);
}
