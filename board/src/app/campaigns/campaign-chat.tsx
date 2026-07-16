"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { opsPost, opsFetch } from "@/lib/ops-api";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
  "swift", "kt", "go", "rs", "rb", "java", "c", "cpp", "h",
]);

const MAX_TOTAL_SIZE = 500 * 1024; // 500KB total

export default function CampaignChat({ onCampaignCreated }: { onCampaignCreated?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [readyToBuild, setReadyToBuild] = useState(false);
  const [budget, setBudget] = useState("10");
  const [launching, setLaunching] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const STORAGE_KEY = "optimus-campaign-chat-session";

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // Persist sessionId to localStorage
  useEffect(() => {
    if (sessionId) {
      try { localStorage.setItem(STORAGE_KEY, sessionId); } catch {}
    }
  }, [sessionId]);

  // Restore session and load history on mount
  useEffect(() => {
    const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
    if (!stored) return;
    setSessionId(stored);
    opsFetch<{ messages: Array<{ role: string; content: string; cost_usd?: number; model?: string; agent_id?: string }> }>(
      `/api/chat/history?sessionId=${stored}`
    ).then((data) => {
      if (data?.messages?.length) {
        setMessages(data.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })));
        // Check if last assistant message had READY_TO_BUILD
        const lastAssistant = [...data.messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.content?.includes("READY_TO_BUILD")) {
          setReadyToBuild(true);
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus input
  useEffect(() => { inputRef.current?.focus(); }, []);

  const totalFileSize = files.reduce((s, f) => s + f.size, 0);

  const handleFileSelect = async (fileList: FileList) => {
    const newFiles: FileAttachment[] = [];
    for (const file of Array.from(fileList)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!TEXT_EXTENSIONS.has(ext)) {
        // Skip binary files with a note
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `Skipped **${file.name}** — only text files are supported (md, json, ts, py, etc.)`,
        }]);
        continue;
      }
      if (totalFileSize + file.size > MAX_TOTAL_SIZE) {
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `Skipped **${file.name}** — total file size would exceed 500KB limit.`,
        }]);
        continue;
      }
      const content = await file.text();
      newFiles.push({ name: file.name, content, size: file.size });
    }
    setFiles((prev) => [...prev, ...newFiles]);
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed && files.length === 0) return;
    if (sending) return;

    setSending(true);

    // Build the message with file contents
    let messageText = trimmed;
    const attachedFiles = [...files];
    if (attachedFiles.length > 0) {
      const fileBlocks = attachedFiles.map(
        (f) => `[Uploaded file: ${f.name} (${(f.size / 1024).toFixed(1)}KB)]\n\`\`\`\n${f.content.slice(0, 100_000)}\n\`\`\``
      );
      messageText = messageText
        ? `${messageText}\n\n${fileBlocks.join("\n\n")}`
        : fileBlocks.join("\n\n");
    }

    // Add user message to UI
    setMessages((prev) => [...prev, {
      role: "user",
      content: trimmed || `Uploaded ${attachedFiles.length} file(s)`,
      files: attachedFiles.map((f) => ({ name: f.name, size: f.size })),
    }]);
    setInput("");
    setFiles([]);

    try {
      // Create session on first message
      let sid = sessionId;
      if (!sid) {
        const sessionRes = await opsPost<{ sessionId: string }>("/api/chat/session", {
          agentId: "campaign-builder",
        });
        if (!sessionRes.ok) throw new Error(sessionRes.error);
        sid = sessionRes.data.sessionId;
        setSessionId(sid);
      }

      // Send message
      const chatRes = await opsPost<{ text: string; costUsd: number }>("/api/chat/message", {
        agentId: "campaign-builder",
        sessionId: sid,
        message: messageText,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      if (!chatRes.ok) throw new Error(chatRes.error);

      const assistantText = chatRes.data.text;
      setMessages((prev) => [...prev, { role: "assistant", content: assistantText }]);

      // Check for READY_TO_BUILD signal
      if (assistantText.includes("READY_TO_BUILD")) {
        setReadyToBuild(true);
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
      }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const launchCampaign = async () => {
    setLaunching(true);
    try {
      // Build goal from conversation
      const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content.includes("READY_TO_BUILD"));
      const spec = lastAssistant?.content.replace("READY_TO_BUILD", "").trim() || "";

      // Collect all uploaded files from the conversation
      const contextFiles = messages
        .filter((m) => m.files && m.files.length > 0)
        .flatMap((m) => m.files || []);

      const goal = spec || userMessages.join("\n\n");

      const res = await opsPost("/api/campaigns", {
        goal_description: goal,
        campaign_mode: "stateless",
        budget_envelope_usd: parseFloat(budget) || 10,
        max_iterations: 10,
        iteration_time_budget: "5 minutes",
        success_criteria: [{ metric: "quality_score", operator: ">=", threshold: 0.8 }],
        auto_approve: true,
        metadata: {
          campaign_type: "build",
          source: "campaign_chat",
          context_files: contextFiles,
          chat_session_id: sessionId,
        },
      });

      if (!res.ok) throw new Error(res.error);

      setMessages((prev) => [...prev, {
        role: "assistant",
        content: "Campaign launched! Redirecting to campaign detail...",
      }]);

      onCampaignCreated?.();

      // Reset after a moment
      setTimeout(() => {
        setMessages([]);
        setSessionId(null);
        setReadyToBuild(false);
        setInput("");
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
      }, 2000);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `Failed to launch: ${err instanceof Error ? err.message : "Unknown error"}`,
      }]);
    } finally {
      setLaunching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  };

  return (
    <div className="bg-surface-raised rounded-xl border border-white/5 flex flex-col" style={{ minHeight: "400px", maxHeight: "600px" }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-orange-500/20 text-orange-300">Build</span>
          <span className="text-sm text-zinc-400">Describe what you want Optimus to build</span>
        </div>
        {sessionId && (
          <button
            onClick={() => { setMessages([]); setSessionId(null); setReadyToBuild(false); setFiles([]); try { localStorage.removeItem(STORAGE_KEY); } catch {} }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            New chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {messages.length === 0 && (
          <div className="text-center py-12 text-zinc-500 text-sm">
            <p className="mb-2">Describe your project. I&apos;ll ask clarifying questions,</p>
            <p>then generate a detailed spec for the campaign.</p>
            <p className="mt-4 text-xs text-zinc-600">You can also drag & drop files for context.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              msg.role === "user"
                ? "bg-accent/20 text-zinc-200 border border-accent/20"
                : "bg-zinc-800/50 text-zinc-300 border border-white/5"
            }`}>
              {msg.files && msg.files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {msg.files.map((f) => (
                    <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-700/50 text-xs text-zinc-400">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                      {f.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-zinc-800/50 border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-500">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* File chips */}
      {files.length > 0 && (
        <div className="px-4 py-2 border-t border-white/5 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.name} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-700/50 text-xs text-zinc-300 border border-white/5">
              <svg className="w-3 h-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              {f.name} ({(f.size / 1024).toFixed(1)}KB)
              <button onClick={() => removeFile(f.name)} className="text-zinc-500 hover:text-zinc-300 ml-0.5">&times;</button>
            </span>
          ))}
        </div>
      )}

      {/* Launch bar */}
      {readyToBuild && (
        <div className="px-4 py-3 border-t border-emerald-500/20 bg-emerald-500/5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            Spec ready
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              Budget
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-16 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-sm text-zinc-200 text-right"
                min="1"
                step="1"
              />
            </label>
            <button
              onClick={launchCampaign}
              disabled={launching}
              className="px-4 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50"
            >
              {launching ? "Launching..." : "Launch Campaign"}
            </button>
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className="px-4 py-3 border-t border-white/5 flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFileSelect(e.target.files)}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex-shrink-0 p-2 text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-zinc-800"
          title="Attach files"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
          }}
          onKeyDown={handleKeyDown}
          placeholder={messages.length === 0 ? "What do you want to build?" : "Reply..."}
          rows={1}
          className="flex-1 bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none min-h-[2.5rem]"
        />
        <button
          onClick={sendMessage}
          disabled={sending || (!input.trim() && files.length === 0)}
          className="flex-shrink-0 p-2 text-accent hover:text-accent-bright transition-colors disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
        </button>
      </div>
    </div>
  );
}
