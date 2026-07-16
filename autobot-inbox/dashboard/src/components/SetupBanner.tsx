"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

interface Status {
  gmail_connected: boolean;
  gmail_credentials: boolean;
  anthropic_configured: boolean;
  demo_mode: boolean;
  gmail_email: string | null;
}

interface Account {
  id: string;
  channel: string;
  label: string;
  identifier: string;
  is_active: boolean;
  sync_status: string;
}

export default function SetupBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const fetchAll = () => {
      fetch(`${API_URL}/api/status`)
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => {});
      fetch(`${API_URL}/api/accounts`)
        .then((r) => r.json())
        .then((data) => setAccounts(data.accounts || []))
        .catch(() => {});
    };
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!status) return null;
  if (status.demo_mode) return null;

  const activeAccounts = accounts.filter((a) => a.is_active);
  const setupAccounts = activeAccounts.filter((a) => a.sync_status === "setup");
  const syncingAccounts = activeAccounts.filter(
    (a) => a.sync_status === "pending" || a.sync_status === "syncing"
  );
  const healthyAccounts = activeAccounts.filter((a) => a.sync_status === "active");

  // State 1: No accounts at all — prompt to connect
  if (activeAccounts.length === 0) {
    const connectGmail = async () => {
      if (!status.gmail_credentials) return;
      setConnecting(true);
      try {
        const res = await fetch(`${API_URL}/api/auth/gmail-url`);
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

    return (
      <div className="mb-6 rounded-lg border border-accent/30 bg-accent/5 p-5">
        <div className="flex items-start gap-4">
          <div className="mt-0.5">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-bright">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-white">Connect an account to get started</h3>
            <p className="mt-1 text-sm text-zinc-400">
              {!status.gmail_credentials
                ? "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your .env file first, then restart."
                : "Connect your Gmail so AutoBot can read, triage, and draft replies."}
            </p>
            {!status.anthropic_configured && (
              <p className="mt-1 text-sm text-status-action">
                ANTHROPIC_API_KEY is also missing — add it in{" "}
                <Link href="/settings" className="underline">Settings</Link>.
              </p>
            )}
          </div>
          {status.gmail_credentials && (
            <button
              onClick={connectGmail}
              disabled={connecting}
              className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
            >
              {connecting ? "Connecting..." : "Connect Gmail"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // State 2: Voice training in progress — not yet syncing
  if (setupAccounts.length > 0 && healthyAccounts.length === 0 && syncingAccounts.length === 0) {
    return (
      <div className="mb-6 rounded-lg border border-accent/30 bg-accent/5 p-5">
        <div className="flex items-center gap-4">
          <div className="h-5 w-5 shrink-0">
            <svg className="animate-spin text-accent-bright" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-white">Training voice model</h3>
            <p className="mt-0.5 text-sm text-zinc-400">
              Learning your writing style — email sync will begin after training completes.{" "}
              <Link href="/settings/voice-train" className="text-accent-bright underline hover:text-accent">
                View progress
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // State 3: Accounts syncing (pending/syncing status)
  if (healthyAccounts.length === 0 && (syncingAccounts.length > 0 || setupAccounts.length > 0)) {
    return (
      <div className="mb-6 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-5">
        <div className="flex items-center gap-4">
          <div className="h-5 w-5 shrink-0">
            <svg className="animate-spin text-yellow-400" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-white">Syncing your inbox</h3>
            <p className="mt-0.5 text-sm text-zinc-400">
              {syncingAccounts.length === 1
                ? `${syncingAccounts[0].identifier} is connecting — emails will appear within 60 seconds.`
                : `${syncingAccounts.length} accounts connecting — emails will appear within 60 seconds.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // State 4: All good — hide banner
  return null;
}
