/**
 * SPEC-linked writeups for architecture graph nodes.
 *
 * Each node ID maps to a spec reference + prose description that appears
 * in the inspector panel when the node is clicked. Content is sourced
 * from SPEC.md v1.0.0 (2026-03-10).
 */

export interface Writeup {
  specRef: string;       // e.g. "§3" or "§5, ADR-017"
  title: string;         // Section title from SPEC
  paragraphs: string[];  // 1-3 concise paragraphs
}

const writeups: Record<string, Writeup> = {
  // ── GOVERNANCE ──────────────────────────────────────────
  "gov-principles": {
    specRef: "§0",
    title: "Design Principles",
    paragraphs: [
      "Six foundational rules governing every architectural decision. P1 (Deny by default) means no capability is granted unless explicit. P2 (Infrastructure enforces; prompts advise) means constitutional rules are enforced by DB roles, JWT, and schema constraints — never by prompt instructions alone.",
      "P3 (Transparency by structure) ensures every state transition, LLM call, and guardrail check is logged automatically. P4 (Boring infrastructure) restricts the stack to Postgres, SQL, JWT, and hash chains. P5 (Measure before you trust) gates capabilities on data, not dates. P6 (Familiar interfaces) means the system adapts to humans via email, Slack, and dashboards.",
    ],
  },
  "gov-board": {
    specRef: "§1, §2",
    title: "Board of Directors",
    paragraphs: [
      "Optimus is a fully agent-staffed technology organization where every operational role is an AI agent, governed by a human board. The board (Dustin & Eric) sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.",
      "During Phase 1, the Strategist runs in suggest mode — it proposes, the board approves or rejects. No agent can deploy, modify infrastructure, or make binding commitments without board authorization.",
    ],
  },
  "gov-spec": {
    specRef: "§2, §14",
    title: "Canonical Architecture Specification",
    paragraphs: [
      "SPEC.md is the single source of truth for Optimus architecture. Changes require both board members' review. The spec defines agent tiers, behavioral contracts, guardrail enforcement, the task graph, and the phased execution plan.",
      "CONSTITUTION.md contains the prescriptive governance constraints extracted from the spec — design principles, Lethal Trifecta assessment, Kill Switch architecture, and legal compliance requirements. It serves as the audit reference document.",
    ],
  },

  // ── INTEGRATIONS ────────────────────────────────────────
  "int-gmail": {
    specRef: "§7",
    title: "Communication Gateway — Email",
    paragraphs: [
      "The Communication Gateway is the highest-risk component per the Lethal Trifecta assessment (private data + untrusted content + external comms). Agents never hold communication credentials directly.",
      "Inbound email is processed deterministically: channel receiver → sanitizer (rule-based, no AI on raw message) → structured extractor → sender verification (SPF/DKIM/DMARC) → intent classifier. Outbound is risk-tiered from auto-send (transactional) to human-in-loop (legal/regulatory).",
    ],
  },
  "int-slack": {
    specRef: "§7",
    title: "Communication Gateway — Slack",
    paragraphs: [
      "Slack connects via Socket Mode for real-time event delivery. Like all channels, inbound messages pass through the Communication Gateway's sanitization pipeline before any agent sees the content.",
      "All outbound messages include AI disclosure (FTC §5, CA SB 1001, EU AI Act Article 50) and a 5-minute cool-down buffer before send, providing a kill switch activation window.",
    ],
  },
  "int-linear": {
    specRef: "§7",
    title: "Communication Gateway — Linear",
    paragraphs: [
      "Linear webhooks deliver issue and project events via HMAC-verified payloads. Config gates filter which teams, projects, and labels are in scope — deny-by-default (P1).",
      "Linear signals feed the task graph for automated ticket triage, creating work items that flow through the orchestrator for agent assignment.",
    ],
  },
  "int-github": {
    specRef: "§7",
    title: "Communication Gateway — GitHub",
    paragraphs: [
      "GitHub connects via App authentication (RS256 JWT → installation token) with webhook delivery. Events include issue comments, PR events, and label changes.",
      "The executor-coder agent uses the Git Trees API for atomic commits, creating PRs on feature branches. GitHub App credentials are managed by infrastructure, never exposed to agents.",
    ],
  },
  "int-drive": {
    specRef: "§7",
    title: "Communication Gateway — Google Drive",
    paragraphs: [
      "The Drive folder watcher polls registered capture sources for new files and ingests them — transcript sources become webhook channel messages (meetings), other kinds become registry artifacts. Gemini/tl;dv meeting transcripts are the primary use case.",
      "Content is sanitized and structured before entering the pipeline. Drive folders are registered self-serve via the Capture page (content.capture_sources table); the watcher prefers service-account-direct access over domain-wide impersonation (ADR-016).",
    ],
  },
  "int-telegram": {
    specRef: "§7",
    title: "Communication Gateway — Telegram",
    paragraphs: [
      "Telegram connects via the Bot API for message delivery. Like all channels, it passes through the adapter layer and Communication Gateway sanitization pipeline.",
      "Telegram is currently configured but not actively processing signals. The adapter pattern (ADR-008) means adding channel support requires only an InputAdapter/OutputAdapter implementation.",
    ],
  },

  // ── ROUTING ─────────────────────────────────────────────
  "sys-adapter": {
    specRef: "§7, ADR-008",
    title: "Adapter Layer",
    paragraphs: [
      "The adapter pattern (ADR-008) abstracts channel I/O through InputAdapter and OutputAdapter interfaces. Each channel implements these interfaces, allowing new channels to be added without modifying core pipeline logic.",
      "Adapters handle protocol-specific concerns (OAuth, Socket Mode, webhooks) while producing a unified message format for downstream processing. Currently 8 adapters are registered. Note: Board Workstation inputs bypass the adapter layer by design \u2014 they enter the system directly via task graph, governance intake, or prompt-to-PR paths.",
    ],
  },
  "sys-config": {
    specRef: "§5, §6",
    title: "Config Gates",
    paragraphs: [
      "Config gates implement P1 (deny-by-default) for inbound signals. Only events matching explicit scope rules — watched Linear teams/projects, GitHub repos, label triggers — are admitted to the pipeline.",
      "This is the first enforcement boundary: raw signals that don't match config gate rules are dropped before reaching the orchestrator, preventing unbounded work item creation.",
    ],
  },
  "router-orchestrator": {
    specRef: "§2, §3",
    title: "Orchestrator",
    paragraphs: [
      "The Orchestrator (Sonnet tier) decomposes incoming work into tasks and assigns them to downstream agents. It uses an explicit can_assign_to list — no globs — ensuring delegation authority is infrastructure-enforced (P2).",
      "The receptionist pattern classifies inbound signals: FYI → log only, Noise → archive, Feedback → ticket pipeline, Complex analysis → strategist, Simple response → responder. Classification is stored as routing_class on work items for misclassification tracking.",
    ],
  },
  "sys-taskgraph": {
    specRef: "§3",
    title: "Task Graph",
    paragraphs: [
      "The Postgres DAG (agent_graph schema, 12 tables + 5 views) replaces email for agent coordination. It preserves accountability while adding atomicity, idempotent processing, and 3-5x lower token cost (~200 tokens vs 2,000-10,000 for email threads).",
      "Work items follow a strict state machine: created → assigned → in_progress → review → completed. Failed tasks retry up to 3 times then escalate. guardCheck() and transition_state() execute as a single atomic Postgres transaction to prevent race conditions.",
    ],
  },
  "sys-eventbus": {
    specRef: "§3, §5a",
    title: "Event Bus",
    paragraphs: [
      "pg_notify provides low-latency event notification without an external message queue (P4 — boring infrastructure). Events signal task state changes, driving the agent runtime loop.",
      "The same pg_notify mechanism synchronizes the Neo4j knowledge graph via an outbox table pattern. pg_notify is used for signaling, not durability — Postgres transactions are the durability layer.",
    ],
  },

  // ── ENFORCEMENT (RIGHT COLUMN) ──────────────────────────
  "sys-guardrails": {
    specRef: "§5",
    title: "Constitutional Gates",
    paragraphs: [
      "The orchestration layer (not agents) enforces all guardrails via infrastructure (P2). guardCheck() and transition_state() execute as a single atomic Postgres transaction, preventing race conditions on budget checks.",
      "Gates G1-G11 cover: G1 budget pre-authorization, G2 commitment detection (no binding obligations), G3 voice tone matching, G4 autonomy level, G5 reversibility (drafts > sends), G6 stakeholder protection (no spam/misleading content), G7 precedent flagging (pricing/timeline/policy), G8 prompt-injection screening, G9 auto-classifier (Claude Code YOLO pattern), G10 spend cap, and G11 retrospective gate. Agents cannot self-police — enforcement is a side effect of the infrastructure they operate within.",
    ],
  },
  "sys-permissions": {
    specRef: "§5, §6, ADR-017",
    title: "Permission Grants",
    paragraphs: [
      "A unified permission_grants table (agent_graph schema) provides a single governance surface for tools, adapters, API clients, and subprocesses. checkPermission() and requirePermission() are wired at actual call sites.",
      "57 grandfathered grants were seeded at creation. Every tool invocation is logged in tool_invocations with resource_type and work_item_id columns for full audit traceability.",
    ],
  },
  "sys-signals": {
    specRef: "ADR-014",
    title: "Signal System",
    paragraphs: [
      "ADR-014 introduced dimensional signal classification: type + direction + domain instead of flat taxonomy expansion. 9 signal types (commitment, deadline, request, question, approval_needed, decision, introduction, info, action_item) cover all inbound intent categories.",
      "15 contact types with auto-computed tiers (inner_circle, active, inbound_only, automated, newsletter, unknown) and a relationship_strength view enable the dashboard's OWE/WAITING/CONNECT routing.",
    ],
  },
  "sys-voice": {
    specRef: "§4",
    title: "Voice System",
    paragraphs: [
      "The voice system ensures outbound communications match each user's natural tone. The profile builder analyzes sent email to extract voice characteristics; the few-shot selector picks exemplar messages for in-context learning.",
      "Tone scoring validates that generated responses match the target voice profile before sending. The voice system is email-specific and should not be reused for content generation (different constraints apply).",
    ],
  },

  // ── DATA STORES ─────────────────────────────────────────
  "store-pg": {
    specRef: "§12",
    title: "Database Architecture",
    paragraphs: [
      "PostgreSQL is the primary operational store with 5 isolated schemas: agent_graph (task coordination), inbox (message processing), voice (tone profiles), signal (classification), and content (Phase 1.5). No cross-schema foreign keys — schemas are isolated by database roles.",
      "Append-only audit tables use hash chains (SHA-256, checkpoint every 10K rows or 1 hour). All queries are parameterized — no string interpolation (P2). Monetary columns use NUMERIC(15,6) with banker's rounding.",
    ],
  },
  "store-neo4j": {
    specRef: "§5a",
    title: "Knowledge Graph Layer",
    paragraphs: [
      "Neo4j serves as an advisory learning layer alongside Postgres. It stores capability graphs, outcome patterns, and decision history. No enforcement moves to Neo4j — all constitutional gates stay in Postgres (P2).",
      "Only Strategist, Architect, and Orchestrator can access reflect() to query Neo4j; Reviewers and Executors have no access (P1). Graceful degradation: Neo4j down = empty reflect() results, no error, Postgres continues normally.",
    ],
  },
  "store-redis": {
    specRef: "§4",
    title: "Runtime Cache",
    paragraphs: [
      "Redis provides API key caching with AES-256-GCM encryption. It serves as the ephemeral data layer for rate limiting and session state that doesn't require Postgres durability.",
    ],
  },

  // ── OUTPUTS ─────────────────────────────────────────────
  "board-workstation": {
    specRef: "\u00A78, \u00A714",
    title: "Board Workstation \u2014 Unified Input",
    paragraphs: [
      "The Board Workstation (port 3200) provides 5 input paths for the human board: Change (prompt-to-PR via Git Trees API), Ask (spec-aware Q&A), Research (URL analysis and gap detection), Intake (governance submissions classified against CONSTITUTION.md), and Directives (direct work item creation in the task graph).",
      "A two-layer auto-classifier routes input without requiring manual chip selection: deterministic heuristics handle obvious cases instantly (bare URLs \u2192 research, short questions \u2192 ask, change keywords with context files \u2192 change), while DeepSeek v3 via OpenRouter classifies ambiguous input at negligible cost (~$0.0001/call). Manual chip overrides remain available.",
      "Board inputs intentionally bypass the adapter layer \u2014 they are not external signals but governance actions. Directives create work items directly in the task graph, governance submissions route through constitutional audit, and prompt-to-PR commits bypass the agent pipeline entirely via the Git Trees API.",
    ],
  },
  "out-board-dash": {
    specRef: "§8, §14",
    title: "Board Dashboard",
    paragraphs: [
      "The Board Workstation (port 3200) provides the human governance interface: prompt-to-PR pipeline, architecture graph visualization, governance inbox for submissions, and system controls.",
      "GitHub OAuth gates access to staqsIO org members. The dashboard proxies all API calls server-side — no credentials are exposed to the browser.",
    ],
  },
  "out-inbox-dash": {
    specRef: "§8",
    title: "Inbox Dashboard",
    paragraphs: [
      "The Inbox Dashboard (port 3100) provides the email operations view for autobot-inbox. It surfaces signal classifications, agent activity, voice profile status, and action proposals.",
    ],
  },
  "out-actions": {
    specRef: "§7",
    title: "Action Proposals",
    paragraphs: [
      "Action proposals are the system's outbound outputs: email replies (executor-responder), pull requests (executor-coder), and tickets (executor-ticket). All outbound actions pass through the Communication Gateway's risk-tiered release process.",
    ],
  },
  "out-briefing": {
    specRef: "§8",
    title: "Daily Briefing",
    paragraphs: [
      "Event digests summarize system activity: daily brief, weekly detailed report, and on-event escalation for violations. The cost tracking utility agent sends daily cost digests to the board via their preferred channel.",
    ],
  },
  "out-archive": {
    specRef: "§8, P3",
    title: "Public Event Archive",
    paragraphs: [
      "Every state transition is logged to an immutable, hash-chained event archive (P3 — transparency by structure). Monthly partitioned state_transitions tables with SHA-256 hash chains provide tamper-evident audit history.",
      "The archive is the foundation of the three-tier audit system: Tier 1 deterministic checks run every cycle at $0 cost, catching ~70% of violations.",
    ],
  },
};

/**
 * Agent-tier writeups keyed by tier name.
 * Used for agent nodes where the writeup depends on the agent's tier.
 */
export const tierWriteups: Record<string, Writeup> = {
  strategist: {
    specRef: "§2",
    title: "Strategist Tier",
    paragraphs: [
      "Strategist agents (Opus) have full graph read access and can create DIRECTIVEs for cross-domain synthesis. In Phase 1, they run in suggest mode — proposing actions for board approval rather than executing autonomously.",
      "Cannot deploy or modify infrastructure. Strategists access Neo4j's reflect() for pattern-based decision support.",
    ],
  },
  architect: {
    specRef: "§2",
    title: "Architect Tier",
    paragraphs: [
      "Architect agents (Sonnet) handle technical architecture and system design. They can read the task graph and design solutions, but cannot assign tasks to executors directly — all assignments route through the Orchestrator.",
    ],
  },
  orchestrator: {
    specRef: "§2, §3",
    title: "Orchestrator Tier",
    paragraphs: [
      "Orchestrator agents (Sonnet) decompose tasks, assign them to executors via explicit can_assign_to lists (no globs), and aggregate results. They are the routing hub of the task graph.",
      "Cannot create DIRECTIVEs. Assignment authority is enforced by DB triggers (agent_assignment_rules table), not prompt instructions.",
    ],
  },
  reviewer: {
    specRef: "§2",
    title: "Reviewer Tier",
    paragraphs: [
      "Reviewer agents (Sonnet) validate executor output on three dimensions: correctness, format, and completeness. They have read-only access to executor work and get 1 round of feedback before escalating.",
      "Reviewers validate against behavioral contracts with measurable success criteria, not subjective judgment.",
    ],
  },
  executor: {
    specRef: "§2, §4",
    title: "Executor Tier",
    paragraphs: [
      "Executor agents (Haiku) implement specific tasks within tight constraints: cannot initiate tasks, cannot read other executors' work, hard token limits. Code tasks get dedicated git worktrees for filesystem isolation.",
      "The eight-step runtime loop (AWAIT → CHECK → GUARDRAIL PRE → LOAD CONTEXT → EXECUTE → GUARDRAIL POST → TRANSITION → AWAIT) governs all executor activity.",
    ],
  },
};

export function getWriteup(nodeId: string): Writeup | undefined {
  return writeups[nodeId];
}

export function getAgentWriteup(tier: string): Writeup | undefined {
  return tierWriteups[tier.toLowerCase()];
}
