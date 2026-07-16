"use client";

import { useState } from "react";
import { useAgentWork } from "./useAgentWork";
import type { AgentWorkCompletion, AgentWorkInProgress } from "./types";

import { getAgentDisplay } from "@/lib/agent-display";

function timeAgo(dateStr: string): string {
  const mins = (Date.now() - new Date(dateStr).getTime()) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function AgentAvatar({ agentId }: { agentId: string }) {
  const display = getAgentDisplay(agentId);
  return (
    <div
      className={`w-7 h-7 ${display.color} rounded-full flex items-center justify-center text-white font-bold text-[10px] flex-shrink-0`}
      title={display.displayName}
    >
      {display.initials}
    </div>
  );
}

function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function CampaignStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: "bg-emerald-500/15 text-emerald-400",
    failed: "bg-red-500/15 text-red-400",
    plateau_paused: "bg-amber-500/15 text-amber-400",
  };
  return (
    <span className={`px-1.5 py-0.5 text-[9px] rounded-full ${styles[status] || "bg-zinc-500/15 text-zinc-400"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(score * 100, 100);
  const color = score >= 0.85 ? "bg-emerald-500" : score >= 0.6 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-zinc-400 tabular-nums">{(score * 100).toFixed(0)}%</span>
    </div>
  );
}

function CompletionCard({ item }: { item: AgentWorkCompletion }) {
  const display = getAgentDisplay(item.agent);
  const persona = { name: display.displayName, initials: display.initials, color: display.color, textColor: display.textColor, label: display.displayName };
  const domain = extractDomain(item.sourceUrl);
  const isCampaign = !!item.campaignId;
  const previewPath = item.agent === "executor-redesign"
    ? `/api/preview?path=${encodeURIComponent(`/api/redesign/preview/${item.id}`)}`
    : `/api/preview?path=${encodeURIComponent(`/api/blueprint/view/${item.id}`)}`;

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg overflow-hidden hover:border-white/10 transition-colors">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
        <AgentAvatar agentId={item.agent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`font-semibold ${persona.textColor}`}>{persona.name}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500">{persona.label}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-600">{timeAgo(item.completedAt)}</span>
            {isCampaign && item.campaignStatus && (
              <>
                <span className="text-zinc-600">·</span>
                <CampaignStatusBadge status={item.campaignStatus} />
              </>
            )}
          </div>
          {isCampaign && item.campaignGoal ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{item.campaignGoal}</p>
          ) : domain ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{domain}</p>
          ) : item.title ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{item.title}</p>
          ) : null}
        </div>
      </div>

      {/* Campaign stats */}
      {isCampaign && (
        <div className="mx-3.5 mb-2 space-y-1.5">
          {item.campaignBestScore != null && (
            <ScoreBar score={item.campaignBestScore} />
          )}
          <div className="flex items-center gap-3 text-[10px] text-zinc-500">
            {item.campaignIterations != null && (
              <span>{item.campaignIterations} iteration{item.campaignIterations !== 1 ? "s" : ""}</span>
            )}
            {item.campaignSpentUsd != null && (
              <span>${item.campaignSpentUsd.toFixed(2)} spent</span>
            )}
          </div>
        </div>
      )}

      {/* Preview iframe (non-campaign only) */}
      {!isCampaign && item.hasPreview && (
        <div className="mx-3 mb-2">
          <div className="relative aspect-[16/10] rounded-lg overflow-hidden bg-zinc-900 border border-white/5">
            <iframe
              src={previewPath}
              sandbox="allow-same-origin"
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ transform: "scale(0.5)", transformOrigin: "top left", width: "200%", height: "200%" }}
              title={`Preview: ${item.title}`}
              loading="lazy"
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-3 px-3.5 pb-3 pt-1 text-[10px]">
        {!isCampaign && item.costUsd != null && (
          <span className="text-zinc-500">${item.costUsd.toFixed(2)}</span>
        )}
        {!isCampaign && item.hasPreview && (
          <a
            href={previewPath}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            View Full
          </a>
        )}
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 hover:text-zinc-300 transition-colors ml-auto"
          >
            Source &#8599;
          </a>
        )}
      </div>
    </div>
  );
}

function InProgressCard({ item }: { item: AgentWorkInProgress }) {
  const display = getAgentDisplay(item.agent);
  const persona = { name: display.displayName, initials: display.initials, color: display.color, textColor: display.textColor, label: display.displayName };
  const domain = extractDomain(item.sourceUrl);
  const isCampaign = !!item.campaignId;

  // Campaign iteration progress
  const iterPct = isCampaign && item.campaignIterations != null && item.campaignMaxIterations
    ? Math.min((item.campaignIterations / item.campaignMaxIterations) * 100, 100)
    : null;

  return (
    <div className="bg-white/[0.02] border border-white/[0.04] rounded-lg px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <AgentAvatar agentId={item.agent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`font-semibold ${persona.textColor}`}>{persona.name}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500 italic">working on...</span>
          </div>
          {isCampaign && item.campaignGoal ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{item.campaignGoal}</p>
          ) : domain ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{domain}</p>
          ) : item.title ? (
            <p className="text-[11px] text-zinc-400 truncate mt-0.5">{item.title}</p>
          ) : null}
        </div>
      </div>

      {/* Campaign progress bar with iteration count */}
      {isCampaign && iterPct != null ? (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-purple-500/60 transition-all duration-500"
              style={{ width: `${iterPct}%` }}
            />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-zinc-500">
            <span>{item.campaignIterations}/{item.campaignMaxIterations} iterations</span>
            {item.campaignSpentUsd != null && item.campaignBudgetUsd != null && (
              <span>${item.campaignSpentUsd.toFixed(2)}/${item.campaignBudgetUsd.toFixed(0)}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse" />
        </div>
      )}
    </div>
  );
}

export default function AgentWorkFeed() {
  const { completions, inProgress, loading, error } = useAgentWork();
  const [expanded, setExpanded] = useState(true);

  const totalCompleted = completions.length;
  const totalInProgress = inProgress.length;
  const totalItems = totalCompleted + totalInProgress;

  // Don't render at all if no data and not loading
  if (!loading && totalItems === 0 && !error) return null;

  if (loading && totalItems === 0) {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600 animate-pulse" />
          <span>Loading agent work...</span>
        </div>
      </div>
    );
  }

  if (error && totalItems === 0) {
    return null; // Silently hide if backend is offline — pipeline health already shows that
  }

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span className="font-medium">Agent Work</span>
          {totalCompleted > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] bg-emerald-500/15 text-emerald-400 rounded-full">
              {totalCompleted} completed
            </span>
          )}
          {totalInProgress > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] bg-amber-500/15 text-amber-400 rounded-full animate-pulse">
              {totalInProgress} in progress
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {inProgress.map(ip => {
            const d = getAgentDisplay(ip.agent);
            return (
              <div
                key={ip.id}
                className={`w-2 h-2 rounded-full ${d.color} animate-pulse`}
                title={`${d.displayName}: working`}
              />
            );
          })}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* In-progress items first */}
          {inProgress.map(item => (
            <InProgressCard key={item.id} item={item} />
          ))}

          {/* Completed items */}
          {completions.map(item => (
            <CompletionCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
