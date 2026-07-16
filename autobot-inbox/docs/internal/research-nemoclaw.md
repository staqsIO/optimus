# NemoClaw Research — Architecture Decision Input

**Date:** 2026-03-28
**Status:** Alpha (preview since 2026-03-16)
**License:** Apache 2.0
**Repo:** https://github.com/NVIDIA/NemoClaw

---

## 1. What Is NemoClaw?

NemoClaw is NVIDIA's open-source **reference stack for running OpenClaw agents inside a sandboxed runtime**. It is NOT an agent framework itself — it is an orchestration + security wrapper around two other projects:

- **OpenClaw** (https://openclaw.ai) — An autonomous "always-on assistant" agent framework. OpenClaw is a separate project (not NVIDIA's). NemoClaw installs a fresh OpenClaw instance inside its sandbox during onboarding. OpenClaw has its own TUI, CLI, plugin system, and agent model. Think of it as a competitor/alternative to Claude Code or Devin — a persistent coding/assistant agent.

- **NVIDIA OpenShell** (https://github.com/NVIDIA/OpenShell) — NVIDIA's Rust-based secure runtime for autonomous agents. Provides Landlock + seccomp + network namespace isolation. 4,100+ GitHub stars. This is the actual sandbox enforcement layer.

**Relationship:** NemoClaw = OpenClaw (agent) + OpenShell (sandbox) + NVIDIA inference routing + declarative policy management. NemoClaw's value-add is the glue: onboarding wizard, blueprint lifecycle, credential management, policy presets, and inference routing.

---

## 2. Capabilities

| Capability | Details |
|---|---|
| Agent execution | Runs OpenClaw agents (coding, tool use, file ops, git, shell commands) |
| Sandboxed isolation | Landlock filesystem, seccomp process, network namespace — deny-by-default |
| Inference routing | Transparent proxy: agent hits `inference.local`, OpenShell routes to real provider |
| Network policy | Declarative YAML egress rules, per-binary restrictions, hot-reloadable |
| Operator approval | Unknown network requests surface in TUI for real-time approve/deny |
| Blueprint lifecycle | Versioned, digest-verified sandbox configs — reproducible environments |
| CLI orchestration | Single `nemoclaw` command manages gateway, sandbox, providers, policy |
| Plugin system | OpenClaw plugins for extensions; NemoClaw itself is an OpenClaw plugin |

**What it does NOT provide:** No built-in computer use (screen control), no browser automation, no GUI interaction. It's a terminal/CLI agent sandbox. The agent operates via shell commands, file I/O, and API calls — not visual interaction.

---

## 3. Architecture

```
Host Machine
├── nemoclaw CLI (TypeScript, npm global)
│   ├── Plugin: registers commands + inference provider
│   └── Blueprint: Python artifact for sandbox orchestration
├── OpenShell runtime (Rust binary)
│   ├── Gateway: credential store, inference proxy
│   ├── Sandbox: container with Landlock + seccomp + netns
│   └── Policy engine: YAML-driven, hot-reloadable
└── Container runtime (Docker / Colima)
    └── Sandbox container (ghcr.io/nvidia/openshell-community/sandboxes/openclaw)
        ├── OpenClaw agent + NemoClaw plugin
        ├── /sandbox (read-write workdir)
        └── inference.local → OpenShell gateway → provider
```

**Components:**
- **Plugin** — TypeScript CLI (Commander.js), runs host-side
- **Blueprint** — Versioned Python artifact, drives OpenShell CLI commands (plan/apply/status/rollback)
- **Sandbox** — OCI container with OpenClaw pre-installed, policy-locked
- **Inference** — Provider-agnostic routing through OpenShell gateway

### Supported Models

| Provider | Notes |
|---|---|
| NVIDIA Endpoints (Nemotron 3 Super 120B) | Default, hosted on integrate.api.nvidia.com |
| OpenAI (GPT models) | Curated + manual model entry |
| Anthropic (Claude models) | Curated + manual model entry |
| Google Gemini | Via OpenAI-compatible endpoint |
| Local Ollama | Routed through same inference.local pattern |
| Other OpenAI-compatible | For proxies and gateways |
| Other Anthropic-compatible | For Claude proxies |
| Local vLLM | Experimental (NEMOCLAW_EXPERIMENTAL=1) |
| Local NVIDIA NIM | Experimental, requires NIM-capable GPU |

---

## 4. Hardware Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 vCPU | 4+ vCPU |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB free | 40 GB free |
| GPU | **Not required** (inference is cloud-routed by default) | Required only for local NIM/vLLM |

**No NVIDIA GPU needed** for the standard flow — inference routes to cloud endpoints.

### Apple Silicon M1 Compatibility

**Yes, supported.** macOS (Apple Silicon) is explicitly listed with Docker Desktop or Colima as supported container runtimes. Podman on macOS is NOT supported yet. The sandbox image is ~2.4 GB compressed.

**macOS first-run requirements:**
1. Xcode Command Line Tools
2. Docker Desktop or Colima (running)
3. Node.js >= 22.16

**Caveats on macOS:**
- Local host-routed inference (Ollama, vLLM) depends on OpenShell host-routing support, which may have limitations on macOS
- Podman not supported on macOS yet

---

## 5. Deployment Model

**Installation:** Single curl command installs globally via npm:
```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

**Runtime stack:**
- `nemoclaw` npm global package (TypeScript CLI)
- OpenShell binary (Rust, installed by the script)
- Docker or Colima (container runtime, must be pre-installed)
- Sandbox runs as OCI container

**Not Kubernetes by default** — though there's a `k8s/` directory in the repo suggesting K8s deployment is in progress or planned.

**DGX Spark** has a separate setup guide for cgroup v2 and Docker config.

**Uninstall:** Dedicated uninstall script removes sandboxes, gateway, images, npm package. Does NOT remove Docker/Node.js/Ollama.

---

## 6. Security Model

NemoClaw's security is its primary value proposition. Four enforcement layers:

### Network (hot-reloadable)
- **Deny-by-default** egress — all outbound connections blocked unless explicitly allowed
- Per-endpoint rules with host, port, protocol, method, path constraints
- **Per-binary restrictions** — e.g., only `git` can talk to github.com, only `node` to telegram
- Unknown hosts blocked and surfaced to operator for real-time approval
- Approved hosts persist for session only (not permanent)

### Filesystem (creation-locked)
- Read-write: `/sandbox`, `/tmp`, `/sandbox/.openclaw-data`
- Read-only: `/usr`, `/lib`, `/proc`, `/app`, `/etc`, `/sandbox/.openclaw` (prevents agent from tampering with auth tokens)
- Everything else denied

### Process (creation-locked)
- Runs as unprivileged `sandbox` user/group
- seccomp blocks privilege escalation and dangerous syscalls
- Landlock enforcement (best_effort compatibility mode)

### Inference
- Credentials stored on host only (`~/.nemoclaw/credentials.json`)
- Sandbox never sees raw API keys
- Agent hits `inference.local`, OpenShell gateway proxies to real provider
- Hot-reloadable provider switching

### Policy Presets (shipped)
Pre-built YAML policies for: Discord, Docker Hub, HuggingFace, Jira, npm, Outlook, PyPI, Slack, Telegram.

---

## 7. External Integration Capability

### Can it interact with external APIs?
**Yes**, via network policy allowlisting. Add endpoints to `openclaw-sandbox.yaml` or apply dynamically at runtime. Each endpoint needs explicit host/port/protocol/method rules. Binary-level restrictions control which processes can reach which endpoints.

### Can it interact with git repos?
**Yes**, GitHub is pre-allowed in the default policy (github.com + api.github.com, restricted to `gh` and `git` binaries). Other git hosts would need policy additions.

### Can it interact with task graphs (e.g., Optimus agent_graph)?
**Not natively.** NemoClaw/OpenClaw knows nothing about Postgres task graphs. However, if the task graph exposes an HTTP API or the agent can use `psql` via shell, you could allowlist the endpoint. The agent inside the sandbox can run arbitrary shell commands within its sandbox — so a CLI tool that talks to the task graph would work if network policy permits.

### Policy customization methods:
| Method | How | Scope |
|---|---|---|
| Static | Edit YAML, re-run `nemoclaw onboard` | Persists across restarts |
| Dynamic | `openshell policy set <file>` on running sandbox | Session only |

---

## 8. Relevance to Optimus

### Potential fit
- NemoClaw's security model (deny-by-default, per-binary network policy, filesystem isolation, credential separation) aligns philosophically with Optimus design principles P1 (deny by default) and P2 (infrastructure enforces).
- Could sandbox executor agents (Haiku-tier) in isolated containers with controlled egress.
- OpenShell's Rust runtime is more battle-tested than prompt-based guardrails.

### Concerns
- **Alpha software** — not production-ready, APIs may change without notice.
- **Tight coupling to OpenClaw** — NemoClaw is specifically designed for OpenClaw agents, not arbitrary agent frameworks. Optimus uses its own agent loop, not OpenClaw.
- **OpenShell is the real value** — if the goal is sandbox isolation, OpenShell alone (without NemoClaw/OpenClaw) may be the right layer to evaluate.
- **No native Postgres integration** — would need HTTP API wrapper or allowlisted psql.
- **Container overhead** — each sandboxed agent is a full OCI container (~2.4 GB image).
- **Node.js 22.16+ required** — Optimus currently runs Node 20+.

### Recommendation
Evaluate **OpenShell directly** rather than NemoClaw if the goal is sandboxing Optimus agents. NemoClaw adds the OpenClaw agent framework on top, which Optimus doesn't need. OpenShell's Landlock + seccomp + network namespace isolation + inference routing could be valuable for executor-tier agent isolation without adopting OpenClaw's agent model.
