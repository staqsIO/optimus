"use client";

/**
 * EntityInspectorPanel — Tier 1 Knowledge Graph inspector (OPT-80)
 *
 * Cloned from InspectorPanel.tsx (system graph) and adapted for entity-lens
 * data. Props mirror the spec: `{ entity: EntityNode; onClose: () => void }`.
 *
 * Extension slot: the bottom of the panel has a `<div id="kg-inspector-ext">`
 * for Tier 2–4 overlays (live agent, provenance subgraph, time scrub).
 */

import Link from "next/link";

export interface EntityNode {
  id: string;
  type: "person" | "organization" | "topic";
  label: string;
  data: {
    initials?: string;
    recentActivity: boolean;
  };
}

export interface InspectorBundle {
  summary: string | null;
  threads: { subject: string; threadId: string; age: string }[];
  connections: { id: string; label: string; strength: number }[];
}

interface Props {
  entity: EntityNode;
  inspector: InspectorBundle;
  onClose: () => void;
}

const TYPE_RING: Record<string, string> = {
  person: "ring-indigo-500",
  organization: "ring-violet-500",
  topic: "ring-amber-500",
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  person: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  organization: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  topic: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  ),
};

function formatAge(age: string): string {
  if (!age) return "";
  try {
    const d = new Date(age);
    if (isNaN(d.getTime())) return age;
    const diffMs = Date.now() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "1d ago";
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths}mo ago`;
  } catch {
    return age;
  }
}

function StrengthBar({ strength }: { strength: number }) {
  // Normalise to 1–5 range for display
  const bars = Math.min(5, Math.max(1, Math.round(strength)));
  return (
    <div className="flex gap-0.5 items-center" aria-label={`Strength: ${bars} of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 w-2.5 rounded-full ${i < bars ? "bg-indigo-500" : "bg-zinc-700"}`}
        />
      ))}
    </div>
  );
}

export default function EntityInspectorPanel({ entity, inspector, onClose }: Props) {
  const ringClass = TYPE_RING[entity.type] || "ring-zinc-500";
  const icon = TYPE_ICON[entity.type];

  return (
    <div
      className="w-full h-full flex flex-col bg-surface border-l border-white/10 overflow-y-auto"
      role="complementary"
      aria-label={`Inspector: ${entity.label}`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4 border-b border-white/10 flex-shrink-0">
        {/* Entity avatar */}
        <div
          className={`w-10 h-10 rounded-full bg-zinc-800 ring-2 ${ringClass} flex items-center justify-center flex-shrink-0 relative`}
        >
          {entity.data.initials ? (
            <span className="text-xs font-semibold text-zinc-200">
              {entity.data.initials}
            </span>
          ) : (
            <span className="text-zinc-400">{icon}</span>
          )}
          {entity.data.recentActivity && (
            <svg
              className="absolute -top-0.5 -right-0.5"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              aria-label="new in last 7 days"
            >
              <circle cx="4" cy="4" r="4" fill="#10b981" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-zinc-100 truncate">
            {entity.label}
          </div>
          <div className="text-[10px] text-zinc-500 capitalize mt-0.5">
            {entity.type}
          </div>
        </div>

        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
          aria-label="Close inspector"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="1" y1="1" x2="13" y2="13" />
            <line x1="13" y1="1" x2="1" y2="13" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
        {/* Summary / fallback CTA */}
        <section aria-labelledby="kg-summary-heading">
          <h3
            id="kg-summary-heading"
            className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2"
          >
            Summary
          </h3>
          {inspector.summary ? (
            <p className="text-xs text-zinc-300 leading-relaxed">
              {inspector.summary}
            </p>
          ) : (
            <div className="rounded-md bg-zinc-800/60 border border-white/5 p-3">
              <p className="text-xs text-zinc-400 mb-2">
                No summary available yet.
              </p>
              <Link
                href="/workstation"
                className="text-xs text-indigo-400 hover:text-indigo-300 underline-offset-2 hover:underline transition-colors"
              >
                Ask Optimus about {entity.label} →
              </Link>
            </div>
          )}
        </section>

        {/* Recent threads */}
        {inspector.threads.length > 0 && (
          <section aria-labelledby="kg-threads-heading">
            <h3
              id="kg-threads-heading"
              className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Recent Threads
            </h3>
            <ul className="flex flex-col gap-1.5">
              {inspector.threads.map((t, i) => (
                <li key={t.threadId || i}>
                  <Link
                    href={t.threadId ? `/inbox?thread=${t.threadId}` : "#"}
                    className="group flex items-start justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white/5 transition-colors"
                  >
                    <span className="text-xs text-zinc-300 group-hover:text-zinc-100 truncate transition-colors">
                      {t.subject}
                    </span>
                    <span className="text-[10px] text-zinc-600 flex-shrink-0 mt-0.5">
                      {formatAge(t.age)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Top connections */}
        {inspector.connections.length > 0 && (
          <section aria-labelledby="kg-connections-heading">
            <h3
              id="kg-connections-heading"
              className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2"
            >
              Top Connections
            </h3>
            <ul className="flex flex-col gap-2">
              {inspector.connections.map((conn) => (
                <li
                  key={conn.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-xs text-zinc-300 truncate">
                    {conn.label}
                  </span>
                  <StrengthBar strength={conn.strength} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Extension slot — Tier 2–4 overlays attach here */}
        <div id="kg-inspector-ext" />
      </div>
    </div>
  );
}
