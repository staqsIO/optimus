/**
 * /api/activity/feed — Lay-user "alive" feed for the Workstation.
 *
 * Aggregates three noise-filtered streams from the ops backend:
 *   1. state_transitions  — work-item lifecycle (via /api/activity)
 *   2. action_proposals   — drafts created, reviewed, approved (via /api/pipeline/completions)
 *   3. signals resolved   — signal events (via /api/signals)
 *
 * Returns events in plain language sorted newest-first.
 * Excludes: heartbeats, GitHub/CI noise, low-relevance state hops.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";
const TIMEOUT_MS = 8_000;

export interface AliveFeedEvent {
  id: string;
  kind: "draft" | "signal" | "task" | "campaign" | "intent";
  /** Plain-language sentence for a non-technical board member */
  headline: string;
  /** Optional short detail (task name, subject line, etc.) */
  detail: string | null;
  agentId: string;
  timestamp: string;
  /** Whether this needs board action */
  requiresAction: boolean;
}

/** Plain-English verbs for work-item transitions that are worth surfacing */
const TRANSITION_HEADLINES: Record<string, string> = {
  "created->assigned":      "picked up a new task",
  "assigned->in_progress":  "started working on",
  "in_progress->review":    "sent work to review",
  "review->completed":      "finished",
  "in_progress->completed": "finished",
};

/** Step types we actively want to surface */
const NOTABLE_STEP_TYPES = new Set([
  "task_execution",
  "decision",
  "campaign_iteration",
  "delegation",
]);

/** Agent IDs whose transitions are always worth showing */
const HIGH_SIGNAL_AGENTS = new Set([
  "executor-responder",
  "executor-triage",
  "executor-coder",
  "executor-redesign",
  "orchestrator",
  "reviewer",
  "strategist",
]);

function backendFetch(path: string, boardUser: string) {
  return fetch(`${API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      "X-Board-User": boardUser,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function toPlainVerb(agentId: string, description: string, stepType: string): string {
  const d = description?.trim() || "";

  // Draft-related
  if (d.toLowerCase().includes("draft") || agentId === "executor-responder") {
    if (d.toLowerCase().includes("creat") || d.toLowerCase().includes("wrote")) {
      return "drafted a reply";
    }
    return "worked on a draft reply";
  }

  // Triage
  if (agentId === "executor-triage" || d.toLowerCase().includes("triage") || d.toLowerCase().includes("classif")) {
    return "triaged incoming messages";
  }

  // Review pass
  if (agentId === "reviewer" || d.toLowerCase().includes("review") || d.toLowerCase().includes("approve")) {
    return "reviewed work";
  }

  // Research
  if (agentId === "executor-research" || d.toLowerCase().includes("research") || d.toLowerCase().includes("fetch")) {
    return "ran a research pass";
  }

  // Redesign
  if (agentId === "executor-redesign" || d.toLowerCase().includes("redesign") || d.toLowerCase().includes("landing page")) {
    return "generated a landing page";
  }

  // Campaign iteration
  if (stepType === "campaign_iteration" || d.toLowerCase().includes("campaign")) {
    return "advanced a campaign";
  }

  // Delegation
  if (stepType === "delegation" || d.toLowerCase().includes("delegat")) {
    return "delegated a subtask";
  }

  // Code
  if (d.toLowerCase().includes("code") || d.toLowerCase().includes("commit") || d.toLowerCase().includes("pull request")) {
    return "generated code changes";
  }

  // Decision
  if (stepType === "decision" || d.toLowerCase().includes("decid") || d.toLowerCase().includes("chose")) {
    return "made a decision";
  }

  // Fallback: clean up raw description
  return d.length > 0 && d.length < 80 ? d : "completed a step";
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const boardUser = session.user?.username ?? session.user?.name ?? "unknown";

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(parseInt(limitParam || "40", 10), 100);

  // The three streams below are independent (no cross-stream data dependency),
  // so they run in parallel. Each resolves to its own event slice and swallows
  // its own failure (best-effort, non-fatal) exactly as the prior sequential
  // version did. Slices are concatenated in the original order (activity →
  // pipeline → signals) so id-dedup precedence (first occurrence wins) is
  // unchanged.
  const [activityEvents, pipelineEvents, signalEvents] = await Promise.all([
    // ── 1. Activity steps (state_transitions proxy) ────────────────────────
    (async (): Promise<AliveFeedEvent[]> => {
      const out: AliveFeedEvent[] = [];
      try {
        const actRes = await backendFetch(`/api/activity?limit=60`, boardUser);
        if (actRes.ok) {
          const actData = await actRes.json() as { steps?: Array<{
            id: string;
            agent_id: string;
            step_type: string;
            description: string;
            status: string;
            duration_ms: number | null;
            created_at: string;
            work_item_title: string | null;
          }> };
          for (const step of actData.steps ?? []) {
            // Filter noise: only notable step types + meaningful descriptions
            if (!NOTABLE_STEP_TYPES.has(step.step_type) && (step.description?.length ?? 0) < 15) continue;
            // Filter GitHub/CI chatter
            if (/github|ci pipeline|build|eslint|lint|jest|vitest/i.test(step.description || "")) continue;
            // Skip raw state_changed noise
            if (/^(orchestrator|executor|reviewer|architect|strategist):\s*state_changed$/i.test(step.description || "")) continue;

            const agentId = step.agent_id || "system";
            // Prefer high-signal agents; for others require a notable step type
            if (!HIGH_SIGNAL_AGENTS.has(agentId) && !NOTABLE_STEP_TYPES.has(step.step_type)) continue;

            const headline = toPlainVerb(agentId, step.description, step.step_type);

            out.push({
              id: `act-${step.id}`,
              kind: "task",
              headline,
              detail: step.work_item_title ?? null,
              agentId,
              timestamp: step.created_at,
              requiresAction: false,
            });
          }
        }
      } catch {
        // Non-fatal: activity stream is best-effort
      }
      return out;
    })(),

    // ── 2. Pipeline completions → drafts created ───────────────────────────
    (async (): Promise<AliveFeedEvent[]> => {
      const out: AliveFeedEvent[] = [];
      try {
        const pipRes = await backendFetch(`/api/pipeline/completions`, boardUser);
        if (pipRes.ok) {
          const pipData = await pipRes.json() as {
            completions?: Array<{
              id: string;
              title: string;
              type: string;
              agent: string;
              status: string;
              completedAt: string;
              campaignGoal: string | null;
              campaignId: string | null;
            }>;
          };
          for (const c of pipData.completions ?? []) {
            const isCampaign = !!c.campaignId;
            const agentId = c.agent || "system";
            let headline: string;
            let kind: AliveFeedEvent["kind"];

            if (agentId === "executor-responder" || c.type === "draft") {
              headline = "drafted a reply";
              kind = "draft";
            } else if (isCampaign) {
              headline = `advanced campaign: ${c.campaignGoal || c.title}`.slice(0, 80);
              kind = "campaign";
            } else {
              headline = `completed ${(c.type || "task").replace(/_/g, " ")}: ${c.title}`.slice(0, 80);
              kind = "task";
            }

            out.push({
              id: `pip-${c.id}`,
              kind,
              headline,
              detail: c.title ?? null,
              agentId,
              timestamp: c.completedAt,
              requiresAction: false,
            });
          }
        }
      } catch {
        // Non-fatal
      }
      return out;
    })(),

    // ── 3. Recent signals resolved ─────────────────────────────────────────
    (async (): Promise<AliveFeedEvent[]> => {
      const out: AliveFeedEvent[] = [];
      try {
        const sigRes = await backendFetch(`/api/signals?limit=20&status=resolved`, boardUser);
        if (sigRes.ok) {
          const sigData = await sigRes.json() as {
            signals?: Array<{
              id: string;
              title: string;
              resolved_at: string | null;
              resolved_by: string | null;
            }>;
            items?: Array<{
              id: string;
              title: string;
              resolved_at: string | null;
              resolved_by: string | null;
            }>;
          };
          const signals = sigData.signals ?? sigData.items ?? [];
          for (const s of signals) {
            if (!s.resolved_at) continue;
            out.push({
              id: `sig-${s.id}`,
              kind: "signal",
              headline: "resolved a signal",
              detail: s.title ?? null,
              agentId: s.resolved_by || "system",
              timestamp: s.resolved_at,
              requiresAction: false,
            });
          }
        }
      } catch {
        // Non-fatal
      }
      return out;
    })(),
  ]);

  const events: AliveFeedEvent[] = [...activityEvents, ...pipelineEvents, ...signalEvents];

  // ── Deduplicate by id, sort newest-first, cap ─────────────────────────────
  const seen = new Set<string>();
  const deduped = events.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  deduped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return NextResponse.json({
    events: deduped.slice(0, limit),
    total: deduped.length,
  });
}
