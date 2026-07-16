/**
 * Scopes the runner-side G8 Model Armor preflight (assertModelArmorProductionReady,
 * lib/runtime/governance/model-armor-preflight.js) to the runner-eligible agents
 * that actually ingest attacker-controllable external content into an LLM.
 * Extracted to its own side-effect-free module so the scoping predicate can be unit
 * tested without importing runner.js (which runs main() unconditionally at module
 * load).
 *
 * Background (GH #495): runner.js used to gate the preflight on
 * `agentNames.length > 0`, which parseArgs() in runner.js always satisfies (it
 * defaults to a non-empty agent list) — so the moment NODE_ENV=production was set on
 * the M1/CLI runner, the preflight would fire for EVERY runner agent, including ones
 * (executor-coder, campaigner, etc.) that never touch untrusted external content.
 * `agentNames.length > 0` is not a valid proxy for "does this run need G8"; this
 * module replaces it with an explicit allow-list of the agents that do.
 *
 * WHICH RUNNER AGENTS CONSUME UNTRUSTED CONTENT (the set below):
 *
 *   - issue-triage — fetches GitHub/Linear issue title + description (anyone can
 *     open an issue → attacker-controllable) in agents/issue-triage/issue-fetcher.js
 *     and interpolates that text STRAIGHT into an LLM prompt via callProvider() in
 *     agents/issue-triage/triage-evaluator.js (~L79-142).
 *
 *   - claw-workshop — fetches Linear issue comments (attacker-controllable) in
 *     agents/claw-workshop/workshop-runner.js (~L108-109), folds them into a prompt
 *     via buildReplyPrompt, then hands that prompt to runExecutor() with a tool
 *     allow-list that includes Bash(git *)/Bash(npm *)/Write/Edit/WebFetch/WebSearch
 *     (~L153-167) — untrusted text steering shell/file/network tools is the full
 *     Lethal Trifecta.
 *
 * WHY THE OTHER RUNNER AGENTS ARE NOT IN THE SET:
 *   executor-coder / executor-blueprint / executor-research / claw-campaigner /
 *   executor-writer / content-atomizer / executor-contract process structured,
 *   board-/agent-originated tasks, not raw attacker-controllable channel content.
 *   executor-redesign DOES take untrusted input (visitor_intent + scraped page HTML)
 *   but has its own independent, already-fail-closed inline gate
 *   (lib/runtime/redesign-safety.js: screenRedesignInput) that rejects at call time
 *   when Model Armor is unconfigured — it does not depend on this boot preflight.
 *
 * CRUCIAL — WHAT MEMBERSHIP IN THIS SET DOES AND DOES NOT GUARANTEE:
 *   Membership only makes the BOOT preflight fire, which asserts that Model Armor is
 *   CONFIGURED (MODEL_ARMOR_MODE=block AND MODEL_ARMOR_TEMPLATE present) before these
 *   agents run in production. It does NOT itself screen the content, and it does NOT
 *   prove the template is valid or that Model Armor blocks at runtime ("preflight
 *   passed" != "G8 verified working"; template-validity / runtime fail-closed is
 *   deferred to OPT-106).
 *
 *   Separately and MORE SERIOUSLY: unlike the API's email path
 *   (lib/runtime/agents/context-loader.js runs a block-mode body screen) and unlike
 *   executor-redesign (screenRedesignInput), the issue-triage and claw-workshop
 *   paths above currently have NO inline sanitize()/screen call at all — the
 *   untrusted text reaches the LLM unscreened even when Model Armor is armed. This
 *   preflight does NOT close that gap; it only guarantees the org-wide screening
 *   config exists. That inline-screening gap is a pre-existing vulnerability tracked
 *   as GH #541. Do NOT read "in this set" as "this content is screened."
 *
 * OPERATIONAL IMPLICATION:
 *   With issue-triage / claw-workshop in the set, a runner started with
 *   NODE_ENV=production + either agent enabled + Model Armor unconfigured will
 *   HARD-FAIL at startup (intended deny-by-default / fail-closed, P1). This is inert
 *   today only because the M1/CLI runner does not set NODE_ENV=production (see
 *   .env.runner.example) — it becomes load-bearing the moment it does.
 *
 * If a future runner-eligible agent starts consuming attacker-controllable external
 * content, add its id here so the runner-side preflight fires for it.
 *
 * @type {Set<string>}
 */
export const RUNNER_UNTRUSTED_CONTENT_AGENTS = new Set([
  'issue-triage',
  'claw-workshop',
]);

/**
 * Whether a runner process asked to run `agentNames` needs the G8 Model Armor
 * boot preflight (i.e. at least one requested agent ingests attacker-controllable
 * external content into an LLM).
 *
 * @param {string[]} agentNames - agent ids this runner process was asked to run
 * @returns {boolean}
 */
export function runnerRequiresModelArmorPreflight(agentNames) {
  return agentNames.some(name => RUNNER_UNTRUSTED_CONTENT_AGENTS.has(name));
}
