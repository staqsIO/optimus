"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { StatCard, Kbd, ChannelPill, timeAgo } from "../../components/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Signal type styling
const SIGNAL_COLORS: Record<string, string> = {
  commitment: "text-red-400 bg-red-500/10 ring-red-500/20",
  deadline: "text-amber-400 bg-amber-500/10 ring-amber-500/20",
  request: "text-blue-400 bg-blue-500/10 ring-blue-500/20",
  action_item: "text-blue-400 bg-blue-500/10 ring-blue-500/20",
  question: "text-cyan-400 bg-cyan-500/10 ring-cyan-500/20",
  approval_needed: "text-orange-400 bg-orange-500/10 ring-orange-500/20",
  decision: "text-green-400 bg-green-500/10 ring-green-500/20",
  introduction: "text-purple-400 bg-purple-500/10 ring-purple-500/20",
  info: "text-zinc-400 bg-zinc-500/10 ring-zinc-500/20",
};

const DOMAIN_LABELS: Record<string, string> = {
  financial: "Financial",
  legal: "Legal",
  scheduling: "Calendar",
};

interface Signal {
  id: string;
  signal_type: string;
  content: string;
  confidence: number;
  due_date: string | null;
  direction: string | null;
  domain: string | null;
  created_at: string;
  message_id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  received_at: string;
  channel: string;
  webhook_source: string | null;
  contact_type: string | null;
  is_vip: boolean;
  tier: string | null;
  account_label: string | null;
  metadata?: Record<string, unknown>;
}

interface Contact {
  id: string;
  email_address: string;
  name: string | null;
  organization: string | null;
  contact_type: string;
  tier: string;
  is_vip: boolean;
  emails_received: number;
  emails_sent: number;
  last_received_at: string | null;
  last_sent_at: string | null;
  relationship_strength: number;
}

interface Stats {
  owe_count: number;
  waiting_count: number;
  overdue_count: number;
  due_this_week: number;
}

type Section = "owe" | "waiting" | "connect";
type FeedbackState = Record<string, "correct" | "incorrect" | null>;

export default function TodayPage() {
  const [owe, setOwe] = useState<Signal[]>([]);
  const [waiting, setWaiting] = useState<Signal[]>([]);
  const [connect, setConnect] = useState<Contact[]>([]);
  const [stats, setStats] = useState<Stats>({ owe_count: 0, waiting_count: 0, overdue_count: 0, due_this_week: 0 });
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<Section>("owe");
  const [focusIndex, setFocusIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{ signalId: string; messageId?: string; timeoutId: ReturnType<typeof setTimeout>; isArchive?: boolean } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const listRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/today`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      setOwe(data?.owe || []);
      setWaiting(data?.waiting || []);
      setConnect(data?.connect || []);
      setStats(data?.stats || { owe_count: 0, waiting_count: 0, overdue_count: 0, due_this_week: 0 });
    } catch {
      // silent — retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Current list for keyboard nav
  const currentList = activeSection === "owe" ? owe : activeSection === "waiting" ? waiting : connect;

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, currentList.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "o":
        case "Enter":
          e.preventDefault();
          if (activeSection !== "connect" && currentList[focusIndex]) {
            const item = currentList[focusIndex] as Signal;
            setExpandedId((prev) => (prev === item.id ? null : item.id));
          }
          break;
        case "r":
          e.preventDefault();
          if (activeSection !== "connect" && currentList[focusIndex]) {
            resolveSignal((currentList[focusIndex] as Signal).id);
          }
          break;
        case "a":
          e.preventDefault();
          if (activeSection !== "connect" && currentList[focusIndex]) {
            archiveSignal(currentList[focusIndex] as Signal);
          }
          break;
        case "1":
          e.preventDefault();
          setActiveSection("owe");
          setFocusIndex(0);
          setExpandedId(null);
          break;
        case "2":
          e.preventDefault();
          setActiveSection("waiting");
          setFocusIndex(0);
          setExpandedId(null);
          break;
        case "3":
          e.preventDefault();
          setActiveSection("connect");
          setFocusIndex(0);
          setExpandedId(null);
          break;
        case "Escape":
          e.preventDefault();
          if (expandedId) setExpandedId(null);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentList, focusIndex, expandedId, activeSection]);

  // Auto-scroll focused item
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusIndex}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusIndex]);

  // Resolve signal
  const resolveSignal = useCallback(async (signalId: string) => {
    // Optimistically remove
    setOwe((prev) => prev.filter((s) => s.id !== signalId));
    setWaiting((prev) => prev.filter((s) => s.id !== signalId));

    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/signals/resolve", body: { ids: [signalId] } }),
      });
    } catch {
      fetchData(); // restore on failure
      return;
    }

    if (undoToast) clearTimeout(undoToast.timeoutId);
    const timeoutId = setTimeout(() => setUndoToast(null), 5000);
    setUndoToast({ signalId, timeoutId });
  }, [fetchData, undoToast]);

  // Archive message (resolve all signals + archive)
  const archiveSignal = useCallback(async (signal: Signal) => {
    setOwe((prev) => prev.filter((s) => s.id !== signal.id));
    setWaiting((prev) => prev.filter((s) => s.id !== signal.id));

    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/emails/archive", body: { messageId: signal.message_id } }),
      });
    } catch {
      fetchData();
      return;
    }

    if (undoToast) clearTimeout(undoToast.timeoutId);
    const timeoutId = setTimeout(() => setUndoToast(null), 5000);
    setUndoToast({ signalId: signal.id, messageId: signal.message_id, timeoutId, isArchive: true });
  }, [fetchData, undoToast]);

  // Submit signal feedback
  const submitFeedback = useCallback(async (signalId: string, verdict: "correct" | "incorrect") => {
    setFeedback((prev) => ({ ...prev, [signalId]: verdict }));
    try {
      await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/signals/feedback", body: { signalId, verdict } }),
      });
    } catch {
      setFeedback((prev) => ({ ...prev, [signalId]: null }));
    }
  }, []);

  // Undo resolve/archive
  const undoResolve = useCallback(async () => {
    if (!undoToast) return;
    clearTimeout(undoToast.timeoutId);
    setUndoToast(null);
    try {
      if (undoToast.isArchive && undoToast.messageId) {
        await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/api/emails/unarchive", body: { messageId: undoToast.messageId } }),
        });
      } else {
        await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/api/signals/unresolve", body: { ids: [undoToast.signalId] } }),
        });
      }
      fetchData();
    } catch { /* silent */ }
  }, [undoToast, fetchData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
          <div className="h-5 w-24 rounded bg-surface-raised animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const overdue = owe.filter((s) => s.due_date && new Date(s.due_date) < new Date());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <span
            className="h-2 w-2 rounded-full bg-status-approved animate-pulse"
            title="Polling every 10s"
          />
        </div>
        <div className="flex items-center gap-4">
          <div className="text-xs text-zinc-500">
            <Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd>
            <span className="ml-1.5">sections</span>
            <Kbd className="ml-3">j</Kbd><Kbd>k</Kbd>
            <span className="ml-1.5">navigate</span>
            <Kbd className="ml-3">o</Kbd>
            <span className="ml-1.5">expand</span>
            <Kbd className="ml-3">r</Kbd>
            <span className="ml-1.5">resolve</span>
            <Kbd className="ml-3">a</Kbd>
            <span className="ml-1.5">archive</span>
          </div>
          <span className="text-sm text-zinc-500">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="You Owe"
          value={stats.owe_count}
          sub={`${overdue.length} overdue`}
          urgent={overdue.length > 0}
        />
        <StatCard
          label="Waiting On"
          value={stats.waiting_count}
          sub="others owe you"
        />
        <StatCard
          label="Overdue"
          value={stats.overdue_count}
          color={stats.overdue_count > 0 ? "text-status-action" : undefined}
          urgent={stats.overdue_count > 0}
        />
        <StatCard
          label="Due This Week"
          value={stats.due_this_week}
          color={stats.due_this_week > 0 ? "text-status-response" : undefined}
        />
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-1 border-b border-white/5 pb-0">
        {([
          { key: "owe" as Section, label: "OWE", count: owe.length, desc: "you owe them" },
          { key: "waiting" as Section, label: "WAITING", count: waiting.length, desc: "they owe you" },
          { key: "connect" as Section, label: "CONNECT", count: connect.length, desc: "going cold" },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveSection(tab.key); setFocusIndex(0); setExpandedId(null); }}
            className={`px-4 py-2.5 text-sm font-semibold transition-colors relative tracking-wide ${
              activeSection === tab.key ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
            <span className={`ml-2 text-xs tabular-nums font-normal ${
              activeSection === tab.key ? "text-zinc-400" : "text-zinc-600"
            }`}>
              {tab.count}
            </span>
            {activeSection === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div ref={listRef}>
        {activeSection === "owe" && (
          <SignalList
            signals={owe}
            focusIndex={focusIndex}
            expandedId={expandedId}
            onExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            onResolve={resolveSignal}
            onArchive={archiveSignal}
            onFeedback={submitFeedback}
            feedback={feedback}
            emptyMessage="Nothing owed. You're clear."
            showOverdue
          />
        )}
        {activeSection === "waiting" && (
          <SignalList
            signals={waiting}
            focusIndex={focusIndex}
            expandedId={expandedId}
            onExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            onResolve={resolveSignal}
            onArchive={archiveSignal}
            onFeedback={submitFeedback}
            feedback={feedback}
            emptyMessage="Not waiting on anything."
            showAge
          />
        )}
        {activeSection === "connect" && (
          <ContactList contacts={connect} focusIndex={focusIndex} />
        )}
      </div>

      {/* Undo toast */}
      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-surface-raised border border-white/10 rounded-lg px-4 py-3 shadow-lg flex items-center gap-3">
          <span className="text-sm text-zinc-300">{undoToast.isArchive ? "Message archived" : "Signal resolved"}</span>
          <button
            onClick={undoResolve}
            className="text-sm font-medium text-accent-bright hover:text-accent transition-colors"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

// --- Signal List Component ---

function SignalList({
  signals,
  focusIndex,
  expandedId,
  onExpand,
  onResolve,
  onArchive,
  onFeedback,
  feedback,
  emptyMessage,
  showOverdue = false,
  showAge = false,
}: {
  signals: Signal[];
  focusIndex: number;
  expandedId: string | null;
  onExpand: (id: string) => void;
  onResolve: (id: string) => void;
  onArchive: (signal: Signal) => void;
  onFeedback: (signalId: string, verdict: "correct" | "incorrect") => void;
  feedback: FeedbackState;
  emptyMessage: string;
  showOverdue?: boolean;
  showAge?: boolean;
}) {
  if (signals.length === 0) {
    return (
      <div className="bg-surface-raised rounded-lg border border-white/5 py-12 text-center">
        <div className="text-zinc-500 text-sm">{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {signals.map((signal, i) => {
        const isOverdue = signal.due_date && new Date(signal.due_date) < new Date();
        const isFocused = i === focusIndex;
        const isExpanded = expandedId === signal.id;
        const age = signal.created_at ? daysSince(signal.created_at) : 0;
        const domainLabel = signal.domain && signal.domain !== "general" ? DOMAIN_LABELS[signal.domain] : null;
        const pattern = (signal.metadata as Record<string, string>)?.strategist_pattern;

        return (
          <div
            key={signal.id}
            data-index={i}
            onClick={() => onExpand(signal.id)}
            className={`bg-surface-raised rounded-lg border transition-colors cursor-pointer ${
              isFocused
                ? "border-accent/40 ring-1 ring-accent/20"
                : "border-white/5 hover:border-white/10"
            } ${showOverdue && isOverdue ? "border-l-2 border-l-status-action" : ""}`}
          >
            <div className="px-4 py-3 flex items-start gap-3">
              {/* Left: signal info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <ChannelPill channel={signal.channel} webhookSource={signal.webhook_source} />
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset ${
                    SIGNAL_COLORS[signal.signal_type] || SIGNAL_COLORS.info
                  }`}>
                    {signal.signal_type.replace("_", " ")}
                  </span>
                  {domainLabel && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-zinc-400 ring-1 ring-inset ring-white/5">
                      {domainLabel}
                    </span>
                  )}
                  {signal.is_vip && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                      VIP
                    </span>
                  )}
                  {showOverdue && isOverdue && (
                    <span className="text-[10px] font-medium text-status-action">OVERDUE</span>
                  )}
                  {showAge && age > 2 && (
                    <span className={`text-[10px] font-medium ${
                      age > 7 ? "text-status-action" : age > 3 ? "text-status-response" : "text-zinc-500"
                    }`}>
                      {age}d waiting
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-200 truncate">{signal.content}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-zinc-500 truncate">
                    {signal.from_name || signal.from_address}
                  </span>
                  {signal.subject && (
                    <>
                      <span className="text-zinc-600">·</span>
                      <span className="text-xs text-zinc-600 truncate">{signal.subject}</span>
                    </>
                  )}
                </div>
                {pattern && (
                  <div className="mt-1 text-[10px] text-amber-400/70 italic">{pattern}</div>
                )}
              </div>

              {/* Right: due date + resolve */}
              <div className="flex flex-col items-end gap-1 shrink-0">
                {signal.due_date && (
                  <span className={`text-xs tabular-nums ${
                    isOverdue ? "text-status-action font-medium" : "text-zinc-400"
                  }`}>
                    {formatDueDate(signal.due_date)}
                  </span>
                )}
                <span className="text-[10px] text-zinc-600">{timeAgo(signal.received_at)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onResolve(signal.id); }}
                  className="text-[10px] text-zinc-500 hover:text-accent-bright transition-colors mt-1"
                >
                  Resolve
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onArchive(signal); }}
                  className="text-[10px] text-zinc-500 hover:text-accent-bright transition-colors"
                >
                  Archive
                </button>
              </div>
            </div>

            {/* Expanded view */}
            {isExpanded && (
              <div className="px-4 pb-3 border-t border-white/5 pt-3">
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-zinc-500 mb-1">Signal Details</div>
                    <div className="text-zinc-300">{signal.content}</div>
                    <div className="mt-2 text-zinc-500">
                      Confidence: {(signal.confidence * 100).toFixed(0)}%
                      {signal.direction && <> · Direction: {signal.direction}</>}
                      {domainLabel && <> · Domain: {domainLabel}</>}
                    </div>
                  </div>
                  <div>
                    <div className="text-zinc-500 mb-1">Source</div>
                    <div className="text-zinc-300">{signal.from_name || signal.from_address}</div>
                    <div className="text-zinc-500 mt-0.5">{signal.subject}</div>
                    {signal.contact_type && signal.contact_type !== "unknown" && (
                      <div className="text-zinc-500 mt-0.5">
                        Type: {signal.contact_type} · Tier: {signal.tier || "unknown"}
                      </div>
                    )}
                  </div>
                </div>
                {/* Feedback buttons */}
                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/5">
                  <span className="text-[10px] text-zinc-500 mr-1">Signal accurate?</span>
                  {feedback[signal.id] ? (
                    <span className={`text-[10px] px-2 py-0.5 rounded ${
                      feedback[signal.id] === "correct"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-red-500/10 text-red-400"
                    }`}>
                      {feedback[signal.id] === "correct" ? "Marked correct" : "Marked incorrect"}
                    </span>
                  ) : (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); onFeedback(signal.id, "correct"); }}
                        className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                        title="Signal is accurate"
                      >
                        Correct
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onFeedback(signal.id, "incorrect"); }}
                        className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        title="Signal is wrong"
                      >
                        Wrong
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Contact List Component ---

function ContactList({ contacts, focusIndex }: { contacts: Contact[]; focusIndex: number }) {
  if (contacts.length === 0) {
    return (
      <div className="bg-surface-raised rounded-lg border border-white/5 py-12 text-center">
        <div className="text-zinc-500 text-sm">All relationships are healthy.</div>
        <div className="text-zinc-600 text-xs mt-1">Contacts with declining engagement will appear here.</div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {contacts.map((contact, i) => {
        const isFocused = i === focusIndex;
        const lastContact = contact.last_received_at || contact.last_sent_at;
        const daysCold = lastContact ? daysSince(lastContact) : 999;

        return (
          <div
            key={contact.id}
            data-index={i}
            className={`bg-surface-raised rounded-lg border px-4 py-3 transition-colors ${
              isFocused
                ? "border-accent/40 ring-1 ring-accent/20"
                : "border-white/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                {/* Strength indicator */}
                <div className="relative w-8 h-8 shrink-0">
                  <svg viewBox="0 0 36 36" className="w-8 h-8 -rotate-90">
                    <circle
                      cx="18" cy="18" r="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      className="text-white/5"
                    />
                    <circle
                      cx="18" cy="18" r="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeDasharray={`${contact.relationship_strength * 0.94} 94`}
                      className={
                        contact.relationship_strength > 40 ? "text-status-approved"
                        : contact.relationship_strength > 20 ? "text-status-response"
                        : "text-status-action"
                      }
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold tabular-nums text-zinc-400">
                    {Math.round(contact.relationship_strength)}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200 truncate">
                      {contact.name || contact.email_address}
                    </span>
                    {contact.is_vip && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                        VIP
                      </span>
                    )}
                    {contact.contact_type !== "unknown" && (
                      <span className="text-[10px] text-zinc-500">{contact.contact_type}</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {contact.organization ? `${contact.organization} · ` : ""}
                    {contact.emails_received + contact.emails_sent} interactions
                    {contact.name && <> · {contact.email_address}</>}
                  </div>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className={`text-xs font-medium ${
                  daysCold > 14 ? "text-status-action"
                  : daysCold > 7 ? "text-status-response"
                  : "text-zinc-400"
                }`}>
                  {daysCold > 0 ? `${daysCold}d ago` : "today"}
                </div>
                <div className="text-[10px] text-zinc-600">last contact</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Helpers ---

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays <= 7) return `in ${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}
