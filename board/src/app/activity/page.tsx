"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { opsFetch } from "@/lib/ops-api";
import TaskTracePanel from "./TaskTracePanel";
import GateFailuresPanel from "./GateFailuresPanel";
import NeedsAttentionBanner from "./NeedsAttentionBanner";

interface AwaitingCampaign {
  id: string;
  goal_description: string;
  work_item_title: string;
}

interface ActivityStep {
  id: string;
  work_item_id: string | null;
  campaign_id: string | null;
  iteration_number: number | null;
  parent_step_id: string | null;
  depth: number;
  agent_id: string | null;
  step_type: string | null;
  description: string;
  status: "in_progress" | "completed" | "failed";
  metadata: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  created_at: string;
  completed_at: string | null;
  duration_ms: number;
  work_item_title: string | null;
}

// Agent decision metadata — loosely structured, varies by agent and step type
type DecisionMetadata = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STEP_TYPE_ICONS: Record<string, string> = {
  task_execution:      "▶",
  llm_call:            "◆",
  planning:            "◇",
  strategy_execution:  "◈",
  quality_check:       "◉",
  decision:            "◎",
  campaign_iteration:  "↻",
  context_load:        "↓",
  gate_check:          "⚑",
  work_item_create:    "+",
  cli_llm_call:        "◆",
  cli_tool_use:        "⚒",
  cli_subagent:        "⇢",
};

const STATUS_COLORS: Record<string, string> = {
  in_progress: "text-yellow-400",
  completed:   "text-emerald-400",
  failed:      "text-red-400",
};

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-yellow-400 animate-pulse",
  completed:   "bg-emerald-500",
  failed:      "bg-red-500",
};

const AGENT_COLORS: Record<string, string> = {
  orchestrator:         "text-violet-400",
  strategist:           "text-blue-400",
  "executor-triage":    "text-cyan-400",
  "executor-responder": "text-teal-400",
  "executor-ticket":    "text-orange-400",
  "executor-coder":     "text-yellow-300",
  "executor-research":  "text-indigo-400",
  "executor-redesign":  "text-pink-400",
  "executor-blueprint": "text-rose-400",
  reviewer:             "text-lime-400",
  architect:            "text-amber-400",
  "claw-campaigner":    "text-purple-400",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function StepRow({ step, onSelect }: { step: ActivityStep; onSelect?: (taskId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const meta = (step.metadata || {}) as DecisionMetadata;
  const hasMetadata = Object.keys(meta).length > 0;
  const indent = step.depth * 20;
  const icon = STEP_TYPE_ICONS[step.step_type || ""] ?? "·";
  const agentColor = AGENT_COLORS[step.agent_id || ""] ?? "text-zinc-400";

  function handleClick() {
    if (step.work_item_id && onSelect) {
      onSelect(step.work_item_id);
    } else if (hasMetadata) {
      setExpanded(!expanded);
    }
  }

  return (
    <div className="relative">
      {step.depth > 0 && (
        <div
          className="absolute top-0 bottom-0 border-l border-white/10"
          style={{ left: indent - 10 }}
        />
      )}

      <div
        className={`flex items-start gap-2 px-4 py-1.5 hover:bg-white/[0.03] group
                    ${(step.work_item_id || hasMetadata) ? "cursor-pointer" : ""}`}
        style={{ paddingLeft: 16 + indent }}
        onClick={handleClick}
      >
        {/* Status dot */}
        <div className="mt-1.5 shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[step.status]}`} />
        </div>

        {/* Step type icon */}
        <span className="shrink-0 text-zinc-500 text-xs font-mono mt-0.5 w-3">{icon}</span>

        {/* Description + work item title */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-sm ${STATUS_COLORS[step.status]} font-mono`}>
              {step.description}
            </span>
            {hasMetadata && (
              <span className="text-zinc-600 text-xs leading-none select-none">
                {expanded ? "▾" : "▸"}
              </span>
            )}
          </div>
          {meta.summary && (
            <span className="text-[11px] text-amber-400/80 block mt-0.5 truncate font-mono">
              {meta.summary}
            </span>
          )}
          {!meta.summary && step.work_item_title && (
            <span className="text-[10px] text-zinc-600 block mt-0.5 truncate">
              {step.work_item_title}
            </span>
          )}
        </div>

        {/* Right side: agent + duration + time + drill-down hint */}
        <div className="flex items-center gap-3 shrink-0 text-xs">
          {step.agent_id && (
            <span className={`${agentColor} opacity-70 group-hover:opacity-100 font-mono`}>
              {step.agent_id}
            </span>
          )}
          <span className="text-zinc-600 tabular-nums w-14 text-right">
            {formatDuration(step.duration_ms)}
          </span>
          <span className="text-zinc-700 tabular-nums w-20 text-right">
            {formatTime(step.created_at)}
          </span>
          {step.work_item_id && (
            <span className="text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity w-3 text-right">
              ›
            </span>
          )}
        </div>
      </div>

      {expanded && hasMetadata && (
        <div
          className="px-4 pb-2"
          style={{ paddingLeft: 16 + indent + 32 }}
        >
          {/* Structured decision fields */}
          {(meta.verdict || meta.classification || meta.routed_to || meta.ticket || meta.draft_id || meta.triage_result) && (
            <div className="text-xs space-y-1 mb-2 border-l-2 border-amber-600/50 pl-2">
              {meta.verdict && (
                <div><span className="text-zinc-500">Verdict:</span> <span className={meta.verdict === "approved" ? "text-emerald-400" : "text-red-400"}>{meta.verdict}</span></div>
              )}
              {meta.classification && (
                <div><span className="text-zinc-500">Classification:</span> <span className="text-cyan-400">{meta.classification}</span>{meta.confidence != null && <span className="text-zinc-600"> ({Math.round(meta.confidence * 100)}%)</span>}</div>
              )}
              {meta.triage_result?.category && (
                <div><span className="text-zinc-500">Triage:</span> <span className="text-cyan-400">{meta.triage_result.category}</span></div>
              )}
              {meta.routed_to && meta.routed_to.length > 0 && (
                <div><span className="text-zinc-500">Routed to:</span> <span className="text-violet-400">{meta.routed_to.join(", ")}</span></div>
              )}
              {meta.routing_method && (
                <div><span className="text-zinc-500">Method:</span> <span className="text-zinc-400">{meta.routing_method}</span></div>
              )}
              {meta.draft_id && (
                <div><span className="text-zinc-500">Draft:</span> <span className="text-teal-400 font-mono">{meta.draft_id.slice(0, 8)}...</span>{meta.tone_score != null && <span className="text-zinc-600"> (tone: {meta.tone_score})</span>}</div>
              )}
              {meta.ticket && (
                <div>
                  <span className="text-zinc-500">Ticket:</span>{" "}
                  {meta.ticket.linear_url ? <a href={meta.ticket.linear_url} target="_blank" rel="noopener" className="text-orange-400 hover:underline">{meta.ticket.title || "Linear"}</a> : null}
                  {meta.ticket.github_url ? <a href={meta.ticket.github_url} target="_blank" rel="noopener" className="text-yellow-300 hover:underline ml-2">GitHub</a> : null}
                </div>
              )}
              {meta.github_pr_url && (
                <div><span className="text-zinc-500">PR:</span> <a href={meta.github_pr_url as string} target="_blank" rel="noopener" className="text-yellow-300 hover:underline">{meta.github_pr_url as string}</a></div>
              )}
              {meta.cost_usd != null && meta.cost_usd > 0 && (
                <div><span className="text-zinc-500">Cost:</span> <span className="text-zinc-400">${meta.cost_usd.toFixed(4)}</span></div>
              )}
            </div>
          )}
          {/* Raw metadata JSON (full details) */}
          <pre className="text-xs text-zinc-500 bg-black/30 rounded p-2 overflow-x-auto">
            {JSON.stringify(meta, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ActivityPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskFromUrl = searchParams.get("task");

  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState<"all" | string>("all");
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  const [showGatesOnly, setShowGatesOnly] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [awaitingCampaigns, setAwaitingCampaigns] = useState<AwaitingCampaign[]>([]);

  useEffect(() => {
    if (taskFromUrl) setSelectedTaskId(taskFromUrl);
  }, [taskFromUrl]);

  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeenAtRef  = useRef<string | null>(null);
  const scrollRef      = useRef<HTMLDivElement>(null);
  const bottomRef      = useRef<HTMLDivElement>(null);
  const isAtBottomRef  = useRef(true);

  // Agents that actually appear in the current data set
  const activeAgents = useMemo(
    () => [...new Set(steps.map(s => s.agent_id).filter((a): a is string => Boolean(a)))],
    [steps]
  );

  // Client-side filter for failed-only view
  const visibleSteps = useMemo(
    () => showFailedOnly ? steps.filter(s => s.status === "failed") : steps,
    [steps, showFailedOnly]
  );

  const failedCount = useMemo(() => steps.filter(s => s.status === "failed").length, [steps]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  // Fetch campaigns currently awaiting human input
  const fetchAwaitingCampaigns = useCallback(async () => {
    const data = await opsFetch<{ campaigns: Array<{ id: string; goal_description: string; work_item_title: string; campaign_status: string }> }>("/api/campaigns");
    if (data?.campaigns) {
      setAwaitingCampaigns(
        data.campaigns
          .filter((c) => c.campaign_status === "awaiting_input")
          .map(({ id, goal_description, work_item_title }) => ({ id, goal_description, work_item_title }))
      );
    }
  }, []);

  // Full fetch — used on initial load and when agentFilter changes
  const fetchFull = useCallback(async () => {
    const agentParam = agentFilter !== "all" ? `&agent_id=${encodeURIComponent(agentFilter)}` : "";
    const [data] = await Promise.all([
      opsFetch<{ steps: ActivityStep[] }>(`/api/activity?limit=200${agentParam}`),
      fetchAwaitingCampaigns(),
    ]);
    if (data?.steps) {
      // Feed comes back newest-first; reverse for chronological display
      const sorted = [...data.steps].reverse();
      setSteps(sorted);
      if (sorted.length > 0) {
        lastSeenAtRef.current = sorted[sorted.length - 1].created_at;
      }
    }
    setLoading(false);
  }, [agentFilter, fetchAwaitingCampaigns]);

  // Incremental fetch — appends only new steps since last poll
  const fetchIncremental = useCallback(async () => {
    if (!lastSeenAtRef.current) {
      await fetchFull();
      return;
    }
    const agentParam = agentFilter !== "all" ? `&agent_id=${encodeURIComponent(agentFilter)}` : "";
    const sinceParam = `&since=${encodeURIComponent(lastSeenAtRef.current)}`;
    const data = await opsFetch<{ steps: ActivityStep[] }>(`/api/activity?limit=200${agentParam}${sinceParam}`);
    if (!data?.steps?.length) return;

    // PG microseconds are truncated to ms in JSON, so `since` can re-return the
    // last seen step (e.g. created_at=.123456Z re-matches since=.123Z).
    // Deduplicate by ID before appending.
    lastSeenAtRef.current = data.steps[data.steps.length - 1].created_at;
    setSteps(prev => {
      const seen = new Set(prev.map(s => s.id));
      const fresh = data.steps.filter(s => !seen.has(s.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    if (isAtBottomRef.current) {
      setTimeout(() => scrollToBottom("smooth"), 50);
    }
    // Also refresh awaiting campaigns on each incremental poll
    fetchAwaitingCampaigns();
  }, [agentFilter, fetchFull, fetchAwaitingCampaigns, scrollToBottom]);

  // Initial load / filter change
  useEffect(() => {
    setLoading(true);
    lastSeenAtRef.current = null;
    fetchFull().then(() => {
      // Jump to bottom instantly on initial load; smooth on updates
      setTimeout(() => scrollToBottom("instant"), 50);
    });
  }, [fetchFull]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live mode interval
  useEffect(() => {
    if (liveMode) {
      intervalRef.current = setInterval(fetchIncremental, 3000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [liveMode, fetchIncremental]);

  const handleRefresh = useCallback(() => {
    lastSeenAtRef.current = null;
    setLoading(true);
    fetchFull();
  }, [fetchFull]);

  return (
    <div className="flex flex-col h-[calc(100vh-49px)] bg-zinc-950 text-zinc-100">
      {/* Retry-exhausted failure banner — surfaces incidents immediately */}
      <div className="px-4 pt-2">
        <NeedsAttentionBanner />
      </div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0 flex-wrap gap-y-1.5">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Activity</span>

        {/* Agent filter — only shows agents with actual data */}
        <div className="flex items-center gap-1 ml-2 flex-wrap">
          <button
            onClick={() => setAgentFilter("all")}
            className={`px-2 py-0.5 rounded text-xs font-mono transition-colors
              ${agentFilter === "all" ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            all agents
          </button>
          {activeAgents.map((a) => (
            <button
              key={a}
              onClick={() => setAgentFilter(agentFilter === a ? "all" : a)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors
                ${agentFilter === a
                  ? "bg-white/10 text-white"
                  : `${AGENT_COLORS[a] ?? "text-zinc-400"} opacity-60 hover:opacity-100`}`}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Failed filter */}
        <div className="h-4 border-l border-white/10 mx-1" />
        <button
          onClick={() => { setShowFailedOnly(!showFailedOnly); if (!showFailedOnly) setShowGatesOnly(false); }}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono transition-colors
            ${showFailedOnly
              ? "bg-red-500/20 text-red-400"
              : failedCount > 0
                ? "text-red-500/60 hover:text-red-400"
                : "text-zinc-700 cursor-default"}`}
          disabled={failedCount === 0 && !showFailedOnly}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${failedCount > 0 ? "bg-red-500" : "bg-zinc-700"}`} />
          {failedCount > 0 ? `${failedCount} failed` : "failed"}
        </button>

        {/* Gate failures view — switches feed to drafts held by G1-G11 */}
        <button
          onClick={() => { setShowGatesOnly(!showGatesOnly); if (!showGatesOnly) setShowFailedOnly(false); }}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono transition-colors
            ${showGatesOnly
              ? "bg-amber-500/20 text-amber-300"
              : "text-amber-500/60 hover:text-amber-400"}`}
          title="Show drafts held by constitutional gates (G1–G11)"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${showGatesOnly ? "bg-amber-400" : "bg-amber-500/40"}`} />
          gates
        </button>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            refresh
          </button>
          <button
            onClick={() => scrollToBottom("smooth")}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ↓ bottom
          </button>
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded transition-colors
              ${liveMode ? "text-emerald-400 bg-emerald-500/10" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
            live
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-4 py-1 border-b border-white/5 text-xs text-zinc-600 shrink-0"
           style={{ paddingLeft: 48 }}>
        <span className="flex-1">description</span>
        <div className="flex items-center gap-3">
          <span className="w-24">agent</span>
          <span className="w-14 text-right">duration</span>
          <span className="w-20 text-right">time</span>
        </div>
      </div>

      {/* Awaiting Input banner — shown when any campaign needs operator response */}
      {awaitingCampaigns.length > 0 && (
        <div className="shrink-0 border-b border-violet-500/30 bg-violet-500/10 px-4 py-2 flex flex-wrap items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-violet-300 uppercase tracking-wide">
            {awaitingCampaigns.length === 1 ? "1 campaign awaiting input" : `${awaitingCampaigns.length} campaigns awaiting input`}
          </span>
          <div className="flex flex-wrap gap-2 ml-1">
            {awaitingCampaigns.map((c) => (
              <Link
                key={c.id}
                href={`/campaigns/${c.id}`}
                className="text-xs text-violet-200 bg-violet-500/20 border border-violet-500/30 rounded px-2 py-0.5 hover:bg-violet-500/30 transition-colors truncate max-w-xs"
              >
                {c.work_item_title || c.goal_description.slice(0, 60)}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Steps list (or gate-failures panel when toggled) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono"
      >
        {showGatesOnly ? (
          <div className="p-4 font-sans">
            <GateFailuresPanel />
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-500">
            Loading activity...
          </div>
        ) : visibleSteps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-600">
            <span className="text-sm">
              {showFailedOnly ? "No failed steps" : "No activity yet"}
            </span>
            <span className="text-xs">
              {showFailedOnly ? "Pipeline is healthy" : "Steps will appear here as agents execute"}
            </span>
          </div>
        ) : (
          <>
            {visibleSteps.map((step) => (
              <StepRow key={step.id} step={step} onSelect={setSelectedTaskId} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-white/5 flex items-center gap-4 text-xs text-zinc-700 shrink-0">
        <span>{steps.length} steps{showFailedOnly && visibleSteps.length !== steps.length ? ` (${visibleSteps.length} shown)` : ""}</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" /> in_progress
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> completed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> failed
        </span>
      </div>

      {/* Task trace panel — slide-in on row click */}
      {selectedTaskId && (
        <TaskTracePanel
          taskId={selectedTaskId}
          onClose={() => {
            setSelectedTaskId(null);
            if (searchParams.get("task")) router.replace("/activity", { scroll: false });
          }}
        />
      )}
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="p-5 text-sm text-zinc-500">Loading activity…</div>}>
      <ActivityPageInner />
    </Suspense>
  );
}
