"use client";

// /issues — Issues (List/Board switchable view of work_items + human-blocker queue).
// Pure lane-bucketing lives in ./lanes.js (ADR-004); this file is the render shell.
// Lane contract + API shape: ../../../docs/adr/003-route-and-api-contract.md
// Skip affordance for needs_you items: ../../../docs/adr/005-skip-needs-you-items.md

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { inboxGet, timeAgo } from "@/components/inbox/shared";
import { useEventStream } from "@/hooks/useEventStream";
import { usePageContext } from "@/contexts/PageContext";
import { computeLanes } from "./lanes.js";
import {
  assigneeChip,
  cardAccentClass,
  cardActions,
  inlineQuestionFor,
  formatNeedsHuman,
} from "./human-task-card.js";
import {
  filterLanes,
  countByView,
  resolveInitialView,
  resolveInitialLayout,
  BOARD_VIEWS,
  BOARD_LAYOUTS,
} from "./board-filter.js";

type LaneId =
  | "needs_you"
  | "created"
  | "assigned"
  | "in_progress"
  | "review"
  | "completed";

type WorkItemCard = {
  kind: "work_item";
  id: string;
  type: "directive" | "workstream";
  title: string;
  status: Exclude<LaneId, "needs_you">;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type ProposalCard = {
  kind: "proposal";
  id: string;
  title: string;
  action_type: string;
  work_item_id: string | null;
  created_at: string;
};

type AttentionCard = {
  kind: "attention";
  id: string;
  title: string;
  signature: string;
  work_item_id: string | null;
  created_at: string;
};

type HumanTaskCardT = {
  kind: "human_task";
  id: string;
  title: string;
  status: string;
  priority: "urgent" | "high" | "normal" | "low";
  size: "quick" | "small" | "medium" | "large" | null;
  task_type: string | null;
  due_date: string | null;
  assignee_contact_id: string | null;
  assignee_label: string | null;
  assignee_confidence: number | null;
  tags: string[];
  next_action_hint: string | null;
  source_quote: string | null;
  signal_id: string | null;
  message_id: string | null;
  relevance_score: number | null;
  extraction_confidence: number | null;
  needs_human: { trigger: string; since: string; hint: string } | null;
  created_at: string;
  updated_at: string;
};

type Card = WorkItemCard | ProposalCard | AttentionCard | HumanTaskCardT;

type BoardResponse = {
  lanes: {
    needs_you: (ProposalCard | AttentionCard | HumanTaskCardT)[];
    created: (WorkItemCard | HumanTaskCardT)[];
    assigned: (WorkItemCard | HumanTaskCardT)[];
    in_progress: (WorkItemCard | HumanTaskCardT)[];
    review: (WorkItemCard | HumanTaskCardT)[];
    completed: (WorkItemCard | HumanTaskCardT)[];
  };
};

type Lane = {
  id: LaneId;
  title: string;
  emphasis: "human" | "flow";
  cards: Card[];
};

export default function BoardPage() {
  const { setCurrentPage } = usePageContext();
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage({ route: "/issues", title: "Issues" });
    return () => setCurrentPage(null);
  }, [setCurrentPage]);

  const fetchData = useCallback(async () => {
    try {
      const res = await inboxGet("/api/board", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BoardResponse;
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEventStream("state_changed", useCallback(() => { fetchData(); }, [fetchData]));
  useEventStream("task_assigned", useCallback(() => { fetchData(); }, [fetchData]));
  useEventStream("needs_attention", useCallback(() => { fetchData(); }, [fetchData]));

  // Fallback poll — SSE handles fast-path refresh; this catches missed events.
  useEffect(() => {
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-40 rounded bg-surface-raised animate-pulse" />
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="min-w-[260px] h-64 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return <BoardBody data={data} error={error} onChange={fetchData} />;
}

function BoardBody({
  data,
  error,
  onChange,
}: {
  data: BoardResponse | null;
  error: string | null;
  onChange: () => void;
}) {
  // Filter view — URL ?view= wins, then localStorage, then role default.
  // For v0.1 we hard-code role='board' (the page is gated behind board JWT).
  const [view, setView] = useState<string>(() => {
    if (typeof window === "undefined") return "humans";
    const urlView = new URLSearchParams(window.location.search).get("view");
    const stored = window.localStorage.getItem("board:view");
    return resolveInitialView({ urlView, storedView: stored, role: "board" });
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("board:view", view);
    const url = new URL(window.location.href);
    if (view === "humans") {
      url.searchParams.delete("view"); // default — keep URL clean
    } else {
      url.searchParams.set("view", view);
    }
    window.history.replaceState({}, "", url.toString());
  }, [view]);

  // Layout mode — URL ?layout= wins, then localStorage, then 'board' default.
  // Orthogonal to `view`: same filtered cards, different rendering.
  const [layout, setLayout] = useState<LayoutMode>(() => {
    if (typeof window === "undefined") return "board";
    const urlLayout = new URLSearchParams(window.location.search).get("layout");
    const stored = window.localStorage.getItem("board:layout");
    return resolveInitialLayout({ urlLayout, storedLayout: stored }) as LayoutMode;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("board:layout", layout);
    const url = new URL(window.location.href);
    if (layout === "board") {
      url.searchParams.delete("layout"); // default — keep URL clean
    } else {
      url.searchParams.set("layout", layout);
    }
    window.history.replaceState({}, "", url.toString());
  }, [layout]);

  // Viewer's contact_id powers the "Mine" view. v0.1: leave null — the API
  // can return it later via a /api/me endpoint. "Mine" still works once
  // that hook lands.
  const me: string | null = null;

  const rawLanes = (data?.lanes || {}) as BoardResponse["lanes"];
  const filtered = filterLanes(rawLanes, view, me);
  const counts = countByView(rawLanes, me);
  const lanes = computeLanes({ lanes: filtered } as unknown as BoardResponse) as Lane[];
  const totalCards = lanes.reduce((sum, l) => sum + l.cards.length, 0);

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Issues</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>{totalCards} cards</span>
          {error && <span className="text-amber-400">stale · {error}</span>}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <ViewFilter view={view} setView={setView} counts={counts} />
        <LayoutToggle layout={layout} setLayout={setLayout} />
      </div>

      {layout === "list" ? (
        <div className="space-y-5">
          {lanes.map((lane) => (
            <ListSection key={lane.id} lane={lane} onSkipped={onChange} />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {lanes.map((lane) => (
            <KanbanColumn key={lane.id} lane={lane} onSkipped={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

type LayoutMode = "board" | "list";

function LayoutToggle({
  layout,
  setLayout,
}: {
  layout: LayoutMode;
  setLayout: (l: LayoutMode) => void;
}) {
  const labels: Record<LayoutMode, string> = { board: "Board", list: "List" };
  return (
    <div
      className="inline-flex gap-1 rounded-md border border-white/5 p-0.5 bg-surface-raised/40 text-[11px]"
      role="group"
      aria-label="Layout"
    >
      {(BOARD_LAYOUTS as LayoutMode[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLayout(l)}
          aria-pressed={layout === l}
          className={`px-2.5 py-1 rounded transition-colors ${
            layout === l
              ? "bg-amber-500/15 text-amber-300"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {labels[l]}
        </button>
      ))}
    </div>
  );
}

function ViewFilter({
  view,
  setView,
  counts,
}: {
  view: string;
  setView: (v: string) => void;
  counts: { mine: number; humans: number; agents: number; all: number };
}) {
  return (
    <div className="inline-flex gap-1 rounded-md border border-white/5 p-0.5 bg-surface-raised/40 text-[11px]">
      {BOARD_VIEWS.map((v: string) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={`px-2.5 py-1 rounded transition-colors ${
            view === v
              ? "bg-amber-500/15 text-amber-300"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <span className="capitalize">{v}</span>
          <span className="ml-1 tabular-nums text-zinc-500">
            {counts[v as keyof typeof counts]}
          </span>
        </button>
      ))}
    </div>
  );
}

function KanbanColumn({ lane, onSkipped }: { lane: Lane; onSkipped: () => void }) {
  const isHuman = lane.emphasis === "human";
  return (
    <section
      className={`min-w-[260px] max-w-[280px] flex-shrink-0 rounded-lg border ${
        isHuman
          ? "border-amber-500/30 bg-amber-500/[0.03]"
          : "border-white/5 bg-surface-raised/40"
      }`}
    >
      <header className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <h2
          className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${
            isHuman ? "text-amber-300" : "text-zinc-400"
          }`}
        >
          {lane.title}
        </h2>
        <span className="text-[11px] tabular-nums text-zinc-500">{lane.cards.length}</span>
      </header>
      <div className="p-2 space-y-2 min-h-[80px]">
        {lane.cards.length === 0 ? (
          <p className="text-[11px] text-zinc-600 px-1 py-2">Empty</p>
        ) : (
          lane.cards.map((card) => (
            <KanbanCard key={cardKey(card)} card={card} onSkipped={onSkipped} />
          ))
        )}
      </div>
    </section>
  );
}

function cardKey(card: Card): string {
  return `${card.kind}-${card.id}`;
}

function ListSection({ lane, onSkipped }: { lane: Lane; onSkipped: () => void }) {
  const isHuman = lane.emphasis === "human";
  return (
    <section>
      <header className="flex items-center gap-2 mb-1.5 px-0.5">
        <h2
          className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${
            isHuman ? "text-amber-300" : "text-zinc-400"
          }`}
        >
          {lane.title}
        </h2>
        <span className="text-[11px] tabular-nums text-zinc-600">{lane.cards.length}</span>
      </header>
      {lane.cards.length === 0 ? null : (
        <ul className="divide-y divide-white/5 rounded-lg border border-white/5 bg-surface-raised/40 overflow-hidden">
          {lane.cards.map((card) => (
            <ListRow key={cardKey(card)} card={card} onSkipped={onSkipped} />
          ))}
        </ul>
      )}
    </section>
  );
}

// Compact, dense list row. Mirrors KanbanCard's link + action behavior exactly
// (same deepLinkFor target, same HumanTaskActions / SkipFooter footers) so a
// card navigates and acts identically in both layouts — only the layout differs.
function ListRow({ card, onSkipped }: { card: Card; onSkipped: () => void }) {
  const href = deepLinkFor(card);
  const accent = cardAccentClass(card);

  const main = (
    <div className="flex items-center gap-3 px-3 py-1.5 min-w-0">
      <RowKindBadge card={card} />
      <p className="flex-1 min-w-0 truncate text-[13px] text-zinc-200">{card.title}</p>
      <RowMeta card={card} />
    </div>
  );

  return (
    <li className={`bg-surface-raised hover:bg-white/[0.02] transition-colors ${accent}`}>
      {href ? (
        <Link href={href} className="block">
          {main}
        </Link>
      ) : (
        <div className="block">{main}</div>
      )}
      <CardFooters card={card} onSkipped={onSkipped} />
    </li>
  );
}

// Type/kind badge for a list row — reuses the same pills the board cards use.
function RowKindBadge({ card }: { card: Card }) {
  if (card.kind === "work_item") return <TypePill type={card.type} />;
  if (card.kind === "proposal") return <KindPill label="proposal" tone="amber" />;
  if (card.kind === "attention") return <KindPill label="attention" tone="red" />;
  // human_task
  const chip = assigneeChip(card);
  return (
    <span className="inline-flex items-center gap-1.5">
      <AssigneeChip chip={chip} />
      <PriorityPill priority={card.priority} />
    </span>
  );
}

// Trailing metadata: status, assignee, age — Linear-row density.
function RowMeta({ card }: { card: Card }) {
  const age = timeAgo(
    card.kind === "work_item" || card.kind === "human_task"
      ? card.updated_at
      : card.created_at,
  );
  return (
    <div className="flex items-center gap-3 flex-shrink-0 text-[11px] text-zinc-500">
      {card.kind === "work_item" && (
        <span className="hidden sm:inline capitalize tabular-nums">
          {card.status.replace(/_/g, " ")}
        </span>
      )}
      {card.kind === "work_item" && (
        <span className="hidden md:inline truncate max-w-[140px] text-zinc-400">
          {card.assigned_to || card.created_by}
        </span>
      )}
      {card.kind === "human_task" && (
        <span className="hidden sm:inline capitalize tabular-nums">
          {card.status.replace(/_/g, " ")}
        </span>
      )}
      <span className="tabular-nums text-zinc-600 whitespace-nowrap">{age}</span>
    </div>
  );
}

// Footer actions shared by both layouts (board cards + list rows) so a new card
// kind can't render actions in one layout and silently miss them in the other.
// human_task and proposal/attention are mutually exclusive kinds.
function CardFooters({ card, onSkipped }: { card: Card; onSkipped: () => void }) {
  if (card.kind === "human_task") {
    return <HumanTaskActions card={card as HumanTaskCardT} onChanged={onSkipped} />;
  }
  if (card.kind === "proposal" || card.kind === "attention") {
    return <SkipFooter card={card} onSkipped={onSkipped} />;
  }
  return null;
}

function KanbanCard({ card, onSkipped }: { card: Card; onSkipped: () => void }) {
  const href = deepLinkFor(card);
  const accent = cardAccentClass(card);

  return (
    <div className={`rounded-md bg-surface-raised border border-white/5 hover:border-white/15 transition-colors ${accent}`}>
      {href ? (
        <Link href={href} className="block px-3 py-2">
          <CardBody card={card} />
        </Link>
      ) : (
        <div className="block px-3 py-2">
          <CardBody card={card} />
        </div>
      )}
      <CardFooters card={card} onSkipped={onSkipped} />
    </div>
  );
}

function SkipFooter({
  card,
  onSkipped,
}: {
  card: ProposalCard | AttentionCard;
}  & { onSkipped: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const path = card.kind === "proposal"
        ? `/api/board/proposals/${encodeURIComponent(card.id)}/skip`
        : `/api/board/attention/${encodeURIComponent(card.id)}/skip`;
      const trimmed = reason.trim();
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, body: trimmed ? { reason: trimmed } : {} }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      setOpen(false);
      setReason("");
      onSkipped();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to skip");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="px-3 pb-2 -mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Skip
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 pb-2 pt-1 border-t border-white/5 space-y-1.5">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why are you skipping? (optional — future-you will thank you)"
        rows={2}
        className="w-full text-[11px] bg-surface-base border border-white/10 rounded px-2 py-1 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 resize-none"
        autoFocus
        disabled={submitting}
      />
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(""); setError(null); }}
          disabled={submitting}
          className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="text-[10px] uppercase tracking-wider text-amber-300 hover:text-amber-200 transition-colors disabled:opacity-50"
        >
          {submitting ? "Skipping…" : "Skip"}
        </button>
      </div>
    </div>
  );
}

function CardBody({ card }: { card: Card }) {
  if (card.kind === "work_item") {
    return (
      <>
        <div className="flex items-center gap-1.5 mb-1">
          <TypePill type={card.type} />
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">
            {timeAgo(card.updated_at)}
          </span>
        </div>
        <p className="text-sm text-zinc-200 line-clamp-2">{card.title}</p>
        <p className="mt-1 text-[11px] text-zinc-500 truncate">
          {card.assigned_to || card.created_by}
        </p>
      </>
    );
  }
  if (card.kind === "proposal") {
    return (
      <>
        <div className="flex items-center gap-1.5 mb-1">
          <KindPill label="proposal" tone="amber" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">
            {timeAgo(card.created_at)}
          </span>
        </div>
        <p className="text-sm text-zinc-200 line-clamp-2">{card.title}</p>
        <p className="mt-1 text-[11px] text-zinc-500 truncate">{card.action_type}</p>
      </>
    );
  }
  if (card.kind === "attention") {
    return (
      <>
        <div className="flex items-center gap-1.5 mb-1">
          <KindPill label="attention" tone="red" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">
            {timeAgo(card.created_at)}
          </span>
        </div>
        <p className="text-sm text-zinc-200 line-clamp-2">{card.title}</p>
        <p className="mt-1 text-[11px] text-zinc-500 font-mono truncate">{card.signature}</p>
      </>
    );
  }
  // human_task
  return <HumanTaskBody card={card} />;
}

function HumanTaskBody({ card }: { card: HumanTaskCardT }) {
  const chip = assigneeChip(card);
  const needs = formatNeedsHuman(card);
  return (
    <>
      <div className="flex items-center gap-1.5 mb-1">
        <AssigneeChip chip={chip} />
        <PriorityPill priority={card.priority} />
        <span className="text-[10px] uppercase tracking-wider text-zinc-600">
          {timeAgo(card.updated_at)}
        </span>
      </div>
      <p className="text-sm text-zinc-200 line-clamp-2">{card.title}</p>
      {card.next_action_hint && (
        <p className="mt-1 text-[11px] text-zinc-400 line-clamp-1">
          → {card.next_action_hint}
        </p>
      )}
      {needs && (
        <p className="mt-1 text-[10px] uppercase tracking-wider text-amber-400/80 truncate">
          {needs}
        </p>
      )}
    </>
  );
}

function AssigneeChip({ chip }: { chip: ReturnType<typeof assigneeChip> }) {
  if (chip.glyph) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[10px] uppercase tracking-wider">
        <span>{chip.glyph}</span>
        <span>{chip.label}</span>
      </span>
    );
  }
  const cls = chip.dashed
    ? "border border-dashed border-amber-400/60 text-amber-300"
    : "bg-amber-500/15 text-amber-200";
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ${cls}`}
      title={chip.label || "Unassigned"}
    >
      {chip.initials}
    </span>
  );
}

function PriorityPill({ priority }: { priority: HumanTaskCardT["priority"] }) {
  const tone: Record<HumanTaskCardT["priority"], string> = {
    urgent: "bg-red-500/20 text-red-300",
    high:   "bg-amber-500/15 text-amber-300",
    normal: "bg-zinc-700/40 text-zinc-400",
    low:    "bg-zinc-800/40 text-zinc-500",
  };
  if (priority === "normal") return null;
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${tone[priority]}`}>
      {priority}
    </span>
  );
}

function HumanTaskActions({ card, onChanged }: { card: HumanTaskCardT; onChanged: () => void }) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = cardActions(card) as ("done"|"skip"|"later"|"not_for_me")[];
  const question = inlineQuestionFor(card);

  if (actions.length === 0 && !question) return null;

  async function fire(verb: "done"|"skip"|"later"|"not_for_me") {
    setSubmitting(verb);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/human-tasks/${encodeURIComponent(card.id)}/action`,
          body: { verb },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(null);
    }
  }

  async function answer(field: string, value: string, label?: string) {
    setSubmitting(`q:${field}`);
    setError(null);
    try {
      const res = await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `/api/human-tasks/${encodeURIComponent(card.id)}/inline-answer`,
          body: { field, value, label },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="px-3 pb-2 pt-1 border-t border-white/5 space-y-1.5">
      {question && (
        <InlineQuestion question={question} onAnswer={answer} submitting={submitting} />
      )}
      {actions.length > 0 && (
        <div className="flex gap-3 text-[10px] uppercase tracking-wider">
          {actions.map((verb) => (
            <button
              key={verb}
              type="button"
              onClick={() => fire(verb)}
              disabled={submitting !== null}
              className={`transition-colors disabled:opacity-50 ${
                verb === "done"
                  ? "text-green-300 hover:text-green-200"
                  : verb === "not_for_me"
                  ? "text-zinc-500 hover:text-zinc-300"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {submitting === verb ? "…" : VERB_LABEL[verb]}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

const VERB_LABEL: Record<"done"|"skip"|"later"|"not_for_me", string> = {
  done: "Done",
  skip: "Skip",
  later: "Later",
  not_for_me: "Not for me",
};

function InlineQuestion({
  question,
  onAnswer,
  submitting,
}: {
  question: { field: string; options: string[] | null };
  onAnswer: (field: string, value: string, label?: string) => void;
  submitting: string | null;
}) {
  const busy = submitting !== null;
  const labels: Record<string, string> = {
    assignee: "Who owns this?",
    when: "When?",
    size: "How big?",
    is_this_ours: "Is this ours?",
  };
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-amber-300">
        {labels[question.field] || question.field}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(question.options || []).map((opt) => (
          <button
            key={opt}
            type="button"
            disabled={busy}
            onClick={() => onAnswer(question.field, opt)}
            className="px-2 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-[11px] capitalize transition-colors disabled:opacity-50"
          >
            {opt.replace(/_/g, " ")}
          </button>
        ))}
        {!question.options && (
          <p className="text-[10px] text-zinc-500">
            Tap card to pick an answer
          </p>
        )}
      </div>
    </div>
  );
}

function TypePill({ type }: { type: "directive" | "workstream" }) {
  const cls =
    type === "directive"
      ? "bg-violet-500/15 text-violet-300"
      : "bg-blue-500/15 text-blue-300";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${cls}`}>
      {type}
    </span>
  );
}

function KindPill({ label, tone }: { label: string; tone: "amber" | "red" }) {
  const cls =
    tone === "amber"
      ? "bg-amber-500/15 text-amber-300"
      : "bg-red-500/15 text-red-300";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}

function deepLinkFor(card: Card): string | null {
  if (card.kind === "work_item") return `/pipeline?task=${encodeURIComponent(card.id)}`;
  if (card.kind === "proposal") return `/drafts?id=${encodeURIComponent(card.id)}`;
  if (card.kind === "attention") {
    return card.work_item_id
      ? `/activity?task=${encodeURIComponent(card.work_item_id)}`
      : `/activity`;
  }
  if (card.kind === "human_task") {
    // Surface the source meeting transcript when present.
    return card.message_id ? `/meetings?id=${encodeURIComponent(card.message_id)}` : null;
  }
  return null;
}
