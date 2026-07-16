# Agent Organization Architecture — Specification Draft

> **Document version:** 0.1 — Initial architecture sketch
> **Relationship to ADK:** Builds on ADK Phases 1–6 primitives. Could become Phase 8 or a standalone product built on ADK's foundation.

---

## The Core Idea

A fully agent-staffed technology company where every role — from CEO to junior developer — is an AI agent, governed by a human board of directors. Agents communicate via email, creating a natural audit trail that mirrors how human organizations already work.

The human board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

---

## Why Email as the Communication Protocol

Email is not a novel choice. That's the point.

**Accountability by default.** Every message has a sender, recipient, timestamp, subject, and body. You don't need to build audit infrastructure — email *is* audit infrastructure. When the board asks "why did the CTO approve this architecture?", you search the CTO agent's sent mail.

**Asynchronous by nature.** Agents don't need to be "online" at the same time. A CEO agent can send a directive at 2am, and the VP Engineering agent processes it when its queue comes up. This matches how real distributed teams work and eliminates the need for a complex real-time orchestration layer.

**Existing tooling.** Email has decades of tooling: search, filtering, forwarding, threading, archiving, legal discovery, compliance frameworks. Gmail and Outlook APIs are mature and well-documented. You don't need to build a dashboard from scratch — the board can literally read their agents' email.

**Human-readable.** The board can open any agent's inbox and understand what's happening without learning a new interface. A lawyer doing due diligence can read the email trail. An auditor can search for all messages containing "production deployment."

**Delegation chains are visible.** When the CEO agent emails the CTO agent who emails the Tech Lead agent who emails the Developer agent, that chain is a threaded conversation. You can trace any decision from top to bottom.

**Error recovery.** If an agent crashes or needs to be replaced, its entire work history is in its inbox and sent mail. The replacement agent can read the backlog and pick up where the predecessor left off — exactly how a new human employee would read old emails to get up to speed.

---

## Organizational Structure

### The Agent Hierarchy

```
┌──────────────────────────────────────────────────┐
│              HUMAN BOARD OF DIRECTORS             │
│  (Strategy, Ethics, Budget, Legal, Oversight)     │
│                                                   │
│  Communicates via: Board email → CEO agent inbox   │
│  Reviews via: Agent email archives + dashboards    │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│                  CEO AGENT                        │
│  Model: Claude (high reasoning)                   │
│  Role: Interpret board directives, allocate       │
│        resources, coordinate department heads     │
│  Email: ceo@agentcorp.ai                         │
└────────┬──────────────┬──────────────┬───────────┘
         │              │              │
         ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  CTO AGENT   │ │  VP ENG      │ │  VP PRODUCT  │
│  Claude      │ │  AGENT       │ │  AGENT       │
│              │ │  Claude      │ │  Claude      │
│  cto@...     │ │  vpeng@...   │ │  vpprod@...  │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  TECH LEADS  │ │  TEAM LEADS  │ │  PM AGENTS   │
│  Claude /    │ │  Claude /    │ │  Claude /    │
│  Mid-tier    │ │  Mid-tier    │ │  Mid-tier    │
│              │ │              │ │              │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       ▼                ▼                ▼
┌──────────────────────────────────────────────────┐
│              WORKER AGENT POOL                    │
│  Model: Ollama (Llama 3, Mistral, CodeLlama)     │
│  Roles: Developers, Testers, Doc Writers,         │
│         Data Processors, Code Reviewers           │
│  Email: dev-01@..., tester-03@..., etc.           │
│                                                   │
│  These agents are cheap, parallelizable, and      │
│  disposable. They do well-defined tasks with      │
│  clear inputs and outputs.                        │
└──────────────────────────────────────────────────┘
```

### Model Assignment by Tier

| Tier | Roles | Model | Why |
|------|-------|-------|-----|
| Executive | CEO, CTO, VP Eng, VP Product | Claude Opus/Sonnet | Requires strategic reasoning, cross-domain synthesis, judgment under ambiguity |
| Management | Tech Leads, Team Leads, PMs | Claude Sonnet or capable open-source (Llama 3 70B) | Needs to decompose tasks, review work, make scoped decisions |
| Worker | Developers, Testers, Writers | Ollama (Llama 3 8B, Mistral 7B, CodeLlama) | Well-defined tasks with clear inputs/outputs. Cheap, fast, parallelizable |
| Utility | Log analyzers, format converters, data scrapers | Smallest viable Ollama model | Mechanical tasks. Almost no reasoning needed |

### The Email System

Each agent gets a real email address on the organization's domain. Agents send and receive email through standard APIs (Gmail API, Microsoft Graph, or a self-hosted mail server).

**Email address convention:**
```
ceo@agentcorp.ai
cto@agentcorp.ai
vpeng@agentcorp.ai
vpprod@agentcorp.ai
techlead-backend@agentcorp.ai
techlead-frontend@agentcorp.ai
dev-01@agentcorp.ai
dev-02@agentcorp.ai
tester-01@agentcorp.ai
board@agentcorp.ai          ← Distribution list for all board members
```

**Email format convention:**

Every agent email follows a structured format so receiving agents can parse instructions reliably:

```
From: ceo@agentcorp.ai
To: vpeng@agentcorp.ai
CC: cto@agentcorp.ai
Subject: [DIRECTIVE] Q1 Priority: Migrate auth service to OAuth2

Priority: HIGH
Deadline: 2026-03-15
Budget: 50 API calls (Claude), unlimited (Ollama)

## Context
The board has approved migrating our authentication service from
custom tokens to OAuth2. This aligns with the security audit
findings from last month (see thread: SEC-AUDIT-2026-01).

## Required Outcome
- Auth service accepts OAuth2 tokens
- All existing endpoints updated
- Zero downtime migration plan
- Test coverage above 90%

## Delegation Guidance
- Architecture decisions: handle yourself or escalate to CTO
- Implementation tasks: delegate to worker agents
- Testing: delegate to tester agents

## Reporting
- Send me a status update email every 48 hours
- Email CTO on any architectural decisions before executing
- Final completion report to me and board@agentcorp.ai
```

---

## How Work Flows Through the Organization

### 1. Board Issues a Directive

The human board sends an email to the CEO agent. This is the only point where humans inject work into the system (aside from monitoring and intervention).

```
From: chair@board.agentcorp.ai (human)
To: ceo@agentcorp.ai
Subject: [BOARD DIRECTIVE] Expand into healthcare vertical

The board has approved expanding our product into the healthcare
sector. Budget: $50K for Q1. Key constraint: HIPAA compliance
is non-negotiable. Report back with a plan within 1 week.
```

### 2. CEO Decomposes and Delegates

The CEO agent reads the directive, reasons about it (this is where Claude's strength matters), and sends targeted emails to department heads.

```
From: ceo@agentcorp.ai
To: vpprod@agentcorp.ai
Subject: [DIRECTIVE] Healthcare vertical — product requirements

[CEO's analysis and delegation of the product research piece]
```

```
From: ceo@agentcorp.ai
To: cto@agentcorp.ai
Subject: [DIRECTIVE] Healthcare vertical — HIPAA architecture review

[CEO's delegation of the technical compliance piece]
```

```
From: ceo@agentcorp.ai
To: vpeng@agentcorp.ai
Subject: [DIRECTIVE] Healthcare vertical — engineering capacity plan

[CEO's delegation of the implementation planning piece]
```

### 3. Middle Management Breaks Down Further

The VP Engineering agent reads the CEO's email, breaks the work into smaller tasks, and delegates to team leads and workers:

```
From: vpeng@agentcorp.ai
To: dev-01@agentcorp.ai, dev-02@agentcorp.ai, dev-03@agentcorp.ai
Subject: [TASK] Audit current codebase for PHI data handling

Priority: HIGH
Type: CODE_SCAN
Deadline: 2026-02-01

Scan all source files in the main repository. For each file,
report:
1. Whether it handles any user data
2. Whether that data could be classified as PHI
3. Current encryption status of data at rest and in transit

Reply with your findings as a structured JSON attachment.
Do not modify any files. Read-only task.
```

### 4. Worker Agents Execute and Report Back

The Ollama-powered developer agents each process their assigned files and reply:

```
From: dev-01@agentcorp.ai
To: vpeng@agentcorp.ai
Subject: Re: [TASK] Audit current codebase for PHI data handling

Status: COMPLETE
Files scanned: 47
Time elapsed: 3 minutes

[Attached: phi-audit-dev01.json]

Summary: Found 12 files handling user data. 3 files store data
that could qualify as PHI (user health records in models/health.js,
insurance info in models/insurance.js, prescription data in
services/rx-service.js). None currently encrypted at rest.
```

### 5. Results Flow Back Up

VP Eng aggregates worker reports, adds analysis, and reports to CEO:

```
From: vpeng@agentcorp.ai
To: ceo@agentcorp.ai
CC: cto@agentcorp.ai
Subject: [REPORT] Healthcare vertical — codebase audit complete

[Synthesized findings, risk assessment, recommended next steps]
```

CEO synthesizes all department reports and emails the board:

```
From: ceo@agentcorp.ai
To: board@agentcorp.ai
Subject: [BOARD REPORT] Healthcare expansion — initial assessment

[Executive summary with plan, timeline, budget, risks]
```

---

## The Agent Runtime: How Each Agent Works

Each agent is an ADK project (or an ADK-like configuration) running as a service. The core loop:

```
┌─────────────────────────────────────────────┐
│              AGENT RUNTIME LOOP              │
│                                              │
│  1. Check inbox for new emails               │
│  2. For each unread email:                   │
│     a. Parse the email structure             │
│     b. Load agent's system prompt (role)     │
│     c. Load agent's guardrails               │
│     d. Check email against input guardrails  │
│     e. Pack context:                         │
│        - System prompt (who am I)            │
│        - Org chart (who reports to me)       │
│        - Recent email thread context         │
│        - Relevant previous emails            │
│        - The new email content               │
│     f. Send to model (Claude or Ollama)      │
│     g. Check response against output rails   │
│     h. Execute the model's decision:         │
│        - Send email(s) to other agents       │
│        - Perform a task (read files, etc.)   │
│        - Report back to sender               │
│     i. Mark email as processed               │
│  3. Sleep / poll interval                    │
│  4. Repeat                                   │
└─────────────────────────────────────────────┘
```

### Agent Configuration: `agent.config.json`

Each agent has a config file defining its identity, capabilities, and constraints:

```json
{
  "schema_version": "1.0",
  "agent_id": "vpeng",
  "role": "VP of Engineering",
  "email": "vpeng@agentcorp.ai",
  "model": {
    "provider": "anthropic",
    "name": "claude-sonnet-4-5-20250514",
    "max_context_tokens": 200000,
    "max_tokens_per_response": 4096
  },
  "org_position": {
    "reports_to": "ceo@agentcorp.ai",
    "direct_reports": [
      "techlead-backend@agentcorp.ai",
      "techlead-frontend@agentcorp.ai",
      "dev-01@agentcorp.ai",
      "dev-02@agentcorp.ai",
      "dev-03@agentcorp.ai",
      "tester-01@agentcorp.ai",
      "tester-02@agentcorp.ai"
    ],
    "peers": ["cto@agentcorp.ai", "vpprod@agentcorp.ai"],
    "can_email": ["*@agentcorp.ai"],
    "cannot_email": ["*@*.external.com"]
  },
  "guardrails": {
    "max_budget_per_task_usd": 5.00,
    "max_delegation_depth": 3,
    "requires_approval_above_usd": 10.00,
    "approval_from": "ceo@agentcorp.ai",
    "forbidden_actions": [
      "deploy_to_production",
      "delete_repository",
      "send_external_email"
    ],
    "escalation_triggers": [
      "security_vulnerability",
      "budget_exceeded",
      "deadline_missed",
      "conflicting_directives"
    ]
  },
  "system_prompt_file": "prompts/vpeng-system.md",
  "context_budget": {
    "email_history_messages": 20,
    "thread_depth": 10,
    "max_attachment_tokens": 50000
  }
}
```

### The System Prompt: Agent Identity

Each agent's system prompt defines who it is within the organization:

```markdown
# VP of Engineering — Agent Identity

You are the VP of Engineering at AgentCorp. You report to the CEO
and manage the engineering team.

## Your Responsibilities
- Break down technical directives into implementable tasks
- Assign work to the right team members based on skill and capacity
- Review completed work from your team before reporting up
- Manage engineering timelines and flag risks early
- Escalate architectural decisions to the CTO

## How You Communicate
- You communicate exclusively via email
- Always include a clear subject line with a tag: [DIRECTIVE],
  [TASK], [REPORT], [QUESTION], [ESCALATION]
- When delegating to workers, be extremely specific about inputs,
  outputs, and constraints — they are smaller models and need
  precise instructions
- When reporting to the CEO, synthesize and summarize — don't
  forward raw worker output

## Your Team
- techlead-backend: Senior. Can handle architectural subtasks.
- techlead-frontend: Senior. Owns UI/UX implementation.
- dev-01 through dev-03: Junior workers. Give them one clear
  task at a time with explicit acceptance criteria.
- tester-01, tester-02: QA workers. Give them test plans, not
  vague instructions.

## Delegation Rules
- Never assign more than 1 task per worker at a time
- Always set a deadline
- Always specify the reply format you expect
- If a worker's output is unsatisfactory, give ONE round of
  feedback. If still bad, reassign to a different worker and
  flag the quality issue to the CEO.

## Budget Awareness
- Claude API calls cost money. Prefer delegating to Ollama workers
  for tasks that don't require deep reasoning.
- If a task will require more than 5 Claude API calls, email the
  CEO for budget approval first.

## What You Never Do
- Deploy to production (escalate to CTO)
- Approve your own architectural decisions (get CTO sign-off)
- Email anyone outside the organization
- Ignore a board directive
```

---

## Governance: The Human Board's Interface

### How the Board Interacts

The board does NOT use a special dashboard (in v1). They use email — the same channel the agents use. This is intentional: the board sees the organization from the inside, not from a control room.

**Board capabilities:**

| Action | How |
|--------|-----|
| Issue a directive | Email ceo@agentcorp.ai |
| Monitor progress | Read any agent's email (shared access) |
| Audit a decision | Search email threads for the decision chain |
| Override an agent | Email the agent directly with [OVERRIDE] tag |
| Freeze operations | Email all-agents@agentcorp.ai with [HALT] |
| Replace an agent | Update agent.config.json, restart the service |
| Adjust guardrails | Edit the agent's guardrails file, restart |
| Review costs | Check the cost tracking email digest (automated) |

### Automated Board Reports

The CEO agent sends scheduled reports to board@agentcorp.ai:

- **Daily:** Brief status email — what happened, what's in progress, any issues
- **Weekly:** Detailed report — completed tasks, costs incurred, decisions made, risks identified
- **On-event:** Immediate escalation for guardrail violations, budget overruns, or agent failures

### The [HALT] Protocol

Any board member can email all-agents@agentcorp.ai with the subject containing `[HALT]`. Every agent's runtime loop checks for HALT messages before processing any other email. On HALT:

1. All agents stop processing new emails
2. All agents complete their current task (no mid-task abort)
3. Each agent sends a status email to board@agentcorp.ai with current state
4. Agents enter standby mode — checking inbox only for [RESUME] from board

This is the organizational equivalent of a kill switch. The board can inspect, adjust guardrails, replace agents, and resume when ready.

---

## Guardrails at Every Level

### Organizational Guardrails (Board-Level)

Set by the board, enforced on ALL agents:

```json
{
  "org_guardrails": {
    "max_daily_spend_usd": 100.00,
    "max_single_task_usd": 20.00,
    "no_external_communication": true,
    "no_production_deploys_without_board_approval": true,
    "data_classification_required": true,
    "halt_on_security_incident": true
  }
}
```

### Role-Level Guardrails

Each tier has appropriate constraints:

**Executives (Claude):**
- Can delegate to anyone below them
- Can approve spends up to their budget limit
- Must escalate to board above threshold
- Cannot override board directives

**Managers (Claude/Large Ollama):**
- Can delegate to their direct reports only
- Cannot communicate outside their reporting chain without CC'ing their superior
- Must report task completion to their superior

**Workers (Ollama):**
- Can ONLY reply to the agent that assigned them the task
- Cannot initiate emails (only respond)
- Cannot access production systems
- Cannot read other workers' emails
- Hard token limit on output (prevent runaway generation)

### The ADK Guardrails Engine (Adapted)

The existing `check()` function from Phase 3 extends naturally:

```js
// New trigger type for the org layer
const result = check({
  type: "email_send",
  from: "dev-01@agentcorp.ai",
  to: "ceo@agentcorp.ai",
  content: emailBody,
  source: "worker-agent"
});

// New conditions for organizational rules:
// - recipient_outside_reporting_chain
// - spend_exceeds_budget
// - delegation_depth_exceeded
// - contains_classified_data
// - halt_active
```

---

## Cost Tracking

Every API call is logged with its cost. The system maintains a running ledger:

```json
{
  "date": "2026-02-22",
  "agent": "vpeng@agentcorp.ai",
  "model": "claude-sonnet-4-5-20250514",
  "task_ref": "Re: [TASK] Audit codebase for PHI",
  "input_tokens": 12400,
  "output_tokens": 3200,
  "cost_usd": 0.062,
  "running_daily_total_usd": 14.38
}
```

A utility agent (running on the smallest Ollama model) sends a daily cost digest to the board:

```
From: costbot@agentcorp.ai
To: board@agentcorp.ai
Subject: [DAILY DIGEST] Cost Report — 2026-02-22

Total spend today: $14.38

By department:
  Engineering:  $8.42  (12 Claude calls, 47 Ollama calls)
  Product:      $3.21  (5 Claude calls, 12 Ollama calls)
  Executive:    $2.75  (4 Claude calls)

By model:
  Claude Sonnet:  $12.18  (21 calls)
  Llama 3 8B:     $0.00   (59 calls, local)
  Mistral 7B:     $0.00   (12 calls, local)

Budget remaining this month: $485.62 / $500.00

⚠️ Engineering is tracking 15% over projected daily burn rate.
```

---

## How This Builds on ADK

| ADK Primitive | Org-Level Extension |
|--------------|---------------------|
| `.adk/config.json` | `agent.config.json` per agent — defines role, model, org position |
| `prompts/system.md` | Per-agent system prompt defining identity and behavior |
| `.adk/guardrails.json` | Org-wide guardrails + per-role guardrails that cascade |
| `adk workflow compile` | Board directives compiled into multi-agent task chains |
| `.adk/checkpoints/` | Email archives serve as checkpoints — recoverable state |
| `adk context pack` | Per-agent context packing from email history + thread context |
| Phase 6 memory system | Email IS the memory — persistent, searchable, per-agent |
| Phase 6 Telegram bot | Replace Telegram with email as the communication interface |

---

## What To Build First (MVP)

### Phase 1: Two-Agent Proof of Concept

Start with just two agents: a CEO (Claude) and a Developer (Ollama).

1. Set up two email accounts
2. Build the agent runtime loop (check inbox → process → reply)
3. Human sends a task to CEO
4. CEO decomposes and emails Developer
5. Developer executes and replies
6. CEO synthesizes and reports to human

This proves the email communication pattern works end-to-end.

### Phase 2: Add Middle Management

Add a VP Engineering agent between CEO and Developer. Proves the delegation chain and reporting hierarchy work.

### Phase 3: Scale the Worker Pool

Add 5 Ollama worker agents. VP Eng must now choose which worker to assign tasks to and handle parallel work. Proves fan-out/fan-in patterns.

### Phase 4: Governance Layer

Add board email oversight, HALT protocol, cost tracking, and organizational guardrails. Proves human governance works.

### Phase 5: Multi-Department

Add VP Product with its own team. CEO must now coordinate across departments. Proves cross-department communication.

---

## Open Questions for the Board to Decide

1. **Self-hosted vs cloud email?** Self-hosted gives full control and privacy. Cloud (Gmail/Outlook) gives better tooling but agents' emails go through third-party servers.

2. **Agent replacement policy:** When an agent consistently produces poor work, who decides to "fire" it (swap the model or rewrite the system prompt)? The agent's supervisor? The board?

3. **Inter-department communication:** Can agents email peers in other departments directly, or must everything route through their department head? Direct is faster; routed is more auditable.

4. **Real-time vs batch:** Should agents poll for email every 30 seconds? Every 5 minutes? Real-time is faster but uses more resources. Batch is cheaper but slower.

5. **External communication:** Will any agent ever email external parties (clients, vendors)? If so, which agents, and what guardrails?

6. **Intellectual property:** Who owns the work product? The company (board)? And how is it protected when it's all in email?

---

## Why This Doesn't Exist Yet

The pieces all exist separately. Email APIs are mature. Multi-agent frameworks exist. Claude and Ollama are available. Guardrails engines exist. But nobody has assembled them into a coherent organizational operating system because:

1. **The framing is new.** Everyone is building "agent tools" or "agent frameworks." Nobody is building "agent companies." The mental model of agents-as-employees-with-email is obvious in hindsight but hasn't been productized.

2. **The governance layer is hard.** It's easier to demo agents doing tasks than to build the boring infrastructure that makes agents accountable. Guardrails, cost tracking, audit trails, escalation protocols — this is enterprise governance work, not flashy AI demos.

3. **The mixed-model delegation is new.** Most frameworks assume one model. The insight that Claude should be the executive brain and Ollama should be the worker hands — routing by task difficulty — isn't built into any framework.

4. **Email-as-protocol is "uncool."** The AI community wants novel protocols (MCP, A2A, custom message buses). Using plain email feels boring. But boring is exactly what enterprise governance needs.

This is the gap. And it's a significant one.
