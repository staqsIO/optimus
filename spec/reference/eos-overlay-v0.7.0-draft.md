# EOS (Traction) Overlay — Specification Amendment for v0.7.0

> **Document type:** Proposed spec amendment — DRAFT for board review
> **Target version:** v0.7.0 (minor bump — significant structural addition)
> **Date:** 2026-02-28
> **Authors:** Claude (drafting), Dustin (direction), pending Eric review
> **Scope:** Overlays the Entrepreneurial Operating System (EOS / Traction) onto the Optimus agent organization architecture. Introduces EOS language as the canonical operating vocabulary throughout the spec. Adds §22 (Operating Rhythm), new schema concepts, and a terminology mapping that touches every existing section.
> **Companion documents:**
> - Gino Wickman, *Traction: Get a Grip on Your Business* (canonical EOS reference)
> - EOS Worldwide toolset (V/TO, Accountability Chart, Scorecard, Level 10 Meeting, Rocks, IDS)

---

## Part 1: Why EOS — and Why Now

### The Gap This Fills

The spec (v0.6.2) is 90+ pages of enforcement architecture — how agents are constrained, how guardrails fire, how state transitions are audited. It defines the *machinery* of the organization with extraordinary rigor.

What it lacks is an *operating system for running the business.* Specifically:

1. **No goal-setting rhythm.** The spec defines Phases with exit criteria, but has no structured mechanism for setting 90-day priorities, tracking weekly progress toward them, or cascading organizational goals to individual agent seats.

2. **No meeting cadence.** The board interacts via "event digests" and "dashboard monitoring" — reactive, not proactive. There is no structured weekly pulse, no quarterly planning session, no annual goal-setting protocol.

3. **No issue resolution protocol.** When something goes wrong, the spec defines mechanical responses (retry, escalate, HALT). But for *systemic* problems — "our cost per directive is trending up," "the Strategist keeps proposing products we reject," "Executor-01 is consistently slower than Executor-02" — there is no structured identify-discuss-solve process.

4. **No accountability structure beyond enforcement.** The spec defines what agents *cannot* do (guardrails, deny-by-default, budget limits). It does not define what agents *are accountable for delivering* in a given quarter.

EOS fills all four gaps. And it does so with P4 (boring infrastructure) — EOS is the most widely adopted small-business operating system in the world, used by over 250,000 companies. It is proven, boring, and effective.

### Why Day One

The graduated autonomy model (§14, v0.5.2) says "all agents are present from Phase 1, human checkpoints removed progressively." The same logic applies to EOS: the operating rhythm must be present from day one so the system *learns* the cadence. If we bolt EOS on in Phase 2, we lose 8 weeks of Scorecard data, 8 weeks of Rock tracking history, and 8 weeks of IDS resolution patterns. The Strategist needs this data to feed G4 (Strategic Decision Quality).

---

## Part 2: The Six EOS Components Mapped to Optimus

### Component 1: Vision — The V/TO (Vision/Traction Organizer)

**What it is in EOS:** An 8-question document that aligns the entire organization. Core Values, Core Focus (purpose + niche), 10-Year Target, Marketing Strategy, 3-Year Picture, 1-Year Plan, Quarterly Rocks, Issues List.

**What it becomes in Optimus:**

The V/TO is the Board's strategic context document. It sits *above* DIRECTIVEs in the conceptual hierarchy. Every DIRECTIVE must reference which V/TO element it serves — this gives the Strategist grounding for §19 (Strategy Evaluation Protocol) decisions. When evaluating whether to build something, the Strategist checks alignment against the V/TO, not just the three-perspective protocol in a vacuum.

**Schema addition:**

```
vto (in agent_graph schema):

  id                    -- UUID
  version               -- INTEGER (incremented on quarterly review)
  core_values           -- JSONB (array of {value, description})
  core_focus            -- JSONB ({purpose, niche})
  ten_year_target       -- TEXT
  marketing_strategy    -- JSONB ({target_market, three_uniques,
                        --   proven_process, guarantee})
  three_year_picture    -- JSONB ({revenue_target, profit_target,
                        --   measurables[], what_does_it_look_like})
  one_year_plan         -- JSONB ({revenue_goal, profit_goal,
                        --   measurables[], goals[]})
  created_at            -- TIMESTAMPTZ
  created_by            -- TEXT ('board')
  approved_at           -- TIMESTAMPTZ
  config_hash           -- TEXT (content-addressed, P3)
```

**Key rules:**
- The V/TO is Board-authored only. No agent may modify or propose modifications to the V/TO. (Agents propose products and strategy through DIRECTIVEs and §19 — the V/TO is the constitution for *what kind of company this is.*)
- V/TO is reviewed quarterly during the Quarterly Planning Session (see §22.6).
- V/TO is Q1-tier context data (§4 data quality tiers) — loaded first, never truncated.
- V/TO `config_hash` is stamped on every DIRECTIVE that references it, creating a provenance chain from vision to execution.

**Phase activation:**
- Phase 0: Board drafts V/TO as part of legal foundation (before any code).
- Phase 1+: V/TO available to all agents as Q1 context. Reviewed quarterly.
- Phase 3+ (AutoBot): V/TO becomes a constitutional document — amendments require the same rigor as constitutional changes.

---

### Component 2: People — The Accountability Chart

**What it is in EOS:** Not an org chart — an *accountability chart*. Every seat has a clear role with 5 key responsibilities (called "Roles" in EOS). People are evaluated by GWC: do they Get it, Want it, and have the Capacity for it? The right people in the right seats.

**What it becomes in Optimus:**

The Accountability Chart is a structured view over the existing `agent_configs` table (§4). Each agent tier is a *seat.* The tier's capabilities and constraints are the seat's *Roles* (the 5 key responsibilities). GWC maps to the graduated trust escalation framework (§11):

| EOS Concept | Optimus Equivalent | Enforcement |
|-------------|-------------------|-------------|
| **Seat** | Agent tier (Strategist, Architect, Orchestrator, Reviewer, Executor, Utility) | `agent_configs.role` |
| **5 Roles** (key responsibilities) | Seat-level Measurables (see Scorecard below) | Tracked in Scorecard, reviewed in Level 10 |
| **Gets it** | Passes shadow mode exit criteria (§11) — minimum tasks, category coverage, < 10% divergence | Orchestration layer measurement |
| **Wants it** | Not directly applicable — but behavioral drift detection (§8 Tier 2) catches the functional equivalent: a model update that makes an agent perform its role differently | Tier 2 Auditor |
| **Capacity** | Per-tier token budgets, tool access, data classification clearance, delegation depth | `agent_configs.guardrails` |
| **Right person, right seat** | Agent replacement protocol (§11) with graduated trust escalation | Shadow mode + 3-level trust progression |

**Schema addition:**

```
accountability_chart (VIEW over agent_configs + runtime metrics):

  seat                  -- role from agent_configs
  agent_id              -- current agent filling the seat
  display_name          -- from agent_configs
  trust_level           -- current graduated trust level (1/2/3)
  model                 -- current model assignment
  roles_json            -- JSONB: 5 key measurables for this seat
  gw_score              -- Gets it + Wants it composite (shadow mode
                        --   pass rate + drift detection clean)
  capacity_score        -- utilization rate vs budget headroom
  rocks_on_track        -- count of on-track Rocks owned by this seat
  rocks_off_track       -- count of off-track Rocks owned by this seat
  rejection_rate_7d     -- rolling 7-day rejection rate
  tasks_completed_7d    -- rolling 7-day task completion count
```

This is a dashboard view, not new architecture. It gives the Board an EOS-native "people page" that answers: is each seat filled by an agent that Gets it, Wants it, and has Capacity?

**When an agent doesn't GWC:** The agent replacement protocol (§11) is the EOS "right person, right seat" conversation. When the Accountability Chart shows an agent is off-track — rejection rate climbing, Rocks off-track, trust level regressing — the Board decides whether to replace (model swap, prompt rewrite, or full replacement). The replacement protocol's shadow mode + graduated trust escalation is how the new agent proves it GWC.

---

### Component 3: Data — The Scorecard

**What it is in EOS:** A weekly pulse — 5-15 numbers that tell the leadership team whether things are on track or off track. Every seat owns specific Measurables. Numbers don't lie, don't have emotions, and don't forget.

**What it becomes in Optimus:**

The Scorecard is the missing bridge between the spec's extensive observability (§8) and the Board's operational awareness. The spec already produces all the data — cost per task, latency, rejection rates, budget burn, guardrail violations. What's missing is the *structured weekly view* that says "on track" or "off track" for each number, owned by a specific seat.

**Schema addition:**

```
scorecard_measurables (in agent_graph schema):

  id                    -- UUID
  measurable            -- TEXT (e.g., 'Cost per directive')
  description           -- TEXT
  owner_seat            -- TEXT (FK to accountability chart seat)
  target_value          -- NUMERIC
  target_direction      -- ENUM: above, below, at
                        --   (above = higher is better,
                        --    below = lower is better,
                        --    at = must hit exact range)
  target_range_low      -- NUMERIC (for 'at' direction)
  target_range_high     -- NUMERIC (for 'at' direction)
  frequency             -- ENUM: weekly, daily
  source_query          -- TEXT (SQL query or view that computes
                        --   the current value — deterministic,
                        --   no LLM, P3)
  category              -- ENUM: operational, financial, quality,
                        --   growth
  phase_introduced      -- INTEGER (which phase this measurable
                        --   becomes active)
  created_at            -- TIMESTAMPTZ

scorecard_readings (in agent_graph schema):

  id                    -- UUID
  measurable_id         -- UUID (FK to scorecard_measurables)
  period_start          -- DATE
  period_end            -- DATE
  actual_value          -- NUMERIC
  on_track              -- BOOLEAN (computed: actual vs target)
  computed_at           -- TIMESTAMPTZ
  computation_hash      -- TEXT (hash of the query + inputs, P3)
```

**Phase 1 Scorecard (operational — no product yet):**

| # | Measurable | Owner Seat | Target | Direction | Source |
|---|-----------|------------|--------|-----------|--------|
| 1 | Cost per directive | Orchestrator | < $3.00 | below | `v_budget_status` + `llm_invocations` |
| 2 | Task success rate | Orchestrator | > 90% | above | `state_transitions` (completed / total) |
| 3 | End-to-end latency p95 | Orchestrator | < 120s | below | `state_transitions` timestamps |
| 4 | Review rejection rate | Reviewer | < 5% | below | `state_transitions` (review → in_progress / review total) |
| 5 | Guardrail violations / week | Tier 1 Audit | 0 | below | `event_log` filtered by violation events |
| 6 | Budget burn rate vs projection | Strategist | ±10% | at | `v_budget_status` vs monthly allocation |
| 7 | Agent idle time | Orchestrator | < 30% | below | `task_events` claim times vs wall clock |
| 8 | Content sanitization false positive rate | Reviewer | < 5% | below | sanitization flags vs reviewer overrides |
| 9 | Strategist suggest-mode match rate | Strategist | trending up | above | `strategic_decisions` (suggest vs board) |
| 10 | PR-to-merge cycle time p95 (agent paths) | Orchestrator | < 30 min | below | GitHub PR metadata |
| 11 | Tool integrity check pass rate | Executor | 100% | above | tool invocation logs |
| 12 | Crash recovery time | Orchestrator | < 60s | below | reaper query timestamps |

**Phase 2+ additions (product + financial):**

| # | Measurable | Owner Seat | Target | Direction |
|---|-----------|------------|--------|-----------|
| 13 | Monthly recurring revenue | Strategist | growing | above |
| 14 | Customer count | Strategist | growing | above |
| 15 | Churn rate | Strategist | < 5% | below |
| 16 | Net revenue vs operating cost | Strategist | > 150% (pre-distribution gate) | above |
| 17 | Gateway unsafe escape rate | Communication Gateway | < 0.01% | below |
| 18 | Decision reversal rate (90-day rolling) | Strategist | < 15% | below |

**How it's computed:** A deterministic utility script (not an LLM — P3) runs each `source_query` weekly (Sunday midnight UTC), writes the result to `scorecard_readings`, and computes `on_track`. The Scorecard is auto-assembled as part of the Level 10 Meeting prep (see §22.5). No agent interprets the numbers — the Board reads them directly.

**Key principle:** The Scorecard is not a dashboard (the spec already has dashboards — §8). The Scorecard is a *weekly discipline.* The same 12 numbers, reviewed in the same order, every week. The power is in the pattern — not the data.

---

### Component 4: Issues — The Issues List + IDS

**What it is in EOS:** One master list of all issues facing the organization. Not tasks — *issues.* Problems, patterns, obstacles, opportunities that need discussion. Resolved using the IDS (Identify, Discuss, Solve) process: identify the root cause (not the symptom), discuss it once with all relevant input, solve it by making a decision and assigning a To-Do.

**What it becomes in Optimus:**

The Issues List fills the gap between mechanical failure handling (§11 — retry, escalate, HALT) and systemic problem resolution. An Issue is not a work item. It is a *pattern or problem that needs human (or Strategist) judgment.*

**How Issues surface:**

| Source | Example | Detection |
|--------|---------|-----------|
| Scorecard off-track | Cost per directive trending above $3.00 for 3+ weeks | Scorecard reading `on_track = false` for 3 consecutive periods |
| Tier 2 Auditor | Behavioral drift detected in Executor-01 | Tier 2 audit finding (§8) |
| Guardrail health check | `can_assign_to` list references deactivated agent | Tier 2 guardrail decay finding (§8) |
| Board observation | "The Strategist keeps proposing consumer products but our V/TO says B2B SaaS" | Board creates Issue manually |
| Agent escalation | Orchestrator escalates after 3 failed retry cycles on same pattern | Escalation event in task graph |
| Capability gate regression | G4 drops below 80% match rate | Gate measurement (§14) |
| Rock off-track | Phase 1 Rock "Task graph operational" still off-track in week 5 | Rock status review |

**Schema addition:**

```
issues (in agent_graph schema):

  id                    -- UUID
  title                 -- TEXT (the issue stated as a problem,
                        --   not a solution)
  description           -- TEXT (root cause hypothesis)
  category              -- ENUM: operational, strategic, people,
                        --   process, technical, financial
  priority              -- INTEGER (1 = most important, set in
                        --   Level 10 during IDS)
  status                -- ENUM: open, ids_in_progress, solved,
                        --   killed
  surfaced_by           -- TEXT (agent_id, 'board', 'scorecard',
                        --   'auditor')
  surfaced_at           -- TIMESTAMPTZ
  owned_by              -- TEXT (seat responsible for resolution)
  root_cause            -- TEXT (filled during IDS Identify step)
  solution              -- TEXT (filled during IDS Solve step)
  resolution_type       -- ENUM: directive, rock, todo, process_change,
                        --   agent_replacement, no_action
  resolution_ref        -- UUID (FK to the DIRECTIVE, Rock, or
                        --   To-Do that implements the solution)
  resolved_at           -- TIMESTAMPTZ
  ids_session_date      -- DATE (which Level 10 this was resolved in)
  created_at            -- TIMESTAMPTZ
```

**IDS protocol for the Board:**

1. **Identify** — State the real issue (not the symptom). "Executor-01 keeps failing code tasks" is a symptom. "Haiku 4.5 lacks sufficient context window for multi-file code changes" is the root cause.
2. **Discuss** — All relevant data on the table. Scorecard history, audit findings, task graph patterns. One discussion, not recurring rehash. The system provides the data automatically (P3).
3. **Solve** — Make a decision. Options: create a DIRECTIVE (strategic fix), create a Rock (quarterly priority), create a To-Do (one-week action item), change a process (spec amendment), replace an agent (§11 protocol), or decide it's not an issue (kill it).

**Key rules:**
- Every Issue gets resolved or killed. No Issue lives on the list for more than 3 Level 10 sessions without being IDS'd. If it's been on the list 3 weeks and nobody's solving it, it's either not important (kill it) or it's being avoided (escalate to Existential tier, §19).
- Issues are never auto-resolved by agents. IDS is a Board protocol (Phase 1-2) or a Strategist protocol with Board veto (Phase 3+).
- The Issues List is separate from the task graph's work items. An Issue may *produce* work items when it's solved, but the Issue itself is a governance artifact, not execution work.

---

### Component 5: Process — Documented Core Processes

**What it is in EOS:** Identify your handful (not dozens) of core processes. Document the 20% that produces 80% of results. Make sure everyone follows them consistently.

**What it becomes in Optimus:**

This is where EOS validates what the spec already does. The spec *is* the documented core process layer. Specifically:

| EOS Core Process | Spec Equivalent | Section |
|-----------------|----------------|---------|
| HR Process (how we hire/fire) | Agent Replacement Protocol | §11 |
| Operations Process (how work gets done) | Agent Runtime Loop | §4 |
| Delivery Process (how we deliver to customers) | Task Graph + State Machine | §3 |
| Sales/Marketing Process | Communication Gateway outbound | §7 |
| Customer Retention Process | Value Measurement Script | §13 |
| Financial Process | Financial Script + Cost Tracking | §10, §12 |
| Strategy Process | Strategy Evaluation Protocol | §19 |

**What EOS adds:** The discipline of naming these as "The Optimus Way" — a small set of core processes that every agent and every board member follows. The spec defines them technically. EOS gives them organizational identity.

**The Optimus Way — 7 Core Processes:**

1. **The Execution Process** — How work flows from DIRECTIVE to completion (§3 state machine + §4 runtime loop)
2. **The Guardrail Process** — How every action is validated before and after execution (§5)
3. **The Review Process** — How outputs are quality-checked on three dimensions (§4 Reviewer, §11)
4. **The Communication Process** — How messages flow to the outside world (§7 Gateway)
5. **The Strategy Process** — How decisions are evaluated and recorded (§19)
6. **The Audit Process** — How the organization monitors itself (§8 three-tier audit)
7. **The Replacement Process** — How agents are swapped safely (§11 shadow mode + graduated trust)

No new schema needed. The spec already documents these. The EOS contribution is: every agent's system prompt references the relevant core processes by name (defense-in-depth per P2 — the prompt *advises*, infrastructure *enforces*). And the Board reviews process compliance as a Scorecard measurable.

---

### Component 6: Traction — Rocks, To-Dos, and the Level 10 Meeting

**What it is in EOS:** The heartbeat. *Rocks* are 90-day priorities (3-7 per quarter, each with a clear owner and a binary done/not-done completion criterion). *To-Dos* are 7-day action items that come out of each Level 10 Meeting. The *Level 10 Meeting* is a weekly 90-minute structured session that keeps everything on track.

**What it becomes in Optimus:**

This is the biggest structural addition. It introduces the **quarterly planning cadence** and the **weekly operating pulse** that the spec currently lacks.

#### Rocks

A Rock is a 90-day priority with a clear owner (seat), a specific deliverable, and a binary completion criterion — it's either done or it's not done.

**Relationship to existing spec concepts:**

| Spec Concept | EOS Concept | Relationship |
|-------------|-------------|--------------|
| Phase 1 build list items | Q1 Rocks | Phase 1's 8-week deliverables become the first set of Rocks |
| DIRECTIVE | Rock or DIRECTIVE | A Rock *may* produce DIRECTIVEs, but they are not the same thing. A Rock is a quarterly commitment; a DIRECTIVE is a task graph instruction. |
| Phase success metrics | Rock completion criteria | Phase 1 metrics become the measurable criteria for Rocks |
| Capability gates (G1-G7) | Multi-quarter Rocks | Gates that span quarters become Rocks with quarterly milestones |

**Schema addition:**

```
rocks (in agent_graph schema):

  id                    -- UUID
  title                 -- TEXT (specific, measurable outcome)
  description           -- TEXT (what "done" looks like)
  owner_seat            -- TEXT (the seat accountable)
  owner_agent_id        -- TEXT (the specific agent, if assigned)
  quarter               -- TEXT (e.g., '2026-Q2')
  status                -- ENUM: on_track, off_track, done, dropped
  completion_criteria   -- JSONB (array of measurable conditions —
                        --   all must be true for done)
  percent_complete      -- INTEGER (0-100, updated weekly)
  vto_alignment         -- TEXT (which V/TO element this serves)
  directives            -- UUID[] (DIRECTIVEs created to execute
                        --   this Rock)
  milestones            -- JSONB (array of {description, target_date,
                        --   complete})
  created_at            -- TIMESTAMPTZ
  completed_at          -- TIMESTAMPTZ
  retrospective         -- TEXT (filled at quarter end — what worked,
                        --   what didn't)
```

**Phase 1 Rocks (Q2 2026 — first 8 weeks reframed):**

| # | Rock | Owner Seat | Done When |
|---|------|-----------|-----------|
| 1 | Task graph operational | Orchestrator | `agent_graph` schema deployed, `transition_state()` passing all state machine tests, 100% state transitions logged |
| 2 | 5-agent runtime live | Orchestrator | All 5 agents processing events through runtime loop, JWT identity working, RLS enforced |
| 3 | Guardrail enforcement passing | Architect | `guardCheck()` atomic with `transition_state()`, all org + role guardrails active, budget pre-auth working |
| 4 | Audit and observability complete | Reviewer | Tier 1 deterministic checks live, public event log operational, cost dashboard showing real data |
| 5 | Board operating rhythm established | Board (Dustin) | Level 10 Meeting running weekly, Scorecard populated, V/TO documented, IDS process working |
| 6 | Source control governance live | Orchestrator | GitHub repo with CODEOWNERS, branch protection, CI checks, agent bot accounts, PR templates |
| 7 | Tool acceptance policy authored | Board (Eric) | Written policy per §6, approved by both board members, no non-core tools registered without it |

Each Rock has milestones at Week 2, Week 4, Week 6, and Week 8. Status is reviewed weekly in the Level 10. A Rock that's off-track at Week 4 becomes an Issue for IDS.

#### To-Dos

To-Dos are 7-day action items. They come out of the Level 10 Meeting's IDS process (or from Rock milestone reviews). They are smaller than Rocks, shorter than DIRECTIVEs, and owned by a specific seat.

**Implementation:** To-Dos map to work items in the task graph with `type = 'todo'` and a 7-day deadline. They are NOT a separate table — they use the existing `work_items` table with a `todo` type added to the type enum. This avoids schema proliferation (P4) while giving the Level 10 a trackable weekly action list.

```
-- Addition to work_items type enum:
-- existing: directive, workstream, task, subtask
-- added:    todo, rock

-- To-Do specific fields (stored in work_items):
--   type = 'todo'
--   deadline = meeting_date + 7 days
--   assigned_to = owner seat/agent
--   parent_id = Rock ID or Issue ID that spawned it
--   status uses existing state machine (created → assigned →
--     in_progress → completed | failed)
```

**Key rules:**
- Every To-Do has a 7-day deadline. No exceptions.
- To-Dos are reviewed at the top of the next Level 10. Binary: done or not done.
- A To-Do that's not done two weeks in a row becomes an Issue.
- To-Do completion rate is a Scorecard measurable (target: > 90%).

#### The Level 10 Meeting

The Level 10 is a weekly 90-minute structured meeting between the Board members (Phase 1-2) or between the Strategist and the Board (Phase 3+). It is the *operating pulse* of the organization.

**Why "Level 10":** EOS asks participants to rate each meeting 1-10. The goal is to consistently hit 10. The structure ensures it.

**Cadence:** Weekly, same day, same time, same agenda. No exceptions. (P6 — the system adapts to the Board's schedule, but the meeting happens every week.)

**Auto-prepared agenda:** A deterministic utility script assembles the meeting package every week (Friday, before the meeting). No LLM interpretation — raw data, structured for human consumption (P3).

**Meeting structure:**

| Segment | Duration | Content | Data Source |
|---------|----------|---------|-------------|
| **Segue** | 5 min | Good news — personal and professional. Humanizes the meeting. | Board members (not auto-generated) |
| **Scorecard Review** | 5 min | Review each Measurable: on-track or off-track. Off-track items drop to the Issues List automatically. | `scorecard_readings` for the week |
| **Rock Review** | 5 min | Each Rock: on-track or off-track. Update `percent_complete`. Off-track Rocks drop to Issues. | `rocks` table, current status |
| **Customer/User Headlines** | 5 min | Key customer/user events. Phase 1: internal observations. Phase 2+: product signals from Data Cooperative. | Communication Gateway inbound + product telemetry |
| **To-Do Review** | 5 min | Each To-Do from last week: done or not done. 90%+ completion target. | `work_items WHERE type='todo' AND deadline = last_week` |
| **IDS** | 60 min | Work the Issues List. Prioritize (most important first). Identify root cause. Discuss once. Solve with a DIRECTIVE, Rock, To-Do, process change, agent replacement, or kill. | `issues` table, sorted by priority |
| **Conclude** | 5 min | Recap new To-Dos. Confirm next meeting. Rate the meeting 1-10. | Meeting notes → `event_log` |

**Meeting output:** Every Level 10 produces a structured meeting record written to the `event_log` (P3 — transparency by structure). Record includes: Scorecard snapshot, Rock statuses, To-Do completion rate, Issues resolved, new To-Dos created, meeting rating, attendees.

**Schema addition:**

```
level_10_meetings (in agent_graph schema):

  id                    -- UUID
  meeting_date          -- DATE
  attendees             -- TEXT[] (board member names / agent IDs)
  scorecard_snapshot    -- JSONB (all measurables + on_track status)
  rocks_snapshot        -- JSONB (all rocks + status + percent)
  todos_reviewed        -- INTEGER
  todos_completed       -- INTEGER
  todo_completion_pct   -- NUMERIC
  issues_discussed      -- UUID[] (FK to issues)
  issues_resolved       -- UUID[] (FK to issues)
  new_todos_created     -- UUID[] (FK to work_items)
  new_issues_surfaced   -- UUID[] (FK to issues)
  meeting_rating_avg    -- NUMERIC (1-10)
  notes                 -- TEXT
  created_at            -- TIMESTAMPTZ
```

**Phase activation for Level 10:**

| Phase | Who Attends | IDS Authority |
|-------|-------------|---------------|
| Phase 1 (Full HITL) | Dustin + Eric | Board resolves all Issues |
| Phase 2 (Tactical autonomy) | Dustin + Eric + Strategist (observer/propose) | Board resolves Strategic + Existential Issues; Strategist proposes Tactical resolutions, Board approves |
| Phase 3 (Strategic autonomy) | Board + Strategist (co-participant) | Strategist resolves Tactical + Strategic Issues; Board retains veto + Existential |
| Phase 4 (Constitutional) | Strategist runs Level 10; Board has dashboard access + kill switch | Strategist resolves all Issues under constitutional constraints; Board monitors via meeting records |

---

### The Quarterly Planning Session

EOS runs a Quarterly Planning Session where the leadership team reviews the V/TO, sets new Rocks for the next quarter, and reviews how the previous quarter's Rocks performed.

**In Optimus:** A structured quarterly session (not a Level 10 — a separate, longer meeting) where the Board:

1. **Reviews V/TO** — Is the 10-Year Target still right? Does the 3-Year Picture need adjustment? Update the 1-Year Plan.
2. **Scores last quarter's Rocks** — Done or not done. No partial credit. Completion rate feeds the organizational Scorecard.
3. **Sets next quarter's Rocks** — 3-7 Rocks for the next 90 days, each with an owner, milestones, and done-when criteria.
4. **Reviews the Accountability Chart** — Is each seat filled by an agent that GWCs? Any replacements needed?
5. **Reviews the Issues List** — Promote long-standing Issues to Rocks if they're important enough.

**Output:** New Rocks created in the `rocks` table. V/TO version incremented if changed. Accountability Chart changes trigger agent replacement protocol (§11) if needed. Everything logged to `event_log`.

**The Annual Planning Session** follows the same structure but with deeper V/TO review (revisit 10-Year Target, 3-Year Picture) and sets the annual goals that quarterly Rocks ladder up to.

---

## Part 3: Terminology Mapping — EOS Language Throughout the Spec

This section defines how EOS vocabulary replaces or augments existing spec language. The principle is: *use EOS terms as the primary vocabulary for organizational concepts; use spec-native terms for technical infrastructure.* The Board talks EOS. The code talks Postgres.

### Global Terminology Changes

| Current Spec Term | EOS Term | Usage Rule | Affected Sections |
|-------------------|----------|-----------|-------------------|
| "Phase 1 build list items" | **Rocks** | All quarterly deliverables are Rocks with owners, milestones, and done-when criteria. "Build list" becomes "Rock sheet." | §14 |
| "Phase success metrics" | **Scorecard Measurables** | Phase metrics become Scorecard items owned by specific seats, tracked weekly. | §14, §14.1 |
| "Board event digests" | **Level 10 prep package** (weekly) + **event digests** (on-demand) | Weekly structured data is the Level 10 package. Real-time alerts remain event digests. | §8 |
| "Dashboard monitoring" | **Scorecard review** (weekly) + **dashboard** (on-demand drill-down) | The Board's primary data interface is the weekly Scorecard, not a real-time dashboard. Dashboard is for investigation, not routine. | §2, §8, §14 |
| "Agent tiers" / "agent roles" | **Seats** (organizational) / **tiers** (technical) | When discussing who is accountable, use "seat." When discussing infrastructure enforcement, use "tier." | §2, §4, §5 |
| "Board approves / rejects" | **Board IDS's** (for issues) / **Board approves** (for DIRECTIVEs and Rocks) | Issue resolution uses IDS language. Directive approval uses standard language. | §5, §14 |
| "Exit criterion" (per phase) | **Gate** (capability) + **Rock completion** (quarterly) | Phase transitions are gated by G1-G7 (capability gates). Quarterly progress is measured by Rock completion rate. | §14 |
| "Intervention classification" | **Constitutional vs. Judgment** (unchanged) + **Issue surfacing** | Board interventions that reveal systemic problems create Issues. One-off corrections remain classifications. | §14, §8 |
| "Decision reversal rate" | **Decision reversal rate** (unchanged — this already IS EOS-compatible measurement language) | No change. Already aligned. | §19 |

### Section-by-Section Changes

#### §0 Design Principles

Add a 7th principle:

**P7. Quarterly cadence, weekly pulse.** The organization operates on 90-day Rock cycles with weekly Level 10 Meetings. Every measurable, every priority, every issue is reviewed in a structured rhythm. The cadence is not optional — it is the operating system of the business, enforced by the same discipline as P1-P6.

#### §1 The Core Idea

Add after "Everything else is agents":

> Optimus runs on EOS (the Entrepreneurial Operating System). The Board sets Vision via the V/TO. Quarterly Rocks define 90-day priorities. Weekly Level 10 Meetings provide the operating pulse. The Scorecard tracks whether the organization is on track. Issues are resolved through IDS. This operating rhythm is present from day one — agents learn the cadence alongside the Board.

#### §2 Architecture Overview — Agent Tiers

Rename table header from "Agent Tiers" to "**Accountability Chart — Seats and Tiers**". Add a "Key Measurables" column:

| Seat | Tier | Roles (5 Key Responsibilities) | Key Measurables (Scorecard) |
|------|------|------|------|
| Strategist | Strategic planning, cross-domain synthesis | Propose DIRECTIVEs aligned to V/TO, evaluate strategy per §19, maintain 1-Year Plan fidelity, manage organizational budget, surface strategic Issues | Budget burn vs projection, decision reversal rate, suggest-mode match rate |
| Architect | Technical architecture, system design | Maintain spec integrity, review technical decisions, ensure P1-P6 compliance in design, define contract layer (§18), guardrail architecture | Guardrail pass rate, spec-to-implementation alignment, architecture decision quality |
| Orchestrator | Task decomposition, work assignment, result aggregation | Decompose DIRECTIVEs into tasks, assign to right seats, maintain task flow, manage PR promotion, resolve operational Issues | Cost per directive, task success rate, end-to-end latency, agent idle time, PR-to-merge cycle time |
| Reviewer | Quality assurance, output validation | Validate on three dimensions (correctness, format, completeness), gate output quality, surface quality Issues, maintain review consistency | Rejection rate, false positive rate, review turnaround time |
| Executor | Implementation, testing, data processing | Execute assigned task to acceptance criteria, produce clean outputs, respond to review feedback, maintain tool integrity | Task completion rate, retry rate, tool integrity pass rate |
| Utility | Cost tracking, format conversion, log analysis | Compute Scorecard readings, prepare Level 10 packages, run deterministic audit checks, compress context | Computation accuracy, package delivery timeliness |

#### §2 Architecture Overview — Diagram

Add to the Human Board box:

```
|  Operating rhythm:                                             |
|    - V/TO (vision — reviewed quarterly)                        |
|    - Rocks (90-day priorities — set quarterly)                 |
|    - Level 10 Meeting (weekly pulse — structured agenda)       |
|    - Scorecard (5-15 numbers — reviewed weekly)                |
|    - Issues List (IDS resolution — worked weekly)              |
```

#### §3 The Task Graph — Work Item Types

Add `rock` and `todo` to the work item type hierarchy:

```
V/TO (Board-authored, quarterly review)
  └── Rock (90-day priority, quarterly cycle)
       └── DIRECTIVE (strategic instruction in task graph)
            └── Workstream (logical grouping)
                 └── Task (assignable unit of work)
                      └── Subtask (decomposed work)
       └── To-Do (7-day action item from Level 10)
  └── Issue (problem/pattern — resolved via IDS)
       └── DIRECTIVE, Rock, To-Do, or process change (resolution)
```

Update the work_items type enum: `directive, workstream, task, subtask, rock, todo`

Rocks sit above DIRECTIVEs conceptually — a Rock may produce one or more DIRECTIVEs. But in the task graph, Rocks and DIRECTIVEs are both top-level work items (Rocks with `type = 'rock'`, DIRECTIVEs with `type = 'directive'`). The Rock's `directives` array (in the `rocks` table) maintains the parent relationship.

#### §4 Agent Runtime — Context Loading

Add V/TO and Rocks to context priority:

| Priority | Content | Tokens | Data Tier |
|----------|---------|--------|-----------|
| 0 (new) | V/TO core focus + current quarter Rocks relevant to this task | ~200-400 | Q1 (board-authored, never truncated) |
| 1 | Agent identity + guardrails | ~500 | Q1 |
| 2 | Current task details + acceptance criteria | ~200-1,000 | Q1 |
| 3 | Parent task summary | ~200-500 | Q2 |
| 4 | Sibling task statuses | ~100-300 | Q2 |
| 5 | Relevant prior work (semantic search) | ~1,000-4,000 | Q2-Q4 |

The V/TO context is minimal — core focus + niche + current quarter Rock titles relevant to this task's lineage. Not the full V/TO document. This costs ~200-400 tokens and ensures every agent's work is grounded in organizational direction.

#### §8 Audit and Observability — Dashboard

Replace the dashboard section header with "**Scorecard + Dashboard (board-facing)**" and restructure:

**Scorecard (weekly — primary Board interface):**
- 12-18 Measurables with on-track / off-track status (see §22.3)
- Rock status (on-track / off-track / done for each)
- To-Do completion rate from last Level 10
- Issues List summary (count open, count resolved this week)

**Dashboard (on-demand — drill-down for investigation):**
- Task funnel (DIRECTIVE → workstream → task → completion)
- Cost by tier, by model, by seat
- (remainder of existing dashboard items unchanged)

**Level 10 prep package (auto-generated weekly):**
- Scorecard snapshot with week-over-week trends
- Rock status with milestone progress
- To-Do list from last meeting with completion status
- Issues List sorted by priority
- Any Tier 2 Auditor findings from the past week
- Any Scorecard Measurables that went off-track

#### §10 Cost Tracking — Daily Digest

Reframe the cost digest as a **Scorecard feed item** rather than a standalone report. The daily digest remains (agents don't wait for the weekly Level 10 to notice a budget problem), but the weekly Scorecard consolidation is the Board's primary cost review.

#### §11 Failure Modes — Agent Replacement

Add EOS framing: "Agent replacement is the Optimus equivalent of the EOS 'right person, right seat' conversation. When the Accountability Chart (§22.2) shows an agent consistently off-track — Rocks incomplete, Scorecard Measurables trending wrong, trust level regressing — the Board initiates the replacement protocol."

#### §14 Phased Execution Plan

**Phase 1 Build — reframed as Q1 Rocks:**

Replace the build list with:

> **Phase 1 is Q1.** The 8-week build is the first quarterly Rock cycle. Phase 1 deliverables are Rocks. Phase 1 success metrics are Scorecard Measurables. The Level 10 Meeting begins in Week 1.

**Phase 1 Rock Sheet:**

(See Rocks table in Part 2, Component 6 above — 7 Rocks with owners and done-when criteria.)

**Phase 1 Instrument (addition):**
- Level 10 Meeting running weekly from Week 1
- Scorecard populated from Week 1 (some Measurables will read 0 until infrastructure is live — that's fine, the discipline of reviewing them starts immediately)
- Issues List active from Week 1
- Rock status reviewed weekly from Week 1
- To-Do completion rate tracked from Week 2 (first To-Dos come out of the Week 1 Level 10)
- V/TO drafted during Phase 0 (or Week 1 at latest)

**Phase 1 success metrics → Scorecard Measurables:**

The existing metrics table (§14) becomes the Phase 1 Scorecard definition. Each metric gets a Seat owner. The table format changes from `| Metric | Target |` to `| Measurable | Owner Seat | Target | Direction |`.

**Phase 2+ Rock Sheet:**

Phase 2 deliverables are also reframed as Rocks. The "Add" list in Phase 2 becomes the Q2 Rock Sheet (or Q3, depending on timing). Each item gets an owner, milestones, and done-when criteria.

**Capability gates (G1-G7) as multi-quarter Rocks:**

Gates that take multiple quarters to pass become Rocks with quarterly milestones. For example:

- **G1 (Constitutional Coverage):** Q2 Rock = "Instrument all board interventions as constitutional/judgment" (done when classification is running). Q3 Rock = "Reduce judgment interventions to < 2/month" (done when the gate condition passes for 3 months).
- **G4 (Strategic Decision Quality):** Q1 Rock = "Instrument decision reversal rate" (done when tracking is live). Q2 Rock = "Shadow-mode three-perspective evaluation running" (done when shadow mode is live and divergence rate is being measured). Q3+ Rock = "Protocol match rate > 80%" (done when the gate passes).

#### §15 Operating Cost Model

Add Level 10 + Scorecard infrastructure cost:

| Component | Cost | Notes |
|-----------|------|-------|
| Scorecard computation (utility script) | $0 | Deterministic SQL, no LLM |
| Level 10 prep package (utility script) | $0 | Deterministic aggregation |
| V/TO storage + versioning | $0 | One row in Postgres |
| Issues/Rocks/To-Dos | $0 | Uses existing task graph infrastructure |
| **EOS overlay total** | **$0/month** | No new LLM costs. No new infrastructure. Just structured views over existing data + board discipline. |

This is the P4 dream — the entire EOS overlay adds zero dollars to the operating budget. It's organizational discipline on top of existing infrastructure.

#### §19 Strategy Evaluation Protocol

Add V/TO alignment check to all evaluation tiers:

```
DECISION: [proposed action]

V/TO ALIGNMENT: Does this serve the Core Focus? Which 1-Year Plan
  goal does it advance? If neither → flag for Board review before
  proceeding with evaluation.

Evaluate across three dimensions...
(remainder unchanged)
```

The V/TO alignment check runs *before* the three-perspective evaluation. If a proposed action doesn't align with the V/TO, it's not automatically rejected — but it's flagged. The Board may decide to update the V/TO (quarterly) or reject the proposal.

Add to Decision Record Schema:

```
strategic_decisions (additions):

  vto_alignment         -- TEXT (which V/TO element this serves)
  rock_id               -- UUID (FK to rocks — which Rock does
                        --   this decision support?)
  quarter               -- TEXT (which quarterly cycle)
```

---

## Part 4: New Section for the Spec — §22 Operating Rhythm (EOS)

This is the full text of the new section to be added to the spec.

---

### §22. Operating Rhythm (EOS)

> *Added in v0.7.0. Overlays the Entrepreneurial Operating System (Traction / EOS) onto the Optimus architecture. Introduces the V/TO, Accountability Chart, Scorecard, Issues List, Core Processes, Rocks, To-Dos, and Level 10 Meeting as first-class organizational concepts. Present from Phase 1 day one.*

#### 22.1 The V/TO (Vision/Traction Organizer)

The V/TO is the Board's strategic context document. It answers eight questions that define what Optimus is, where it's going, and how it gets there. Every DIRECTIVE must reference which V/TO element it serves.

The V/TO is Board-authored only. No agent may modify it. It is Q1-tier context data — loaded first, never truncated. It is reviewed quarterly and versioned with a `config_hash` for provenance.

Schema: `vto` table in `agent_graph`. See Part 2, Component 1 for full DDL.

#### 22.2 The Accountability Chart

The Accountability Chart defines every seat in the organization, its 5 key responsibilities, and the agent currently filling it. It is a structured view over `agent_configs` enriched with runtime performance metrics (trust level, Rock status, Scorecard performance).

GWC evaluation maps to: shadow mode exit criteria (Gets it), behavioral drift detection (Wants it), per-tier guardrails (Capacity). When an agent doesn't GWC, the Board initiates the agent replacement protocol (§11).

Schema: `accountability_chart` view. See Part 2, Component 2 for full definition.

#### 22.3 The Scorecard

The Scorecard is 12-18 weekly Measurables that tell the Board whether the organization is on track. Each Measurable has an owner seat, a target, and a binary on-track / off-track status computed deterministically (no LLM).

Off-track Measurables automatically surface as Issues for the next Level 10 IDS session.

Schema: `scorecard_measurables` + `scorecard_readings` tables. See Part 2, Component 3 for full DDL and Phase 1 Scorecard definition.

#### 22.4 The Issues List + IDS

The Issues List is the single repository for all organizational problems, patterns, and obstacles. Issues are distinct from work items — they are governance artifacts resolved through the IDS process (Identify root cause, Discuss once, Solve with a decision).

Issues surface from: Scorecard off-track readings, Tier 2 Auditor findings, Board observation, agent escalation, Rock off-track status, capability gate regression.

Every Issue is resolved or killed within 3 Level 10 sessions. Resolution produces a DIRECTIVE, Rock, To-Do, process change, agent replacement, or explicit no-action decision.

Schema: `issues` table. See Part 2, Component 4 for full DDL.

#### 22.5 Core Processes — The Optimus Way

Seven core processes define how Optimus operates. They are documented in the spec (§3-§11, §19) and referenced by name in agent system prompts. Process compliance is a Scorecard concern — not just outcome quality.

1. The Execution Process (§3 + §4)
2. The Guardrail Process (§5)
3. The Review Process (§4 Reviewer + §11)
4. The Communication Process (§7)
5. The Strategy Process (§19)
6. The Audit Process (§8)
7. The Replacement Process (§11)

#### 22.6 Rocks

Rocks are 90-day priorities. 3-7 per quarter, each with an owner seat, milestones, and binary done/not-done criteria. Phase deliverables are reframed as Rocks. Capability gates (G1-G7) that span quarters become Rocks with quarterly milestones.

Rocks are reviewed weekly in the Level 10. Off-track Rocks become Issues for IDS. At quarter end, each Rock is scored done or not done — no partial credit. The quarterly Rock completion rate is an organizational health metric.

Schema: `rocks` table + `rock` type in `work_items`. See Part 2, Component 6 for full DDL.

#### 22.7 To-Dos

To-Dos are 7-day action items produced by the Level 10 Meeting's IDS process. They use the existing `work_items` table with `type = 'todo'`. Every To-Do has a 7-day deadline and a seat owner. A To-Do not completed in two consecutive weeks becomes an Issue.

To-Do completion rate (target: > 90%) is a Scorecard Measurable.

#### 22.8 The Level 10 Meeting

The Level 10 is a weekly 90-minute structured meeting. It is the operating pulse of the organization. Same day, same time, same agenda, every week.

**Agenda:** Segue (5 min) → Scorecard (5 min) → Rock Review (5 min) → Headlines (5 min) → To-Do Review (5 min) → IDS (60 min) → Conclude (5 min).

A deterministic utility script auto-prepares the meeting package weekly. The meeting produces a structured record in the `event_log`. Meeting rating (1-10) is tracked as an organizational health signal.

Phase activation: Board-only (Phase 1-2) → Board + Strategist (Phase 3) → Strategist-run with Board oversight (Phase 4).

Schema: `level_10_meetings` table. See Part 2, Component 6 for full DDL.

#### 22.9 The Quarterly Planning Session

A structured quarterly session (separate from the Level 10) where the Board reviews the V/TO, scores last quarter's Rocks, sets next quarter's Rocks, reviews the Accountability Chart, and promotes long-standing Issues to Rocks.

The Annual Planning Session follows the same structure with deeper V/TO review (10-Year Target, 3-Year Picture).

#### 22.10 Interaction with Graduated Autonomy

The EOS operating rhythm applies at every autonomy level:

| Autonomy Level | V/TO | Rocks | Scorecard | Level 10 | IDS |
|----------------|------|-------|-----------|----------|-----|
| Level 0 (Full HITL) | Board authors | Board sets | Board reviews | Board runs | Board resolves |
| Level 1 (Tactical) | Board authors | Board sets; Strategist proposes | Board reviews; Strategist flags off-track | Board runs; Strategist presents data | Board resolves; Strategist proposes tactical solutions |
| Level 2 (Strategic) | Board authors; Strategist proposes amendments | Board approves; Strategist drafts | Strategist reviews; Board monitors | Strategist co-runs | Strategist resolves tactical + strategic; Board retains existential |
| Level 3 (Constitutional) | Constitutional document | Strategist sets under constitutional constraints | Strategist reviews; Board has dashboard access | Strategist runs; meeting record in event log | Strategist resolves under constitutional constraints; Board has kill switch |

The EOS rhythm does not change across autonomy levels — the *same* meeting, *same* Scorecard, *same* Rock cycle. What changes is *who runs it.* This is how institutional knowledge transfers from humans to agents: the structure stays, the operator changes.

---

## Part 5: Schema Summary — All EOS Additions

| Table/View | Schema | Type | Purpose |
|-----------|--------|------|---------|
| `vto` | `agent_graph` | Table | Vision/Traction Organizer (board-authored) |
| `rocks` | `agent_graph` | Table | 90-day priorities with owner, milestones, criteria |
| `issues` | `agent_graph` | Table | Organizational issues for IDS resolution |
| `scorecard_measurables` | `agent_graph` | Table | Measurable definitions with targets and owners |
| `scorecard_readings` | `agent_graph` | Table | Weekly computed values for each measurable |
| `level_10_meetings` | `agent_graph` | Table | Meeting records with snapshots |
| `accountability_chart` | `agent_graph` | View | Seats + current agents + performance metrics |
| `work_items.type` | `agent_graph` | Enum addition | Add `rock`, `todo` to existing type enum |

Total: 5 new tables, 1 new view, 1 enum expansion. All within the existing `agent_graph` schema. No new schemas, no new database roles, no new infrastructure. P4 (boring infrastructure) satisfied.

---

## Part 6: Changelog Entry for v0.7.0

### v0.7.0 — 2026-02-28 `DRAFT`

**Authors:** Dustin, Claude (drafting assistance), pending Eric review
**Inputs:** EOS / Traction operating system (Gino Wickman), board directive to overlay EOS from Phase 1 day one
**Status:** EOS overlay. Introduces organizational operating rhythm vocabulary and structures across the entire spec. No infrastructure changes — organizational discipline on top of existing architecture.

**Added:**
- §22 Operating Rhythm (EOS) — new section covering V/TO (§22.1), Accountability Chart (§22.2), Scorecard (§22.3), Issues List + IDS (§22.4), Core Processes (§22.5), Rocks (§22.6), To-Dos (§22.7), Level 10 Meeting (§22.8), Quarterly Planning Session (§22.9), interaction with graduated autonomy (§22.10)
- §0 P7: Quarterly cadence, weekly pulse — new design principle
- 5 new tables: `vto`, `rocks`, `issues`, `scorecard_measurables`, `scorecard_readings`, `level_10_meetings`
- 1 new view: `accountability_chart` (over `agent_configs` + runtime metrics)
- `work_items.type` enum: added `rock`, `todo`
- Phase 1 Rock Sheet: 7 Rocks with owners, milestones, and done-when criteria (replaces build list)
- Phase 1 Scorecard: 12 Measurables with seat owners and targets
- Companion document reference: EOS overlay specification

**Changed (EOS terminology throughout):**
- §1: Added EOS operating rhythm paragraph
- §2 Agent Tiers → Accountability Chart — Seats and Tiers: added seat framing, 5 Key Responsibilities, Key Measurables column
- §2 Architecture diagram: added operating rhythm to Human Board box
- §3 Work item hierarchy: added V/TO → Rock → DIRECTIVE cascade and Issue → resolution pathway
- §3 `work_items.type` enum: added `rock`, `todo`
- §4 Context loading: added V/TO + Rocks as priority 0 context (~200-400 tokens, Q1 tier)
- §8 Dashboard → Scorecard + Dashboard: Scorecard is primary weekly interface; dashboard is on-demand drill-down
- §8 Event digests: weekly digest becomes Level 10 prep package
- §10 Cost digest: reframed as Scorecard feed item
- §11 Agent replacement: added EOS "right person, right seat" framing
- §14 Phase 1 build list → Phase 1 Rock Sheet: all deliverables reframed as Rocks with owners and criteria
- §14 Phase success metrics → Scorecard Measurables: all metrics get seat owners
- §14 Phase 2+ deliverables: reframed as future quarter Rock Sheets
- §14 Capability gates (G1-G7): reframed as multi-quarter Rocks with quarterly milestones
- §14 Phase 1 Instrument: added Level 10, Scorecard, Issues List, Rock tracking from Week 1
- §15 Cost model: added EOS overlay line item ($0/month — no new LLM or infrastructure costs)
- §19 Strategy evaluation: added V/TO alignment check before perspective evaluation; added `vto_alignment`, `rock_id`, `quarter` to decision record schema

**Not changed:**
- All infrastructure (§3-§9, §12): unchanged. EOS is organizational, not technical.
- Guardrail enforcement (§5): unchanged. EOS doesn't alter security.
- Kill switch (§9): unchanged.
- Communication Gateway (§7): unchanged.
- AutoBot Constitution (§13): unchanged (V/TO becomes constitutional in Phase 3+, but that's a Phase 3 decision).
- Legal Compliance (§17): unchanged.
- Software Composition (§18): unchanged.

**Cost impact:** $0/month additional. The entire EOS overlay uses deterministic SQL queries over existing tables, adds zero LLM invocations, and requires no new infrastructure. It is pure organizational discipline — the most boring, most proven operating system overlaid on the most boring, most proven infrastructure.

---

## Part 7: Board Decision Points

The following require Board decision before this amendment is finalized:

1. **P7 addition:** Adding a 7th design principle ("Quarterly cadence, weekly pulse"). This is a structural addition to the foundational principles. Confirm or amend.

2. **Level 10 day/time:** EOS requires same day, same time, every week. What's the Board's preferred Level 10 slot?

3. **V/TO authoring timeline:** Draft V/TO during Phase 0 (before code) or Week 1 of Phase 1? Recommendation: Phase 0. The V/TO answers "what kind of company is this" — which should be answered before building anything.

4. **Rock count for Q1:** 7 Rocks proposed (see Part 2). EOS recommends 3-7. Confirm this is the right set, or adjust. Note: Rock #5 ("Board operating rhythm established") is the meta-Rock — the Rock about establishing the system that tracks Rocks. It must be on the list.

5. **Scorecard ownership for Phase 1:** The proposed Scorecard assigns owners to seats. Since all agents are in suggest mode during Phase 1, "ownership" means the seat is *accountable for the number* — even though the Board is making all decisions. Confirm this framing.

6. **Issue aging policy:** Proposed that Issues unresolved after 3 Level 10 sessions either get solved or killed. Adjust the threshold?

7. **EOS terminology depth:** This amendment proposes using EOS language as the primary organizational vocabulary. Confirm that terms like "Rock," "Level 10," "IDS," "Scorecard," "V/TO," and "Accountability Chart" should appear in agent system prompts, event logs, and the public archive — or should they be Board-facing only?
