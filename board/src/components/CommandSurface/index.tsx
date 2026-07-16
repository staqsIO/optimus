"use client";

import { useState, useEffect } from "react";
import { useEventStreamContext } from "@/components/EventStreamProvider";
import ChatPanel from "./ChatPanel";
import ProactiveFeed from "./ProactiveFeed";
import AgentStrip from "./AgentStrip";

type Tab = "chat" | "feed" | "agents";

interface CommandSurfaceProps {
  open: boolean;
  onToggle: () => void;
}

export default function CommandSurface({ open, onToggle }: CommandSurfaceProps) {
  const [tab, setTab] = useState<Tab>("chat");
  const { counters } = useEventStreamContext();

  // Cmd+K shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle]);

  // Auto-open on HITL request and switch to feed
  useEffect(() => {
    if (counters.pendingHitl > 0 && !open) {
      onToggle();
      setTab("feed");
    }
  }, [counters.pendingHitl]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "chat", label: "Chat" },
    { key: "feed", label: "Feed", badge: counters.unreadFeed || undefined },
    { key: "agents", label: "Agents" },
  ];

  // Collapsed strip
  if (!open) {
    return (
      <div className="w-10 shrink-0 border-l border-white/5 bg-zinc-950 flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggle}
          className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Open panel (⌘K)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {/* Chat icon */}
        <button
          onClick={() => { onToggle(); setTab("chat"); }}
          className="w-8 h-8 rounded-lg hover:bg-white/5 flex items-center justify-center text-zinc-600 hover:text-zinc-400 transition-colors"
          title="Chat"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
        {/* Feed with badge */}
        <button
          onClick={() => { onToggle(); setTab("feed"); }}
          className="w-8 h-8 rounded-lg hover:bg-white/5 flex items-center justify-center text-zinc-600 hover:text-zinc-400 transition-colors relative"
          title="Feed"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {(counters.unreadFeed > 0 || counters.pendingHitl > 0) ? (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-violet-500 text-[8px] font-bold text-white flex items-center justify-center">
              {(counters.unreadFeed || counters.pendingHitl) > 9 ? "9+" : (counters.unreadFeed || counters.pendingHitl)}
            </span>
          ) : null}
        </button>
        {/* Agents icon */}
        <button
          onClick={() => { onToggle(); setTab("agents"); }}
          className="w-8 h-8 rounded-lg hover:bg-white/5 flex items-center justify-center text-zinc-600 hover:text-zinc-400 transition-colors"
          title="Agents"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-[380px] shrink-0 border-l border-white/5 bg-zinc-950 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === t.key
                  ? "bg-white/10 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
              {t.badge && t.badge > 0 ? (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-violet-500/30 text-violet-300 rounded-full">
                  {t.badge > 9 ? "9+" : t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-zinc-600 mr-1">
            <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-[9px]">{"\u2318"}K</kbd>
          </span>
          <button
            onClick={onToggle}
            className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Collapse panel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tab content */}
      {tab === "chat" && <ChatPanel />}
      {tab === "feed" && <ProactiveFeed />}
      {tab === "agents" && <AgentStrip />}
    </div>
  );
}
