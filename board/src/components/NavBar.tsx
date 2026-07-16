"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useApiKey } from "./ApiKeyProvider";
import { useEventStreamContext } from "./EventStreamProvider";
import { opsFetch } from "@/lib/ops-api";

export default function NavBar() {
  const { data: session } = useSession();
  const { hasKey, saveKey, clearKey } = useApiKey();
  const { status: sseStatus, counters } = useEventStreamContext();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pendingShareCount, setPendingShareCount] = useState(0);

  // ADR-017 follow-up: poll pending share-grant invitations for the badge.
  // Cheap endpoint (single COUNT). 30s cadence — instant feedback comes from
  // the user navigating to /sharing, this is just the ambient notifier.
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    const tick = async () => {
      const r = await opsFetch<{ count: number }>("/api/sharing/pending-count");
      if (!cancelled) setPendingShareCount(r?.count || 0);
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [session?.user]);

  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [settingsOpen]);

  async function handleSave() {
    const trimmed = keyInput.trim();
    if (!trimmed || saving) return;
    setError("");
    setSaving(true);
    const result = await saveKey(trimmed);
    setSaving(false);
    if (result.error) {
      setError(result.error);
    } else {
      setKeyInput("");
      setSettingsOpen(false);
    }
  }

  async function handleClear() {
    if (saving) return;
    setError("");
    await clearKey();
    setKeyInput("");
    setSettingsOpen(false);
  }

  const navLinks = [
    { href: "/today", label: "Today", group: "ops" },
    { href: "/drafts", label: "Drafts", group: "ops" },
    { href: "/engagements", label: "Engagements", group: "ops" },
    { href: "/search", label: "Search", group: "ops" },
    { href: "/workstation", label: "Workstation", group: "system" },
    { href: "/governance", label: "Governance", group: "system" },
    { href: "/issues", label: "Issues", group: "system" },
    { href: "/pipeline", label: "Pipeline", group: "system" },
    { href: "/runs", label: "Runs", group: "system" },
    { href: "/campaigns", label: "Campaigns", group: "system" },
    { href: "/agents", label: "Agents", group: "system" },
    { href: "/activity", label: "Activity", group: "system" },
    { href: "/flows", label: "Flows", group: "system" },
    { href: "/contacts", label: "Contacts", group: "system" },
    { href: "/graph", label: "Graph", group: "system" },
    { href: "/knowledge-base", label: "Knowledge", group: "system" },
    { href: "/sharing", label: "Sharing", group: "system" },
    { href: "/spec", label: "Spec", group: "system" },
    { href: "/settings", label: "Settings", group: "system" },
  ];

  return (
    <>
      <nav className="flex items-center justify-between px-4 md:px-6 py-3 bg-surface-raised border-b border-white/5">
        <div className="flex items-center gap-4 md:gap-6">
          <Link href="/" className="text-sm font-semibold text-accent-bright tracking-wide flex items-center gap-2">
            OPTIMUS
            <span
              className={`w-2 h-2 rounded-full transition-colors ${
                sseStatus === "connected" ? "bg-emerald-500" :
                sseStatus === "reconnecting" ? "bg-yellow-500 animate-pulse" :
                "bg-red-500"
              }`}
              title={`Stream: ${sseStatus}`}
            />
            {counters.unreadFeed > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-violet-500/30 text-violet-300 rounded-full leading-none">
                {counters.unreadFeed > 9 ? "9+" : counters.unreadFeed}
              </span>
            )}
          </Link>
          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-6">
            {navLinks.map((link, i) => (
              <span key={link.href} className="contents">
                {link.group === "system" && navLinks[i - 1]?.group === "ops" && (
                  <span className="text-zinc-600">|</span>
                )}
                <Link href={link.href} className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors inline-flex items-center gap-1.5">
                  {link.label}
                  {link.href === "/sharing" && pendingShareCount > 0 && (
                    <span
                      className="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30"
                      title={`${pendingShareCount} pending share invitation${pendingShareCount === 1 ? "" : "s"}`}
                    >
                      {pendingShareCount}
                    </span>
                  )}
                </Link>
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {session?.user && (
            <div className="hidden md:flex items-center gap-3">
              <div className="relative" ref={popoverRef}>
                <button
                  onClick={() => setSettingsOpen(!settingsOpen)}
                  className="relative text-zinc-400 hover:text-zinc-200 transition-colors text-lg leading-none"
                  title="Settings"
                >
                  {"\u2699"}
                  {hasKey && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
                  )}
                </button>
                {settingsOpen && (
                  <div className="absolute right-0 top-full mt-2 w-72 bg-zinc-900 border border-white/10 rounded-lg shadow-xl p-4 z-50">
                    <label className="block text-xs text-zinc-400 mb-1.5">
                      Anthropic API Key
                    </label>
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder={hasKey ? "Key saved \u2022\u2022\u2022" : "sk-ant-..."}
                      className="w-full px-2.5 py-1.5 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-accent-bright"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSave();
                      }}
                      disabled={saving}
                    />
                    {error && (
                      <p className="mt-1.5 text-xs text-red-400">{error}</p>
                    )}
                    <div className="flex gap-2 mt-2.5">
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex-1 px-3 py-1.5 text-xs bg-accent-bright/20 text-accent-bright rounded hover:bg-accent-bright/30 transition-colors disabled:opacity-50"
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleClear}
                        disabled={saving}
                        className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 transition-colors disabled:opacity-50"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {session.user.image && (
                <img
                  src={session.user.image}
                  alt=""
                  className="w-6 h-6 rounded-full"
                />
              )}
              <span className="text-sm text-zinc-400">@{session.user.name}</span>
              <button
                onClick={() => signOut()}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Sign out
              </button>
            </div>
          )}

          {/* Mobile hamburger button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label="Toggle menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              {mobileMenuOpen ? (
                <path d="M18 6L6 18M6 6l12 12" />
              ) : (
                <path d="M3 12h18M3 6h18M3 18h18" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {/* Mobile slide-out menu */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="fixed inset-y-0 right-0 w-64 bg-zinc-900 border-l border-white/10 z-50 md:hidden overflow-y-auto">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-zinc-500 font-semibold">Navigation</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold px-2 mb-1">Operations</div>
              {navLinks.filter(l => l.group === "ops").map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-3 py-2.5 text-sm text-zinc-300 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-colors"
                >
                  {link.label}
                </Link>
              ))}
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold px-2 mt-4 mb-1">System</div>
              {navLinks.filter(l => l.group === "system").map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2.5 text-sm text-zinc-300 hover:text-zinc-100 hover:bg-white/5 rounded-lg transition-colors flex items-center justify-between"
                >
                  <span>{link.label}</span>
                  {link.href === "/sharing" && pendingShareCount > 0 && (
                    <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30">
                      {pendingShareCount}
                    </span>
                  )}
                </Link>
              ))}
            </div>
            {session?.user && (
              <div className="p-4 border-t border-white/5 mt-2">
                <div className="flex items-center gap-2 mb-3">
                  {session.user.image && (
                    <img src={session.user.image} alt="" className="w-6 h-6 rounded-full" />
                  )}
                  <span className="text-sm text-zinc-400">@{session.user.name}</span>
                </div>
                <button
                  onClick={() => signOut()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
