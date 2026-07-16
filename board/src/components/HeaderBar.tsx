"use client";

import { useState, useEffect, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useApiKey } from "./ApiKeyProvider";
import { useEventStreamContext } from "./EventStreamProvider";

export default function HeaderBar() {
  const { data: session } = useSession();
  const { hasKey, saveKey, clearKey } = useApiKey();
  const { status: sseStatus } = useEventStreamContext();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

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

  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-4 bg-surface-raised border-b border-white/5">
      {/* Left: Logo + connection dot */}
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
      </Link>

      {/* Center: empty for now (breadcrumb later) */}
      <div className="flex-1" />

      {/* Right: SSE status, user, settings, sign out */}
      <div className="flex items-center gap-3">
        <span className="hidden sm:inline text-[11px] text-zinc-600">
          SSE: {sseStatus}
        </span>

        {session?.user && (
          <div className="flex items-center gap-3">
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
            <span className="hidden sm:inline text-sm text-zinc-400">@{session.user.name}</span>
            <button
              onClick={() => signOut()}
              className="hidden sm:inline text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
