// graph/schema.js — Initial graph constraints and indexes
import { runCypher, getOriginOrg, isGraphAvailable } from './client.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/schema');

// Canonical entity-type registry (STAQPRO-579). `lib/graph/schema.js` is the
// documented owner/entry point for these names — the labels declared as UNIQUE
// constraints below and MERGE'd by `lib/graph/sync.js`. The definitions live in
// the dependency-free `./entity-types.js` so subsystems (e.g. `lib/engagements/`)
// can consume the registry without pulling in the Neo4j driver chain. Import
// from here OR from `./entity-types.js`; both resolve to the same frozen map.
// See `lib/graph/OWNERSHIP.md` for the ownership rationale.
export { ENTITY_TYPES, ENTITY_TYPE_VALUES, isEntityType } from './entity-types.js';

export async function ensureSchema() {
  if (!isGraphAvailable()) return;

  const constraints = [
    'CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
    'CREATE CONSTRAINT capability_name IF NOT EXISTS FOR (c:Capability) REQUIRE c.name IS UNIQUE',
    'CREATE CONSTRAINT task_outcome_id IF NOT EXISTS FOR (t:TaskOutcome) REQUIRE t.id IS UNIQUE',
    'CREATE CONSTRAINT pattern_id IF NOT EXISTS FOR (p:Pattern) REQUIRE p.id IS UNIQUE',
    'CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (d:Decision) REQUIRE d.id IS UNIQUE',
    // Spec graph constraints
    'CREATE CONSTRAINT spec_section_id IF NOT EXISTS FOR (s:SpecSection) REQUIRE s.id IS UNIQUE',
    'CREATE CONSTRAINT design_principle_id IF NOT EXISTS FOR (p:DesignPrinciple) REQUIRE p.id IS UNIQUE',
    'CREATE CONSTRAINT constitutional_gate_id IF NOT EXISTS FOR (g:ConstitutionalGate) REQUIRE g.id IS UNIQUE',
    'CREATE CONSTRAINT db_table_name IF NOT EXISTS FOR (t:DbTable) REQUIRE t.name IS UNIQUE',
    // CRM graph constraints (Phase 2 of contacts upgrade — see ADR-026)
    'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE',
    'CREATE CONSTRAINT identity_key IF NOT EXISTS FOR (i:Identity) REQUIRE i.key IS UNIQUE',
    'CREATE CONSTRAINT organization_id IF NOT EXISTS FOR (o:Organization) REQUIRE o.id IS UNIQUE',
    'CREATE CONSTRAINT project_locator IF NOT EXISTS FOR (p:Project) REQUIRE p.locator IS UNIQUE',
    // Meeting graph node (Plan 041) — id is the stable source_meeting_id merge key
    'CREATE CONSTRAINT meeting_id IF NOT EXISTS FOR (m:Meeting) REQUIRE m.id IS UNIQUE',
  ];

  const indexes = [
    'CREATE INDEX task_outcome_created IF NOT EXISTS FOR (t:TaskOutcome) ON (t.created_at)',
    'CREATE INDEX pattern_domain IF NOT EXISTS FOR (p:Pattern) ON (p.domain)',
    'CREATE INDEX decision_type IF NOT EXISTS FOR (d:Decision) ON (d.type)',
    // Spec graph indexes
    'CREATE INDEX spec_section_domain IF NOT EXISTS FOR (s:SpecSection) ON (s.domain)',
    'CREATE INDEX spec_section_phase IF NOT EXISTS FOR (s:SpecSection) ON (s.phase)',
    // CRM graph indexes
    'CREATE INDEX person_name IF NOT EXISTS FOR (p:Person) ON (p.name)',
    'CREATE INDEX organization_slug IF NOT EXISTS FOR (o:Organization) ON (o.slug)',
    'CREATE INDEX identity_channel IF NOT EXISTS FOR (i:Identity) ON (i.channel)',
    // STAQPRO-359: per-label origin_org indexes. SINGLE SOURCE OF TRUTH —
    // client.js's ensureIndexes() used to create a parallel set named
    // origin_org_<label>_idx (711b297); that loop was removed and its labels
    // folded in here so prod no longer carries two indexes per label. Every
    // node label we write gets a real index so federation read paths can
    // filter `WHERE n.origin_org = $org` against an index instead of a full
    // scan. Neo4j 4.x has no label-less node index, so each Label is
    // enumerated. New labels: add one entry here (and nowhere else).
    'CREATE INDEX origin_org_agent IF NOT EXISTS FOR (n:Agent) ON (n.origin_org)',
    'CREATE INDEX origin_org_capability IF NOT EXISTS FOR (n:Capability) ON (n.origin_org)',
    'CREATE INDEX origin_org_person IF NOT EXISTS FOR (n:Person) ON (n.origin_org)',
    'CREATE INDEX origin_org_organization IF NOT EXISTS FOR (n:Organization) ON (n.origin_org)',
    'CREATE INDEX origin_org_project IF NOT EXISTS FOR (n:Project) ON (n.origin_org)',
    'CREATE INDEX origin_org_identity IF NOT EXISTS FOR (n:Identity) ON (n.origin_org)',
    'CREATE INDEX origin_org_taskoutcome IF NOT EXISTS FOR (n:TaskOutcome) ON (n.origin_org)',
    'CREATE INDEX origin_org_decision IF NOT EXISTS FOR (n:Decision) ON (n.origin_org)',
    'CREATE INDEX origin_org_campaign IF NOT EXISTS FOR (n:Campaign) ON (n.origin_org)',
    'CREATE INDEX origin_org_strategy IF NOT EXISTS FOR (n:Strategy) ON (n.origin_org)',
    'CREATE INDEX origin_org_iteration IF NOT EXISTS FOR (n:Iteration) ON (n.origin_org)',
    'CREATE INDEX origin_org_specsection IF NOT EXISTS FOR (n:SpecSection) ON (n.origin_org)',
    'CREATE INDEX origin_org_designprinciple IF NOT EXISTS FOR (n:DesignPrinciple) ON (n.origin_org)',
    'CREATE INDEX origin_org_constitutionalgate IF NOT EXISTS FOR (n:ConstitutionalGate) ON (n.origin_org)',
    'CREATE INDEX origin_org_dbtable IF NOT EXISTS FOR (n:DbTable) ON (n.origin_org)',
    'CREATE INDEX origin_org_governancesubmission IF NOT EXISTS FOR (n:GovernanceSubmission) ON (n.origin_org)',
    'CREATE INDEX origin_org_auditevent IF NOT EXISTS FOR (n:AuditEvent) ON (n.origin_org)',
    'CREATE INDEX origin_org_workitem IF NOT EXISTS FOR (n:WorkItem) ON (n.origin_org)',
    'CREATE INDEX origin_org_adr IF NOT EXISTS FOR (n:ADR) ON (n.origin_org)',
    'CREATE INDEX origin_org_specdomain IF NOT EXISTS FOR (n:SpecDomain) ON (n.origin_org)',
    'CREATE INDEX origin_org_domain IF NOT EXISTS FOR (n:Domain) ON (n.origin_org)',
    'CREATE INDEX origin_org_explorationcycle IF NOT EXISTS FOR (n:ExplorationCycle) ON (n.origin_org)',
    'CREATE INDEX origin_org_finding IF NOT EXISTS FOR (n:Finding) ON (n.origin_org)',
    'CREATE INDEX origin_org_goaltype IF NOT EXISTS FOR (n:GoalType) ON (n.origin_org)',
    // Folded in from client.js's removed loop (STAQPRO-359 cleanup) — labels
    // that loop covered which weren't already enumerated above.
    'CREATE INDEX origin_org_topic IF NOT EXISTS FOR (n:Topic) ON (n.origin_org)',
    'CREATE INDEX origin_org_tool IF NOT EXISTS FOR (n:Tool) ON (n.origin_org)',
    'CREATE INDEX origin_org_concept IF NOT EXISTS FOR (n:Concept) ON (n.origin_org)',
    'CREATE INDEX origin_org_pattern IF NOT EXISTS FOR (n:Pattern) ON (n.origin_org)',
    'CREATE INDEX origin_org_insight IF NOT EXISTS FOR (n:Insight) ON (n.origin_org)',
    'CREATE INDEX origin_org_spec IF NOT EXISTS FOR (n:Spec) ON (n.origin_org)',
    'CREATE INDEX origin_org_skill IF NOT EXISTS FOR (n:Skill) ON (n.origin_org)',
    'CREATE INDEX origin_org_email IF NOT EXISTS FOR (n:Email) ON (n.origin_org)',
    'CREATE INDEX origin_org_meeting IF NOT EXISTS FOR (n:Meeting) ON (n.origin_org)',
    'CREATE INDEX origin_org_document IF NOT EXISTS FOR (n:Document) ON (n.origin_org)',
  ];

  for (const stmt of [...constraints, ...indexes]) {
    await runCypher(stmt);
  }

  log.info('Schema constraints and indexes ensured');

  // STAQPRO-359 cleanup: drop the legacy origin_org_<label>_idx indexes
  // client.js's removed ensureIndexes() loop used to create. The replacement
  // origin_org_<label> indexes above already ran in this same startup pass,
  // so there is no window without an index. Idempotent — DROP ... IF EXISTS
  // is a no-op once the duplicates are gone.
  const legacyOriginOrgIndexes = [
    'person', 'organization', 'project', 'topic', 'decision', 'tool',
    'concept', 'agent', 'pattern', 'insight', 'spec', 'skill', 'email',
    'meeting', 'document',
  ].map(l => `origin_org_${l}_idx`);
  for (const name of legacyOriginOrgIndexes) {
    await runCypher(`DROP INDEX ${name} IF EXISTS`);
  }
  log.info(`Legacy origin_org_<label>_idx indexes dropped (STAQPRO-359 cleanup)`);

  await backfillOriginOrg();
}

/**
 * STAQPRO-359 (board decision 2026-05-16): backfill legacy Neo4j nodes that
 * pre-date the federation primitive with the current org's identifier.
 *
 * Idempotent — after first run the predicate matches 0 nodes and this is a
 * no-op on subsequent startups. Single transaction (Optimus's Neo4j is
 * small enough not to need batching). Logs the tagged count once when
 * non-zero so deploys can confirm the backfill ran.
 *
 * Value semantics: uses the current `ORG_DID` (default `"self"`) so legacy
 * nodes are treated as belonging to this org. For Staqs Pro before
 * ORG_DID is set this is `"self"`, matching the new-node default. For
 * named orgs (e.g. ORG_DID=did:web:staqs.io) legacy nodes inherit that
 * identity — federation read paths can then use a uniform
 * `WHERE n.origin_org = $org` filter without a special case for null.
 */
async function backfillOriginOrg() {
  const orgDid = getOriginOrg();
  const records = await runCypher(
    `MATCH (n)
     WHERE n.origin_org IS NULL
     SET n.origin_org = $orgDid
     RETURN count(n) AS tagged`,
    { orgDid }
  );
  const tagged = records?.[0]?.get?.('tagged')?.toInt?.() ?? 0;
  if (tagged > 0) {
    log.info(`[STAQPRO-359] backfilled ${tagged} legacy nodes with origin_org="${orgDid}"`);
  }
}
