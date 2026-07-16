# Architecture: Project Deploy Campaigns

**Author:** Liotta (Systems Architect)
**Date:** 2026-04-04
**Status:** Proposal for board review

---

## Leverage Analysis

The hidden 10x insight: **you do not need a new campaign mode.** The existing `stateful` campaign mode already provisions an isolated workspace, runs iterative plan-execute-measure loops, commits improvements, and pushes branches. The gap is not in orchestration — it is in three narrow capabilities:

1. **Repo creation** — `ghApi` call, 12 lines of code
2. **Deploy trigger** — `railway up` or Vercel CLI, 15 lines of code
3. **URL propagation** — write the preview URL into `campaign.metadata.preview_url`

Everyone's instinct is to build a "deploy pipeline" with template engines, scaffold generators, and platform abstractions. That is the O(n*m) approach — n templates times m deploy targets. The contrarian move: **treat the LLM as the scaffold generator** (it already is in build campaigns) and constrain the deploy target to exactly one platform. The campaign loop already iterates on quality — add deploy as a success criterion measurement, not a separate system.

## First-Principles Breakdown

Current campaign modes and what they actually do:

| Mode | Workspace | Tools | Output | Deploy |
|------|-----------|-------|--------|--------|
| `stateless` | none | none | text only | N/A |
| `stateful` | git worktree (Optimus repo) | Read/Write/Edit/Bash | files in worktree | push branch |
| `workshop` | git worktree (Optimus repo) | full Claude Code | files in worktree | push branch, PR |
| **`project` (new)** | **fresh GitHub repo** | **full Claude Code** | **files in new repo** | **Railway preview** |

The delta from `workshop` to `project` is exactly:
- `createWorkspace()` creates a new GitHub repo + local clone instead of a git worktree
- `pushBranch()` pushes to the new repo instead of Optimus
- Post-push hook calls Railway API to deploy
- Success criteria includes "HTTP 200 from preview URL"

That is 3 functions and 1 DB migration. Not a new system.

## Architecture

### 1. New campaign_mode: `project`

```sql
ALTER TABLE agent_graph.campaigns
  DROP CONSTRAINT campaigns_campaign_mode_check;
ALTER TABLE agent_graph.campaigns
  ADD CONSTRAINT campaigns_campaign_mode_check
  CHECK (campaign_mode IN ('stateless', 'stateful', 'workshop', 'project'));
```

### 2. Project workspace provisioning (campaign-workspace.js extension)

Instead of `git worktree add` from Optimus, `project` mode does:

```
createProjectWorkspace(campaignId, projectName):
  1. POST /orgs/staqsIO/repos → create private repo `staqsIO/{projectName}`
  2. Clone to /tmp/optimus-projects/{campaignId}/
  3. Write goal.md + initial scaffold (from LLM first iteration)
  4. git push origin main
  5. Store repo URL in campaign.metadata.github_repo
  6. Store local path in campaign.workspace_path
```

**Why not templates?** The LLM generates better scaffolds than templates because it reads the goal description. A "build me a Next.js dashboard for tracking X" prompt produces a more relevant scaffold than any template. The campaign iteration loop already handles quality gating — if the first scaffold is bad, iteration 2 fixes it. Templates add complexity with no measurable quality improvement.

### 3. Deploy trigger (new file: `agents/claw-campaigner/project-deploy.js`)

**Railway wins over Vercel.** Here is the 5-sentence rubric:

1. **Why Railway?** Railway API creates ephemeral services from GitHub repos with zero config — one POST creates a service, connects the repo, and deploys. Vercel requires a project setup step, framework detection, and build config.
2. **Why now?** Campaigns already push to GitHub. Railway watches the repo and auto-deploys on push. The campaign loop already pushes after each successful iteration.
3. **Expected edge:** Deploy latency under 90 seconds for a Next.js app. Board sees a live URL within the first campaign iteration.
4. **Blast radius if it fails:** A Railway service fails to deploy. The campaign continues iterating on code quality. The URL is simply missing from the dashboard until deploy succeeds. No data loss.
5. **Rollback plan:** Delete the Railway service via API. The repo and campaign artifacts remain. Re-deploy is idempotent.

```
deployToRailway(campaignId, repoFullName):
  1. POST /v2/projects → create Railway project (name = campaign slug)
  2. POST /v2/services → create service linked to GitHub repo
  3. POST /v2/variables → inject env vars from campaign.constraints.env_vars
  4. Poll GET /v2/deployments until status = SUCCESS (timeout: 5 min)
  5. Extract public URL from deployment
  6. Store in campaign.metadata.preview_url
  7. Return URL
```

The Railway API uses a GraphQL endpoint. Auth via `RAILWAY_TOKEN` (already in env). The token never touches the LLM prompt (P2 enforcement — deploy credentials are infrastructure, not context).

### 4. Campaign loop integration (minimal changes to campaign-loop.js)

In the campaign loop, add three hooks at existing extension points:

**A. Workspace creation (line ~132):**
```javascript
if (campaignMode === 'project' && !workspacePath) {
  workspacePath = await createProjectWorkspace(campaignId, campaignMeta.project_name);
}
```

**B. Post-commit deploy (line ~408, after commitImprovement):**
```javascript
if (campaignMode === 'project' && gitCommitHash) {
  await pushBranch(campaignId); // pushes to the new repo
  const url = await deployToRailway(campaignId, campaignMeta.github_repo);
  if (url) {
    await notifyCreator(campaignId, `Preview live: ${url}`);
  }
}
```

**C. Success measurement (campaign-scorer.js extension):**
Add a `url_reachable` success criterion that does `fetch(previewUrl)` and checks for HTTP 2xx. This integrates with the existing `evaluateSuccessCriteria` system — no new measurement framework.

### 5. Cleanup (non-negotiable cost control)

**Auto-cleanup after 7 days of campaign completion:**

```sql
-- Add to campaigns table
ALTER TABLE agent_graph.campaigns
  ADD COLUMN IF NOT EXISTS cleanup_at TIMESTAMPTZ;

-- Trigger: set cleanup_at = completed_at + 7 days when campaign succeeds/fails
```

A daily cron (or daemon tick) runs:
```
cleanupExpiredProjects():
  1. SELECT campaigns WHERE cleanup_at < now() AND cleanup_at IS NOT NULL
  2. For each: DELETE Railway service, ARCHIVE GitHub repo (not delete — P3 audit trail)
  3. Update campaign.metadata.cleaned_up = true
```

**Cost bound:** Railway hobby plan, $5/service/month. With 7-day cleanup, max concurrent previews = (campaigns per week * 1). At 5 board members creating 2 projects/week each, that is 10 active previews = $50/month worst case.

### 6. Projects system integration (migration 020)

The `project` campaign mode integrates with the existing Projects system via project_memberships:

```
When a project campaign starts:
  1. Create or find the agent_graph.projects row (by slug)
  2. INSERT INTO project_memberships (project_id, 'campaign', campaignId)
  3. Store project_id in campaign.metadata.project_id

When the campaign deploys:
  4. Write preview_url to project_memory (key: 'preview_url')
  5. Write github_repo to project_memory (key: 'github_repo')
```

This means the `/projects/:slug` detail page automatically shows:
- The campaign(s) that built the project
- The live preview URL (from project memory)
- The GitHub repo (from project memory)
- Iteration history (via campaign membership)

No new board pages needed. The existing Projects and Campaigns pages cover it.

### 7. Board UX flow

```
Board member on /campaigns → Quick Build:
  - Goal: "Build a Next.js dashboard that shows our agent pipeline metrics"
  - Mode: "Project" (new option in dropdown)
  - Budget: $10 (default)
  → Creates campaign with campaign_mode='project'
  → Campaign loop starts:
    Iteration 1: scaffold + initial code + deploy → preview URL appears
    Iteration 2-N: board feedback via HITL → campaign adjusts → redeploy
  → Board sees live URL on campaign detail page AND project detail page
```

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `agents/claw-campaigner/campaign-workspace.js` | Add `createProjectWorkspace()`, `cleanupProjectWorkspace()` | ~80 |
| `agents/claw-campaigner/project-deploy.js` | **NEW** — Railway API client (create, deploy, cleanup) | ~120 |
| `agents/claw-campaigner/campaign-loop.js` | Add project mode hooks at 3 points | ~30 |
| `agents/claw-campaigner/campaign-scorer.js` | Add `url_reachable` criterion | ~15 |
| `autobot-inbox/sql/021-project-campaigns.sql` | Widen campaign_mode CHECK, add cleanup_at column | ~15 |
| `board/src/app/campaigns/new/page.tsx` | Add "Project" to mode dropdown | ~5 |
| `autobot-inbox/src/api-routes/projects.js` | No changes — existing endpoints cover it | 0 |

**Total: ~265 lines of new code, 1 new file, 5 modified files.**

## Answers to Your Specific Questions

### 1. What is the minimum viable deploy pipeline?

Three functions: `createProjectWorkspace()` (GitHub repo + clone), `deployToRailway()` (Railway API), and `cleanupExpiredProjects()` (cron). Everything else — iteration, quality gating, HITL feedback, budget control — already exists in the campaign loop. Do not build a deploy pipeline. Bolt deploy onto the existing campaign pipeline.

### 2. Railway vs Vercel for previews?

**Railway.** Vercel requires framework detection, build config, and a project-level setup that does not map cleanly to ephemeral campaign-scoped deploys. Railway creates a service from a GitHub repo in one API call and auto-deploys on push. Railway also handles backend services (Express, WebSocket), not just static/Next.js — which matters when campaigns build APIs.

### 3. Should campaigns create repos, or Projects first?

**Campaigns create repos.** The campaign IS the builder. The Project (migration 020) is the organizational container that gets the campaign linked to it via membership. Creating the project first adds a manual step that the campaign loop should handle automatically. Flow: Quick Build form creates campaign -> campaign creates GitHub repo -> campaign registers itself as a project membership.

### 4. How should templates work?

**They should not exist.** The LLM generates the scaffold from the goal description. This is strictly better than templates because:
- Templates require maintenance (N templates * M frameworks)
- The LLM already knows how to scaffold Next.js, Express, static sites, etc.
- The campaign iteration loop corrects bad scaffolds automatically
- Success criteria (url_reachable + board HITL) gate quality

If scaffold quality becomes a measurable problem (>3 iterations to first successful deploy), revisit with a template system. Measure first, optimize second.

### 5. What about cleanup?

7-day auto-cleanup after campaign completion. Railway services archived (not deleted — audit trail). GitHub repos archived. Daily cron job. Cost ceiling: $50/month at 10 concurrent previews.

### 6. How does this interact with Projects (migration 020)?

Via `project_memberships`. Campaign registers itself as a member of the project. Preview URL and repo URL stored in `project_memory`. Existing project detail page shows everything. Zero new UI needed.

## Risk Assessment

1. **Railway API rate limits or downtime** — Mitigation: deploy is non-blocking. Campaign continues iterating on code. Deploy retries on next successful iteration via existing transient error retry logic.

2. **LLM generates code that does not build** — Mitigation: `url_reachable` success criterion fails, campaign iterates. This is the same pattern as existing campaign quality gating. The loop already handles this.

3. **Cost runaway from forgotten previews** — Mitigation: `cleanup_at` column + daily cron. Hard ceiling: campaigns have budget envelopes. Railway costs are bounded by the 7-day window.

## Success Criteria

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Time from Quick Build to live URL | N/A (not possible today) | < 10 minutes | Campaign iteration 1 duration + deploy time |
| Deploy success rate on first iteration | N/A | > 70% | url_reachable pass rate on iteration 1 |
| Iterations to board-approved output | N/A | < 5 | Campaign completed_iterations at stop_success |
| Monthly preview cost | $0 | < $50 | Railway billing |
| Cleanup compliance | N/A | 100% (no previews older than 7 days) | Daily cron audit log |
