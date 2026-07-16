export interface ExpertProfile {
  id: string;
  name: string;
  systemPrompt: string;
  defaultFiles: string[];
}

export const EXPERTS: Record<string, ExpertProfile> = {
  strategy: {
    id: "strategy",
    name: "Strategy Analysis",
    systemPrompt: `You are a strategy analyst for the Optimus project — a governed agent organization building AI-powered products.

Analyze questions through the lens of market positioning, product direction, pricing models, competitive dynamics, and growth strategy. When relevant, reference:
- Spec §14-§15 for phase milestones and exit criteria
- Product specs in products/ for future revenue streams
- Current capabilities in autobot-inbox for what's shipped vs. planned

Be direct about trade-offs. Frame recommendations in terms of business outcomes. Cite specific files and sections.`,
    defaultFiles: [
      "spec/SPEC.md",
      "CLAUDE.md",
      "products/README.md",
    ],
  },

  architecture: {
    id: "architecture",
    name: "Architecture Review",
    systemPrompt: `You are a technical architect reviewing the Optimus system — a governed agent organization backed by a Postgres task graph.

Analyze questions through the lens of system design, agent tier hierarchy, database schema, code patterns, and infrastructure decisions. Reference:
- Spec §2-§5 for agent tiers, task graph, and guardrail enforcement
- ADRs for rationale behind key decisions
- Database migrations for schema evolution
- Design principles P1-P6 (especially P2: infrastructure enforces, P4: boring infrastructure)

Be precise about implementation details. Identify architectural implications of changes. Cite specific spec sections and ADR numbers.`,
    defaultFiles: [
      "spec/SPEC.md",
      "autobot-inbox/CLAUDE.md",
      "autobot-inbox/docs/internal/system-architecture.md",
      "autobot-inbox/docs/internal/database-architecture.md",
    ],
  },

  governance: {
    id: "governance",
    name: "Governance & Spec",
    systemPrompt: `You are a governance expert for the Optimus project — reviewing constitutional law, spec evolution, and organizational decisions.

Analyze questions through the lens of the governing specification, design principles, open questions, and decision history. Reference:
- Spec §0 design principles (P1-P6) as the constitutional foundation
- Open questions for unresolved governance items
- Decision records for precedent
- Conversation history for context on how decisions evolved

Frame answers in terms of what the spec says, what's unresolved, and what requires board decision. Be clear about the distinction between spec-mandated behavior and implementation choices.`,
    defaultFiles: [
      "spec/SPEC.md",
      "spec/open-questions/README.md",
    ],
  },

  operations: {
    id: "operations",
    name: "Operations & Pipeline",
    systemPrompt: `You are an operations expert for the Optimus project — focused on what's currently running, how agents process work, and operational health.

Analyze questions through the lens of the live agent pipeline, constitutional gates, cost model, and what's actually shipped. Reference:
- Agent configuration for what's deployed
- Constitutional gates G1-G7 for enforcement
- Cost model for budget implications
- Changelog for what's shipped and when

Be concrete about current state vs. planned state. Ground answers in what the system actually does today, not aspirational architecture.`,
    defaultFiles: [
      "autobot-inbox/CLAUDE.md",
      "autobot-inbox/config/agents.json",
      "autobot-inbox/docs/internal/constitutional-gates.md",
      "autobot-inbox/docs/internal/cost-model.md",
    ],
  },
};

export const DOCUMENT_INDEX: { path: string; description: string }[] = [
  // Root
  { path: "CLAUDE.md", description: "Project-wide guidance — workspace structure, code conventions, design principles, documentation triggers" },
  { path: "ONBOARDING.md", description: "Onboarding guide for new contributors to the Optimus project" },

  // Spec — core
  { path: "spec/SPEC.md", description: "Canonical architecture specification v0.8.0 — agent tiers, task graph, guardrails, phases, constitutional layer" },
  { path: "spec/CLAUDE.md", description: "Spec workspace conventions for contributing to SPEC.md and conversation entries" },
  { path: "spec/CHANGELOG.md", description: "Version history of spec changes following Keep a Changelog format" },
  { path: "spec/multi-user-engineering-plan.md", description: "Engineering plan for multi-user Optimus instances" },

  // Spec — agents
  { path: "spec/agents/AGENTS.md", description: "Agent system overview — tier hierarchy, role descriptions, capability boundaries" },
  { path: "spec/agents/strategist.md", description: "Strategist agent definition — Claude Opus, suggest-mode, strategic planning" },
  { path: "spec/agents/architect.md", description: "Architect agent definition — Claude Sonnet, technical design, system architecture" },
  { path: "spec/agents/orchestrator-eng.md", description: "Orchestrator agent definition — Claude Sonnet, task decomposition, assignment" },
  { path: "spec/agents/reviewer-backend.md", description: "Reviewer agent definition — Claude Sonnet, QA, 1-round feedback then escalate" },
  { path: "spec/agents/executor-01.md", description: "Executor agent definition — Haiku 4.5, implementation, hard token limit" },

  // Spec — decisions
  { path: "spec/decisions/001-email-vs-task-graph.md", description: "ADR-001: Chose Postgres task graph over email for agent coordination" },
  { path: "spec/decisions/002-individual-install-over-multi-tenant.md", description: "ADR-002: Individual install per user, not shared multi-tenant database" },
  { path: "spec/decisions/003-cve-auto-patch-policy.md", description: "ADR-003: CVE auto-patching policy — awaiting board decision" },

  // Spec — conversations (recent)
  { path: "spec/conversation/009-dustin-github-workflow-architecture.md", description: "Dustin's proposal for GitHub-based workflow architecture" },
  { path: "spec/conversation/010-dustin-github-multiagent-ecosystem-research.md", description: "Research on existing multiagent ecosystems using GitHub" },
  { path: "spec/conversation/011-dustin-den-dom-proposal.md", description: "DEN/DOM organizational model proposal from Dustin" },
  { path: "spec/conversation/012-eric-linkedin-content-automation.md", description: "LinkedIn content automation proposal — Phase 1.5 accepted" },
  { path: "spec/conversation/013-eric-workstream-separation.md", description: "Workstream separation proposal — ship product before platform" },

  // Spec — open questions & research
  { path: "spec/open-questions/README.md", description: "Tracked governance questions — resolved, deferred, and open items awaiting board decisions" },
  { path: "spec/research-questions/REGISTRY.md", description: "Registry of 26 research questions organized by phase and measurement gate" },

  // Spec — reference materials
  { path: "spec/reference/eos-overlay-v0.7.0-draft.md", description: "EOS overlay architecture draft for organizational operating system" },
  { path: "spec/reference/phase1-build-sequence-and-gap-analysis.md", description: "Phase 1 build sequence with gap analysis for remaining work" },

  // Spec — reviews
  { path: "spec/reviews/2026-02-27-linus-agents-md-review.md", description: "Linus security review of agent definitions" },
  { path: "spec/reviews/2026-02-27-liotta-agents-md-eval.md", description: "Liotta architecture evaluation of agent definitions" },

  // autobot-inbox — product config
  { path: "autobot-inbox/CLAUDE.md", description: "Product implementation guidance — build commands, env vars, schema, gates, agent pipeline" },
  { path: "autobot-inbox/config/agents.json", description: "Config-driven agent selection — maps agent roles to models and capabilities (ADR-009)" },
  { path: "autobot-inbox/package.json", description: "Node.js dependencies and npm scripts for autobot-inbox" },

  // autobot-inbox — internal docs
  { path: "autobot-inbox/docs/internal/system-architecture.md", description: "System architecture overview — modules, data flow, integration points" },
  { path: "autobot-inbox/docs/internal/database-architecture.md", description: "Database schema architecture — 5 schemas, migration history, relationships" },
  { path: "autobot-inbox/docs/internal/agent-pipeline.md", description: "Agent pipeline description — poll loop, claim-execute-transition, handler functions" },
  { path: "autobot-inbox/docs/internal/constitutional-gates.md", description: "Constitutional gates G1-G7 — enforcement rules, budget checks, tone matching" },
  { path: "autobot-inbox/docs/internal/cost-model.md", description: "Cost modeling — per-agent token costs, budget tracking, rate limiting" },
  { path: "autobot-inbox/docs/internal/graduated-autonomy.md", description: "Graduated autonomy levels — how agents earn more capability over time" },
  { path: "autobot-inbox/docs/internal/voice-system.md", description: "Voice profile system — email-specific tone matching via few-shot examples" },

  // autobot-inbox — ADRs
  { path: "autobot-inbox/docs/internal/adrs/001-metadata-only-email-storage.md", description: "ADR-001: Store email metadata only, not full body content" },
  { path: "autobot-inbox/docs/internal/adrs/002-zero-llm-orchestrator.md", description: "ADR-002: Orchestrator uses zero LLM calls — pure SQL state machine" },
  { path: "autobot-inbox/docs/internal/adrs/003-conditional-strategist-routing.md", description: "ADR-003: Route to strategist only when needed, not on every message" },
  { path: "autobot-inbox/docs/internal/adrs/004-pglite-to-docker-postgres.md", description: "ADR-004: Migrated from PGlite to Docker Postgres for production" },
  { path: "autobot-inbox/docs/internal/adrs/005-task-graph-over-message-queue.md", description: "ADR-005: Task graph over message queue for agent coordination" },
  { path: "autobot-inbox/docs/internal/adrs/006-append-only-audit-trail.md", description: "ADR-006: Append-only audit trail with hash chains" },
  { path: "autobot-inbox/docs/internal/adrs/007-state-changed-routing-fix.md", description: "ADR-007: Fixed state-changed event routing for proper agent handoffs" },
  { path: "autobot-inbox/docs/internal/adrs/008-adapter-pattern-for-multi-channel.md", description: "ADR-008: InputAdapter/OutputAdapter pattern for email, Slack, webhook channels" },
  { path: "autobot-inbox/docs/internal/adrs/009-config-driven-agent-selection.md", description: "ADR-009: agents.json replaces hardcoded imports in src/index.js" },
  { path: "autobot-inbox/docs/internal/adrs/010-tool-sandboxing-and-architect-routing.md", description: "ADR-010: 4-layer tool execution + DB trigger for architect assignment enforcement" },
  { path: "autobot-inbox/docs/internal/adrs/011-voice-edit-delta-feedback-loop.md", description: "ADR-011: Track voice edits to improve profile accuracy over time" },
  { path: "autobot-inbox/docs/internal/adrs/012-graduated-escalation.md", description: "ADR-012: Graduated escalation — retry, escalate tier, then alert board" },
  { path: "autobot-inbox/docs/internal/adrs/013-unified-action-proposals.md", description: "ADR-013: Unified action proposals for all agent-initiated changes" },
  { path: "autobot-inbox/docs/internal/adrs/014-signal-taxonomy-v2.md", description: "ADR-014: Signal taxonomy v2 — structured categories for extracted signals" },

  // autobot-inbox — external docs
  { path: "autobot-inbox/docs/external/product-overview.md", description: "Product capability overview for stakeholders" },
  { path: "autobot-inbox/docs/external/changelog.md", description: "Product changelog — shipped features in Keep a Changelog format" },
  { path: "autobot-inbox/docs/external/getting-started.md", description: "User getting started guide — setup, configuration, first run" },
  { path: "autobot-inbox/docs/external/cli-guide.md", description: "CLI command reference — inbox, briefing, voice, directive, send, review, stats, halt" },
  { path: "autobot-inbox/docs/external/dashboard-guide.md", description: "Dashboard user guide for the Next.js board interface" },

  // autobot-inbox — key source files
  { path: "autobot-inbox/src/index.js", description: "Main entry point — agent loop orchestration, config-driven agent loading" },
  { path: "autobot-inbox/src/api.js", description: "HTTP API server — REST endpoints, requireAuth middleware, kill switch" },
  { path: "autobot-inbox/src/db.js", description: "Database connection pool and parameterized query utilities" },

  // autobot-inbox — agents
  { path: "autobot-inbox/src/agents/strategist.js", description: "Strategist agent — Claude Opus, strategic planning, suggest-mode in Phase 1" },
  { path: "autobot-inbox/src/agents/architect.js", description: "Architect agent — Claude Sonnet, technical design decisions" },
  { path: "autobot-inbox/src/agents/orchestrator.js", description: "Orchestrator agent — task decomposition, assignment via can_assign_to list" },
  { path: "autobot-inbox/src/agents/executor-triage.js", description: "Triage executor — Haiku 4.5, classifies incoming emails" },
  { path: "autobot-inbox/src/agents/executor-responder.js", description: "Responder executor — Haiku 4.5, generates email draft responses" },
  { path: "autobot-inbox/src/agents/reviewer.js", description: "Reviewer agent — Claude Sonnet, QA on executor output, 1-round feedback" },

  // autobot-inbox — runtime
  { path: "autobot-inbox/src/runtime/agent-loop.js", description: "Generic claim-execute-transition loop — all agents share this runtime" },
  { path: "autobot-inbox/src/runtime/state-machine.js", description: "Task state machine — created, assigned, in_progress, review, completed" },
  { path: "autobot-inbox/src/runtime/guard-check.js", description: "Constitutional gates G1-G7 — atomic enforcement via Postgres transaction" },
  { path: "autobot-inbox/src/runtime/context-loader.js", description: "Context assembly — loads relevant data for agent prompts within budget" },

  // autobot-inbox — key migrations
  { path: "autobot-inbox/sql/001-agent-graph.sql", description: "Core task graph schema — work_items, typed DAG edges, state transitions" },
  { path: "autobot-inbox/sql/002-messages.sql", description: "Email message metadata storage (no body content)" },
  { path: "autobot-inbox/sql/003-voice.sql", description: "Voice profiles schema — per-user tone matching" },
  { path: "autobot-inbox/sql/004-signal.sql", description: "Signal extraction schema — priority signals from messages" },
  { path: "autobot-inbox/sql/011-constitutional-layer.sql", description: "Constitutional gates G1-G7 as DB constraints" },
  { path: "autobot-inbox/sql/023-content.sql", description: "Content generation schema for Phase 1.5 LinkedIn pipeline" },
  { path: "autobot-inbox/sql/024-tool-sandboxing.sql", description: "Tool registry and execution sandboxing (ADR-010)" },
  { path: "autobot-inbox/sql/026-assignment-enforcement.sql", description: "DB-trigger-enforced agent assignment rules" },
  { path: "autobot-inbox/sql/030-contact-classification.sql", description: "Contact classification from Google Contacts sync" },
  { path: "autobot-inbox/sql/031-signal-taxonomy-v2.sql", description: "Signal taxonomy v2 structured categories (ADR-014)" },

  // Future products
  { path: "products/README.md", description: "Future product roadmap — planned Optimus product portfolio" },
  { path: "products/deep-thought/spec.md", description: "Deep Thought product specification" },
  { path: "products/ssl-compiler/prd.md", description: "SSL Compiler product requirements document" },
];

export const ROUTER_PROMPT = `You are a routing assistant for the Optimus Board Workstation — a governed agent organization monorepo.

Given a user's message and the document index below, determine:
1. Whether this is a "question" (wants information) or a "command" (wants to trigger agent work)
2. Which expert perspective is most appropriate: "strategy", "architecture", "governance", or "operations"
3. Which 3-8 files from the index are most relevant

Expert descriptions:
- "strategy": Market analysis, pricing, competitive positioning, product direction, revenue models
- "architecture": Technical design, agent tiers, database schema, code patterns, infrastructure decisions
- "governance": Constitutional law, spec evolution, open questions, decisions, phase transitions
- "operations": Current pipeline status, agent config, gates, cost model, what's shipped

Command detection — if the user wants to CREATE work, ASSIGN a task, have an agent DO something, or issue a DIRECTIVE, classify as "command". Examples:
- "Have the architect review X" → command
- "Create a task for executor-coder to fix Y" → command
- "Assign Jamie to work on Z" → command
- "Is the SPEC up to date?" → question
- "What's the budget status?" → question

Available agents for commands: orchestrator, strategist, architect, reviewer, executor-triage, executor-responder, executor-ticket, executor-coder, executor-redesign

Jamie dispatch: When the user refers to "Jamie", "the M1", "the Mac", or "the runner", they mean executor-coder running on the remote M1 Mac. Map "Jamie" → executor-coder with jamie: true. Examples:
- "Have Jamie fix the login bug" → command, assignTo: "executor-coder", jamie: true
- "Send this to the M1" → command, assignTo: "executor-coder", jamie: true
- "Create a task for executor-coder to fix Y" → command, assignTo: "executor-coder", jamie: true

Respond with JSON only (no markdown fences, no explanation outside the JSON):

For questions:
{
  "intent": "question",
  "expert": "strategy" | "architecture" | "governance" | "operations",
  "files": ["path/to/file1.md", "path/to/file2.md"],
  "reasoning": "One sentence explaining your routing decision"
}

For commands:
{
  "intent": "command",
  "expert": "operations",
  "files": [],
  "reasoning": "One sentence explaining the command",
  "command": {
    "title": "Short task title",
    "description": "What the agent should do",
    "assignTo": "agent-id from the list above",
    "jamie": true | false,
    "priority": 1-5
  }
}`;
