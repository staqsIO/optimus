"use client";

import { useEffect, useState, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

interface OpsPulseProps {
  onDraftClick: () => void;
}

interface BriefingStats {
  stats: {
    drafts_awaiting_review: number;
    cost_today_usd: number;
    budget_today_usd: number;
    emails_awaiting_triage: number;
  };
}

interface StatusData {
  gmail_connected: boolean;
  anthropic_configured: boolean;
}

interface Phase1Data {
  successRate?: number;
}

type HealthColor = "green" | "amber" | "red";

interface PulseState {
  drafts: number | null;
  costToday: string | null;
  budgetToday: string | null;
  pipeline: number | null;
  health: HealthColor | null;
  gmailConnected: boolean | null;
  anthropicConfigured: boolean | null;
  phase1Rate: number | null;
  offline: boolean;
}

const INITIAL_STATE: PulseState = {
  drafts: null,
  costToday: null,
  budgetToday: null,
  pipeline: null,
  health: null,
  gmailConnected: null,
  anthropicConfigured: null,
  phase1Rate: null,
  offline: false,
};

function KpiCard({
  label,
  children,
  onClick,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`flex flex-col gap-1.5 p-3 bg-surface rounded-lg border border-white/5 min-w-0 ${
        onClick ? "hover:bg-white/[0.02] cursor-pointer transition-colors" : ""
      } ${className}`}
    >
      <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">{label}</span>
      {children}
    </Tag>
  );
}

function ServiceDot({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500" title={`${label}: ${connected ? "connected" : "disconnected"}`}>
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          connected ? "bg-emerald-400" : "bg-red-400"
        }`}
      />
      {label}
    </span>
  );
}

export default function OpsPulse({ onDraftClick }: OpsPulseProps) {
  const [state, setState] = useState<PulseState>(INITIAL_STATE);

  const poll = useCallback(async () => {
    const [briefing, status, phase1] = await Promise.all([
      opsFetch<BriefingStats>("/api/briefing"),
      opsFetch<StatusData>("/api/status"),
      opsFetch<Phase1Data>("/api/metrics/phase1"),
    ]);

    if (!briefing && !status && !phase1) {
      setState((prev) => ({ ...prev, offline: true }));
      return;
    }

    // Log raw API responses for debugging #310
    console.debug("[OpsPulse] raw API:", { briefing, status, phase1 });

    setState((prev) => {
      const next: PulseState = { ...prev, offline: false };

      if (briefing && typeof briefing === "object" && "stats" in briefing && briefing.stats && typeof briefing.stats === "object") {
        const s = briefing.stats as Record<string, unknown>;
        next.drafts = Number(s.drafts_awaiting_review) || 0;
        next.costToday = Number(s.cost_today_usd || 0).toFixed(2);
        next.budgetToday = Number(s.budget_today_usd || 0).toFixed(2);
        next.pipeline = Number(s.emails_awaiting_triage) || 0;
      }

      if (status && typeof status === "object") {
        const both = !!status.gmail_connected && !!status.anthropic_configured;
        const none = !status.gmail_connected && !status.anthropic_configured;
        next.health = both ? "green" : none ? "red" : "amber";
        next.gmailConnected = !!status.gmail_connected;
        next.anthropicConfigured = !!status.anthropic_configured;
      }

      if (phase1 && typeof phase1 === "object" && "successRate" in phase1 && typeof phase1.successRate === "number") {
        next.phase1Rate = phase1.successRate;
      }

      console.debug("[OpsPulse] computed state:", next);
      return next;
    });
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [poll]);

  if (state.offline) {
    return (
      <div className="p-4 bg-surface-raised rounded-lg border border-amber-500/20 text-center" role="status">
        <div className="flex items-center justify-center gap-2 text-sm text-amber-400">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
          Backend offline
        </div>
      </div>
    );
  }

  const costNum = parseFloat(state.costToday || "0");
  const budgetNum = parseFloat(state.budgetToday || "1");
  const budgetPct = budgetNum > 0 ? Math.min(100, Math.round((costNum / budgetNum) * 100)) : 0;
  const budgetColor = budgetPct > 80 ? "bg-red-400" : budgetPct > 50 ? "bg-amber-400" : "bg-emerald-400";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
      {/* Drafts */}
      <KpiCard label="Drafts" onClick={onDraftClick}>
        <div className="flex items-center gap-2">
          <span className={`text-lg font-semibold tabular-nums ${
            state.drafts && state.drafts > 0 ? "text-accent-bright" : "text-zinc-300"
          }`}>
            {typeof state.drafts === "number" ? state.drafts : "--"}
          </span>
          {state.drafts != null && state.drafts > 0 && (
            <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
          )}
        </div>
      </KpiCard>

      {/* Budget */}
      <KpiCard label="Budget">
        <span className="text-lg font-semibold tabular-nums text-zinc-300">
          ${state.costToday ?? "--"}
        </span>
        {state.costToday != null && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${budgetColor}`}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            <span className="text-[10px] text-zinc-600 tabular-nums">${state.budgetToday}</span>
          </div>
        )}
      </KpiCard>

      {/* Pipeline */}
      <KpiCard label="Pipeline">
        <span className={`text-lg font-semibold tabular-nums ${
          typeof state.pipeline === "number" && state.pipeline > 0 ? "text-zinc-200" : "text-zinc-500"
        }`}>
          {typeof state.pipeline === "number" ? state.pipeline : "--"}
        </span>
        <span className="text-[10px] text-zinc-600">awaiting triage</span>
      </KpiCard>

      {/* Health */}
      <KpiCard label="Health">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              state.health === "green" ? "bg-emerald-400" :
              state.health === "amber" ? "bg-amber-400" :
              state.health === "red" ? "bg-red-400" : "bg-zinc-600"
            }`}
          />
          <span className={`text-sm font-medium ${
            state.health === "green" ? "text-emerald-400" :
            state.health === "amber" ? "text-amber-400" :
            state.health === "red" ? "text-red-400" : "text-zinc-500"
          }`}>
            {state.health === "green" ? "Healthy" :
             state.health === "amber" ? "Degraded" :
             state.health === "red" ? "Offline" : "--"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {state.gmailConnected != null && <ServiceDot connected={state.gmailConnected} label="Gmail" />}
          {state.anthropicConfigured != null && <ServiceDot connected={state.anthropicConfigured} label="Claude" />}
        </div>
      </KpiCard>

      {/* Phase 1 */}
      <KpiCard label="Phase 1" className="col-span-2 sm:col-span-1">
        <span className={`text-lg font-semibold tabular-nums ${
          state.phase1Rate != null && state.phase1Rate >= 80 ? "text-emerald-400" :
          state.phase1Rate != null && state.phase1Rate >= 50 ? "text-amber-400" :
          state.phase1Rate != null ? "text-red-400" : "text-zinc-500"
        }`}>
          {state.phase1Rate != null ? `${state.phase1Rate}%` : "--"}
        </span>
        <span className="text-[10px] text-zinc-600">success rate</span>
      </KpiCard>
    </div>
  );
}
