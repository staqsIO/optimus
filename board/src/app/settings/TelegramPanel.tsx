"use client";

import { useEffect, useState, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TelegramAccount {
  id: string;
  label: string;
  identifier: string;
  is_active: boolean;
  sync_status: string;
  last_sync_at: string | null;
  last_error: string | null;
}

interface TelegramStatus {
  bot_token_configured: boolean;
  board_user_ids_count: number;
  board_user_ids_configured: boolean;
  accounts: TelegramAccount[];
  stats_24h: {
    inbound: number;
    outbound: number;
    notifications: number;
  };
}

type EventType = "message" | "draft_send" | "notification";
type Direction = "inbound" | "outbound";

interface TelegramEvent {
  id: string;
  direction: Direction;
  event_type: EventType;
  sender?: string;
  sender_name?: string;
  recipient?: string;
  body: string;
  chat_id?: string | null;
  ts: string;
  send_state?: string;
  board_action?: string;
  telegram_msg_id?: string;
  intent_type?: string;
  source_agent?: string;
  work_item_id?: string;
}

interface ActivityResponse {
  since: string;
  limit: number;
  total: number;
  inbound_count: number;
  outbound_count: number;
  events: TelegramEvent[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sendStateLabel(state?: string): string {
  switch (state) {
    case "delivered":
      return "Delivered";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "logged":
      return "Logged";
    case "approved":
      return "Approved";
    case "sent":
      return "Sent";
    case "blocked":
      return "Blocked";
    default:
      return state ?? "—";
  }
}

function sendStateColor(state?: string): string {
  switch (state) {
    case "delivered":
    case "sent":
      return "bg-status-approved";
    case "pending":
    case "logged":
    case "approved":
      return "bg-yellow-400";
    case "failed":
    case "blocked":
      return "bg-status-action";
    default:
      return "bg-zinc-600";
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ ok, dim = false }: { ok: boolean | null; dim?: boolean }) {
  const color =
    ok === null
      ? "bg-zinc-500"
      : ok
        ? "bg-status-approved"
        : "bg-status-action";
  return (
    <div
      className={`h-2 w-2 rounded-full shrink-0 ${color} ${dim ? "opacity-50" : ""}`}
    />
  );
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <StatusDot ok={ok} />
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <span className="text-sm text-zinc-500">{detail}</span>
    </div>
  );
}

function EventRow({ event }: { event: TelegramEvent }) {
  const isInbound = event.direction === "inbound";
  const actor = isInbound
    ? event.sender_name || event.sender || "Unknown"
    : event.recipient || "Board";
  const snippet =
    event.body.length > 120 ? event.body.slice(0, 120) + "…" : event.body;

  return (
    <div className="flex gap-3 py-2.5 border-b border-white/5 last:border-0">
      {/* Direction indicator */}
      <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
        <span
          className={`text-[10px] font-mono px-1 py-0.5 rounded ${
            isInbound
              ? "bg-blue-900/40 text-blue-300"
              : "bg-emerald-900/40 text-emerald-300"
          }`}
        >
          {isInbound ? "IN" : "OUT"}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-zinc-300 truncate">
            {actor}
          </span>
          {event.chat_id && (
            <span className="text-[10px] text-zinc-600 font-mono">
              chat:{event.chat_id}
            </span>
          )}
          {/* Send state badge for outbound */}
          {!isInbound && event.send_state && (
            <span className="flex items-center gap-1 ml-auto shrink-0">
              <span
                className={`w-1.5 h-1.5 rounded-full ${sendStateColor(event.send_state)}`}
              />
              <span className="text-[10px] text-zinc-500">
                {sendStateLabel(event.send_state)}
              </span>
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">{snippet}</p>
        {event.source_agent && (
          <p className="text-[10px] text-zinc-600 mt-0.5">
            via {event.source_agent}
          </p>
        )}
      </div>

      {/* Timestamp */}
      <div className="text-[10px] text-zinc-600 shrink-0 pt-0.5 whitespace-nowrap">
        {relativeTime(event.ts)}
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function TelegramPanel() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "inbound" | "outbound">("all");

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      opsFetch<TelegramStatus>("/api/telegram/status"),
      fetch("/api/telegram/activity?limit=50")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([statusData, activityData]) => {
        setStatus(statusData);
        setActivity(activityData as ActivityResponse | null);
      })
      .catch(() => setError("Failed to load Telegram data"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleEvents =
    activity?.events.filter((e) =>
      filter === "all" ? true : e.direction === filter
    ) ?? [];

  // ── Loading state
  if (loading && !status) {
    return (
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">Telegram</h2>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Telegram</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="text-xs text-status-action bg-status-action/10 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Connection status */}
      {status && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-400">
            Connection Status
          </h3>
          <div className="space-y-2.5">
            <StatusRow
              label="Bot Token"
              ok={status.bot_token_configured}
              detail={
                status.bot_token_configured ? "Configured" : "Not configured"
              }
            />
            <StatusRow
              label="Board Members"
              ok={status.board_user_ids_configured}
              detail={
                status.board_user_ids_configured
                  ? `${status.board_user_ids_count} user ID${status.board_user_ids_count !== 1 ? "s" : ""} configured`
                  : "TELEGRAM_BOARD_USER_IDS not set"
              }
            />
            {status.accounts.length > 0 ? (
              status.accounts.map((acc) => (
                <StatusRow
                  key={acc.id}
                  label={acc.label || acc.identifier || "Telegram account"}
                  ok={acc.is_active && acc.sync_status === "active"}
                  detail={
                    !acc.is_active
                      ? "Disconnected"
                      : acc.sync_status === "active"
                        ? "Active"
                        : acc.sync_status
                  }
                />
              ))
            ) : (
              <StatusRow
                label="Account"
                ok={status.bot_token_configured}
                detail={
                  status.bot_token_configured
                    ? "Bot registered (no inbox.accounts row)"
                    : "Not registered"
                }
              />
            )}
          </div>

          {/* 24h stats */}
          <div className="grid grid-cols-3 gap-3 pt-2">
            {(
              [
                {
                  label: "Inbound",
                  value: status.stats_24h.inbound,
                  color: "text-blue-300",
                },
                {
                  label: "Sent",
                  value: status.stats_24h.outbound,
                  color: "text-emerald-300",
                },
                {
                  label: "Notifications",
                  value: status.stats_24h.notifications,
                  color: "text-zinc-300",
                },
              ] as const
            ).map(({ label, value, color }) => (
              <div
                key={label}
                className="bg-surface rounded-md p-3 text-center border border-white/5"
              >
                <div className={`text-lg font-semibold ${color}`}>{value}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{label} (24h)</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-400">
            Recent Activity
            {activity && (
              <span className="ml-2 text-zinc-600 font-normal">
                ({activity.total} in last 7 days)
              </span>
            )}
          </h3>

          {/* Direction filter */}
          <div className="flex gap-1">
            {(["all", "inbound", "outbound"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[10px] px-2 py-1 rounded capitalize transition-colors ${
                  filter === f
                    ? "bg-accent/20 text-accent-bright"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {!activity && !loading && (
          <div className="py-6 text-center">
            <p className="text-sm text-zinc-500">No activity data available.</p>
            <p className="text-xs text-zinc-600 mt-1">
              Gap: <code className="font-mono">autobot_comms.outbound_intents</code> and{" "}
              <code className="font-mono">inbox.messages</code> are the data sources.
              Data will appear once the Telegram bot sends or receives messages.
            </p>
          </div>
        )}

        {activity && visibleEvents.length === 0 && (
          <div className="py-6 text-center">
            <p className="text-sm text-zinc-500">
              No {filter === "all" ? "" : filter + " "}events in the last 7 days.
            </p>
          </div>
        )}

        {visibleEvents.length > 0 && (
          <div className="divide-y divide-white/5">
            {visibleEvents.map((event) => (
              <EventRow key={`${event.event_type}-${event.id}`} event={event} />
            ))}
          </div>
        )}
      </div>

      {/* Data source note */}
      <p className="text-[10px] text-zinc-600 border-t border-white/5 pt-3">
        Inbound from <code className="font-mono">inbox.messages</code> (channel=telegram).
        Outbound from <code className="font-mono">agent_graph.action_proposals</code> +{" "}
        <code className="font-mono">autobot_comms.outbound_intents</code>. Read-only.
      </p>
    </div>
  );
}
