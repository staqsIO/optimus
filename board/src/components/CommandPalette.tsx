"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRecentPages } from "@/hooks/useRecentPages";
import { getAllowedPages, NAV_ICONS, type PageEntry } from "@/lib/nav-config";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { opsFetch } from "@/lib/ops-api";

interface AgentResult {
  id: string;
  name: string;
  tier?: string;
}

interface SearchResult {
  id: string;
  label: string;
  href: string;
  group: string;
  icon?: React.ReactNode;
  score: number;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [agents, setAgents] = useState<AgentResult[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { role } = useCurrentUser();
  const { recentPages } = useRecentPages();

  const allowedPages = useMemo(() => getAllowedPages(role), [role]);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Focus input on open, reset state
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Fetch agents lazily on first open
      if (agents === null) {
        opsFetch<{ agents: AgentResult[] }>("/api/agents").then((data) => {
          setAgents(data?.agents || []);
        });
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build results
  const results = useMemo(() => {
    const items: SearchResult[] = [];

    // Recent pages (only when no query)
    if (!query && recentPages.length > 0) {
      for (const slug of recentPages) {
        const page = allowedPages.find((p) => p.slug === slug);
        if (page) {
          items.push({
            id: `recent-${slug}`,
            label: page.label,
            href: `/${slug}`,
            group: "Recent",
            icon: NAV_ICONS[slug],
            score: 200, // always on top
          });
        }
      }
    }

    // Pages
    for (const page of allowedPages) {
      // Skip if already in recent (no query mode)
      if (!query && items.some((i) => i.id === `recent-${page.slug}`)) continue;

      const score = query
        ? fuzzyMatch(query, page.label, page.keywords)
        : 1;

      if (score > 0) {
        items.push({
          id: `page-${page.slug}`,
          label: page.label,
          href: `/${page.slug}`,
          group: query ? "Pages" : page.group,
          icon: NAV_ICONS[page.slug],
          score: query ? score : 1,
        });
      }
    }

    // Agents (when searching)
    if (query && agents) {
      for (const agent of agents) {
        const score = fuzzyMatch(query, agent.name);
        if (score > 0) {
          items.push({
            id: `agent-${agent.id}`,
            label: agent.name,
            href: `/agents/${agent.id}`,
            group: "Agents",
            icon: NAV_ICONS.agents,
            score,
          });
        }
      }
    }

    // Sort by score descending, then alphabetically
    items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

    return items;
  }, [query, allowedPages, recentPages, agents]);

  // Group results for rendering
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    const order: string[] = [];
    for (const item of results) {
      if (!map.has(item.group)) {
        map.set(item.group, []);
        order.push(item.group);
      }
      map.get(item.group)!.push(item);
    }
    return order.map((group) => ({ group, items: map.get(group)! }));
  }, [results]);

  const flatResults = results;

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (flatResults[selectedIndex]) {
            router.push(flatResults[selectedIndex].href);
            setOpen(false);
          }
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [flatResults, selectedIndex, router],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
          <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, agents..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-white/5 border border-white/10 text-zinc-600 font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2">
          {flatResults.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-600">
              No results found
            </div>
          ) : (
            grouped.map(({ group, items }) => (
              <div key={group}>
                <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">
                  {group}
                </div>
                {items.map((item) => {
                  flatIndex++;
                  const idx = flatIndex;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      onClick={() => {
                        router.push(item.href);
                        setOpen(false);
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        isSelected
                          ? "bg-white/10 text-zinc-100"
                          : "text-zinc-400 hover:bg-white/5"
                      }`}
                    >
                      <span className="shrink-0 text-zinc-500">{item.icon}</span>
                      <span className="truncate">{item.label}</span>
                      {query && (
                        <span className="ml-auto text-[10px] text-zinc-600 shrink-0">
                          {item.group}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/5 text-[10px] text-zinc-600">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 font-mono">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 font-mono">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 font-mono">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
