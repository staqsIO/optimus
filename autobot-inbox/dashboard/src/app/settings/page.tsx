"use client";

import { useEffect, useState, useCallback } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

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

interface VoiceStatus {
  sentEmails: number;
  embeddingsGenerated: number;
  globalProfile: { sampleCount: number; formality: number; lastUpdated: string } | null;
  recipientProfiles: number;
  editDeltas: number;
  embeddingProvider: "voyage" | "openai" | null;
}

export default function SettingsPage() {
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
  const refresh = useCallback(() => {
    fetch(`${API_URL}/api/status`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    fetch(`${API_URL}/api/accounts`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => setAccounts(data.accounts || []))
      .catch(() => {});
    fetch(`${API_URL}/api/voice/status`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then(setVoiceStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connectGmail = async (label?: string) => {
    setConnecting(true);
    try {
      const endpoint = label
        ? `${API_URL}/api/auth/gmail?label=${encodeURIComponent(label)}`
        : `${API_URL}/api/auth/gmail-url`;
      const res = await fetch(endpoint);
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
      await fetch("/api/proxy", {
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
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/accounts/delete", body: { accountId } }),
      });
      refresh();
    } catch {}
    setDisconnectingId(null);
  };

  const resyncAccount = async (accountId: string) => {
    setResyncingId(accountId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/proxy", {
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
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/contacts/sync", body: { accountId } }),
      });
      refresh();
    } catch {}
    setSyncingContactsId(null);
  };

  const activateAccount = async (accountId: string) => {
    setActivatingId(accountId);
    try {
      await fetch("/api/proxy", {
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
      const res = await fetch("/api/proxy", {
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
                className="flex items-center justify-between rounded-md bg-surface-overlay px-4 py-3"
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
                <div className="flex items-center gap-3">
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
                      <a
                        href={`/settings/voice-train?accountId=${acc.id}&email=${encodeURIComponent(acc.identifier)}&label=${encodeURIComponent(acc.label)}`}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-dim"
                      >
                        Train Voice
                      </a>
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
          <div className="flex items-center gap-2">
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
            <div key={key} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    configured ? "bg-status-approved" : "bg-status-action"
                  }`}
                />
                <span className="text-sm text-zinc-300">{label}</span>
              </div>
              <div className="flex items-center gap-2">
                {configured && !keyInputs[key] && keySaved !== key && (
                  <span className="text-xs text-zinc-500">Configured</span>
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
                  className="w-48 rounded-md bg-surface-overlay border border-white/10 px-2 py-1 text-xs text-white placeholder:text-zinc-600 focus:border-accent focus:outline-none font-mono"
                />
                <button
                  onClick={() => saveKey(key)}
                  disabled={keySaving === key || !keyInputs[key] || (keyInputs[key]?.length || 0) < 8}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
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
