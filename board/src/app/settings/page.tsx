"use client";

import { useEffect, useState, useCallback } from "react";
import { inboxGet } from "@/components/inbox/shared";
import { opsFetch } from "@/lib/ops-api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WidgetPicker from "@/components/WidgetPicker";
import TeamPanel from "@/components/settings/TeamPanel";
import TelegramPanel from "./TelegramPanel";

interface BoardMember {
  id: string;
  github_username: string;
  display_name: string;
  email: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}

interface Status {
  gmail_connected: boolean;
  gmail_credentials: boolean;
  anthropic_configured: boolean;
  openai_configured: boolean;
  voyage_configured: boolean;
  slack_configured: boolean;
  demo_mode: boolean;
  gmail_email: string | null;
}

interface Account {
  id: string;
  channel: string;
  label: string;
  identifier: string;
  is_active: boolean;
  last_sync_at: string | null;
  sync_status: string;
  last_error: string | null;
  created_at: string;
}

interface CalendarWatch {
  id: string;
  account_email: string;
  calendar_id: string;
  label: string;
  is_active: boolean;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface VoiceStatus {
  sentEmails: number;
  embeddingsGenerated: number;
  globalProfile: { sampleCount: number; formality: number; lastUpdated: string } | null;
  recipientProfiles: number;
  editDeltas: number;
  embeddingProvider: "voyage" | "openai" | null;
}

export default function SettingsPage() {
  const { isAdmin, username: currentUsername } = useCurrentUser();
  const currentUser = currentUsername;
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [resyncingId, setResyncingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [addingLabel, setAddingLabel] = useState("");
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [syncingContactsId, setSyncingContactsId] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState<string | null>(null);
  // STAQPRO-327 calendar watches
  const [calendarWatches, setCalendarWatches] = useState<CalendarWatch[]>([]);
  const [calendarAdding, setCalendarAdding] = useState(false);
  const [calendarEmail, setCalendarEmail] = useState("");
  const [calendarCalendarId, setCalendarCalendarId] = useState("primary");
  const [calendarLabel, setCalendarLabel] = useState("");
  const [calendarRemovingId, setCalendarRemovingId] = useState<string | null>(null);
  const [calendarBackfillingId, setCalendarBackfillingId] = useState<string | null>(null);
  const refresh = useCallback(() => {
    inboxGet("/api/status", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    inboxGet(`/api/accounts${currentUser ? `?owner=${encodeURIComponent(currentUser)}` : ''}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => setAccounts(data.accounts || data || []))
      .catch(() => {});
    inboxGet("/api/voice/status", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setVoiceStatus)
      .catch(() => {});
    inboxGet("/api/calendar/watches", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => setCalendarWatches(data.watches || []))
      .catch(() => {});
    opsFetch<{ members: BoardMember[] }>("/api/board-members")
      .then((data) => setMembers(data?.members || []))
      .catch(() => {});
  }, [currentUser]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connectGmail = async (label?: string) => {
    setConnecting(true);
    try {
      const ownerParam = currentUser ? `&owner=${encodeURIComponent(currentUser)}` : '';
      const path = label
        ? `/api/auth/gmail?label=${encodeURIComponent(label)}${ownerParam}`
        : `/api/auth/gmail-url?owner=${encodeURIComponent(currentUser)}`;
      const res = await inboxGet(path);
      const { url, error } = await res.json();
      if (error) {
        alert(error);
        setConnecting(false);
        return;
      }
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  const disconnectAccount = async (accountId: string) => {
    setDisconnectingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/disconnect", body: { accountId } }),
      });
      refresh();
    } catch {}
    setDisconnectingId(null);
  };

  const deleteAccount = async (accountId: string) => {
    if (!confirm("Permanently delete this account and all its data? This cannot be undone.")) return;
    setDisconnectingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/delete", body: { accountId } }),
      });
      refresh();
    } catch {}
    setDisconnectingId(null);
  };

  // STAQPRO-318: when an account's refresh token is revoked / expired, Resync
  // is useless — the only recovery is a fresh OAuth dance bound to the
  // existing row. Reconnect kicks off /api/auth/gmail-url?accountId=… which
  // pre-fills login_hint and rebinds the new token to the same account.
  const reconnectAccount = async (accountId: string) => {
    setConnecting(true);
    try {
      const ownerParam = currentUser ? `&owner=${encodeURIComponent(currentUser)}` : '';
      const res = await inboxGet(`/api/auth/gmail-url?accountId=${encodeURIComponent(accountId)}${ownerParam}`);
      const { url, error } = await res.json();
      if (error) {
        alert(error);
        setConnecting(false);
        return;
      }
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  // Detect refresh-token-revoked / expired-grant errors. Google's `invalid_grant`
  // is the canonical signal, but other OAuth failures (unauthorized_client,
  // 401 from gmail.modify) require the same recovery — a fresh consent dance.
  const isAuthFailure = (lastError: string | null | undefined): boolean => {
    if (!lastError) return false;
    const e = lastError.toLowerCase();
    return (
      e.includes('invalid_grant') ||
      e.includes('unauthorized') ||
      e.includes('token has been expired') ||
      e.includes('invalid_client')
    );
  };

  // STAQPRO-536: Calendar uses a *service account* with domain-wide
  // delegation (calendar.readonly), NOT a per-user OAuth grant. So a calendar
  // sync failure is never recoverable with a per-user "Reconnect" dance —
  // it's an admin/infra action (re-grant delegation scopes, fix the service
  // account key, or re-enable the API). We surface the failure as a
  // "Service Account Error" label with an admin instruction, mirroring
  // isAuthFailure() above but deliberately routing to a different (admin)
  // remediation path rather than a reconnect button.
  const isCalendarAuthFailure = (lastError: string | null | undefined): boolean => {
    if (!lastError) return false;
    const e = lastError.toLowerCase();
    return (
      e.includes('invalid_grant') ||
      e.includes('unauthorized') ||
      e.includes('forbidden') ||
      e.includes('permission') ||
      e.includes('delegation') ||
      e.includes('service account') ||
      e.includes('insufficient') ||
      e.includes('access_denied') ||
      e.includes('invalid_client')
    );
  };

  const resyncAccount = async (accountId: string) => {
    setResyncingId(accountId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/api/accounts/resync", body: { accountId } }),
        });
        if (res.ok) { refresh(); break; }
        if (res.status !== 503 || attempt === 2) break;
        // Agents busy — wait and retry
        await new Promise(r => setTimeout(r, 3000));
      } catch { break; }
    }
    setResyncingId(null);
  };

  const syncContacts = async (accountId: string) => {
    setSyncingContactsId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/contacts/sync", body: { accountId } }),
      });
      refresh();
    } catch {}
    setSyncingContactsId(null);
  };

  const [trainingId, setTrainingId] = useState<string | null>(null);

  const trainVoice = async (accountId: string) => {
    setTrainingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/voice/bootstrap", body: { accountId, sampleSize: 500 } }),
      });
      refresh();
    } catch {}
    setTrainingId(null);
  };

  const activateAccount = async (accountId: string) => {
    setActivatingId(accountId);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/activate", body: { accountId } }),
      });
      refresh();
    } catch {}
    setActivatingId(null);
  };

  const saveKey = async (key: string) => {
    const value = keyInputs[key];
    if (!value || value.length < 8) return;
    setKeySaving(key);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/settings/keys", body: { key, value } }),
      });
      const data = await res.json();
      if (data.ok) {
        setKeySaved(key);
        setKeyInputs((prev) => ({ ...prev, [key]: "" }));
        setTimeout(() => setKeySaved(null), 2000);
        refresh();
      }
    } catch {}
    setKeySaving(null);
  };

  const addCalendarWatch = async () => {
    if (!calendarEmail) return;
    setCalendarAdding(true);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/calendar/watches",
          body: {
            account_email: calendarEmail.trim().toLowerCase(),
            calendar_id: (calendarCalendarId || "primary").trim(),
            label: calendarLabel.trim() || `${calendarEmail.trim()} (${calendarCalendarId || "primary"})`,
          },
        }),
      });
      const data = await res.json();
      if (data?.error) {
        // eslint-disable-next-line no-alert
        alert(data.error);
      } else {
        setCalendarEmail("");
        setCalendarLabel("");
        setCalendarCalendarId("primary");
        refresh();
      }
    } catch {}
    setCalendarAdding(false);
  };

  const removeCalendarWatch = async (id: string) => {
    setCalendarRemovingId(id);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/calendar/watches/remove", body: { id } }),
      });
      refresh();
    } catch {}
    setCalendarRemovingId(null);
  };

  const backfillCalendarWatch = async (id: string) => {
    setCalendarBackfillingId(id);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/calendar/watches/backfill",
          body: { id, lookback_days: 400 },
        }),
      });
      const data = await res.json();
      if (data?.error) {
        // eslint-disable-next-line no-alert
        alert(data.error);
        setCalendarBackfillingId(null);
        return;
      }
      // Backfill is fire-and-forget on the server — it can take minutes for
      // 400 days of events. Capture the current last_poll_at so we can
      // detect when the server-side run completes (or errors), and keep
      // the button in "Running..." until then.
      const startingRow = calendarWatches.find((w) => w.id === id);
      const startingLastPoll = startingRow?.last_poll_at || null;
      const deadline = Date.now() + 90_000; // 90s window — long enough for a typical 400d backfill on a small calendar.
      const tick = async () => {
        try {
          const r = await fetch(
            `/api/inbox-proxy?path=${encodeURIComponent("/api/calendar/watches")}`,
          );
          const d = await r.json();
          const row = (d?.watches || []).find((w: CalendarWatch) => w.id === id);
          const changed =
            row && (row.last_poll_at !== startingLastPoll || row.last_error);
          setCalendarWatches(d?.watches || []);
          if (changed || Date.now() > deadline) {
            setCalendarBackfillingId(null);
            return;
          }
        } catch {
          // Transient — keep polling.
        }
        setTimeout(tick, 4000);
      };
      setTimeout(tick, 4000);
    } catch {
      setCalendarBackfillingId(null);
    }
  };

  if (!status) {
    return (
      <div className="space-y-8">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  const API_KEYS: { key: string; label: string; configured: boolean }[] = [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API", configured: status.anthropic_configured },
    { key: "OPENAI_API_KEY", label: "OpenAI API", configured: status.openai_configured },
    { key: "VOYAGE_API_KEY", label: "Voyage AI", configured: status.voyage_configured },
    { key: "SLACK_BOT_TOKEN", label: "Slack Bot", configured: status.slack_configured },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Dashboard Preferences */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">Dashboard</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Choose which widgets appear on your Today page. Select a preset or toggle individual widgets.
        </p>
        <WidgetPicker />
      </div>

      <TeamPanel
        members={members}
        setMembers={setMembers}
        currentUsername={currentUsername}
        isAdmin={isAdmin}
      />


      {/* Connected Accounts */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Connected Accounts</h2>
          <span className="text-xs text-zinc-500">{accounts.filter((a) => a.is_active).length} active</span>
        </div>

        {accounts.length > 0 ? (
          <div className="space-y-3 mb-4">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-md bg-surface-overlay px-4 py-3 gap-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      acc.channel === "slack"
                        ? "bg-purple-500/20 text-purple-400"
                        : "bg-blue-500/20 text-blue-400"
                    }`}
                  >
                    {acc.channel === "slack" ? "# Slack" : "\u2709 Email"}
                  </span>
                  <div>
                    <div className="text-sm text-white font-medium">{acc.label}</div>
                    <div className="text-xs text-zinc-500">{acc.identifier}</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <div
                        className={`h-2 w-2 rounded-full ${
                          !acc.is_active
                            ? "bg-zinc-600"
                            : acc.sync_status === "active"
                              ? "bg-status-approved"
                              : acc.sync_status === "error"
                                ? "bg-status-action"
                              : acc.sync_status === "setup"
                                ? "bg-orange-400"
                                : acc.sync_status === "syncing" || acc.sync_status === "pending"
                                  ? "bg-yellow-400"
                                  : "bg-zinc-600"
                        }`}
                      />
                      <span className="text-xs text-zinc-400">
                        {!acc.is_active
                          ? "Disconnected"
                          : acc.sync_status === "setup"
                            ? "Needs activation"
                            : acc.sync_status === "pending"
                              ? "Waiting for first sync"
                              : acc.sync_status === "active"
                                ? "Active"
                                : acc.sync_status === "syncing"
                                  ? "Syncing"
                                  : acc.sync_status === "error"
                                    ? "Error"
                                    : acc.sync_status}
                      </span>
                    </div>
                    {acc.last_sync_at && (
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Last sync: {new Date(acc.last_sync_at).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                  {acc.is_active && acc.sync_status === "setup" ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => trainVoice(acc.id)}
                        disabled={trainingId === acc.id}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
                      >
                        {trainingId === acc.id ? "Training..." : "Train Voice"}
                      </button>
                      <button
                        onClick={() => activateAccount(acc.id)}
                        disabled={activatingId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                      >
                        {activatingId === acc.id ? "..." : "Skip & Activate"}
                      </button>
                    </div>
                  ) : acc.is_active ? (
                    <div className="flex gap-2">
                      {/* STAQPRO-318: when sync_status='error' AND last_error
                          looks like an OAuth failure, Resync is useless —
                          surface Reconnect (fresh OAuth bound to this row)
                          instead, and hide Resync to avoid the dead-button trap. */}
                      {acc.sync_status === "error" && isAuthFailure(acc.last_error) ? (
                        <button
                          onClick={() => reconnectAccount(acc.id)}
                          disabled={connecting}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
                          title="OAuth token revoked or expired — re-authorize this account"
                        >
                          {connecting ? "..." : "Reconnect"}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => syncContacts(acc.id)}
                            disabled={syncingContactsId === acc.id}
                            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                          >
                            {syncingContactsId === acc.id ? "..." : "Sync Contacts"}
                          </button>
                          <button
                            onClick={() => resyncAccount(acc.id)}
                            disabled={resyncingId === acc.id}
                            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/30 hover:text-white disabled:opacity-50"
                          >
                            {resyncingId === acc.id ? "..." : "Resync"}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => disconnectAccount(acc.id)}
                        disabled={disconnectingId === acc.id}
                        className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
                      >
                        {disconnectingId === acc.id ? "..." : "Disconnect"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => deleteAccount(acc.id)}
                      disabled={disconnectingId === acc.id}
                      className="rounded-md border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {disconnectingId === acc.id ? "..." : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500 mb-4">No accounts connected yet.</div>
        )}

        {/* Add Account */}
        {status.gmail_credentials ? (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              type="text"
              value={addingLabel}
              onChange={(e) => setAddingLabel(e.target.value)}
              placeholder="Label (e.g., Work Email)"
              className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
            />
            <button
              onClick={() => connectGmail(addingLabel || "Gmail")}
              disabled={connecting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 whitespace-nowrap"
            >
              {connecting ? "Connecting..." : "+ Add Gmail Account"}
            </button>
          </div>
        ) : (
          <div className="rounded-md bg-surface-overlay p-4 text-sm text-zinc-400">
            <p className="font-medium text-zinc-300 mb-1">
              OAuth credentials required
            </p>
            <p>
              Set <code className="text-accent-bright">GMAIL_CLIENT_ID</code>{" "}
              and{" "}
              <code className="text-accent-bright">GMAIL_CLIENT_SECRET</code>{" "}
              in your .env file, then restart.
            </p>
          </div>
        )}

        <p className="text-xs text-zinc-500 mt-3">
          Add multiple Gmail accounts to aggregate all inboxes. Each account is polled independently.
        </p>
      </div>

      {/* Drive Folder Watches */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-2">Drive Folder Watches</h2>
        <p className="text-sm text-zinc-400">
          Drive folder capture has moved to the{" "}
          <a href="/capture" className="text-accent hover:underline">Capture page</a>.
        </p>
      </div>

      {/* Calendar Watches (STAQPRO-327) */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Calendar Watches</h2>
          <span className="text-xs text-zinc-500">{calendarWatches.filter(w => w.is_active).length} active</span>
        </div>

        {calendarWatches.length > 0 ? (
          <div className="space-y-3 mb-4">
            {calendarWatches.map((watch) => (
              <div
                key={watch.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between rounded-md bg-surface-overlay px-4 py-3 gap-3"
              >
                <div className="flex items-center gap-3">
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-300">
                    gcal
                  </span>
                  <div>
                    <div className="text-sm text-white font-medium">{watch.label}</div>
                    <div className="text-xs text-zinc-500">
                      {watch.account_email}{watch.calendar_id !== "primary" ? ` · ${watch.calendar_id}` : ""}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="flex items-center gap-1.5">
                      <div className={`h-2 w-2 rounded-full ${
                        watch.last_error ? "bg-status-action"
                          : watch.is_active ? "bg-status-approved"
                          : "bg-zinc-600"
                      }`} />
                      {/* STAQPRO-536: a service-account auth failure can't be
                          fixed by a per-user reconnect — label it distinctly
                          and point the operator at the admin remediation path
                          via tooltip (no reconnect button: calendar uses a
                          domain-wide-delegated service-account JWT). */}
                      <span
                        className="text-xs text-zinc-400"
                        title={
                          watch.last_error && isCalendarAuthFailure(watch.last_error)
                            ? "Service-account delegation failure. Calendar uses a domain-wide-delegated service account (calendar.readonly) — this is not fixable with a per-user reconnect. Admin action required: verify the service-account key, confirm domain-wide delegation scopes in the Google Workspace admin console, and ensure the Calendar API is enabled."
                            : undefined
                        }
                      >
                        {watch.last_error && isCalendarAuthFailure(watch.last_error)
                          ? "Service Account Error"
                          : watch.last_error ? "Error" : watch.is_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    {watch.last_poll_at && (
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Last poll: {new Date(watch.last_poll_at).toLocaleTimeString()}
                      </div>
                    )}
                    {watch.last_error && (
                      <div className="text-xs text-red-400 mt-0.5 max-w-48 truncate" title={watch.last_error}>
                        {watch.last_error}
                      </div>
                    )}
                    {watch.last_error && isCalendarAuthFailure(watch.last_error) && (
                      <div className="text-[11px] text-amber-400/80 mt-0.5 max-w-48">
                        Admin must re-grant service-account delegation — not a per-user reconnect.
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => backfillCalendarWatch(watch.id)}
                    disabled={calendarBackfillingId === watch.id}
                    title="Backfill the last 400 days of events"
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                  >
                    {calendarBackfillingId === watch.id ? "Running…" : "Backfill"}
                  </button>
                  <button
                    onClick={() => removeCalendarWatch(watch.id)}
                    disabled={calendarRemovingId === watch.id}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
                  >
                    {calendarRemovingId === watch.id ? "..." : "Remove"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500 mb-4">No calendars connected.</div>
        )}

        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              type="email"
              value={calendarEmail}
              onChange={(e) => setCalendarEmail(e.target.value)}
              placeholder="Workspace email (e.g. eric@staqs.io)"
              className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
            />
            <input
              type="text"
              value={calendarLabel}
              onChange={(e) => setCalendarLabel(e.target.value)}
              placeholder="Label (e.g., Eric's Calendar)"
              className="w-full sm:w-48 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              type="text"
              value={calendarCalendarId}
              onChange={(e) => setCalendarCalendarId(e.target.value)}
              placeholder="Calendar ID (default: primary)"
              className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none"
            />
            <button
              onClick={addCalendarWatch}
              disabled={calendarAdding || !calendarEmail}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 whitespace-nowrap"
            >
              {calendarAdding ? "Adding..." : "+ Add Watch"}
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-500 mt-3">
          Read-only Google Calendar ingestion. The service account already has domain-wide delegation for{" "}
          <code className="text-zinc-400">calendar.readonly</code>. You manage your <strong>own</strong> calendars here —
          the email must be one of your connected addresses (teammates connect their own; their calendars become
          toggleable on the <strong>Calendar</strong> page). Use <code className="text-zinc-400">primary</code> for your
          default calendar, or paste a secondary calendar ID.
          Click <strong>Backfill</strong> to import historic events back ~400 days.
        </p>
      </div>

      {/* Voice Training */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">Voice Training</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Analyze sent emails to learn your writing style — greetings, closings,
          vocabulary, and tone.
        </p>

        {voiceStatus === null ? (
          <div className="text-sm text-zinc-500">Loading voice status...</div>
        ) : voiceStatus.sentEmails === 0 ? (
          <div className="rounded-md bg-surface-overlay p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-2 w-2 rounded-full bg-zinc-600" />
              <span className="text-sm text-zinc-300 font-medium">Not trained</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">
              No sent emails analyzed yet. Connect an account and run voice training to enable reply drafting in your style.
            </p>
            <code className="text-xs text-accent-bright">npm run bootstrap-voice</code>
          </div>
        ) : (
          <div className="space-y-3">
            <StatusRow
              label="Voice Profile"
              ok={!!voiceStatus.globalProfile}
              detail={
                voiceStatus.globalProfile
                  ? `${voiceStatus.globalProfile.sampleCount} samples, formality ${voiceStatus.globalProfile.formality.toFixed(2)}`
                  : "Not built"
              }
            />
            <StatusRow
              label="Sent Emails"
              ok={voiceStatus.sentEmails > 0}
              detail={`${voiceStatus.sentEmails} analyzed`}
            />
            <StatusRow
              label="Embeddings"
              ok={voiceStatus.embeddingsGenerated > 0}
              detail={
                voiceStatus.embeddingProvider
                  ? `${voiceStatus.embeddingsGenerated} via ${voiceStatus.embeddingProvider}`
                  : `${voiceStatus.embeddingsGenerated} (no provider configured)`
              }
            />
            <StatusRow
              label="Recipient Profiles"
              ok={voiceStatus.recipientProfiles > 0}
              detail={`${voiceStatus.recipientProfiles} profiles`}
            />
            <StatusRow
              label="Edit Deltas"
              ok={null}
              detail={`${voiceStatus.editDeltas} recorded`}
            />
            <div className="pt-2">
              <code className="text-xs text-accent-bright">npm run bootstrap-voice</code>
              <span className="text-xs text-zinc-500 ml-2">to re-train</span>
            </div>
          </div>
        )}
      </div>

      {/* API Keys */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">API Keys</h2>
        <div className="space-y-3">
          {API_KEYS.map(({ key, label, configured }) => (
            <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    configured ? "bg-status-approved" : "bg-status-action"
                  }`}
                />
                <span className="text-sm text-zinc-300">{label}</span>
                {configured && !keyInputs[key] && keySaved !== key && (
                  <span className="text-xs text-zinc-500 sm:hidden">Configured</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {configured && !keyInputs[key] && keySaved !== key && (
                  <span className="text-xs text-zinc-500 hidden sm:inline">Configured</span>
                )}
                {keySaved === key && (
                  <span className="text-xs text-green-400">Saved</span>
                )}
                <input
                  type="password"
                  value={keyInputs[key] || ""}
                  onChange={(e) =>
                    setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={configured ? "Replace key..." : "sk-..."}
                  className="w-full sm:w-48 rounded-md bg-surface-overlay border border-white/10 px-2 py-1 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none font-mono"
                />
                <button
                  onClick={() => saveKey(key)}
                  disabled={keySaving === key || !keyInputs[key] || (keyInputs[key]?.length || 0) < 8}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50 shrink-0"
                >
                  {keySaving === key ? "..." : "Save"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Keys are saved to .env and loaded into the running process. Anthropic is required; OpenAI or Voyage enable embeddings.
        </p>
      </div>

      {/* Telegram */}
      <TelegramPanel />

      {/* System Status */}
      <div className="bg-surface-raised rounded-lg border border-white/5 p-6">
        <h2 className="text-lg font-semibold mb-4">System Status</h2>
        <div className="space-y-3">
          <StatusRow
            label="Gmail"
            ok={status.gmail_connected}
            detail={status.gmail_connected ? status.gmail_email || "Connected" : "No active account"}
          />
          <StatusRow
            label="Accounts"
            ok={accounts.filter((a) => a.is_active).length > 0}
            detail={`${accounts.filter((a) => a.is_active).length} active`}
          />
          <StatusRow
            label="Demo Mode"
            ok={null}
            detail={status.demo_mode ? "Active" : "Off"}
          />
        </div>
      </div>
    </div>
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
        <div
          className={`h-2 w-2 rounded-full ${
            ok === null
              ? "bg-zinc-500"
              : ok
                ? "bg-status-approved"
                : "bg-status-action"
          }`}
        />
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <span className="text-sm text-zinc-500">{detail}</span>
    </div>
  );
}
