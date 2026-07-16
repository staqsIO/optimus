"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { markdownToHtml } from "@/lib/markdown";
import { classifyIntent, type IntentType } from "@/lib/classify-intent";
import { useEventStream, type EventStreamEvent } from "@/hooks/useEventStream";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Citation {
  n: number;
  kind: "meeting" | "wiki" | "email" | "drive" | "github" | "vault" | "kb" | "graph";
  label: string;
  snippet: string;
  documentId?: string;
  similarity?: number;
}

interface ChatMessage {
  /** board_chat_messages.id — present on streamed turns and history reloads */
  id?: string;
  role: "user" | "assistant";
  content: string;
  /** thumbs feedback: 1 | -1 | null */
  feedback?: number | null;
  agentId?: string;
  cost_usd?: number;
  model?: string;
  files?: { name: string; size: number }[];
  action?: string;
  campaign_id?: string;
  artifact_type?: string;
  intent?: IntentType;
  citations?: Citation[];
}

const CITATION_KIND_COLOR: Record<Citation["kind"], string> = {
  meeting: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  wiki: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  email: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  drive: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  github: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  vault: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  kb: "bg-zinc-700/40 text-zinc-300 border-zinc-600",
  graph: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
};

interface FileAttachment {
  name: string;
  content: string;
  size: number;
}

/** Live progress frame from the streaming chat endpoint. */
interface StreamStatus {
  phase: "context" | "thinking" | "tool";
  tool?: string;
  label?: string;
}

/** Payload of the streaming endpoint's `done` frame. */
interface StreamDone {
  text: string;
  agentId?: string;
  costUsd?: number;
  model?: string;
  sessionId?: string;
  messageId?: string;
  action?: string;
  campaign_id?: string;
  artifact_type?: string;
  citations?: Citation[];
}

interface ChatSession {
  id: string;
  title: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  campaign_id?: string;
}

interface Artifact {
  type: "content" | "research" | "build" | "image";
  title: string;
  body?: string;
  draft_id?: string;
  pr_url?: string;
  image_url?: string;
  status?: string;
  word_count?: number;
  reading_time_min?: number;
  cost_usd?: number;
  gates?: Array<{ gate_name: string; passed: boolean; details: Record<string, unknown> | null }>;
}

interface ActiveRun {
  campaign_id: string;
  title: string;
  status: "running" | "paused" | "succeeded" | "failed";
  type: "content" | "build" | "research";
  currentStep: number;
  steps: string[];
  startedAt: number;
  /** ms timestamp of last DB update — used to label paused runs */
  lastUpdatedAt?: number;
  elapsed: string;
  cost: number;
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const STEPS_BY_TYPE: Record<string, string[]> = {
  content: ["Planning", "Research", "Drafting", "Gates", "Review"],
  build: ["Planning", "Coding", "Testing", "PR"],
  research: ["Planning", "Gathering", "Synthesis"],
};

const AGENT_COLORS: Record<string, string> = {
  orchestrator: "text-blue-400",
  strategist: "text-purple-400",
  architect: "text-emerald-400",
  reviewer: "text-amber-400",
  "executor-writer": "text-violet-400",
  "executor-research": "text-cyan-400",
  "claw-campaigner": "text-orange-400",
};

const MODE_CHIP: Record<IntentType, { label: string; color: string }> = {
  content: { label: "Content", color: "bg-violet-500/20 text-violet-300" },
  build: { label: "Build", color: "bg-orange-500/20 text-orange-300" },
  research: { label: "Research", color: "bg-cyan-500/20 text-cyan-300" },
  ask: { label: "Ask", color: "bg-blue-500/20 text-blue-300" },
  change: { label: "Change", color: "bg-amber-500/20 text-amber-300" },
  intake: { label: "Intake", color: "bg-emerald-500/20 text-emerald-300" },
  contract: { label: "Contract", color: "bg-pink-500/20 text-pink-300" },
};

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "ts", "tsx", "js", "jsx", "css", "html", "py",
  "yaml", "yml", "toml", "sh", "sql", "prisma", "env", "csv", "xml",
  "swift", "kt", "go", "rs", "rb", "java", "c", "cpp", "h", "pdf",
]);

const MAX_FILE_SIZE = 500_000; // 500KB total

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [detectedIntent, setDetectedIntent] = useState<IntentType | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<ActiveRun[]>([]);
  const [rightPanel, setRightPanel] = useState<"progress" | "artifact">("progress");
  const [streamingText, setStreamingText] = useState("");
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [retryPayload, setRetryPayload] = useState<{ fullMessage: string; displayText: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Update elapsed time for active runs (skip paused — their "elapsed"
  // is an "Xd ago" snapshot, not a live counter)
  useEffect(() => {
    if (activeRuns.length === 0) return;
    const interval = setInterval(() => {
      setActiveRuns((prev) =>
        prev.map((r) => {
          if (r.status === "paused") return r;
          const secs = Math.floor((Date.now() - r.startedAt) / 1000);
          const mins = Math.floor(secs / 60);
          return { ...r, elapsed: mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s` };
        })
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [activeRuns.length]);

  // Hydrate active/recent runs from API. Called on mount and on a 30s
  // interval as a safety net so direct DB updates (or missed SSE events)
  // don't leave the panel showing zombie state.
  const hydrateRuns = useCallback(async () => {
    const data = await opsFetch<{ campaigns: Array<{ id: string; goal_description: string; campaign_status: string; spent_usd: string; created_at: string; updated_at?: string; metadata?: Record<string, unknown>; completed_iterations: number; max_iterations: number }> }>("/api/campaigns");
    if (!data?.campaigns) return;
    const RUNNING = new Set(["approved", "running"]);
    const PAUSED = new Set(["awaiting_input", "paused", "plateau_paused"]);
    const active: ActiveRun[] = [];
    const recent: ActiveRun[] = [];
    for (const c of data.campaigns.slice(0, 20)) {
      const contentType = (c.metadata as Record<string, unknown>)?.content_type as string | undefined;
      const type = (contentType === "blog" || contentType === "linkedin" ? "content" : "build") as ActiveRun["type"];
      const isRunning = RUNNING.has(c.campaign_status);
      const isPaused = PAUSED.has(c.campaign_status);
      const lastUpdatedMs = c.updated_at ? new Date(c.updated_at).getTime() : new Date(c.created_at).getTime();
      const status: ActiveRun["status"] =
        c.campaign_status === "succeeded" ? "succeeded"
        : c.campaign_status === "failed" || c.campaign_status === "cancelled" ? "failed"
        : isPaused ? "paused"
        : "running";
      const run: ActiveRun = {
        campaign_id: c.id,
        title: c.goal_description?.slice(0, 80) || "Run",
        status,
        type,
        currentStep: (isRunning || isPaused) ? Math.min(c.completed_iterations, (STEPS_BY_TYPE[type]?.length || 4) - 1) : (STEPS_BY_TYPE[type]?.length || 4),
        steps: STEPS_BY_TYPE[type] || STEPS_BY_TYPE.build,
        startedAt: new Date(c.created_at).getTime(),
        lastUpdatedAt: lastUpdatedMs,
        elapsed: isPaused ? `paused ${formatAgo(lastUpdatedMs)}` : "",
        cost: parseFloat(c.spent_usd) || 0,
      };
      if (isRunning || isPaused) {
        active.push(run);
      } else if (c.campaign_status === "succeeded" || c.campaign_status === "failed") {
        recent.push(run);
      }
    }
    // Always overwrite — empty results must clear stale state. Merge in
    // any SSE-optimistic runs (created within the last 60s) that haven't
    // hit the API yet, so the periodic refetch doesn't flicker them out.
    setActiveRuns((prev) => {
      const apiIds = new Set(active.map((r) => r.campaign_id));
      const optimistic = prev.filter(
        (r) => !apiIds.has(r.campaign_id) && Date.now() - r.startedAt < 60_000
      );
      return [...active, ...optimistic];
    });
    setRecentRuns(recent.slice(0, 5));
  }, []);

  useEffect(() => {
    hydrateRuns();
    const interval = setInterval(hydrateRuns, 30_000);
    return () => clearInterval(interval);
  }, [hydrateRuns]);

  // SSE: campaign events → progress tracking
  // Backend publishes: campaign_approved, campaign_iteration, campaign_completed, campaign_failed
  useEventStream("campaign_approved", useCallback((e: EventStreamEvent) => {
    const id = e.campaign_id as string;
    const title = (e.goal_description || e.title || "New run") as string;
    const type = ((e.content_type as string) === "blog" || (e.content_type as string) === "linkedin" ? "content" : "build") as ActiveRun["type"];
    setActiveRuns((prev) => {
      if (prev.some((r) => r.campaign_id === id)) return prev;
      return [...prev, {
        campaign_id: id, title, status: "running", type,
        currentStep: 0, steps: STEPS_BY_TYPE[type] || STEPS_BY_TYPE.build,
        startedAt: Date.now(), elapsed: "0s", cost: 0,
      }];
    });
  }, []));

  // campaign_iteration (backend name) — advance step
  useEventStream("campaign_iteration", useCallback((e: EventStreamEvent) => {
    const id = e.campaign_id as string;
    const cost = (e.cost_usd as number) || 0;
    setActiveRuns((prev) =>
      prev.map((r) =>
        r.campaign_id === id
          ? { ...r, currentStep: Math.min(r.currentStep + 1, r.steps.length - 1), cost: r.cost + cost }
          : r
      )
    );
  }, []));

  // campaign_completed (backend name) — move to recent as succeeded
  useEventStream("campaign_completed", useCallback((e: EventStreamEvent) => {
    const id = e.campaign_id as string;
    setActiveRuns((prev) => {
      const run = prev.find((r) => r.campaign_id === id);
      if (run) {
        setRecentRuns((recent) => [{ ...run, status: "succeeded" as const, currentStep: run.steps.length }, ...recent].slice(0, 5));
      }
      return prev.filter((r) => r.campaign_id !== id);
    });
  }, []));

  // campaign_failed (backend name) — move to recent as failed
  useEventStream("campaign_failed", useCallback((e: EventStreamEvent) => {
    const id = e.campaign_id as string;
    setActiveRuns((prev) => {
      const run = prev.find((r) => r.campaign_id === id);
      if (run) {
        setRecentRuns((recent) => [{ ...run, status: "failed" as const, currentStep: run.steps.length }, ...recent].slice(0, 5));
      }
      return prev.filter((r) => r.campaign_id !== id);
    });
  }, []));

  useEventStream("draft_ready", useCallback((e: EventStreamEvent) => {
    const campaignId = e.campaign_id as string;
    const draftId = e.draft_id as string;
    if (draftId) {
      openArtifact(draftId);
      setRightPanel("artifact");
    }
    // Mark run as succeeded
    setActiveRuns((prev) => {
      const run = prev.find((r) => r.campaign_id === campaignId);
      if (run) {
        setRecentRuns((recent) => [{ ...run, status: "succeeded" as const, currentStep: run.steps.length }, ...recent].slice(0, 5));
      }
      return prev.filter((r) => r.campaign_id !== campaignId);
    });
  }, []));

  // Load artifact from a content draft
  async function openArtifact(draftId: string) {
    const data = await opsFetch<{
      draft: { title: string; body: string; status: string; content_type: string; word_count: number; reading_time_min: number; cost_usd: string; published_url: string | null; slug: string };
      gates: Array<{ gate_name: string; passed: boolean; details: Record<string, unknown> | null }>;
    }>(`/api/content/drafts/${draftId}`);
    if (data?.draft) {
      setArtifact({
        type: "content",
        title: data.draft.title || "Untitled",
        body: data.draft.body,
        draft_id: draftId,
        pr_url: data.draft.published_url || undefined,
        status: data.draft.status,
        word_count: data.draft.word_count,
        reading_time_min: data.draft.reading_time_min,
        cost_usd: parseFloat(data.draft.cost_usd || "0"),
        gates: data.gates,
        image_url: data.draft.slug ? `/blog/images/${data.draft.slug}.png` : undefined,
      });
    }
  }

  // Open artifact from a campaign (find the latest draft for that campaign)
  async function openArtifactFromCampaign(campaignId: string) {
    const data = await opsFetch<{ drafts: Array<{ id: string }> }>(`/api/content/drafts?campaign_id=${campaignId}&limit=1`);
    if (data?.drafts?.[0]) {
      openArtifact(data.drafts[0].id);
    }
  }

  // Approve/reject from artifact panel
  async function handleArtifactAction(action: "approve" | "reject") {
    if (!artifact?.draft_id) return;
    await opsPost(`/api/content/drafts/${artifact.draft_id}/${action}`);
    setArtifact((prev) => prev ? { ...prev, status: action === "approve" ? "approved" : "rejected" } : null);
  }

  // Load sessions list
  const loadSessions = useCallback(async () => {
    const data = await opsFetch<{ sessions: ChatSession[] }>("/api/chat/sessions");
    setSessions(data?.sessions || []);
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Restore last session from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("optimus-chat-session");
    if (saved) {
      setActiveSessionId(saved);
    }
  }, []);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) { setMessages([]); setTotalCost(0); return; }
    localStorage.setItem("optimus-chat-session", activeSessionId);
    opsFetch<{ messages: Array<{ id?: string; role: string; content: string; agent_id?: string; cost_usd?: number; model?: string; feedback?: number | null }> }>(
      `/api/chat/history?sessionId=${activeSessionId}`
    ).then((data) => {
      if (data?.messages) {
        setMessages(data.messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          agentId: m.agent_id,
          cost_usd: m.cost_usd,
          model: m.model,
          feedback: m.feedback,
        })));
        setTotalCost(data.messages.reduce((sum, m) => sum + (parseFloat(String(m.cost_usd || 0)) || 0), 0));
      }
    });
  }, [activeSessionId]);

  // Scroll to bottom on new messages and while tokens stream in
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // New conversation
  function startNewConversation() {
    setActiveSessionId(null);
    setMessages([]);
    setTotalCost(0);
    setInput("");
    setFiles([]);
    localStorage.removeItem("optimus-chat-session");
    inputRef.current?.focus();
  }

  // Finalize a turn from the streaming endpoint's `done` frame: update the
  // session, append the authoritative assistant message, track cost/runs.
  const finishTurn = useCallback((data: StreamDone, displayText: string) => {
    const { text: responseText, agentId, costUsd, model, sessionId: sid, action, campaign_id, artifact_type, citations } = data;

    // Update session ID if new
    if (sid && sid !== activeSessionId) {
      setActiveSessionId(sid);
      localStorage.setItem("optimus-chat-session", sid);
      loadSessions(); // refresh session list
    }

    const assistantMsg: ChatMessage = {
      id: data.messageId,
      role: "assistant",
      content: responseText,
      agentId,
      cost_usd: costUsd,
      model,
      action,
      campaign_id,
      artifact_type,
      citations,
      feedback: null,
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setTotalCost((prev) => prev + (costUsd || 0));

    // If a campaign was created, add it to active runs
    if (action === "campaign_created" && campaign_id) {
      const runType = (artifact_type === "content" ? "content" : artifact_type === "research" ? "research" : "build") as ActiveRun["type"];
      setActiveRuns((prev) => {
        if (prev.some((r) => r.campaign_id === campaign_id)) return prev;
        return [...prev, {
          campaign_id, title: displayText.slice(0, 60), status: "running", type: runType,
          currentStep: 0, steps: STEPS_BY_TYPE[runType] || STEPS_BY_TYPE.build,
          startedAt: Date.now(), elapsed: "0s", cost: 0,
        }];
      });
      setRightPanel("progress");
    }
  }, [activeSessionId, loadSessions]);

  // Run one streamed turn against POST /api/ops/chat-stream, rendering
  // tokens and progress as they arrive. Used by sendMessage and Retry.
  const streamTurn = useCallback(async (fullMessage: string, displayText: string) => {
    setRetryPayload(null);
    setStreamingText("");
    setStreamStatus({ phase: "context", label: "Gathering context…" });

    const ac = new AbortController();
    abortRef.current = ac;
    let liveText = "";
    let finished = false;

    try {
      const res = await fetch("/api/ops/chat-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: fullMessage,
          sessionId: activeSessionId,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Backend error (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1] ?? "message";
          const dataLine = frame.match(/^data: (.+)$/m)?.[1];
          if (!dataLine) continue;
          let data: StreamDone & StreamStatus & { delta?: string; message?: string };
          try { data = JSON.parse(dataLine); } catch { continue; }

          if (event === "token" && data.delta) {
            liveText += data.delta;
            setStreamingText(liveText);
            setStreamStatus(null);
          } else if (event === "status") {
            setStreamStatus({ phase: data.phase, tool: data.tool, label: data.label });
          } else if (event === "tool_result") {
            setStreamStatus({ phase: "thinking", label: "Thinking…" });
          } else if (event === "done") {
            finished = true;
            finishTurn(data, displayText);
          } else if (event === "error") {
            finished = true;
            setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.message || "Something went wrong."}` }]);
            setRetryPayload({ fullMessage, displayText });
          }
        }
      }

      if (!finished) {
        // Stream dropped before a done/error frame. Keep whatever streamed
        // (the backend persisted it as a partial) and offer a retry.
        if (liveText) {
          setMessages((prev) => [...prev, { role: "assistant", content: liveText }]);
        }
        setMessages((prev) => [...prev, { role: "assistant", content: "Error: connection lost mid-response." }]);
        setRetryPayload({ fullMessage, displayText });
      }
    } catch (e) {
      if (ac.signal.aborted) {
        // User hit Stop: keep the partial, no error.
        if (liveText) {
          setMessages((prev) => [...prev, { role: "assistant", content: `${liveText}\n\n*(stopped)*` }]);
        }
      } else {
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: e instanceof Error && e.message ? `Error: ${e.message}` : "Failed to reach Optimus. Check your connection.",
        }]);
        setRetryPayload({ fullMessage, displayText });
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      setStreamingText("");
      setStreamStatus(null);
      setDetectedIntent(null);
    }
  }, [activeSessionId, finishTurn]);

  // Send message
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text && files.length === 0) return;
    if (sending) return;

    setSending(true);

    // Classify intent (runs client-side heuristic, fast)
    const { intent } = await classifyIntent(text, { hasContextFiles: files.length > 0 });
    setDetectedIntent(intent);

    // Build full message with file contents
    let fullMessage = text;
    if (files.length > 0) {
      const fileBlocks = files.map((f) => `\n\n<file name="${f.name}">\n${f.content}\n</file>`).join("");
      fullMessage = text + fileBlocks;
    }

    // Show user message immediately
    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      files: files.map((f) => ({ name: f.name, size: f.size })),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setFiles([]);

    await streamTurn(fullMessage, text);
  }, [input, files, sending, streamTurn]);

  // Stop the in-flight generation (partial text is kept; the backend tears
  // down its LLM stream via the propagated abort).
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // P5: thumbs feedback. Clicking the active value clears it. Optimistic
  // update; a downvote also seeds a failure memory server-side.
  const rateMessage = useCallback(async (messageId: string, value: 1 | -1) => {
    const current = messages.find((m) => m.id === messageId)?.feedback;
    const next = current === value ? null : value;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: next } : m)));
    const result = await opsPost("/api/chat/feedback", {
      sessionId: activeSessionId,
      messageId,
      feedback: next,
    });
    if (!result.ok) {
      // Revert on failure
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: current } : m)));
    }
  }, [messages, activeSessionId]);

  // Retry the last failed turn (the user message is already in the thread).
  const retryLastTurn = useCallback(() => {
    if (!retryPayload || sending) return;
    setSending(true);
    void streamTurn(retryPayload.fullMessage, retryPayload.displayText);
  }, [retryPayload, sending, streamTurn]);

  // File handling
  function handleFiles(fileList: FileList) {
    const newFiles: FileAttachment[] = [];
    let totalSize = files.reduce((s, f) => s + f.size, 0);

    Array.from(fileList).forEach((file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!TEXT_EXTENSIONS.has(ext)) return;
      if (totalSize + file.size > MAX_FILE_SIZE) return;
      totalSize += file.size;

      const reader = new FileReader();
      reader.onload = (e) => {
        newFiles.push({ name: file.name, content: e.target?.result as string, size: file.size });
        if (newFiles.length === Array.from(fileList).filter((f) => TEXT_EXTENSIONS.has(f.name.split(".").pop()?.toLowerCase() || "")).length) {
          setFiles((prev) => [...prev, ...newFiles]);
        }
      };
      reader.readAsText(file);
    });
  }

  // Key handler
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex h-full">
      {/* Left: Session list */}
      <div className="w-[280px] border-r border-zinc-800 flex flex-col shrink-0">
        <div className="p-3 border-b border-zinc-800">
          <button
            onClick={startNewConversation}
            className="w-full px-3 py-2 text-sm font-medium rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            + New conversation
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="p-3 text-xs text-zinc-600">No conversations yet</div>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSessionId(s.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/30 hover:bg-white/[0.02] border-l-2 transition-[background-color,border-color] duration-150 ${
                  activeSessionId === s.id
                    ? "bg-white/[0.04] border-l-violet-500"
                    : "border-l-transparent"
                }`}
              >
                <div className="text-sm text-zinc-300 truncate">
                  {s.title || "New conversation"}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-zinc-600">
                    {(() => { const d = new Date(s.updated_at || s.created_at); return isNaN(d.getTime()) ? "" : d.toLocaleDateString(); })()}
                  </span>
                  {s.agent_id && (
                    <span className={`text-[10px] ${AGENT_COLORS[s.agent_id] || "text-zinc-500"}`}>
                      {s.agent_id}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right: Conversation */}
      <div className="flex-1 flex flex-col">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
              <svg className="w-16 h-16 mb-4 text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-lg font-medium text-zinc-400 mb-1">What do you need?</p>
              <p className="text-sm text-zinc-600 mb-6">Ask anything, or start a task:</p>
              <div className="flex flex-wrap gap-2 justify-center max-w-md">
                {[
                  { label: "Summarize today's meetings", text: "Summarize today's meetings", color: "border-cyan-500/30 hover:bg-cyan-500/10 text-cyan-300" },
                  { label: "What's overdue?", text: "What's overdue?", color: "border-amber-500/30 hover:bg-amber-500/10 text-amber-300" },
                  { label: "What did I commit to this week?", text: "What did I commit to this week?", color: "border-violet-500/30 hover:bg-violet-500/10 text-violet-300" },
                  { label: "Pipeline status", text: "What's the pipeline status?", color: "border-blue-500/30 hover:bg-blue-500/10 text-blue-300" },
                  { label: "Research…", text: "Research ", color: "border-cyan-500/30 hover:bg-cyan-500/10 text-cyan-300" },
                  { label: "Write a blog post…", text: "Write a blog post about ", color: "border-violet-500/30 hover:bg-violet-500/10 text-violet-300" },
                  { label: "Build a landing page…", text: "Build a landing page for ", color: "border-orange-500/30 hover:bg-orange-500/10 text-orange-300" },
                ].map((s) => (
                  <button
                    key={s.label}
                    onClick={() => { setInput(s.text); inputRef.current?.focus(); }}
                    className={`px-3 py-1.5 text-xs rounded-full border bg-zinc-900/40 transition-colors duration-150 ${s.color}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] ${msg.role === "user" ? "order-1" : ""}`}>
                    {/* Agent label */}
                    {msg.role === "assistant" && msg.agentId && (
                      <div className={`text-[10px] font-medium mb-1 ${AGENT_COLORS[msg.agentId] || "text-zinc-500"}`}>
                        {msg.agentId}{msg.model ? ` · ${msg.model.split("/").pop()}` : ""}
                        {msg.cost_usd ? ` · $${parseFloat(String(msg.cost_usd)).toFixed(4)}` : ""}
                      </div>
                    )}

                    {/* Message bubble */}
                    <div className={`rounded-lg px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900 border border-zinc-800 text-zinc-300"
                    }`}>
                      {msg.role === "assistant" ? (
                        <div
                          className="prose prose-invert prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: markdownToHtml(msg.content) }}
                        />
                      ) : (
                        <span className="whitespace-pre-wrap">{msg.content}</span>
                      )}
                    </div>

                    {/* Thumbs feedback (P5) — downvotes seed failure memories */}
                    {msg.role === "assistant" && msg.id && (
                      <div className="flex gap-1 mt-1">
                        <button
                          onClick={() => msg.id && rateMessage(msg.id, 1)}
                          title="Good response"
                          className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                            msg.feedback === 1 ? "text-emerald-400 bg-emerald-500/10" : "text-zinc-600 hover:text-zinc-300"
                          }`}
                        >
                          👍
                        </button>
                        <button
                          onClick={() => msg.id && rateMessage(msg.id, -1)}
                          title="Bad response — Optimus will learn from this"
                          className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                            msg.feedback === -1 ? "text-red-400 bg-red-500/10" : "text-zinc-600 hover:text-zinc-300"
                          }`}
                        >
                          👎
                        </button>
                      </div>
                    )}

                    {/* Citation chips — surfaces RAG sources used in this answer */}
                    {msg.role === "assistant" && msg.citations && msg.citations.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {msg.citations.map((c) => (
                          <span
                            key={c.n}
                            className={`group relative inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded border cursor-default ${CITATION_KIND_COLOR[c.kind]}`}
                          >
                            <span className="opacity-70">[{c.n}]</span>
                            <span className="truncate max-w-[200px]">{c.label}</span>
                            <span className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-20 w-80 p-3 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl text-zinc-300 whitespace-normal leading-relaxed">
                              <span className="block text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                                Source [{c.n}]
                              </span>
                              <span className="block text-[11px] text-zinc-200 mb-1.5">
                                {c.label}
                              </span>
                              <span className="block text-[10px] text-zinc-400">
                                {c.snippet}
                                {c.snippet.length >= 240 && "…"}
                              </span>
                            </span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* File chips */}
                    {msg.files && msg.files.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {msg.files.map((f) => (
                          <span key={f.name} className="px-2 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">
                            {f.name} ({(f.size / 1024).toFixed(1)}KB)
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Campaign action card — reactive to live SSE state */}
                    {msg.action === "campaign_created" && msg.campaign_id && (() => {
                      const cid = msg.campaign_id;
                      const live = activeRuns.find((r) => r.campaign_id === cid);
                      const completed = recentRuns.find((r) => r.campaign_id === cid);
                      const state: "running" | "paused" | "succeeded" | "failed" | "unknown" =
                        live?.status === "paused" ? "paused"
                        : live ? "running"
                        : completed?.status === "succeeded" ? "succeeded"
                        : completed?.status === "failed" ? "failed"
                        : "unknown";

                      const palette = {
                        running: "border-violet-500/30 bg-violet-500/10 text-violet-300",
                        paused: "border-amber-500/30 bg-amber-500/10 text-amber-300",
                        succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                        failed: "border-red-500/30 bg-red-500/10 text-red-300",
                        unknown: "border-zinc-700/50 bg-zinc-900/50 text-zinc-400",
                      }[state];

                      return (
                        <div className={`mt-2 p-3 rounded-lg border ${palette}`}>
                          <div className="flex items-center gap-2 text-xs">
                            {state === "running" ? (
                              <>
                                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                <span>{live?.steps[live.currentStep] ?? "Working"}…</span>
                                {live?.elapsed && <span className="opacity-70">· {live.elapsed}</span>}
                                {live && live.cost > 0 && <span className="opacity-70">· ${live.cost.toFixed(4)}</span>}
                              </>
                            ) : state === "paused" ? (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span>Paused</span>
                                {live?.elapsed && <span className="opacity-70">· {live.elapsed}</span>}
                              </>
                            ) : state === "succeeded" ? (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>Done</span>
                              </>
                            ) : state === "failed" ? (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span>Failed</span>
                              </>
                            ) : (
                              <>
                                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                <span>Starting…</span>
                              </>
                            )}
                          </div>

                          {/* Segmented progress bar — visible for all states with steps */}
                          {(live || completed) && (() => {
                            const run = live ?? completed!;
                            const totalSteps = run.steps.length;
                            const filledThrough = state === "succeeded"
                              ? totalSteps
                              : Math.min(run.currentStep, totalSteps - 1);
                            return (
                              <div className="mt-2 flex gap-1">
                                {run.steps.map((_, i) => {
                                  let barColor: string;
                                  if (state === "failed") {
                                    barColor = i <= filledThrough ? "bg-red-400/70" : "bg-zinc-800";
                                  } else if (state === "succeeded") {
                                    barColor = "bg-emerald-500";
                                  } else if (state === "paused") {
                                    barColor = i < filledThrough ? "bg-emerald-500" : i === filledThrough ? "bg-amber-400" : "bg-zinc-800";
                                  } else {
                                    barColor = i < filledThrough ? "bg-emerald-500" : i === filledThrough ? "bg-violet-400 animate-pulse" : "bg-zinc-800";
                                  }
                                  return (
                                    <span
                                      key={i}
                                      className={`flex-1 h-1 rounded-full ${barColor}`}
                                      title={run.steps[i]}
                                    />
                                  );
                                })}
                              </div>
                            );
                          })()}

                          <div className="mt-1.5 flex gap-2">
                            <Link
                              href={`/campaigns/${cid}`}
                              className="text-[10px] text-violet-400 hover:text-violet-300"
                            >
                              View Run →
                            </Link>
                            {msg.artifact_type === "content" && (
                              <Link href="/content" className="text-[10px] text-violet-400 hover:text-violet-300">
                                View in Content →
                              </Link>
                            )}
                            {state === "succeeded" && (
                              <button
                                onClick={() => openArtifactFromCampaign(cid)}
                                className="text-[10px] text-emerald-400 hover:text-emerald-300"
                              >
                                Open Result →
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Draft result card — shown when content is ready */}
                    {msg.action === "draft_ready" && msg.artifact_type === "content" && (
                      <div className="mt-2 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                        <div className="flex items-center gap-2 text-xs text-emerald-300 mb-1.5">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span>Content ready for review</span>
                        </div>
                        <button
                          onClick={() => msg.campaign_id && openArtifactFromCampaign(msg.campaign_id)}
                          className="text-[10px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          Open Preview →
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {/* Live streaming bubble — tokens render as they arrive */}
              {sending && streamingText && (
                <div className="flex justify-start">
                  <div className="max-w-[80%]">
                    <div className="rounded-lg px-4 py-3 text-sm leading-relaxed bg-zinc-900 border border-zinc-800 text-zinc-300">
                      <div
                        className="prose prose-invert prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: markdownToHtml(streamingText) }}
                      />
                    </div>
                    {/* Mid-stream tool progress (round 2+) */}
                    {streamStatus && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-pulse" />
                        <span>{streamStatus.label || "Working…"}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Pre-token progress indicator with mode chip */}
              {sending && !streamingText && (
                <div className="flex justify-start">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      {detectedIntent && (
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${MODE_CHIP[detectedIntent].color}`}>
                          {MODE_CHIP[detectedIntent].label}
                        </span>
                      )}
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                      </div>
                      <span>{streamStatus?.label || (streamStatus?.phase === "thinking" ? "Thinking…" : "Optimus is working...")}</span>
                    </div>
                  </div>
                </div>
              )}
              {/* Retry affordance after a failed turn */}
              {!sending && retryPayload && (
                <div className="flex justify-start">
                  <button
                    onClick={retryLastTurn}
                    className="px-3 py-1.5 text-xs font-medium rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    ↻ Retry
                  </button>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Cost indicator */}
        {totalCost > 0 && (
          <div className="px-6 py-1 text-[10px] text-zinc-600 text-right">
            Session cost: ${totalCost.toFixed(4)}
          </div>
        )}

        {/* Input area */}
        <div
          className={`border-t border-zinc-800 p-4 ${dragOver ? "bg-violet-500/5" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        >
          {/* File chips */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {files.map((f) => (
                <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">
                  {f.name}
                  <button onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))} className="text-zinc-600 hover:text-zinc-300">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Active runs badge — Plan/Build toggle removed (Phase 0) */}
          {activeRuns.length > 0 && (
            <div className="flex justify-end max-w-3xl mx-auto mb-2">
              <button
                onClick={() => setRightPanel("progress")}
                className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-colors"
              >
                <span className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-pulse" />
                {activeRuns.length} running
              </button>
            </div>
          )}

          <div className="flex gap-2 max-w-3xl mx-auto">
            <label className="flex items-center px-2 cursor-pointer text-zinc-600 hover:text-zinc-400 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              <input type="file" multiple className="hidden" onChange={(e) => e.target.files && handleFiles(e.target.files)} />
            </label>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Optimus anything..."
              rows={1}
              className="flex-1 px-4 py-2.5 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 resize-none"
              style={{ minHeight: "42px", maxHeight: "120px" }}
            />
            {sending ? (
              <button
                onClick={stopStreaming}
                title="Stop generating"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-700 text-zinc-200 hover:bg-red-900/60 hover:text-red-200 transition-colors"
              >
                ■
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim() && files.length === 0}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                →
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right panel — Progress or Artifact */}
      {(artifact || activeRuns.length > 0 || recentRuns.length > 0) && (
        <div className="w-[380px] shrink-0 border-l border-zinc-800 flex flex-col h-full">
          {/* Panel switcher — only when both views available */}
          {artifact && (activeRuns.length > 0 || recentRuns.length > 0) && (
            <div className="flex border-b border-zinc-800">
              <button
                onClick={() => setRightPanel("progress")}
                className={`flex-1 px-3 py-2 text-[10px] font-medium transition-colors ${
                  rightPanel === "progress" ? "text-zinc-200 border-b border-violet-500" : "text-zinc-500 hover:text-zinc-400"
                }`}
              >
                Progress {activeRuns.length > 0 && `(${activeRuns.length})`}
              </button>
              <button
                onClick={() => setRightPanel("artifact")}
                className={`flex-1 px-3 py-2 text-[10px] font-medium transition-colors ${
                  rightPanel === "artifact" ? "text-zinc-200 border-b border-violet-500" : "text-zinc-500 hover:text-zinc-400"
                }`}
              >
                Preview
              </button>
            </div>
          )}

          {/* Progress view */}
          {(rightPanel === "progress" || !artifact) && (activeRuns.length > 0 || recentRuns.length > 0) ? (
            <div className="flex-1 overflow-y-auto">
              {/* Active runs */}
              {activeRuns.length > 0 && (
                <div className="p-4">
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">Active Runs</h3>
                  <div className="space-y-3">
                    {activeRuns.map((run) => {
                      const isPaused = run.status === "paused";
                      return (
                        <div
                          key={run.campaign_id}
                          className={`p-3 rounded-lg border ${
                            isPaused
                              ? "border-amber-500/20 bg-amber-500/5 opacity-70"
                              : "border-zinc-800 bg-zinc-900/50"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${MODE_CHIP[run.type]?.color || "bg-zinc-700 text-zinc-400"}`}>
                              {run.type}
                            </span>
                            {isPaused && (
                              <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-500/20 text-amber-300">
                                paused
                              </span>
                            )}
                            <span className="text-xs text-zinc-300 truncate flex-1">{run.title}</span>
                          </div>

                          {/* Step progress — current step pulses for running, static for paused */}
                          <div className="space-y-1.5 mb-3">
                            {run.steps.map((step, i) => (
                              <div key={step} className="flex items-center gap-2">
                                {i < run.currentStep ? (
                                  <span className="w-3 h-3 rounded-full bg-emerald-500 flex items-center justify-center">
                                    <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                  </span>
                                ) : i === run.currentStep ? (
                                  isPaused ? (
                                    <span className="w-3 h-3 rounded-full border-2 border-amber-400/60" />
                                  ) : (
                                    <span className="w-3 h-3 rounded-full border-2 border-violet-400 animate-pulse" />
                                  )
                                ) : (
                                  <span className="w-3 h-3 rounded-full border border-zinc-700" />
                                )}
                                <span className={`text-[11px] ${
                                  i < run.currentStep ? "text-zinc-500 line-through" :
                                  i === run.currentStep ? (isPaused ? "text-amber-300" : "text-zinc-200 font-medium") :
                                  "text-zinc-600"
                                }`}>
                                  {step}
                                </span>
                              </div>
                            ))}
                          </div>

                          {/* Elapsed + cost */}
                          <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                            <span className={isPaused ? "text-amber-400/80" : ""}>{run.elapsed}</span>
                            {run.cost > 0 && <span>${run.cost.toFixed(4)}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Recent runs */}
              {recentRuns.length > 0 && (
                <div className="p-4 border-t border-zinc-800">
                  <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Recent</h3>
                  <div className="space-y-1">
                    {recentRuns.map((run) => (
                      <button
                        key={run.campaign_id}
                        onClick={() => run.status === "succeeded" && openArtifactFromCampaign(run.campaign_id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/[0.03] transition-colors text-left"
                      >
                        <span className={run.status === "succeeded" ? "text-emerald-400" : "text-red-400"}>
                          {run.status === "succeeded" ? "✓" : "✗"}
                        </span>
                        <span className="text-xs text-zinc-400 truncate flex-1">{run.title}</span>
                        <span className={`px-1 py-0.5 text-[9px] rounded ${MODE_CHIP[run.type]?.color || "bg-zinc-700 text-zinc-400"}`}>
                          {run.type}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeRuns.length === 0 && recentRuns.length === 0 && (
                <div className="flex-1 flex items-center justify-center p-4">
                  <p className="text-xs text-zinc-600">No active runs. Switch to Build mode to start.</p>
                </div>
              )}
            </div>
          ) : artifact ? (
            /* Artifact view — existing code */
            <>
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-violet-500/20 text-violet-300">
                      {artifact.type}
                    </span>
                    {artifact.status && (
                      <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${
                        artifact.status === "approved" ? "bg-green-500/20 text-green-300" :
                        artifact.status === "rejected" ? "bg-red-500/20 text-red-300" :
                        artifact.status === "published" ? "bg-emerald-500/20 text-emerald-300" :
                        "bg-yellow-500/20 text-yellow-300"
                      }`}>
                        {artifact.status}
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-100">{artifact.title}</h3>
                  <div className="flex gap-3 mt-0.5 text-[10px] text-zinc-500">
                    {artifact.word_count && <span>{artifact.word_count} words</span>}
                    {artifact.reading_time_min && <span>{artifact.reading_time_min} min read</span>}
                    {artifact.cost_usd && <span>${artifact.cost_usd.toFixed(4)}</span>}
                  </div>
                </div>
                <button
                  onClick={() => setArtifact(null)}
                  className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                  title="Close"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Actions */}
              {artifact.status === "review" && (
                <div className="flex gap-2 p-3 border-b border-zinc-800">
                  <button
                    onClick={() => handleArtifactAction("approve")}
                    className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleArtifactAction("reject")}
                    className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              )}

              {/* PR link */}
              {artifact.pr_url && (
                <a
                  href={artifact.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 border-b border-zinc-800 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  View Pull Request
                </a>
              )}

              {/* Gate results */}
              {artifact.gates && artifact.gates.length > 0 && (
                <details className="border-b border-zinc-800">
                  <summary className="px-4 py-2 text-[10px] font-medium text-zinc-500 cursor-pointer hover:text-zinc-400">
                    Content Gates ({artifact.gates.filter((g) => g.passed).length}/{artifact.gates.length} passed)
                  </summary>
                  <div className="px-4 pb-2 space-y-0.5">
                    {artifact.gates.map((g, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px]">
                        <span className={g.passed ? "text-emerald-400" : "text-red-400"}>
                          {g.passed ? "PASS" : "FAIL"}
                        </span>
                        <span className="text-zinc-500">{g.gate_name.replace(/_/g, " ")}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Body — rendered content */}
              <div className="flex-1 overflow-y-auto p-4">
                {artifact.body ? (
                  <div
                    className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(artifact.body) }}
                  />
                ) : (
                  <div className="text-sm text-zinc-500">No content preview available.</div>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
