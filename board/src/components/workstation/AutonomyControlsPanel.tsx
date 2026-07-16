"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import type {
  AutonomyData,
  AutonomyAgent,
  AutonomyCriterion,
  AutonomyPromotion,
} from "./types";

import { formatAgentId } from "@/lib/agent-display";

const LEVEL_BADGE: Record<number, string> = {
  0: "bg-zinc-500/10 text-zinc-400",
  1: "bg-amber-500/10 text-amber-400",
  2: "bg-emerald-500/10 text-emerald-400",
};

const LEVEL_LABELS: Record<number, string> = {
  0: "L0 - Supervised",
  1: "L1 - Semi-autonomous",
  2: "L2 - Autonomous",
};

const CRITERIA_LABELS: Record<string, string> = {
  minDrafts: "Minimum drafts reviewed",
  maxEditRate: "Max edit rate (%)",
  minDays: "Minimum operating days",
  successRate: "Success rate (30d)",
  noGuardFailures: "No guard failures (14d)",
  costEfficiency: "Cost efficiency (vs fleet)",
  successRate95: "Success rate (60d)",
  noActiveFailures: "No active failure modes (30d)",
  delegationHealth: "Delegation health (worst path)",
  maxErrorRate: "Max error rate (%)",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CriterionRow({
  name,
  criterion,
}: {
  name: string;
  criterion: AutonomyCriterion;
}) {
  const label = CRITERIA_LABELS[name] || name;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={criterion.met ? "text-emerald-400" : "text-red-400"}>
        {criterion.met ? "\u2713" : "\u2717"}
      </span>
      <span className="text-zinc-400">{label}</span>
      <span className="text-zinc-600">
        {criterion.actual !== null && criterion.actual !== undefined
          ? `${criterion.actual}`
          : "no data"}{" "}
        / {`${criterion.required}`}
      </span>
      {criterion.note && (
        <span className="text-zinc-600 italic">({criterion.note})</span>
      )}
    </div>
  );
}

export default function AutonomyControlsPanel() {
  const [data, setData] = useState<AutonomyData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [confirmAgent, setConfirmAgent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await opsFetch<AutonomyData>("/api/governance/autonomy");
    if (result) setData(result);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const handlePromote = useCallback(
    async (agentId: string) => {
      setPromoting(agentId);
      setConfirmAgent(null);
      try {
        const result = await opsPost<{ ok: boolean }>("/api/governance/autonomy/promote", {
          agentId,
        });
        if (result.ok && result.data?.ok) {
          await load();
        }
      } finally {
        setPromoting(null);
      }
    },
    [load]
  );

  const agents = data?.agents || [];
  const evaluation = data?.evaluation;
  const history = data?.history || [];
  const criteria = evaluation?.exitCriteria?.criteria || {};
  const allMet = evaluation?.exitCriteria?.met ?? false;

  if (!data) {
    return (
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-600" />
          <span>Autonomy controls -- loading</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between p-3 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px]">
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
          <span className="font-medium">Autonomy Controls</span>
          {evaluation && (
            <span
              className={`px-1.5 py-0.5 text-[9px] rounded-full ${
                LEVEL_BADGE[evaluation.currentLevel] || LEVEL_BADGE[0]
              }`}
            >
              L{evaluation.currentLevel}
            </span>
          )}
          {evaluation && (
            <span className="text-[9px] text-zinc-600">
              {allMet
                ? "exit criteria met"
                : `${Object.values(criteria).filter((c) => !c.met).length} criteria pending`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {agents.map((a) => (
            <div
              key={a.agent_id}
              className={`w-2 h-2 rounded-full ${
                a.current_level === 2
                  ? "bg-emerald-400"
                  : a.current_level === 1
                    ? "bg-amber-400"
                    : "bg-zinc-600"
              }`}
              title={`${formatAgentId(a.agent_id)}: L${a.current_level}`}
            />
          ))}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-4">
          {/* Agent grid */}
          <div className="space-y-2">
            {agents.map((agent: AutonomyAgent) => {
              const name = formatAgentId(agent.agent_id);
              const badgeClass =
                LEVEL_BADGE[agent.current_level] || LEVEL_BADGE[0];
              const canPromote =
                agent.current_level < 2 && allMet && !promoting;

              return (
                <div
                  key={agent.agent_id}
                  className="flex items-center justify-between bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-300 font-medium">
                      {name}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {agent.agent_type}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 text-[9px] rounded ${badgeClass}`}
                    >
                      L{agent.current_level}
                    </span>
                    {agent.promoted_at && (
                      <span className="text-[9px] text-zinc-600">
                        promoted {timeAgo(agent.promoted_at)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {confirmAgent === agent.agent_id ? (
                      <>
                        <button
                          onClick={() => handlePromote(agent.agent_id)}
                          disabled={!!promoting}
                          className="px-2 py-1 text-[10px] rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 disabled:opacity-40"
                        >
                          Confirm L{agent.current_level + 1}
                        </button>
                        <button
                          onClick={() => setConfirmAgent(null)}
                          className="px-2 py-1 text-[10px] rounded bg-zinc-500/15 text-zinc-400 hover:bg-zinc-500/25 border border-zinc-500/20"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmAgent(agent.agent_id)}
                        disabled={!canPromote}
                        className="px-2 py-1 text-[10px] rounded bg-white/5 text-zinc-400 hover:bg-white/10 border border-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {agent.current_level >= 2
                          ? "Max level"
                          : promoting === agent.agent_id
                            ? "Promoting..."
                            : `Promote to L${agent.current_level + 1}`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Exit criteria checklist */}
          {evaluation && Object.keys(criteria).length > 0 && (
            <div className="bg-white/[0.02] rounded-lg px-3 py-2 border border-white/5 space-y-1.5">
              <p className="text-[10px] text-zinc-500 uppercase font-medium">
                {LEVEL_LABELS[evaluation.currentLevel] || "L0"} exit criteria
              </p>
              {Object.entries(criteria).map(([key, criterion]) => (
                <CriterionRow key={key} name={key} criterion={criterion} />
              ))}
              <p className="text-[10px] text-zinc-500 pt-1 italic">
                {evaluation.exitCriteria.recommendation}
              </p>
            </div>
          )}

          {/* Promotion history */}
          {history.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-zinc-500 uppercase font-medium px-1">
                Promotion history
              </p>
              {history.map((p: AutonomyPromotion, i: number) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-[10px] text-zinc-500 px-1"
                >
                  <span className="text-zinc-600">{timeAgo(p.created_at)}</span>
                  <span className="text-zinc-400">
                    {formatAgentId(p.agent_id)}
                  </span>
                  <span>
                    L{p.from_level} &rarr; L{p.to_level}
                  </span>
                  <span className="text-zinc-600">by {p.promoted_by}</span>
                  {p.notes && (
                    <span className="text-zinc-600 italic truncate max-w-[200px]">
                      {p.notes}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
