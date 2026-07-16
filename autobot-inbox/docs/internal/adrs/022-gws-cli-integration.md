---
title: "Google Workspace CLI (gws) Integration"
status: Proposed
date: 2026-03-22
authors: [Eric]
spec_refs: ["P2 (Infrastructure enforces)", "P4 (Boring infrastructure)", "§5 (Guardrail enforcement)"]
---

# ADR-022: Google Workspace CLI (gws) Integration

## Context

autobot-inbox currently integrates with Google Workspace via the `googleapis` Node.js SDK directly:

- **Gmail**: `src/gmail/auth.js` (OAuth2 multi-account with TTL cache), `src/gmail/client.js` (fetch body/metadata, create drafts), `src/gmail/poller.js` (incremental sync via history ID), `src/gmail/sender.js` (draft creation and board-approved sending)
- **Drive**: `src/drive/watcher.js` (polls folders for Google Docs/PDFs, ingests as webhook messages)
- **Adapters**: `src/adapters/email-adapter.js` delegates to `gmail/client.js` and `gmail/sender.js` via the InputAdapter/OutputAdapter interface

This works but has gaps:

1. **No content sanitization at the fetch boundary.** Email bodies and Drive documents reach agents as raw text. Prompt injection via email is a known attack vector. Per P2, sanitization should be infrastructure-enforced, not prompt-advised.
2. **Pagination is manual.** `poller.js` handles history pagination but `watcher.js` only fetches 50 files per poll (no `nextPageToken` handling).
3. **Each Google API requires bespoke client setup.** Adding Calendar or Sheets would mean another `src/<service>/` directory with auth plumbing.
4. **No dry-run mode.** Testing Gmail draft creation or Drive queries against production requires real API calls.

The `gws` CLI (v0.18.1) is a Google-maintained tool that wraps the same REST APIs but adds:

- `--output json` for structured output (native for `execSync`/`spawn` consumption)
- `--sanitize` flag that pipes content through Model Armor before returning (content sanitization at the infrastructure layer)
- `--dry-run` for safe testing
- `--page-all` for automatic pagination
- Unified auth via gcloud ADC (Application Default Credentials) — no per-service OAuth setup

**Constraint**: `gws` does NOT have MCP server mode yet. Integration is via subprocess (`child_process.execFile`).

## Decision

Introduce `gws` CLI as the content-fetching layer for Gmail and Drive, behind the existing adapter interfaces. The `googleapis` SDK remains for operations that require OAuth2 user-context (draft creation, sending, label queries) and for the incremental sync mechanism (history IDs). This is an incremental migration — not a replacement.

### Architecture

```
                    ┌─────────────────────────┐
                    │   Adapter Registry      │
                    │   (src/adapters/)        │
                    └────────┬────────────────┘
                             │
                    ┌────────▼────────────────┐
                    │   email-adapter.js      │
                    │   (InputAdapter +       │
                    │    OutputAdapter)        │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐ ┌───▼──────┐ ┌─────▼──────┐
     │ gws-client.js  │ │client.js │ │ sender.js  │
     │ (NEW)          │ │(existing)│ │ (existing) │
     │                │ │          │ │            │
     │ fetchBody()    │ │metadata  │ │ createDraft│
     │ fetchDriveDoc()│ │labels    │ │ sendDraft  │
     │ --sanitize     │ │          │ │            │
     └────────────────┘ └──────────┘ └────────────┘
              │
     ┌────────▼────────┐
     │  gws CLI        │
     │  (subprocess)   │
     │  --sanitize     │
     │  --output json  │
     └─────────────────┘
```

### What changes

| File | Change | Phase |
|------|--------|-------|
| `src/gmail/gws-client.js` | **NEW.** Wrapper around `gws gmail messages get --output json --sanitize`. Exports `fetchEmailBodyViaGws(gmailId)` and `fetchDriveDocViaGws(fileId)`. Handles subprocess lifecycle, JSON parsing, error mapping. | 1 |
| `src/gmail/client.js` | **MODIFY.** `fetchEmailBody()` gains an env-gated branch: when `GWS_ENABLED=true`, delegates to `gws-client.js` instead of direct API call. Existing googleapis path remains as fallback. | 1 |
| `src/drive/watcher.js` | **MODIFY.** File content export (`drive.files.export` / `drive.files.get`) delegates to `gws-client.js` when `GWS_ENABLED=true`. Folder listing stays on googleapis SDK (needs auth context). Add `--page-all` for pagination fix. | 2 |
| `src/adapters/email-adapter.js` | **NO CHANGE.** Adapter interface is stable — it calls `fetchEmailBody()` which handles the gws delegation internally. | — |
| `config/agents.json` | **NO CHANGE.** Agent tool declarations don't change; the transport layer is invisible to agents. | — |
| `.env.example` | **MODIFY.** Add `GWS_ENABLED`, `GWS_SANITIZE`, `GWS_PATH` variables. | 1 |

### What does NOT change

- **OAuth2 auth flow** (`src/gmail/auth.js`): Multi-account OAuth stays. `gws` uses ADC for its own auth but cannot impersonate per-account OAuth tokens stored in the DB. For multi-account, we pass `--impersonate-service-account` or fall back to googleapis SDK.
- **Poller** (`src/gmail/poller.js`): History-based incremental sync stays on googleapis SDK. `gws` has no equivalent to `users.history.list` with `startHistoryId`.
- **Sender** (`src/gmail/sender.js`): Draft creation and sending stay on googleapis SDK. These require OAuth2 user-context tokens and are write operations where `--sanitize` doesn't apply (we control the content).
- **Signal reconciliation**: Label checking (`fetchMessageLabels`) stays on googleapis SDK (cheap `format: minimal` call).

### Token refresh strategy

`gws` authenticates via gcloud ADC. ADC access tokens expire after 1 hour. Token refresh is handled automatically by the gcloud credential helper — no application-level refresh needed. For multi-account scenarios where `gws` cannot use ADC (user-specific OAuth tokens stored in DB), we fall back to the existing googleapis SDK path.

Environment variable `GWS_AUTH_MODE` controls this:

| Value | Behavior |
|-------|----------|
| `adc` (default) | Use gcloud ADC. Works for single-account / service-account setups. |
| `fallback` | Always use googleapis SDK (disables gws for auth-dependent calls). |

### Sanitization architecture

The `--sanitize` flag on `gws` routes content through Google's Model Armor service before returning it. This enforces P2 at the infrastructure layer:

```
Email body → gws CLI → Model Armor → sanitized text → agent
```

Configuration:

- `GWS_SANITIZE=true` (default when `GWS_ENABLED=true`): all `fetchEmailBody` and `fetchDriveDoc` calls use `--sanitize`
- `GWS_SANITIZE=false`: bypass sanitization (for debugging / cost optimization)
- Sanitization is logged in `tool_invocations` with `resource_type: 'gws_sanitize'` for audit (P3)

When Model Armor flags content, `gws` returns a structured error. The wrapper maps this to a `{ sanitized: true, blocked: true, reason: '...' }` response. The adapter surfaces this as a null body with a `content_blocked` flag on the message metadata, so agents fall back to the snippet (existing behavior for null bodies).

### `gws-client.js` implementation sketch

```javascript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const GWS_PATH = process.env.GWS_PATH || 'gws';
const GWS_TIMEOUT_MS = 30_000;

export async function fetchEmailBodyViaGws(gmailId, { sanitize = true } = {}) {
  const args = ['gmail', 'messages', 'get', gmailId,
    '--format', 'full', '--output', 'json'];
  if (sanitize && process.env.GWS_SANITIZE !== 'false') {
    args.push('--sanitize');
  }

  try {
    const { stdout } = await execFileAsync(GWS_PATH, args, {
      timeout: GWS_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024, // 5MB
    });
    const result = JSON.parse(stdout);
    return extractBodyFromGwsResult(result);
  } catch (err) {
    if (err.code === 'SANITIZE_BLOCKED') {
      return { blocked: true, reason: err.message };
    }
    console.error(`[gws] fetchEmailBody failed for ${gmailId}:`, err.message);
    return null; // Fallback: caller retries via googleapis SDK
  }
}
```

### Migration strategy (incremental, not big-bang)

**Phase 1 — Gmail body fetch with sanitization (1-2 days)**

1. Create `src/gmail/gws-client.js` with `fetchEmailBodyViaGws()`
2. Add env-gated branch in `client.js:fetchEmailBody()`: when `GWS_ENABLED=true`, try gws first, fall back to googleapis on error
3. Add `GWS_ENABLED`, `GWS_SANITIZE`, `GWS_PATH` to `.env.example`
4. Test with `GWS_ENABLED=true` on dev, compare output to googleapis path
5. Monitor: log both paths for 48 hours, compare body text for drift

**Phase 2 — Drive document fetch with sanitization (1 day)**

1. Add `fetchDriveDocViaGws(fileId)` to `gws-client.js`
2. Modify `watcher.js` to delegate content export to gws when enabled
3. Add `--page-all` for folder listing (fixes 50-file pagination limit)

**Phase 3 — Evaluate full migration (deferred)**

1. If gws adds MCP server mode, re-evaluate: could replace subprocess with MCP client
2. If gws adds OAuth token passthrough, multi-account support improves
3. If Model Armor proves reliable over 30 days, consider making `--sanitize` mandatory (remove env gate)

### Rollback

Set `GWS_ENABLED=false` in `.env`. All code paths fall back to existing googleapis SDK. No database changes, no migration, no schema changes. Zero-risk rollback.

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Replace googleapis entirely with gws** | Simpler codebase, single tool | No history-based sync, no per-account OAuth, no draft creation via CLI. Would break poller and sender. | Rejected — too many gaps |
| **Build custom Model Armor integration** | Direct API, no CLI dependency | New dependency, auth complexity, reinventing what gws already does. Violates P4. | Rejected — gws already does this |
| **Wait for gws MCP server mode** | Cleaner integration via MCP protocol | No timeline. MCP mode may never ship. Current subprocess approach works fine. | Rejected — don't block on vaporware |
| **Add sanitization as a prompt-level instruction** | Zero infrastructure change | Violates P2 ("infrastructure enforces, prompts advise"). Agents can ignore prompts. | Rejected — architectural violation |

## Consequences

### Positive

- **Content sanitization at the infrastructure boundary** (P2 compliance). Prompt injection via email is mitigated before content reaches any agent.
- **Incremental adoption.** Env-gated, with automatic fallback. No breaking changes.
- **Drive pagination fixed** as a side effect (`--page-all`).
- **Audit trail.** Sanitization events logged to `tool_invocations` (P3).
- **Dry-run mode** available for testing (`gws ... --dry-run`).

### Negative

- **Subprocess overhead.** Each `gws` call spawns a process (~50-100ms). Acceptable for email body fetch (not latency-sensitive) but would be problematic for high-frequency calls.
- **New system dependency.** `gws` must be installed and authenticated on every host. Adds to onboarding checklist.
- **ADC limitation.** Multi-account OAuth tokens stored in DB cannot be used with `gws` natively. These accounts fall back to googleapis SDK (no sanitization).

### Neutral

- **Model Armor cost.** Sanitization API calls have a cost (TBD based on Google pricing). Monitor via `tool_invocations` audit.
- **Agent config unchanged.** Agents are unaware of the transport layer change — adapter interface absorbs it.

## Affected Files

- `src/gmail/gws-client.js` (new)
- `src/gmail/client.js` (modify — env-gated delegation)
- `src/drive/watcher.js` (modify — Phase 2, env-gated delegation + pagination)
- `.env.example` (modify — new env vars)
- `docs/internal/adrs/README.md` (modify — add ADR-022 to index)
