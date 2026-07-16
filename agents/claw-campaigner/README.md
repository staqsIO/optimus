# claw-campaigner

Orchestrator-tier agent that claims board-approved campaigns and executes them autonomously within a board-defined envelope. Implements the autoresearch-inspired iteration loop described in ADR-021.

---

## Architecture Overview

```
index.js              ← Poll/claim loop (SELECT…FOR UPDATE SKIP LOCKED)
  └── campaign-loop.js     ← Per-campaign iteration driver
        ├── strategy-planner.js   ← LLM planning with cross-campaign learning
        ├── campaign-scorer.js    ← Constraint-based output evaluation
        ├── circuit-breaker.js    ← Plateau + halt signal detection
        ├── campaign-budget.js    ← DB-enforced budget envelope
        ├── campaign-workspace.js ← Git worktree / GitHub repo provisioning
        └── project-deploy.js     ← Framework-aware deploy (Vercel / Railway)
```

The agent runs as an Orchestrator-tier process. It **never self-approves** — the board sets the goal, success criteria, budget, and deadline. Everything inside the envelope is autonomous.

`campaignerLoop._getActiveCampaignCount()` is exposed for the runner status ticker to display live campaign count without accessing internal state directly.

### Concurrency Model

`index.js` maintains an `activeCampaigns: Map<campaignId, AbortController>`. Up to `maxConcurrentCampaigns` (default: 2) campaigns run in parallel as non-blocking async loops. Each gets its own `AbortController` for clean shutdown.

```js
// index.js:35
const activeCampaigns = new Map(); // campaignId → AbortController
```

### Claim Protocol

`claimNextCampaign()` uses a two-phase pattern to avoid holding a DB transaction open during slow I/O:

1. **Fast transaction** — `SELECT…FOR UPDATE SKIP LOCKED` claims one `approved` campaign, transitions it to `running`, and sets a placeholder `workspace_path` to satisfy the DB CHECK constraint (`index.js:69-101`).
2. **Outside the transaction** — workspace is provisioned (can take several seconds) (`index.js:108-146`).

Orphaned campaigns (heartbeat stale > 5 minutes) are reset to `approved` on each poll cycle and at startup (`index.js:174-185`, `index.js:252-265`).

---

## Campaign Modes

| Mode | Workspace | Scorer | Cleanup |
|------|-----------|--------|---------|
| `stateless` | none | `evaluateSuccessCriteria` (text output) | immediate |
| `stateful` | git worktree in the Optimus repo | `evaluateStatefulOutput` (git diff) | immediate on terminal state |
| `project` | fresh GitHub repo + local clone | `evaluateStatefulOutput` (git diff) + deploy | 7-day deferred cleanup |

```js
// index.js:89
const needsWorkspace = (claimed.campaign_mode === 'stateful' || claimed.campaign_mode === 'project')
  && !claimed.workspace_path;
```

**Stateless** campaigns produce output as LLM text (documents, research, copy). Scoring evaluates the raw output against structural constraints.

Within stateless, **build campaigns** are auto-detected when tools are not needed and the output is code/artifacts. Detection uses `BUILD_GOAL_PATTERN` (`campaign-loop.js:38`):

```js
const BUILD_GOAL_PATTERN = /\b(build|create|generate|implement|develop|design|code|site|app|page|landing|website|dashboard|api|component)\b/i;
// Also triggered by: metadata.campaign_type === 'build'
```

Build campaigns run with `allowedTools: []` (no tools — pure LLM output) and `maxTurns: 15`. They are scored by `evaluateBuildOutput()` rather than `evaluateSuccessCriteria()`.

**Stateful** campaigns operate on a git worktree (`campaign-workspace.js:createWorkspace`). Scoring evaluates the cumulative `git diff --stat`. On success or plateau-pause, the branch is pushed to origin before cleanup (`campaign-loop.js:pushBranch`).

**Project** campaigns create a new GitHub repo under `staqsIO/optimus-project-{id}` via the GitHub API, clone it locally, and optionally deploy to Vercel or Railway (`campaign-workspace.js:createProjectWorkspace`, `project-deploy.js:deployProject`). Cleanup is deferred 7 days to preserve deployed artifacts.

---

## Iteration Loop

Each campaign runs `runCampaignLoop()` (`campaign-loop.js`) which cycles until a stop condition is reached. Hard ceiling: `MAX_ITERATIONS_PER_CAMPAIGN = 50`.

```
while (true):
  1. Pre-checks (halt, deadline, budget, max iterations, plateau)
  2. Create iteration work_item  ← guardCheck + audit chain anchor
  3. Reserve budget              ← DB-level pre-authorization
  4. Plan strategy               ← LLM call (max 3 turns, $0.50 cap)
  5. HITL gate (optional)        ← pause if strategy.hitl_question set
  6. Execute strategy            ← spawnCLI / LLM with tools
  7. Score output                ← constraint-based evaluation
  8. Decide: keep / discard / stop
  9. Log to campaign_iterations  ← append-only
 10. Commit or release budget
```

### Step 4 — Plan (`strategy-planner.js`)

The planner builds a context-rich prompt including:
- Full goal + success criteria
- History of prior iteration outcomes (what worked, what failed)
- **Cross-campaign learning**: winning strategies for the same goal type queried from Neo4j (`queryWinningStrategies`, min score 0.7)
- **RAG context**: `queryRAG()` via `getCampaignRAGContext()` — knowledge base documents relevant to the campaign goal (`scope: 'campaign', kbOnly: true`)
- **Failure guidance**: specific failure reasons from the most recent discarded iteration
- **Pivot directive**: injected when circuit breaker signals plateau (`strategy-planner.js:pivotBlock`)

```js
// strategy-planner.js — Neo4j query for cross-campaign learning
MATCH (s:Strategy)-[:STRATEGY_FOR]->(gt:GoalType {name: $goalType})
WHERE s.best_score > 0.7
RETURN s.approach, s.iterations_to_success, s.best_score, s.goal_summary
ORDER BY s.best_score DESC LIMIT $limit
```

Plan invocations are capped independently at `maxBudgetUsd: 0.50` and `maxTurns: 3` regardless of the campaign envelope.

### Step 5 — HITL Gate

If the planner sets `strategy.hitl_question`, the loop pauses and notifies the creator via Telegram. Execution resumes after `awaitHumanInput()` returns. The answer is injected into the execute prompt as `OPERATOR CLARIFICATION`:

```js
// campaign-loop.js
if (strategy.hitl_question) {
  notifyCreator(campaignId, `⏸️ Campaign needs your input!\nQ: "${strategy.hitl_question}"`);
  const hitlAnswer = await awaitHumanInput(campaignId, strategy.hitl_question, agentId);
  hitlContext = `\n\nOPERATOR CLARIFICATION:\nQ: ${strategy.hitl_question}\nA: ${hitlAnswer}`;
}
```

### Step 6 — Execute

`spawnCLI` runs Claude Code as a subprocess with the planned strategy. Stateful/project campaigns run with `permissionMode: 'bypassPermissions'` and a filesystem-scoped workspace. Stateless campaigns use `allowedTools: []` for pure reasoning.

### Error Classification and Retry

Errors are classified as transient or fatal:

| Category | Transient | Behavior |
|----------|-----------|----------|
| `rate_limit`, `timeout`, `network`, `service_busy`, `json_parse` | yes | exponential backoff + retry (max 3) |
| `guard_check`, `budget`, `cancelled`, `max_iterations` | no | stop campaign immediately |

```js
// campaign-loop.js
function retryDelayMs(attempt) {
  const base = 30_000 * Math.pow(2, attempt); // 30s, 60s, 120s
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}
const MAX_RETRIES = 3;
```

---

## Scoring System

All scoring is **constraint-based** — no LLM self-assessment (`campaign-scorer.js`).

### Build Scorer (`evaluateBuildOutput`)

For `isBuildCampaign = true` campaigns (tools disabled, code in fenced blocks):

| Check | Points | Failure Reason |
|-------|--------|----------------|
| Has ≥1 fenced code block | 2 | `no_code_blocks` |
| Total code chars ≥ 100 | 2 | `code_too_short` |
| Stub ratio < 2 per block (`// TODO`, `// ...`, `raise NotImplementedError`, `placeholder`) | 1 | `placeholder_stubs` |
| Word count ≥ 50 | 1 | `word_count_low` |
| Required sections present (≥50%) | 1 | `missing_sections` |

Score = `earnedPoints / totalPoints`. Pass threshold: **≥ 0.7**.

### Stateless Scorer (`evaluateSuccessCriteria`)

Five checks with weighted points:

| Check | Points | Pass Condition | Failure Reason |
|-------|--------|----------------|----------------|
| Word count | 1 | Within `minWords`–`maxWords` (default 20–50,000) | `word_count_low` |
| No self-assessment | 2 (weighted) | No quality scores, confidence ratings, execution reports | `self_assessment` |
| Format compliance | 2 | html/json/sql/markdown matches detected format | — |
| Envelope wrapping | 1 | Narrative ≤ 3× code length | `envelope_wrapped` |
| Required sections | 1 | ≥50% of sections from success criteria present | `missing_sections` |

Self-assessment check (weighted 2×) detects: `quality score: N`, `confidence: N`, `execution report`, `task completion summary`, `## Quality Assessment`.

```js
// campaign-scorer.js
const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 10000 : 0;
const passed = score >= 0.7; // 70% threshold for passing
```

Failure reasons are accumulated in `failureReasons[]` (e.g., `PLACEHOLDER_STUBS`, `SELF_ASSESSMENT`, `MISSING_SECTIONS`) and fed back to the strategy planner on the next iteration.

### Stateful/Project Scorer (`evaluateStatefulOutput`)

Three-strategy cascade — evaluated in priority order:

1. **Committed diff** (`git diff --stat`) — most reliable signal. Parses insertions, deletions, files changed. Base score `0.2` + increments for volume (10/50/200 line thresholds) + `0.2` if no CLI errors.
2. **Uncommitted status** (`git status --porcelain`) — CLI wrote files but didn't commit. Base `0.3` + file count increments.
3. **CLI output text** — fallback when no git changes at all. Scores on word count + completion keywords (`written`, `created`, `generated`).

A diff with fewer than 20 characters falls through to strategy 2, then 3. No signal at all scores `0.1` (auto-fail with reason `no_changes`).

### Decision Logic

After scoring:
- `score >= threshold` → **keep**: commit budget, log as `succeeded`, notify board
- `score < threshold` → **discard**: release budget reservation, increment failure counter
- Consecutive failures ≥ `MAX_RETRIES` → stop as `failed`

On success, `recordWinningStrategy()` writes the approach, score, and iteration count to Neo4j for future cross-campaign learning.

---

## Poll Error Deduplication

`poll()` in `index.js` suppresses repetitive identical errors. On a new error, it is logged immediately. On subsequent identical errors (same `err.code || err.message`), only a count is accumulated. On recovery (next successful poll), a single `✓ Recovered (N errors cleared)` line is emitted (`index.js:162–169`). This keeps logs readable during transient DB outages.

---

## Budget Management

Budget enforcement is **DB-level** (P2: infrastructure enforces, prompts advise). The `campaigns.no_overspend` CHECK constraint is the final backstop. `campaign-budget.js` wraps four Postgres functions:

```js
reserveBudget(campaignId, estimatedCost)     // atomic check-and-reserve before iteration
releaseBudget(campaignId, estimatedCost)     // undo reservation on failure/abort
commitSpend(campaignId, reserved, actual)    // move reserved → spent after completion
getBudgetState(campaignId)                   // { envelope, spent, reserved, remaining, maxPerIteration }
estimateIterationCost(model, inputTokens, outputTokens, modelsConfig)  // uses agents.json pricing
```

**Reserve** runs before every iteration. The DB function returns `false` (no reservation) if:
- `budget_spent + budget_reserved + estimatedCost > total_budget_usd`, or
- `estimatedCost > max_cost_per_iteration`

When `reserveBudget` returns `false`, the loop stops with `stop_budget`.

**Release** fires on any iteration error, ensuring a failed iteration does not permanently consume its reservation. The `campaign-loop.js` `finally` block guarantees release runs even if scoring throws.

**Commit** accepts both the reserved amount and actual spend, allowing the DB to handle over/under-runs within the envelope without requiring the caller to know the exact accounting rules.

---

## Circuit Breaker Behavior

`circuit-breaker.js` implements `preIterationChecks()`, which runs at the top of every iteration in priority order:

```js
// circuit-breaker.js
export async function preIterationChecks(campaignId) {
  if (await checkHalt())          return { canContinue: false, stopReason: 'stop_halt' };
  if (await checkDeadline(campaignId))
                                  return { canContinue: false, stopReason: 'stop_deadline' };
  if (await checkMaxIterations(campaignId))
                                  return { canContinue: false, stopReason: 'stop_max_iterations' };
  const plateau = await checkPlateau(campaignId);
  if (plateau.plateaued) {
    if (plateau.pivotRequired) return { canContinue: true, stopReason: null, pivotRequired: true };
    return { canContinue: false, stopReason: 'stop_plateau' };
  }
  return { canContinue: true, stopReason: null };
}
```

Note: budget exhaustion (`stop_budget`) is checked in `campaign-loop.js` via `reserveBudget()` — not inside `preIterationChecks`. The circuit breaker only handles halt, deadline, iteration cap, and plateau.

### Halt Signals (Fail-Closed)

Any active row in `agent_graph.halt_signals` immediately stops all campaigns. This is a system-wide emergency brake. The check is **fail-closed**: a DB query error is treated as halt active, preventing runaway execution during infrastructure failures.

```js
// circuit-breaker.js
export async function checkHalt() {
  const result = await query(
    `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`
  );
  return result.rows.length > 0;
}
```

### Plateau Detection

`checkPlateau()` reads the last `plateau_window` iterations' `quality_score` values from `agent_graph.campaign_iterations`. If the improvement between the oldest and newest score in the window is below `plateau_threshold`, the campaign transitions to `plateau_paused` (not `failed`).

On plateau detection, `countPriorPivots()` counts strategy approach changes (different `strategy_used.approach` across consecutive iterations) plus non-null `strategy_adjustment` fields. Up to **2 pivots** are allowed before the campaign hard-stops:

- Pivot 1–2: `pivotRequired: true` is returned — the loop continues, but `buildStrategyPrompt()` injects a `PIVOT REQUIRED` directive.
- After pivot 2: `canContinue: false, stopReason: 'stop_plateau'` — campaign stops.

Each pivot forces the strategy planner to produce a fundamentally different approach (`campaign-loop.js:199–201`, `strategy-planner.js:122–124`).

### Deadline

`checkDeadline()` compares `now()` against `campaigns.deadline`. Expired campaigns stop with `stop_deadline`.

---

## Workspace Management (`campaign-workspace.js`)

### Stateful — Git Worktrees

Worktrees are created inside the Optimus repo under `WORKTREE_BASE`. Each campaign gets a dedicated branch `campaign/{campaignId}`. On terminal state (success, fail, cancel), the branch is pushed to origin and the worktree is removed. On `plateau_paused`, the branch is pushed but the worktree is retained for resumption.

### Project — GitHub Repos

```
1. Create repo `staqsIO/optimus-project-{id[:8]}` via GitHub API
2. Clone with x-access-token auth
3. Scaffold README.md + package.json
4. Initial commit and push to main
5. Update campaigns.workspace_path + campaigns.metadata.github_repo
```

On cleanup, repos are **archived** rather than deleted to preserve the audit trail (P3: transparency by structure).

---

## Deployment (`project-deploy.js`)

Framework detection routes project campaigns to the optimal platform:

| Detected Framework | Platform | Notes |
|--------------------|----------|-------|
| Next.js, Nuxt, SvelteKit, Astro, static | Vercel | Edge, ISR, free tier |
| Express, Fastify, plain Node, Python | Railway | Process-based |
| Unknown | Railway | Default fallback |

`deployProject()` detects the framework from `package.json`, creates the project on the target platform, links the GitHub repo, waits for the deploy to complete, and stores the preview URL in `campaigns.metadata`. If Vercel fails (missing token, API error), it falls back to Railway automatically.

Auth tokens (`RAILWAY_TOKEN`, `VERCEL_TOKEN`) are loaded from environment variables at runtime and never passed to LLM prompts (P2: infrastructure enforces).

If neither token is configured, the campaign continues without a deploy — graceful degradation rather than failure.
