# GitHub Multi-Agent Ecosystem Research

A landscape scan of repos, tools, and frameworks for humans and AI agents collaborating on software development through GitHub.

*Research date: February 27, 2026*

---

## GitHub's Official Solutions

### GitHub Agentic Workflows (`github/gh-aw`)

GitHub's official approach to repo-level AI automation, launched in technical preview February 2026. You describe outcomes in plain Markdown, add it as an automated workflow, and it executes using a coding agent in GitHub Actions. Supports multiple coding agents including GitHub Copilot CLI, Claude Code, and OpenAI Codex. Workflows run with read-only permissions by default, with write operations only allowed through sanitized safe-outputs. Multiple layers of protection including sandboxed execution, input sanitization, network isolation, tool allow-listing, and compile-time validation.

- **Repo:** https://github.com/github/gh-aw
- **Examples:** https://github.com/githubnext/agentics
- **Status:** Technical preview
- **Key pattern:** Markdown-defined workflows compiled to GitHub Actions YAML

### GitHub Agent HQ

Announced at Universe 2025. A single command center to assign, steer, and track the work of multiple agents. Enterprise administrators can define which agents and models are authorized across the organization. Includes a Copilot metrics dashboard, agentic code review, and a dedicated control plane to govern AI access and agent behavior.

- **Docs:** https://github.blog/news-insights/company-news/welcome-home-agents/
- **Status:** Rolling out with Copilot Pro+ and Enterprise
- **Key pattern:** Centralized governance — who's allowed to do what, audit logging, permission systems

### Custom Agents via `agents.md`

GitHub now supports custom agents defined in `agents.md` files. Instead of one general assistant, you build a team of specialists: `@docs-agent` for technical writing, `@test-agent` for QA, `@security-agent` for security analysis. The format is used by over 60,000 open-source projects and is now stewarded by the Agentic AI Foundation under the Linux Foundation.

- **Standard:** https://agents.md/
- **Repo:** https://github.com/agentsmd/agents.md
- **Templates:** https://github.com/kunal8164705/Agents.md-Templates
- **Best practices (analysis of 2,500+ repos):** https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
- **Key findings from analysis:** Successful agents put commands early, use code examples over explanations, have well-defined boundaries, and include specific anti-patterns (what NOT to do)

---

## Standout Open Source Repos

### `AndrewAltimit/template-repo` — Full Lifecycle Agent Orchestration

The most complete reference architecture for what we're building. An agent orchestration and security template featuring six AI agents that autonomously manage the development lifecycle: Issue Created → Admin Approval → Agent Claims → PR Created → AI Review → Human Merge. Demonstrates running a council of AI agents (Claude, Gemini, Codex, OpenCode) across a shared codebase with board-driven task delegation, automated PR review, and security hardening.

- **Repo:** https://github.com/AndrewAltimit/template-repo
- **License:** Unlicense (public domain) / MIT fallback
- **Key files:** `CLAUDE.md`, `AGENTS.md`, `.agents.yaml`, docs/agents/
- **Notable:** All code changes authored by AI agents under human oversight. Includes MCP tool building, agent2agent workflows, trust measurement, and containerized tooling.
- **Why it matters:** Closest existing implementation to the human-as-orchestrator, agents-as-builders-and-reviewers model

### `ComposioHQ/agent-orchestrator` — Fleet Management for Coding Agents

Manages fleets of AI coding agents working in parallel. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

- **Repo:** https://github.com/ComposioHQ/agent-orchestrator
- **Agent-agnostic:** Claude Code, Codex, Aider
- **Runtime-agnostic:** tmux, Docker
- **Tracker-agnostic:** GitHub, Linear
- **Key commands:**
  - `ao spawn <project> <issue>` — launch an agent on a task
  - `ao status` — overview of all sessions
  - `ao send <session> "Fix the tests"` — send instructions
  - `ao dashboard` — web dashboard at localhost:3000
- **Automated reactions:**
  - CI fails → agent gets logs and fixes it
  - Reviewer requests changes → agent addresses them
  - PR approved with green CI → notification to merge
- **Why it matters:** Most practical "spawn and walk away" tool. Maps directly to the orchestrator model.

### `wshobson/agents` — Massive Agent Library for Claude Code

A comprehensive production-ready system: 112 specialized AI agents, 16 multi-agent workflow orchestrators, 146 agent skills, and 79 development tools organized into 72 focused, single-purpose plugins for Claude Code.

- **Repo:** https://github.com/wshobson/agents
- **Structure:** Plugin-based architecture with granular installs
- **Workflows:** git, full-stack, TDD, Conductor (context-driven development), Agent Teams (multi-agent orchestration)
- **Why it matters:** Shows how to structure agent specialization at scale. Good reference for organizing many agents without bloat.

### `ruvnet/ruflo` (claude-flow) — Smart Routing Orchestration

Agent orchestration platform for Claude with intelligent cost-routing. Analyzes each request and automatically routes to the cheapest handler that can do the job. Simple code transforms skip the LLM entirely using WebAssembly. Medium tasks use faster, cheaper models. Only complex architecture decisions use Opus.

- **Repo:** https://github.com/ruvnet/ruflo
- **Wiki (detailed):** https://github.com/ruvnet/claude-flow/wiki/Workflow-Orchestration
- **Key pattern:** Spec-first approach using ADRs (Architecture Decision Records) and DDD bounded contexts
- **Supports:** Fork-join, map-reduce, and sequential workflow patterns
- **Why it matters:** Cost optimization is critical when running many agents. Also has the most detailed workflow orchestration documentation.

### `OpenBMB/ChatDev` — Academic Multi-Agent Software Dev

Version 2.0 released January 2026 as a zero-code multi-agent orchestration platform. Models the software development process as roles (CEO, CTO, programmer, tester, reviewer) that communicate through structured dialogue. Academic origin but increasingly practical.

- **Repo:** https://github.com/OpenBMB/ChatDev
- **Key paper:** "Multi-Agent Collaboration via Evolving Orchestration" (NeurIPS 2025)
- **Why it matters:** The research behind it (reinforcement learning to optimize agent sequencing) is likely where all orchestration tools are headed.

### `microsoft/agent-framework` — Enterprise Multi-Agent Framework

Microsoft's framework for building, orchestrating, and deploying AI agents and multi-agent workflows. Supports Python and .NET. Actively developed with frequent releases.

- **Repo:** https://github.com/microsoft/agent-framework
- **Why it matters:** Enterprise backing, likely to become a standard for organizations on Azure/GitHub ecosystem.

---

## Meta-Resources & Curated Lists

### `hesreallyhim/awesome-claude-code`

The best index of the Claude Code ecosystem. Curated list of skills, hooks, slash-commands, agent orchestrators, applications, and plugins.

- **Repo:** https://github.com/hesreallyhim/awesome-claude-code
- **Notable entries:**
  - `davila7/claude-code-templates` — CLI tool with ready-to-use configs, agents, commands, hooks, MCPs
  - Claude Code System Prompts by Piebald AI — full system prompt documentation
  - Claude Code GitHub Actions by Anthropic — official CI/CD integration

### `kaushikb11/awesome-llm-agents`

Broader landscape of LLM agent frameworks. Last updated February 24, 2026. Covers CrewAI, Swarms, PraisonAI, OpenAgents, and dozens more.

- **Repo:** https://github.com/kaushikb11/awesome-llm-agents

### `ashishpatel26/500-AI-Agents-Projects`

500 AI agent use cases across industries with links to open-source implementations.

- **Repo:** https://github.com/ashishpatel26/500-AI-Agents-Projects

### AI Agent Workflow Orchestration Guidelines (Gist)

A battle-tested CLAUDE.md / orchestration guidelines document with strong community reception. Covers subagent delegation, verification patterns, and session management.

- **Gist:** https://gist.github.com/OmerFarukOruc/a02a5883e27b5b52ce740cadae0e4d60

---

## Key Patterns Across the Ecosystem

### 1. `agents.md` is the Emerging Standard
Not a custom invention — it's a Linux Foundation-stewarded open format used by 60K+ projects. Any governance system should build on this rather than inventing a new format.

### 2. Agent-per-Worktree Isolation
The strongest repos (ComposioHQ, AndrewAltimit) give each agent its own git worktree. This prevents agents from stepping on each other's work at the filesystem level, not just the branch level.

### 3. Automated Reaction Loops
The most mature systems don't just assign work — they handle the feedback loop automatically. CI failure → agent gets logs → agent fixes → re-run. Review comments → agent addresses → re-review. Human only enters on escalation.

### 4. Cost-Aware Routing
With multiple agents running in parallel, API costs add up fast. Ruflo's pattern of routing simple tasks to cheap/local models and reserving expensive models for complex decisions is a pattern worth adopting early.

### 5. Read-Only by Default
GitHub's own agentic workflows enforce read-only permissions by default. Write operations require explicit approval through safe outputs. This is the right security posture for any multi-agent system.

### 6. Spec-First / ADR-Driven
The best results come from defining architecture decisions and specifications before agents start coding. Agents that reference ADRs and specs produce more consistent, aligned code than agents given freeform instructions.

---

## Recommended Starting Path

1. **Adopt `agents.md` standard** — don't invent a custom format. Use the ecosystem.
2. **Study `AndrewAltimit/template-repo`** — fork it, read the CLAUDE.md and AGENTS.md, understand the full lifecycle.
3. **Install `ComposioHQ/agent-orchestrator`** — most practical tool for spawn-and-manage workflows.
4. **Watch GitHub Agentic Workflows** — technical preview now, will likely become the default within months.
5. **Reference `awesome-claude-code`** — stay current on the Claude Code ecosystem as it evolves rapidly.
6. **Layer governance on top** — use the governance framework (territory, identity, escalation, sacred files) as the organizational layer these tools assume you already have.
