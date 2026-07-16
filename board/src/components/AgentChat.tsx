"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { opsFetch, opsPost } from "@/lib/ops-api";

// ============================================================
// Types
// ============================================================

interface AgentInfo {
  id: string;
  type: string;
  model: string;
  chat: { enabled: boolean; maxCostPerSession: number; chatTools: string[] };
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  cost_usd?: number;
  model?: string;
  created_at?: string;
}

// Agent type → display config
const AGENT_COLORS: Record<string, string> = {
  strategist: "bg-purple-600",
  orchestrator: "bg-blue-600",
  architect: "bg-emerald-600",
  reviewer: "bg-amber-600",
  executor: "bg-zinc-600",
  utility: "bg-gray-600",
};

const AGENT_LABELS: Record<string, string> = {
  strategist: "ST",
  orchestrator: "OR",
  architect: "AR",
  reviewer: "RV",
  executor: "EX",
};

function getInitials(id: string, type: string): string {
  return AGENT_LABELS[type] || id.slice(0, 2).toUpperCase();
}

function getColor(type: string): string {
  return AGENT_COLORS[type] || "bg-zinc-600";
}

// ============================================================
// Component
// ============================================================

export default function AgentChat() {
  const { data: session } = useSession();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);

  // Per-agent state
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [sessionCost, setSessionCost] = useState<Record<string, number>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<Array<{
    sessionId: string; boardUser: string; messageCount: number;
    totalCost: number; firstMessage: string; lastActive: string;
  }>>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load chat-enabled agents on mount
  useEffect(() => {
    if (!session) return;
    opsFetch<{ agents: Record<string, AgentInfo> }>("/api/agents/config").then((data) => {
      if (!data?.agents) return;
      const chatAgents = Object.values(data.agents).filter(
        (a) => a.chat?.enabled
      );
      setAgents(chatAgents);
    });
  }, [session]);

  // Restore sessions from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("optimus-chat-sessions");
      if (stored) setSessions(JSON.parse(stored));
    } catch {}
  }, []);

  // Persist sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("optimus-chat-sessions", JSON.stringify(sessions));
    } catch {}
  }, [sessions]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeAgent]);

  // Focus input when agent opens
  useEffect(() => {
    if (activeAgent) inputRef.current?.focus();
  }, [activeAgent]);

  // Get or create session for an agent
  const ensureSession = useCallback(
    async (agentId: string): Promise<string | null> => {
      if (sessions[agentId]) return sessions[agentId];

      const result = await opsPost<{ sessionId: string }>("/api/chat/session", {
        agentId,
      });
      if (!result.ok) {
        console.error("Failed to create session:", result.error);
        return null;
      }

      const sid = result.data.sessionId;
      setSessions((prev) => ({ ...prev, [agentId]: sid }));
      return sid;
    },
    [sessions]
  );

  // Load history when opening a chat
  const openAgent = useCallback(
    async (agentId: string) => {
      if (activeAgent === agentId) {
        setActiveAgent(null);
        return;
      }
      setActiveAgent(agentId);
      setInput("");

      // Load history if we have a session
      const sid = sessions[agentId];
      if (sid && !messages[agentId]?.length) {
        const data = await opsFetch<{ messages: ChatMessage[] }>(
          `/api/chat/history?sessionId=${sid}`
        );
        if (data?.messages?.length) {
          setMessages((prev) => ({ ...prev, [agentId]: data.messages }));
          // Sum up cost
          const cost = data.messages.reduce(
            (sum, m) => sum + (parseFloat(String(m.cost_usd)) || 0),
            0
          );
          setSessionCost((prev) => ({ ...prev, [agentId]: cost }));
        }
      }
    },
    [activeAgent, sessions, messages]
  );

  // Send a message
  const sendMessage = useCallback(async () => {
    if (!activeAgent || !input.trim() || sending) return;

    const msg = input.trim();
    setInput("");
    setSending(true);

    // Optimistic: add user message
    const userMsg: ChatMessage = { role: "user", content: msg };
    setMessages((prev) => ({
      ...prev,
      [activeAgent]: [...(prev[activeAgent] || []), userMsg],
    }));

    try {
      const sid = await ensureSession(activeAgent);
      if (!sid) {
        setSending(false);
        return;
      }

      const result = await opsPost<{
        text: string;
        costUsd: number;
        model: string;
      }>("/api/chat/message", {
        sessionId: sid,
        agentId: activeAgent,
        message: msg,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      if (!result.ok) {
        // Add error as assistant message
        const errMsg: ChatMessage = {
          role: "assistant",
          content: `Error: ${result.error}`,
        };
        setMessages((prev) => ({
          ...prev,
          [activeAgent]: [...(prev[activeAgent] || []), errMsg],
        }));
      } else {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: result.data.text,
          cost_usd: result.data.costUsd,
          model: result.data.model,
        };
        setMessages((prev) => ({
          ...prev,
          [activeAgent]: [...(prev[activeAgent] || []), assistantMsg],
        }));
        setSessionCost((prev) => ({
          ...prev,
          [activeAgent]:
            (prev[activeAgent] || 0) + (result.data.costUsd || 0),
        }));
      }
    } catch (err) {
      const errMsg: ChatMessage = {
        role: "assistant",
        content: "Failed to reach the backend.",
      };
      setMessages((prev) => ({
        ...prev,
        [activeAgent]: [...(prev[activeAgent] || []), errMsg],
      }));
    }

    setSending(false);
  }, [activeAgent, input, sending, ensureSession]);

  // New session for current agent
  const newSession = useCallback(async () => {
    if (!activeAgent) return;
    // Clear local state
    setSessions((prev) => {
      const next = { ...prev };
      delete next[activeAgent];
      return next;
    });
    setMessages((prev) => ({ ...prev, [activeAgent]: [] }));
    setSessionCost((prev) => ({ ...prev, [activeAgent]: 0 }));
  }, [activeAgent]);

  // Load session history for active agent
  const loadSessionHistory = useCallback(async () => {
    if (!activeAgent) return;
    setHistoryOpen((prev) => !prev);
    const data = await opsFetch<{ sessions: typeof sessionHistory }>(
      `/api/chat/sessions?agentId=${activeAgent}`
    );
    if (data?.sessions) setSessionHistory(data.sessions);
  }, [activeAgent]);

  // Resume a past session
  const resumeSession = useCallback(
    async (sessionId: string) => {
      if (!activeAgent) return;
      setSessions((prev) => ({ ...prev, [activeAgent]: sessionId }));
      // Load messages for this session
      const data = await opsFetch<{ messages: ChatMessage[] }>(
        `/api/chat/history?sessionId=${sessionId}`
      );
      if (data?.messages) {
        setMessages((prev) => ({ ...prev, [activeAgent]: data.messages }));
        const cost = data.messages.reduce(
          (sum, m) => sum + (parseFloat(String(m.cost_usd)) || 0), 0
        );
        setSessionCost((prev) => ({ ...prev, [activeAgent]: cost }));
      }
      setHistoryOpen(false);
    },
    [activeAgent]
  );

  if (!session || agents.length === 0) return null;

  const activeAgentConfig = agents.find((a) => a.id === activeAgent);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {/* Chat window */}
      {activeAgent && activeAgentConfig && (
        <div className="w-[380px] h-[480px] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700 bg-zinc-800/80">
            <div className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full ${getColor(activeAgentConfig.type)} flex items-center justify-center text-[10px] font-bold text-white`}
              >
                {getInitials(activeAgentConfig.id, activeAgentConfig.type)}
              </div>
              <div>
                <div className="text-sm font-medium text-zinc-100">
                  {activeAgentConfig.id}
                </div>
                <div className="text-[10px] text-zinc-500 flex items-center gap-1.5">
                  <span className="px-1 py-0.5 bg-zinc-700 rounded text-[9px]">
                    {activeAgentConfig.type}
                  </span>
                  <span className="px-1 py-0.5 bg-zinc-700 rounded text-[9px]">
                    {activeAgentConfig.model.split("-").slice(-2).join("-")}
                  </span>
                  {(sessionCost[activeAgent] || 0) > 0 && (
                    <span className="text-zinc-500">
                      ${(sessionCost[activeAgent] || 0).toFixed(4)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={loadSessionHistory}
                title="Session history"
                className={`p-1 transition-colors ${historyOpen ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <button
                onClick={newSession}
                title="New session"
                className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
              <button
                onClick={() => setActiveAgent(null)}
                title="Close"
                className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Session history panel */}
          {historyOpen && (
            <div className="border-b border-zinc-700 bg-zinc-800/90 px-3 py-2 max-h-[200px] overflow-y-auto">
              <div className="text-[10px] text-zinc-500 uppercase font-medium mb-1">Past sessions</div>
              {sessionHistory.length === 0 && (
                <div className="text-xs text-zinc-600 py-2">No past sessions found.</div>
              )}
              {sessionHistory.map((s) => (
                <button
                  key={s.sessionId}
                  onClick={() => resumeSession(s.sessionId)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-zinc-700 transition-colors mb-0.5 ${
                    sessions[activeAgent] === s.sessionId ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-400'
                  }`}
                >
                  <div className="truncate">{s.firstMessage || '(empty session)'}</div>
                  <div className="flex gap-2 text-[10px] text-zinc-600 mt-0.5">
                    <span>{s.messageCount} msgs</span>
                    <span>${s.totalCost.toFixed(4)}</span>
                    <span>{new Date(s.lastActive).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {(!messages[activeAgent] || messages[activeAgent].length === 0) && (
              <div className="text-center text-zinc-600 text-sm mt-8">
                <div>
                  Start a conversation with{" "}
                  <span className="text-zinc-400">{activeAgentConfig.id}</span>
                </div>
                <div className="text-[10px] text-zinc-700 mt-2">
                  Try: &quot;review task 1234&quot; or &quot;what are you working on?&quot;
                </div>
              </div>
            )}
            {(messages[activeAgent] || []).map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-sm"
                      : "bg-zinc-800 text-zinc-200 rounded-bl-sm border border-zinc-700"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-zinc-800 border border-zinc-700 text-zinc-400 px-3 py-2 rounded-xl rounded-bl-sm text-sm">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">.</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>.</span>
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-zinc-700 px-3 py-2 bg-zinc-800/50">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={`Message ${activeAgentConfig.id}...`}
                disabled={sending}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={sending || !input.trim()}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent selector strip */}
      {selectorOpen && (
        <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 rounded-full px-2 py-1.5 shadow-lg">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => openAgent(agent.id)}
              title={`${agent.id} (${agent.type})`}
              className={`w-9 h-9 rounded-full ${getColor(agent.type)} flex items-center justify-center text-[10px] font-bold text-white transition-all hover:scale-110 ${
                activeAgent === agent.id
                  ? "ring-2 ring-blue-400 ring-offset-2 ring-offset-zinc-900"
                  : ""
              }`}
            >
              {getInitials(agent.id, agent.type)}
            </button>
          ))}
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setSelectorOpen((prev) => !prev)}
        className="w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg flex items-center justify-center transition-all hover:scale-105"
        title="Agent Chat"
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </button>
    </div>
  );
}
