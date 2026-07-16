"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { opsFetch, opsPost, opsPatch } from "@/lib/ops-api";
import { useChatSession } from "@/contexts/ChatSessionContext";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  agentId?: string;
  cost_usd?: number;
  model?: string;
  files?: { name: string; size: number }[];
}

interface FileAttachment {
  name: string;
  content: string;
  size: number;
}

interface ChatSurfaceProps {
  sessionId?: string | null;
  onSessionChange?: (id: string | null) => void;
  pageContext?: { route: string; title: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } | null;
}

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "py",
  "yaml", "yml", "toml", "sh", "sql", "prisma", "env", "csv", "xml",
  "swift", "kt", "go", "rs", "rb", "java", "c", "cpp", "h", "pdf",
]);

const MAX_FILE_SIZE = 500 * 1024;

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "text-blue-400",
  strategist: "text-purple-400",
  architect: "text-emerald-400",
  reviewer: "text-amber-400",
  "claw-explorer": "text-cyan-400",
  "campaign-builder": "text-orange-400",
};

export default function ChatSurface({ sessionId: propSessionId, onSessionChange, pageContext }: ChatSurfaceProps) {
  const { data: session } = useSession();
  const { setActiveSessionId, refreshSessions } = useChatSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(propSessionId ?? null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [chatMode, setChatMode] = useState<"plan" | "build">("plan");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Sync prop sessionId to internal state
  useEffect(() => {
    const newId = propSessionId ?? null;
    if (newId !== currentSessionId) {
      setCurrentSessionId(newId);
    }
  }, [propSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync active session to context
  useEffect(() => {
    setActiveSessionId(currentSessionId);
  }, [currentSessionId, setActiveSessionId]);

  // Load history when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setMessages([]);
      setTotalCost(0);
      setSessionTitle(null);
      return;
    }

    opsFetch<{ messages: Array<{ role: string; content: string; cost_usd?: number; model?: string; agent_id?: string }> }>(
      `/api/chat/history?sessionId=${currentSessionId}`
    ).then((data) => {
      if (data?.messages?.length) {
        setMessages(data.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          agentId: m.agent_id || undefined,
          cost_usd: m.cost_usd ? parseFloat(String(m.cost_usd)) : undefined,
          model: m.model || undefined,
        })));
        setTotalCost(data.messages.reduce((s, m) => s + (parseFloat(String(m.cost_usd)) || 0), 0));
      } else {
        setMessages([]);
        setTotalCost(0);
      }
    });

    // Load session metadata for title (scope to project if on project page)
    const sessionUrl = pageContext?.route?.includes('/projects/') && pageContext?.entityId
      ? `/api/chat/sessions?projectSlug=${encodeURIComponent(pageContext.entityId)}`
      : `/api/chat/sessions`;
    opsFetch<{ sessions: Array<{ id: string; title: string | null }> }>(
      sessionUrl
    ).then((data) => {
      const s = data?.sessions?.find((s) => s.id === currentSessionId);
      if (s?.title) setSessionTitle(s.title);
    });
  }, [currentSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const newFiles: FileAttachment[] = [];
    for (const file of Array.from(fileList)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (file.size > MAX_FILE_SIZE) continue;
      const content = await file.text();
      newFiles.push({ name: file.name, content, size: file.size });
    }
    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const removeFile = useCallback((name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  const sendMessage = useCallback(async () => {
    if ((!input.trim() && files.length === 0) || sending) return;
    const textPart = input.trim();
    const attachedFiles = [...files];
    setInput("");
    setFiles([]);
    setSending(true);

    if (inputRef.current) inputRef.current.style.height = "auto";

    let fullMessage = textPart;
    if (attachedFiles.length > 0) {
      const fileBlocks = attachedFiles.map(
        (f) => `[File: ${f.name} (${(f.size / 1024).toFixed(1)}KB)]\n\`\`\`\n${f.content.slice(0, 100_000)}\n\`\`\``
      );
      fullMessage = fullMessage
        ? `${fullMessage}\n\n${fileBlocks.join("\n\n")}`
        : fileBlocks.join("\n\n");
    }

    setMessages((prev) => [...prev, {
      role: "user",
      content: textPart || `Uploaded ${attachedFiles.length} file(s)`,
      files: attachedFiles.map((f) => ({ name: f.name, size: f.size })),
    }]);

    try {
      const result = await opsPost<{
        text: string;
        agentId: string;
        costUsd: number;
        model: string;
        sessionId: string;
      }>("/api/chat/auto", {
        message: fullMessage,
        sessionId: currentSessionId,
        mode: chatMode,
        pageContext: pageContext || undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      if (!result.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${result.error}` },
        ]);
      } else {
        const { text, agentId, costUsd, model, sessionId: sid } = result.data;
        if (!currentSessionId) {
          setCurrentSessionId(sid);
          onSessionChange?.(sid);
          refreshSessions();
        }
        setTotalCost((prev) => prev + (costUsd || 0));
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: text, agentId, cost_usd: costUsd, model },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to reach the backend." },
      ]);
    }
    setSending(false);
    inputRef.current?.focus();
  }, [input, sending, currentSessionId, files, onSessionChange, refreshSessions, pageContext]);

  const newSession = useCallback(() => {
    setMessages([]);
    setFiles([]);
    setCurrentSessionId(null);
    setSessionTitle(null);
    setTotalCost(0);
    onSessionChange?.(null);
    inputRef.current?.focus();
  }, [onSessionChange]);

  const handleTitleSave = useCallback(async () => {
    setEditingTitle(false);
    if (!currentSessionId || !sessionTitle?.trim()) return;
    await opsPatch(`/api/chat/sessions?id=${currentSessionId}`, { title: sessionTitle.trim() });
    refreshSessions();
  }, [currentSessionId, sessionTitle, refreshSessions]);

  const togglePin = useCallback(async () => {
    if (!currentSessionId) return;
    // We need current pinned state — toggle it
    const res = await opsFetch<{ sessions: Array<{ id: string; pinned: boolean }> }>(`/api/chat/sessions`);
    const s = res?.sessions?.find((s) => s.id === currentSessionId);
    const newPinned = !(s?.pinned);
    await opsPatch(`/api/chat/sessions?id=${currentSessionId}`, { pinned: newPinned });
    refreshSessions();
  }, [currentSessionId, refreshSessions]);

  const toggleShare = useCallback(async () => {
    if (!currentSessionId) return;
    const res = await opsFetch<{ sessions: Array<{ id: string; isShared: boolean }> }>(`/api/chat/sessions`);
    const s = res?.sessions?.find((s) => s.id === currentSessionId);
    const newShared = !(s?.isShared);
    await opsPatch(`/api/chat/sessions?id=${currentSessionId}`, { is_shared: newShared });
    refreshSessions();
  }, [currentSessionId, refreshSessions]);

  if (!session) return null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header bar */}
      <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {editingTitle && currentSessionId ? (
            <input
              ref={titleInputRef}
              value={sessionTitle || ""}
              onChange={(e) => setSessionTitle(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => { if (e.key === "Enter") handleTitleSave(); if (e.key === "Escape") setEditingTitle(false); }}
              className="text-sm font-medium text-zinc-300 bg-transparent border-b border-zinc-600 outline-none px-0 py-0"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { if (currentSessionId) setEditingTitle(true); }}
              className="text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
              title={currentSessionId ? "Click to rename" : undefined}
            >
              {sessionTitle || "Optimus"}
            </button>
          )}
          {totalCost > 0 && (
            <span className="text-xs text-zinc-600">
              ${totalCost.toFixed(4)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {currentSessionId && (
            <>
              {/* Pin button */}
              <button
                onClick={togglePin}
                className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors p-1.5 rounded hover:bg-white/5"
                title="Pin session"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </button>
              {/* Share button */}
              <button
                onClick={toggleShare}
                className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors p-1.5 rounded hover:bg-white/5"
                title="Share session"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
              </button>
            </>
          )}
          {messages.length > 0 && (
            <button
              onClick={newSession}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-white/5"
            >
              new chat
            </button>
          )}
        </div>
      </div>

      {/* Messages -- drag-drop zone */}
      <div
        className={`flex-1 overflow-y-auto px-4 py-6 transition-colors ${dragOver ? "bg-blue-500/5 ring-1 ring-inset ring-blue-500/20" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
      >
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-zinc-600 mt-[15vh] space-y-3">
              <div className="text-4xl mb-4 opacity-40">~</div>
              <div className="text-zinc-300 text-lg font-medium">What do you need?</div>
              <div className="text-zinc-600 text-sm space-y-2 mt-6">
                <div>&quot;What&apos;s the pipeline status?&quot;</div>
                <div>&quot;Build me a landing page for...&quot;</div>
                <div>&quot;What should I focus on today?&quot;</div>
                <div>&quot;Review the latest campaign output&quot;</div>
              </div>
              <div className="text-zinc-700 text-xs mt-8">
                Messages auto-route to the right agent
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className="max-w-[80%]">
                {msg.role === "assistant" && msg.agentId ? (
                  <div
                    className={`text-[10px] mb-0.5 ${AGENT_COLORS[msg.agentId] || "text-zinc-500"}`}
                  >
                    {msg.agentId}
                  </div>
                ) : null}
                <div
                  className={`px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600/80 text-white rounded-br-md"
                      : "bg-zinc-800/80 text-zinc-200 rounded-bl-md border border-zinc-700/30"
                  }`}
                >
                  {msg.files && msg.files.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {msg.files.map((f) => (
                        <span key={f.name} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 text-[10px]">
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          {f.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {msg.content}
                </div>
              </div>
            </div>
          ))}
          {sending ? (
            <div className="flex justify-start">
              <div className="bg-zinc-800/80 border border-zinc-700/30 text-zinc-500 px-4 py-2.5 rounded-2xl rounded-bl-md text-sm">
                <span className="inline-flex gap-0.5">
                  <span className="animate-bounce">.</span>
                  <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>
                    .
                  </span>
                  <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>
                    .
                  </span>
                </span>
              </div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* File chips */}
      {files.length > 0 ? (
        <div className="px-4 py-2 border-t border-white/5">
          <div className="max-w-3xl mx-auto flex flex-wrap gap-1">
            {files.map((f) => (
              <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700/50">
                <svg className="w-2.5 h-2.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                {f.name} ({(f.size / 1024).toFixed(1)}K)
                <button onClick={() => removeFile(f.name)} className="text-zinc-600 hover:text-zinc-300 ml-0.5">&times;</button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Input — two-row Cursor-style layout */}
      <div className="border-t border-white/5 px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        {/* Row 1: Textarea with inline send */}
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Ask Optimus anything..."
            disabled={sending}
            rows={1}
            className="w-full bg-zinc-900 border border-zinc-700/50 rounded-lg px-3 py-2 pr-9 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none min-h-[2.25rem]"
          />
          <button
            onClick={sendMessage}
            disabled={sending || (!input.trim() && files.length === 0)}
            className="absolute right-2 bottom-2 p-1 text-zinc-500 hover:text-blue-400 disabled:text-zinc-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        {/* Row 2: Compact action buttons */}
        <div className="flex items-center gap-1 mt-1.5">
          <button
            onClick={() => setChatMode(chatMode === "plan" ? "build" : "plan")}
            className={`px-2 py-0.5 text-[10px] font-medium rounded shrink-0 transition-colors border ${
              chatMode === "build"
                ? "bg-orange-500/15 text-orange-300 border-orange-500/30"
                : "bg-zinc-800/50 text-zinc-500 border-zinc-700/30 hover:text-zinc-400"
            }`}
            title={chatMode === "plan" ? "Plan mode: discuss and plan" : "Build mode: execute actions"}
          >
            {chatMode === "plan" ? "Plan" : "Build"}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors rounded hover:bg-zinc-800/50"
            title="Attach files"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
          </button>
          <span className="text-[10px] text-zinc-700 ml-auto">Enter to send</span>
        </div>
      </div>
    </div>
  );
}
