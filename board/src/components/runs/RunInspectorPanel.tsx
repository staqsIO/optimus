"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";
import { getAgentDisplay, formatAgentId } from "@/lib/agent-display";
import KeyValueRenderer from "@/components/graph/renderers/KeyValueRenderer";
import TimelineRenderer from "@/components/graph/renderers/TimelineRenderer";
import TableRenderer from "@/components/graph/renderers/TableRenderer";
import type { RunTreeItem, ActivityStep, StateTransition } from "./types";

interface Props {
  item: RunTreeItem;
  runId: string;
  onClose: () => void;
}

type Tab = "details" | "activity" | "transitions";

export default function RunInspectorPanel({ item, runId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("details");
  const [activity, setActivity] = useState<ActivityStep[] | null>(null);
  const [transitions, setTransitions] = useState<StateTransition[] | null>(null);
  const [loading, setLoading] = useState(false);

  const agent = item.assigned_to ? getAgentDisplay(item.assigned_to) : null;

  useEffect(() => {
    setActivity(null);
    setTransitions(null);
    setTab("details");
  }, [item.id]);

  useEffect(() => {
    if (tab === "activity" && !activity) {
      setLoading(true);
      opsFetch<{ steps: ActivityStep[] }>(
        `/api/runs/activity?id=${runId}&work_item_id=${item.id}`
      ).then((data) => {
        setActivity(data?.steps || []);
        setLoading(false);
      });
    }
    if (tab === "transitions" && !transitions) {
      setLoading(true);
      opsFetch<{ transitions: StateTransition[] }>(
        `/api/runs/transitions?id=${runId}&work_item_id=${item.id}`
      ).then((data) => {
        setTransitions(data?.transitions || []);
        setLoading(false);
      });
    }
  }, [tab, item.id, runId, activity, transitions]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "details", label: "Details" },
    { key: "activity", label: "Activity" },
    { key: "transitions", label: "Transitions" },
  ];

  return (
    <div className="h-full flex flex-col bg-[#0e0e16] border-l border-white/5">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <div
              className={`w-7 h-7 rounded-full ${agent.color} flex items-center justify-center flex-shrink-0`}
            >
              <span className="text-[10px] font-bold text-white">{agent.initials}</span>
            </div>
          )}
          <div className="min-w-0">
            <div className="text-xs text-zinc-200 font-medium truncate">{item.title}</div>
            <div className="text-[10px] text-zinc-500">
              {item.type} {item.assigned_to ? `\u00b7 ${formatAgentId(item.assigned_to)}` : ""}
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 text-lg leading-none flex-shrink-0 ml-2"
        >
          \u00d7
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
              tab === t.key
                ? "text-accent-bright border-b-2 border-accent-bright"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "details" && (
          <div className="space-y-4">
            <div>
              <h4 className="text-[10px] text-zinc-500 font-medium mb-2 uppercase tracking-wider">Configuration</h4>
              <KeyValueRenderer
                data={{
                  id: item.id,
                  type: item.type,
                  status: item.status,
                  assigned_to: item.assigned_to || "unassigned",
                  created_by: item.created_by,
                  delegation_depth: item.delegation_depth,
                  budget_usd: item.budget_usd,
                  created_at: item.created_at,
                  updated_at: item.updated_at,
                  duration_ms: item.duration_ms,
                }}
              />
            </div>
            {item.metadata && Object.keys(item.metadata).length > 0 && (
              <div>
                <h4 className="text-[10px] text-zinc-500 font-medium mb-2 uppercase tracking-wider">Metadata</h4>
                <KeyValueRenderer data={item.metadata} />
              </div>
            )}
          </div>
        )}

        {tab === "activity" && (
          loading ? (
            <div className="text-[10px] text-zinc-600 italic">Loading activity...</div>
          ) : activity && activity.length > 0 ? (
            <TimelineRenderer
              data={activity.map((s) => ({
                id: s.id,
                step_name: s.description,
                status: s.status,
                agent_id: s.agent_id,
                created_at: s.created_at,
                duration_ms: s.duration_ms,
                summary: s.metadata?.summary || null,
              }))}
            />
          ) : (
            <div className="text-[10px] text-zinc-600 italic">No activity steps</div>
          )
        )}

        {tab === "transitions" && (
          loading ? (
            <div className="text-[10px] text-zinc-600 italic">Loading transitions...</div>
          ) : transitions && transitions.length > 0 ? (
            <TableRenderer
              data={transitions}
              columns={["from_state", "to_state", "agent_id", "cost_usd", "created_at"]}
            />
          ) : (
            <div className="text-[10px] text-zinc-600 italic">No state transitions</div>
          )
        )}
      </div>
    </div>
  );
}
