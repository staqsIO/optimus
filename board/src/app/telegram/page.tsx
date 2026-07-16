"use client";

// Plan 040 — first-class read-only view of Telegram comms activity.
// Reads GET /api/telegram/status + GET /api/telegram/activity via the inbox-proxy
// (board-role backend, ADR-019 board JWT). The Telegram channel is a single shared
// board channel — this is ops observability, not a per-viewer inbox. Read-only:
// no send/mutate affordances (an outbound-send surface is a separate, higher-risk plan).

import { Suspense, useCallback, useEffect, useState } from "react";
import { inboxGet, timeAgo } from "@/components/inbox/shared";
import { usePageContext } from "@/contexts/PageContext";

interface TelegramAccount {
  id: string;
  label: string | null;
  identifier: string | null;
  is_active: boolean;
  sync_status: string | null;
  last_sync_at: string | null;
  last_error: string | null;
}

interface TelegramStatus {
  bot_token_configured: boolean;
  board_user_ids_count: number;
  board_user_ids_configured: boolean;
  accounts: TelegramAccount[];
  stats_24h: { inbound: number; outbound: number; notifications: number };
}

interface TelegramEvent {
  id: string;
  direction: "inbound" | "outbound";
  event_type: "message" | "draft_send" | "notification";
  body: string | null;
  ts: string;
  // inbound
  sender?: string | null;
  sender_name?: string | null;
  chat_id?: string | null;
  work_item_id?: string | null;
  // outbound (draft_send + notification)
  recipient?: string | null;
  send_state?: string | null;
  // outbound draft_send
  board_action?: string | null;
  telegram_msg_id?: string | null;
  // outbound notification
  intent_type?: string | null;
  source_agent?: string | null;
}

interface TelegramActivity {
  since: string;
  limit: number;
  total: number;
  inbound_count: number;
  outbound_count: number;
  events: TelegramEvent[];
}

const DIRECTION_COLORS: Record<string, string> = {
  inbound: "bg-blue-500/20 text-blue-400",
  outbound: "bg-purple-500/20 text-purple-400",
};

const SEND_STATE_COLORS: Record<string, string> = {
  delivered: "bg-green-500/20 text-green-400",
  sent: "bg-green-500/20 text-green-400",
  pending: "bg-yellow-500/20 text-yellow-400",
  queued: "bg-yellow-500/20 text-yellow-400",
  failed: "bg-red-500/20 text-red-400",
  rejected: "bg-red-500/20 text-red-400",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  message: "message",
  draft_send: "reply",
  notification: "notification",
};

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-400">{label}</div>
    </div>
  );
}

function eventParty(ev: TelegramEvent): string {
  if (ev.direction === "inbound") {
    return ev.sender_name || ev.sender || "Unknown sender";
  }
  return ev.recipient || ev.source_agent || "—";
}

function TelegramPageInner() {
  const { setCurrentPage } = usePageContext();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [activity, setActivity] = useState<TelegramActivity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCurrentPage({ route: "/telegram", title: "Telegram" });
    return () => setCurrentPage(null);
  }, [setCurrentPage]);

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, activityRes] = await Promise.all([
        inboxGet("/api/telegram/status", { signal: AbortSignal.timeout(8000) }),
        inboxGet("/api/telegram/activity?limit=100", { signal: AbortSignal.timeout(8000) }),
      ]);
      if (statusRes.ok) setStatus((await statusRes.json()) as TelegramStatus);
      if (activityRes.ok) setActivity((await activityRes.json()) as TelegramActivity);
    } catch {
      // silent — retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 w-64 rounded bg-surface-raised animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-lg bg-surface-raised animate-pulse" />
      </div>
    );
  }

  const events = activity?.events ?? [];
  const stats = status?.stats_24h ?? { inbound: 0, outbound: 0, notifications: 0 };
  const accounts = status?.accounts ?? [];
  const botConnected = status?.bot_token_configured ?? false;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Telegram</h1>
        <p className="text-sm text-zinc-400">
          Inbound messages, outbound replies, and board notifications on the Telegram channel.
          Read-only — sending happens through the agent pipeline.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Inbound (24h)" value={stats.inbound} />
        <StatTile label="Outbound (24h)" value={stats.outbound} />
        <StatTile label="Notifications (24h)" value={stats.notifications} />
        <StatTile label="Events shown" value={events.length} />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Connection</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              botConnected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
            }`}
          >
            {botConnected ? "bot token configured" : "bot token missing"}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              status?.board_user_ids_configured
                ? "bg-green-500/20 text-green-400"
                : "bg-zinc-600/20 text-zinc-500"
            }`}
          >
            {status?.board_user_ids_count ?? 0} board user id
            {(status?.board_user_ids_count ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        {accounts.length > 0 && (
          <div className="space-y-2">
            {accounts.map((acct) => (
              <div
                key={acct.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-4 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{acct.label || acct.identifier || acct.id}</div>
                  {acct.last_error && (
                    <div className="truncate text-xs text-red-400">{acct.last_error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      acct.is_active
                        ? "bg-green-500/20 text-green-400"
                        : "bg-zinc-600/20 text-zinc-500"
                    }`}
                  >
                    {acct.sync_status || (acct.is_active ? "active" : "inactive")}
                  </span>
                  {acct.last_sync_at && (
                    <span className="text-xs text-zinc-500">{timeAgo(acct.last_sync_at)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent Activity</h2>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No Telegram activity in the selected window.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Direction</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Party</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((ev) => (
                  <tr key={`${ev.event_type}-${ev.id}`} className="hover:bg-surface-raised/50">
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          DIRECTION_COLORS[ev.direction] ?? "bg-zinc-500/20 text-zinc-400"
                        }`}
                      >
                        {ev.direction}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-zinc-400">
                      {EVENT_TYPE_LABELS[ev.event_type] ?? ev.event_type}
                    </td>
                    <td className="px-4 py-2 text-zinc-300">{eventParty(ev)}</td>
                    <td className="px-4 py-2 text-zinc-400">
                      <span className="line-clamp-2 max-w-md">{ev.body || "—"}</span>
                    </td>
                    <td className="px-4 py-2">
                      {ev.send_state ? (
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${
                            SEND_STATE_COLORS[ev.send_state] ?? "bg-zinc-500/20 text-zinc-400"
                          }`}
                        >
                          {ev.send_state}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{timeAgo(ev.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function TelegramPage() {
  return (
    <Suspense fallback={null}>
      <TelegramPageInner />
    </Suspense>
  );
}
