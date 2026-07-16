"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { markdownToHtml } from "@/lib/markdown";

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

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "py",
  "yaml", "yml", "toml", "sh", "sql", "prisma", "env", "csv", "xml",
  "swift", "kt", "go", "rs", "rb", "java", "c", "cpp", "h", "pdf",
]);

const MAX_FILE_SIZE = 500 * 1024; // 500KB per file

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "text-blue-400",
  strategist: "text-purple-400",
  architect: "text-emerald-400",
  reviewer: "text-amber-400",
  "claw-explorer": "text-cyan-400",
  "campaign-builder": "text-orange-400",
};

export default function ChatPanel() {
  const { data: session } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist sessionId to localStorage
  useEffect(() => {
    if (sessionId) {
      try { localStorage.setItem("optimus-auto-chat-session", sessionId); } catch {}
    }
  }, [sessionId]);

  // Restore session and load history on mount
  useEffect(() => {
    const stored = (() => { try { return localStorage.getItem("optimus-auto-chat-session"); } catch { return null; } })();
    if (!stored) return;
    setSessionId(stored);
    opsFetch<{ messages: Array<{ role: string; content: string; cost_usd?: number; model?: string; agent_id?: string }> }>(
      `/api/chat/history?sessionId=${stored}`
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
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Build full message with file contents
    let fullMessage = textPart;
    if (attachedFiles.length > 0) {
      const fileBlocks = attachedFiles.map(
        (f) => `[File: ${f.name} (${(f.size / 1024).toFixed(1)}KB)]\n\`\`\`\n${f.content.slice(0, 100_000)}\n\`\`\``
      );
      fullMessage = fullMessage
        ? `${fullMessage}\n\n${fileBlocks.join("\n\n")}`
        : fileBlocks.join("\n\n");
    }

    // Show user message (display text only, not raw file content)
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
        sessionId,
      });

      if (!result.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${result.error}` },
        ]);
      } else {
        const { text, agentId, costUsd, model, sessionId: sid } = result.data;
        if (!sessionId) setSessionId(sid);
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
  }, [input, sending, sessionId]);

  const newSession = useCallback(() => {
    setMessages([]);
    setFiles([]);
    setSessionId(null);
    setTotalCost(0);
    try { localStorage.removeItem("optimus-auto-chat-session"); } catch {}
    inputRef.current?.focus();
  }, []);

  if (!session) return null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header bar */}
      <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">Optimus</span>
          {totalCost > 0 && (
            <span className="text-[10px] text-zinc-600">
              ${totalCost.toFixed(4)}
            </span>
          )}
        </div>
        {messages.length > 0 && (
          <button
            onClick={newSession}
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            new chat
          </button>
        )}
      </div>

      {/* Messages — drag-drop zone */}
      <div
        className={`flex-1 overflow-y-auto px-3 py-3 space-y-3 transition-colors ${dragOver ? "bg-blue-500/5 ring-1 ring-inset ring-blue-500/20" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
      >
        {messages.length === 0 && (
          <div className="text-center text-zinc-600 text-xs mt-12 space-y-2">
            <div className="text-2xl mb-3 opacity-50">~</div>
            <div className="text-zinc-400 text-sm">What do you need?</div>
            <div className="text-zinc-700 text-[11px] space-y-1 mt-4">
              <div>&quot;What&apos;s the pipeline status?&quot;</div>
              <div>&quot;Build me a landing page for...&quot;</div>
              <div>&quot;What should I focus on today?&quot;</div>
              <div>&quot;Review the latest campaign output&quot;</div>
            </div>
            <div className="text-zinc-800 text-[10px] mt-6">
              Messages auto-route to the right agent
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className="max-w-[90%]">
              {msg.role === "assistant" && msg.agentId ? (
                <div
                  className={`text-[10px] mb-0.5 ${AGENT_COLORS[msg.agentId] || "text-zinc-500"}`}
                >
                  {msg.agentId}
                </div>
              ) : null}
              <div
                className={`px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
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
                {msg.role === "assistant" ? (
                  <div
                    className="prose prose-sm prose-invert max-w-none [&>p]:m-0 [&>p]:mb-2 [&>ul]:m-0 [&>ul]:mb-2 [&>ol]:m-0 [&>ol]:mb-2 [&>li]:m-0 [&>h1]:text-sm [&>h2]:text-sm [&>h3]:text-xs [&>pre]:text-xs [&>pre]:bg-black/30 [&>pre]:p-2 [&>pre]:rounded [&>code]:text-xs [&>code]:bg-black/20 [&>code]:px-1 [&>code]:rounded"
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(msg.content) }}
                  />
                ) : (
                  msg.content
                )}
              </div>
            </div>
          </div>
        ))}
        {sending ? (
          <div className="flex justify-start">
            <div className="bg-zinc-800/80 border border-zinc-700/30 text-zinc-500 px-3 py-2 rounded-2xl rounded-bl-md text-sm">
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

      {/* File chips */}
      {files.length > 0 ? (
        <div className="px-3 py-1.5 border-t border-white/5 flex flex-wrap gap-1">
          {files.map((f) => (
            <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 text-[10px] text-zinc-300 border border-zinc-700/50">
              <svg className="w-2.5 h-2.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              {f.name} ({(f.size / 1024).toFixed(1)}K)
              <button onClick={() => removeFile(f.name)} className="text-zinc-600 hover:text-zinc-300 ml-0.5">&times;</button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Input */}
      <div className="border-t border-white/5 px-3 py-2.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        <div className="flex gap-1.5 items-end">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-zinc-600 hover:text-zinc-400 transition-colors shrink-0 rounded-lg hover:bg-zinc-800"
            title="Attach files"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Ask anything..."
            disabled={sending}
            rows={1}
            className="flex-1 bg-zinc-900 border border-zinc-700/50 rounded-xl px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none min-h-[2.5rem]"
          />
          <button
            onClick={sendMessage}
            disabled={sending || (!input.trim() && files.length === 0)}
            className="p-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-xl transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
