"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { markdownToHtml } from "@/lib/markdown";
import type { AgendaData, AgendaAction, AgendaSection, AgendaItem, SpecIndex, DiscussMessage, SpecContextEntry } from "./types";

interface AgendaPanelProps {
  data: AgendaData | null;
  loading: boolean;
  activeItemId?: string | null;
  onAction: (action: AgendaAction, item?: AgendaItem) => void;
  onRefresh: () => void;
  onSpecRefClick?: (sectionId: string) => void;
  onActiveSpecSections?: (sectionIds: string[], context: Record<string, SpecContextEntry[]>) => void;
}

// --- Contributor system ---

const CONTRIBUTOR_COLORS: Record<string, { bg: string; text: string; ring: string }> = {
  eric:   { bg: "bg-blue-500/15",    text: "text-blue-400",    ring: "ring-blue-500/25" },
  dustin: { bg: "bg-emerald-500/15", text: "text-emerald-400", ring: "ring-emerald-500/25" },
  mike:   { bg: "bg-purple-500/15",  text: "text-purple-400",  ring: "ring-purple-500/25" },
  board:  { bg: "bg-amber-500/15",   text: "text-amber-400",   ring: "ring-amber-500/25" },
};

const CONTRIBUTOR_MAP: Record<string, string> = {
  "eric": "Eric", "eric gang": "Eric",
  "dustin": "Dustin",
  "mike": "Mike", "mike maibach": "Mike",
  "board": "Board",
};

function resolveContributor(raw: string): string | null {
  return CONTRIBUTOR_MAP[raw.toLowerCase().trim()] || null;
}

function ContributorBadge({ name }: { name: string }) {
  const key = name.toLowerCase();
  const colors = CONTRIBUTOR_COLORS[key] || CONTRIBUTOR_COLORS.board;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ring-1 ring-inset ${colors.bg} ${colors.text} ${colors.ring}`}
    >
      {name}
    </span>
  );
}

// --- Priority ---

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-400",
  medium: "bg-amber-400",
  low: "bg-zinc-500",
};

const PRIORITY_LABEL: Record<string, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

function PriorityDot({ priority }: { priority: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[priority] || PRIORITY_DOT.low}`}
      role="img"
      aria-label={PRIORITY_LABEL[priority] || "Low priority"}
      title={PRIORITY_LABEL[priority] || "Low priority"}
    />
  );
}

// --- Metadata ---

function MetadataPill({ label, value }: { label: string; value: unknown }) {
  const display = typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface border border-white/5 rounded text-zinc-500">
      <span className="text-zinc-600">{label}:</span> {display}
    </span>
  );
}

// --- Section Navigation ---

const SECTION_NAV: {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  activeColor: string;
}[] = [
  {
    id: "pending-review",
    label: "need review",
    shortLabel: "Review",
    color: "bg-red-500/15 text-red-400 ring-red-500/25",
    activeColor: "bg-red-500/25 text-red-300 ring-red-500/40",
  },
  {
    id: "open-questions",
    label: "open questions",
    shortLabel: "Questions",
    color: "bg-red-500/15 text-red-400 ring-red-500/25",
    activeColor: "bg-red-500/25 text-red-300 ring-red-500/40",
  },
  {
    id: "spec-patches",
    label: "spec patches",
    shortLabel: "Patches",
    color: "bg-amber-500/15 text-amber-400 ring-amber-500/25",
    activeColor: "bg-amber-500/25 text-amber-300 ring-amber-500/40",
  },
  {
    id: "draft-releases",
    label: "draft releases",
    shortLabel: "Releases",
    color: "bg-amber-500/15 text-amber-400 ring-amber-500/25",
    activeColor: "bg-amber-500/25 text-amber-300 ring-amber-500/40",
  },
  {
    id: "recent-decisions",
    label: "decisions",
    shortLabel: "Decisions",
    color: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/25",
    activeColor: "bg-emerald-500/25 text-emerald-300 ring-emerald-500/40",
  },
  {
    id: "deferred-items",
    label: "deferred",
    shortLabel: "Deferred",
    color: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/25",
    activeColor: "bg-zinc-500/25 text-zinc-300 ring-zinc-500/40",
  },
  {
    id: "research-questions",
    label: "research",
    shortLabel: "Research",
    color: "bg-purple-500/15 text-purple-400 ring-purple-500/25",
    activeColor: "bg-purple-500/25 text-purple-300 ring-purple-500/40",
  },
];

function SectionNav({
  sections,
  activeSectionId,
  onNavigate,
  variant = "inline",
}: {
  sections: AgendaSection[];
  activeSectionId: string | null;
  onNavigate: (sectionId: string) => void;
  variant?: "inline" | "sticky";
}) {
  const pills = SECTION_NAV.map(({ id, label, shortLabel, color, activeColor }) => {
    const section = sections.find((s) => s.id === id);
    if (!section || section.items.length === 0) return null;
    const isActive = activeSectionId === id;
    return (
      <button
        key={id}
        onClick={() => onNavigate(id)}
        aria-current={isActive ? "true" : undefined}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full ring-1 ring-inset transition-all duration-150 cursor-pointer hover:scale-[1.03] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          isActive ? activeColor : color
        }`}
      >
        {isActive && (
          <span className="w-1.5 h-1.5 rounded-full bg-current flex-shrink-0" />
        )}
        <span>{section.items.length}</span>
        <span>{variant === "sticky" ? shortLabel : label}</span>
      </button>
    );
  }).filter(Boolean);

  if (pills.length === 0) return null;

  if (variant === "sticky") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-600 mr-1">Jump to:</span>
        {pills}
      </div>
    );
  }

  return (
    <nav aria-label="Agenda sections" className="flex flex-wrap gap-2">
      {pills}
    </nav>
  );
}

// --- Skeleton Loader ---

function SkeletonSection() {
  return (
    <div className="p-5 bg-surface-raised rounded-lg border border-white/5 space-y-3">
      <div className="space-y-2">
        <div className="h-4 w-36 bg-surface-overlay/50 rounded animate-pulse" />
        <div className="h-3 w-64 bg-surface-overlay/30 rounded animate-pulse" />
      </div>
      <div className="space-y-2">
        <div className="p-3 rounded-md bg-surface border border-white/5 space-y-2">
          <div className="h-3.5 w-48 bg-surface-overlay/50 rounded animate-pulse" />
          <div className="h-3 w-full bg-surface-overlay/30 rounded animate-pulse" />
          <div className="h-3 w-2/3 bg-surface-overlay/30 rounded animate-pulse" />
        </div>
        <div className="p-3 rounded-md bg-surface border border-white/5 space-y-2">
          <div className="h-3.5 w-56 bg-surface-overlay/50 rounded animate-pulse" />
          <div className="h-3 w-full bg-surface-overlay/30 rounded animate-pulse" />
          <div className="h-3 w-1/2 bg-surface-overlay/30 rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

// --- Agenda Item Card ---

function AgendaItemCard({
  item,
  expanded,
  isActive,
  onToggle,
  onAction,
  onSpecRefClick,
}: {
  item: AgendaItem;
  expanded: boolean;
  isActive?: boolean;
  onToggle: () => void;
  onAction: (action: AgendaAction, item: AgendaItem) => void;
  onSpecRefClick?: (sectionId: string) => void;
}) {
  const contentId = `content-${item.id}`;
  const hasContent = Boolean(item.content);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll into view when this card becomes the active selection
  useEffect(() => {
    if (isActive && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isActive]);

  // Extract contributors from metadata
  const contributors: string[] = [];
  const participantsRaw = item.metadata.participants || item.metadata.decidedBy || "";
  if (participantsRaw) {
    for (const part of participantsRaw.split(/[,&]/)) {
      const name = resolveContributor(part);
      if (name && !contributors.includes(name)) contributors.push(name);
    }
  }

  // Filter out participant/decidedBy from metadata pills (shown as badges instead)
  const metadataEntries = Object.entries(item.metadata).filter(
    ([key]) => key !== "participants" && key !== "decidedBy"
  );

  return (
    <div
      ref={cardRef}
      className={`rounded-md bg-surface border transition-colors ${
        isActive
          ? "border-accent/40 ring-1 ring-accent/20 bg-accent/[0.04]"
          : "border-white/5 hover:border-white/10"
      }`}
    >
      {/* Active indicator bar */}
      {isActive && (
        <div className="flex items-center gap-2 px-3 pt-2 pb-0">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
          <span className="text-[10px] text-accent-bright font-medium uppercase tracking-wider">Selected</span>
        </div>
      )}
      <div className="flex items-start gap-3 p-3">
        <div className="pt-1.5">
          <PriorityDot priority={item.priority} />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          {/* Contributor badges + spec ref pills */}
          {(contributors.length > 0 || (item.specRefs && item.specRefs.length > 0)) && (
            <div className="flex flex-wrap gap-1.5">
              {contributors.map((name) => (
                <ContributorBadge key={name} name={name} />
              ))}
              {item.specRefs?.map((ref) => (
                <button
                  key={ref.sectionId}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSpecRefClick?.(ref.sectionId);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-indigo-500/10 text-indigo-400 rounded ring-1 ring-inset ring-indigo-500/20 hover:bg-indigo-500/15 hover:text-indigo-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {"\u00A7"}{ref.sectionId}
                </button>
              ))}
            </div>
          )}

          <p className="text-sm text-zinc-200 leading-snug">{item.title}</p>

          {/* Preview text (clamped when collapsed, hidden when expanded) */}
          {!expanded && item.summary !== item.title && (
            <p className="text-xs text-zinc-500 leading-relaxed line-clamp-3">
              {item.summary}
            </p>
          )}

          {/* Metadata pills */}
          {metadataEntries.length > 0 && !expanded && (
            <div className="flex flex-wrap gap-1.5">
              {metadataEntries.map(([key, value]) => (
                <MetadataPill key={key} label={key} value={value} />
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            {item.actions.map((action, i) => (
              <button
                key={i}
                onClick={() => onAction(action, item)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  i === 0
                    ? "bg-accent hover:bg-accent-dim text-white"
                    : "bg-surface-overlay text-zinc-300 hover:bg-surface-selected border border-white/10"
                }`}
              >
                {action.label}
              </button>
            ))}
            {hasContent && (
              <button
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={contentId}
                className="px-3 py-1 text-xs rounded-md transition-colors bg-surface-overlay text-zinc-300 hover:bg-surface-selected border border-white/10"
              >
                {expanded ? "\u25BE Collapse" : "\u25B8 Read"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && item.content && (
        <div
          id={contentId}
          role="region"
          aria-label="Document content"
          className="relative border-t border-white/5"
        >
          <div className="max-h-[50vh] overflow-y-auto px-5 py-4">
            <div
              className="prose prose-sm prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(item.content) }}
            />
          </div>
          <div className="sticky bottom-0 flex justify-end px-5 py-2 bg-gradient-to-t from-surface to-transparent">
            <button
              onClick={onToggle}
              className="px-3 py-1 text-xs rounded-md bg-surface-overlay text-zinc-400 hover:text-zinc-200 border border-white/10 hover:border-white/20 transition-colors"
            >
              Collapse
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Section Card ---

function AgendaSectionCard({
  section,
  expandedItemId,
  activeItemId,
  onToggleItem,
  onAction,
  onSpecRefClick,
}: {
  section: AgendaSection;
  expandedItemId: string | null;
  activeItemId?: string | null;
  onToggleItem: (id: string) => void;
  onAction: (action: AgendaAction, item: AgendaItem) => void;
  onSpecRefClick?: (sectionId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-zinc-300">{section.title}</h3>
        <p className="text-xs text-zinc-600 mt-0.5">{section.description}</p>
      </div>
      {section.items.length > 0 ? (
        <div className="space-y-2">
          {section.items.map((item) => (
            <AgendaItemCard
              key={item.id}
              item={item}
              expanded={expandedItemId === item.id}
              isActive={activeItemId === item.id}
              onToggle={() => onToggleItem(item.id)}
              onAction={onAction}
              onSpecRefClick={onSpecRefClick}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-600 italic pl-5">No items</p>
      )}
    </div>
  );
}

// --- SpecReferencePanel re-exported from separate file ---
export { SpecReferencePanel } from "./SpecReferencePanel";

// --- Expert Names ---

const EXPERT_NAMES: Record<string, string> = {
  strategy: "Strategy Analysis",
  architecture: "Architecture Review",
  governance: "Governance & Spec",
  operations: "Operations & Pipeline",
};

// --- Discuss Panel ---

interface DiscussPanelProps {
  item: AgendaItem;
  messages: DiscussMessage[];
  loading: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
  onSpecRefClick?: (sectionId: string) => void;
  onClearThread?: () => void;
}

const DISCUSS_SUGGESTIONS = [
  "What does this propose?",
  "How does this affect the spec?",
  "What's the board decision needed?",
];

export function DiscussPanel({
  item,
  messages,
  loading,
  onSend,
  onClose,
  onSpecRefClick,
  onClearThread,
}: DiscussPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    onSend(text);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="w-[380px] flex-shrink-0 border-l border-white/5 bg-surface-raised flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-white/5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-zinc-200 font-medium truncate flex-1">
            {item.title}
          </p>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onClearThread && messages.length > 0 && (
              <button
                onClick={onClearThread}
                className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-white/5"
                title="Clear thread history"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors rounded hover:bg-white/5"
              aria-label="Close discussion"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {/* Spec ref pills */}
        {item.specRefs && item.specRefs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.specRefs.map((ref) => (
              <button
                key={ref.sectionId}
                onClick={() => onSpecRefClick?.(ref.sectionId)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-indigo-500/10 text-indigo-400 rounded ring-1 ring-inset ring-indigo-500/20 hover:bg-indigo-500/15 hover:text-indigo-300 transition-colors"
              >
                {"\u00A7"}{ref.sectionId}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Quick-start suggestions when empty */}
        {messages.length === 0 && !loading && (
          <div className="space-y-2 py-4">
            <p className="text-xs text-zinc-600 text-center">Ask about this item:</p>
            <div className="space-y-1.5">
              {DISCUSS_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => onSend(suggestion)}
                  className="w-full text-left px-3 py-2 text-xs text-zinc-400 bg-surface border border-white/5 rounded-md hover:border-white/10 hover:text-zinc-300 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message thread */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 ${
                msg.role === "user"
                  ? "bg-accent/10 border border-accent/20 text-zinc-200"
                  : "bg-surface border border-white/5 text-zinc-300"
              }`}
            >
              {msg.role === "assistant" && msg.expert && (
                <p className="text-xs text-zinc-600 mb-1">
                  {EXPERT_NAMES[msg.expert] || msg.expert}
                </p>
              )}
              {msg.role === "assistant" ? (
                <div
                  className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(msg.content) }}
                />
              ) : (
                <p className="text-sm leading-relaxed">{msg.content}</p>
              )}
              {msg.role === "assistant" && msg.filesUsed && msg.filesUsed.length > 0 && (
                <p className="text-xs text-zinc-600 mt-1.5">
                  {msg.filesUsed.length} file{msg.filesUsed.length === 1 ? "" : "s"} referenced
                </p>
              )}
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-surface border border-white/5 rounded-lg px-3 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-white/5">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a follow-up question..."
            rows={1}
            className="flex-1 px-3 py-2 text-sm bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="px-3 py-2 text-sm bg-accent hover:bg-accent-dim text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Exports ---

export { EXPERT_NAMES };

export default function AgendaPanel({
  data,
  loading,
  activeItemId,
  onAction,
  onRefresh,
  onSpecRefClick,
  onActiveSpecSections,
}: AgendaPanelProps) {
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [showStickyNav, setShowStickyNav] = useState(false);
  const inlineNavRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  function toggleItem(id: string) {
    const isExpanding = expandedItemId !== id;
    setExpandedItemId((prev) => (prev === id ? null : id));
    // When expanding an item with specRefs, update active spec sections with context
    if (isExpanding && data) {
      for (const section of data.sections) {
        const item = section.items.find((i) => i.id === id);
        if (item?.specRefs?.length) {
          const sectionIds = item.specRefs.map((r) => r.sectionId);
          const ctx: Record<string, SpecContextEntry[]> = {};
          for (const sid of sectionIds) {
            ctx[sid] = [{ title: item.title, file: item.source.file }];
          }
          onActiveSpecSections?.(sectionIds, ctx);
          break;
        }
      }
    }
  }

  // Scroll-spy: highlight the section currently in the viewport
  // Also emit combined specRefs from visible section items
  useEffect(() => {
    if (!data) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const sectionId = entry.target.getAttribute("data-section-id");
            setActiveSectionId(sectionId);

            // Collect all specRefs from items in this section, with context
            if (sectionId && onActiveSpecSections) {
              const section = data.sections.find((s) => s.id === sectionId);
              if (section) {
                const ctx: Record<string, SpecContextEntry[]> = {};
                for (const item of section.items) {
                  if (item.specRefs) {
                    for (const ref of item.specRefs) {
                      if (!ctx[ref.sectionId]) ctx[ref.sectionId] = [];
                      if (!ctx[ref.sectionId].some((e) => e.title === item.title)) {
                        ctx[ref.sectionId].push({ title: item.title, file: item.source.file });
                      }
                    }
                  }
                }
                const specIds = Object.keys(ctx);
                if (specIds.length > 0) {
                  onActiveSpecSections(specIds, ctx);
                }
              }
            }
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 }
    );

    sectionRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [data, onActiveSpecSections]);

  // Detect when inline nav scrolls out of view → show sticky nav
  useEffect(() => {
    if (!inlineNavRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => setShowStickyNav(!entry.isIntersecting),
      { threshold: 0 }
    );

    observer.observe(inlineNavRef.current);
    return () => observer.disconnect();
  }, [data]);

  const scrollToSection = useCallback((sectionId: string) => {
    const el = sectionRefs.current.get(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const registerSectionRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      sectionRefs.current.set(id, el);
    } else {
      sectionRefs.current.delete(id);
    }
  }, []);

  if (loading) {
    return (
      <div className="space-y-4 p-2">
        <SkeletonSection />
        <SkeletonSection />
        <SkeletonSection />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const nonEmptySections = data.sections.filter(
    (s) => s.items.length > 0 || s.id === "research-questions"
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-zinc-600">
            Last updated:{" "}
            {new Date(data.fetchedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-xs bg-surface-overlay text-zinc-400 hover:text-zinc-200 rounded-md border border-white/10 hover:border-white/20 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Inline section nav (clickable pills with counts) */}
      <div ref={inlineNavRef}>
        <SectionNav
          sections={data.sections}
          activeSectionId={activeSectionId}
          onNavigate={scrollToSection}
        />
      </div>

      {/* Sticky nav — slides in when inline nav scrolls out of view */}
      <div
        className={`sticky top-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2.5 bg-[#0a0a0f]/80 backdrop-blur-xl border-b border-white/5 transition-all duration-200 ${
          showStickyNav
            ? "opacity-100 translate-y-0"
            : "opacity-0 -translate-y-2 pointer-events-none"
        }`}
      >
        <SectionNav
          sections={data.sections}
          activeSectionId={activeSectionId}
          onNavigate={scrollToSection}
          variant="sticky"
        />
      </div>

      {/* Partial failure warnings */}
      {data.errors.length > 0 && (
        <div className="px-4 py-3 text-xs bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/20 space-y-1">
          <p className="font-medium">Some data sources could not be loaded:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {data.errors.map((err, i) => (
              <li key={i}>
                {err.source}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sections */}
      {nonEmptySections.length > 0 ? (
        <div className="space-y-6">
          {nonEmptySections.map((section) => (
            <div
              key={section.id}
              ref={(el) => registerSectionRef(section.id, el)}
              data-section-id={section.id}
              className="p-5 bg-surface-raised rounded-lg border border-white/5 scroll-mt-16"
            >
              <AgendaSectionCard
                section={section}
                expandedItemId={expandedItemId}
                activeItemId={activeItemId}
                onToggleItem={toggleItem}
                onAction={onAction}
                onSpecRefClick={onSpecRefClick}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="p-8 bg-surface-raised rounded-lg border border-white/5 text-center">
          <p className="text-sm text-zinc-400">
            Nothing needs your attention right now.
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            All governance items are resolved or up to date.
          </p>
        </div>
      )}
    </div>
  );
}
