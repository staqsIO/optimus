"use client";

/**
 * Right panel: persistent chat surface with session history.
 *
 * Always visible in the 3-panel layout. Shows:
 * - Session selector dropdown at the top
 * - ChatSurface for the active session
 * - New Chat button
 * - Page context awareness via usePageContext
 */

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import ChatSurface from "@/components/ChatSurface";
import { useChatSession } from "@/contexts/ChatSessionContext";
import { usePageContext } from "@/contexts/PageContext";
import { opsFetch } from "@/lib/ops-api";

interface ChatSession {
  id: string;
  title: string | null;
  agentId: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string | null;
  projectId: string | null;
  projectName: string | null;
}

export default function ChatPanel() {
  const pathname = usePathname();
  const { activeSessionId, setActiveSessionId, sessionVersion } = useChatSession();
  const { currentPage } = usePageContext();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Build page context from current route
  const pageContext = currentPage || (pathname ? {
    route: pathname,
    title: pathname === "/" ? "Home" : pathname.split("/").pop()?.replace(/-/g, " ") || "",
  } : null);

  // Derive project slug from page context (scoped session fetching)
  const projectSlug = currentPage?.route?.includes("/projects/") && currentPage?.entityId
    ? currentPage.entityId
    : null;

  // Fetch sessions (scoped to project when on a project page)
  useEffect(() => {
    const url = projectSlug
      ? `/api/chat/sessions?projectSlug=${encodeURIComponent(projectSlug)}`
      : "/api/chat/sessions";
    opsFetch<{ sessions: ChatSession[] }>(url).then((data) => {
      if (data?.sessions) setSessions(data.sessions);
    });
  }, [sessionVersion, projectSlug]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setShowHistory(false);
  }, [setActiveSessionId]);

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setShowHistory(false);
  }, [setActiveSessionId]);

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-white/5 flex items-center gap-2">
        <button
          onClick={handleNewChat}
          className="p-1.5 rounded-lg bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors"
          title="New Chat"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* Session selector */}
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors"
        >
          <span className="truncate">
            {activeSessionId
              ? sessions.find((s) => s.id === activeSessionId)?.title || "Chat"
              : "New conversation"}
          </span>
          <svg className={`w-3 h-3 shrink-0 transition-transform ${showHistory ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Page context indicator */}
        {pageContext && pageContext.route !== "/" && (
          <div className="px-1.5 py-0.5 rounded text-[9px] bg-accent/10 text-accent-bright truncate max-w-[100px]" title={`Context: ${pageContext.route}`}>
            {pageContext.title || pageContext.route}
          </div>
        )}
      </div>

      {/* History dropdown */}
      {showHistory && (
        <div className="shrink-0 border-b border-white/5 max-h-[300px] overflow-y-auto bg-zinc-900/50">
          {sessions.length === 0 ? (
            <div className="px-3 py-4 text-xs text-zinc-600 text-center">No chat history</div>
          ) : (
            sessions.slice(0, 20).map((s) => (
              <button
                key={s.id}
                onClick={() => handleSelectSession(s.id)}
                className={`w-full text-left px-3 py-2 text-xs transition-colors border-b border-white/[.02] ${
                  s.id === activeSessionId
                    ? "bg-white/10 text-zinc-100"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{s.title || "New conversation"}</span>
                  {s.projectName && !projectSlug && (
                    <span className="shrink-0 px-1 py-0.5 rounded text-[8px] bg-accent/10 text-accent-bright">
                      {s.projectName}
                    </span>
                  )}
                </div>
                {s.lastPreview && (
                  <div className="truncate text-[10px] text-zinc-600 mt-0.5">{s.lastPreview}</div>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* Chat surface */}
      <div className="flex-1 min-h-0">
        <ChatSurface
          sessionId={activeSessionId}
          pageContext={pageContext}
        />
      </div>
    </div>
  );
}
