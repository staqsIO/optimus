"use client";

/**
 * KG node renderers for the Knowledge Graph Tier 1 entity-lens view (OPT-80).
 *
 * Three node types:
 *   kg-person       — circle, indigo ring, initials monogram
 *   kg-organization — rounded rect, violet ring, building glyph
 *   kg-topic        — pill, amber ring, tag glyph
 *
 * Visual encoding follows spec §2:
 *   - Focused entity: ring-width 3px, scale 1.25
 *   - New-in-7d badge: emerald SVG dot (aria-label="new in last 7 days")
 *   - All shapes use zinc-800 fill
 */

import { type NodeProps, Handle, Position } from "@xyflow/react";

export interface KGNodeData {
  label: string;
  initials?: string;
  recentActivity: boolean;
  focused: boolean;
  entityType: "person" | "organization" | "topic";
  [key: string]: unknown;
}

// ── Shared badge ─────────────────────────────────────────────────────────────

function NewBadge() {
  return (
    <svg
      className="absolute -top-1 -right-1 pointer-events-none"
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-label="new in last 7 days"
      role="img"
    >
      <circle cx="4" cy="4" r="4" fill="#10b981" />
    </svg>
  );
}

// ── Shared handles ────────────────────────────────────────────────────────────

function KGHandles() {
  return (
    <>
      <Handle type="source" position={Position.Right} className="!bg-zinc-600 !w-1.5 !h-1.5 !border-0" />
      <Handle type="target" position={Position.Left} className="!bg-zinc-600 !w-1.5 !h-1.5 !border-0" />
    </>
  );
}

// ── Person node ───────────────────────────────────────────────────────────────

export function KGPersonNode({ data, selected }: NodeProps) {
  const d = data as KGNodeData;
  const focused = d.focused;
  const ringWidth = focused ? "ring-[3px]" : "ring-1";
  const scale = focused ? "scale-125" : "scale-100";
  const label = d.label ?? "";
  const initials =
    d.initials ||
    label
      .split(" ")
      .slice(0, 2)
      .map((w: string) => w[0]?.toUpperCase() ?? "")
      .join("");

  return (
    <div
      className={`relative flex flex-col items-center gap-1 transition-transform duration-200 ${scale}`}
      role="button"
      aria-label={`Person: ${label}`}
      aria-pressed={selected}
    >
      <KGHandles />
      <div
        className={`w-10 h-10 rounded-full bg-zinc-800 ${ringWidth} ring-indigo-500 flex items-center justify-center cursor-pointer hover:ring-indigo-400 transition-shadow`}
      >
        <span className="text-xs font-semibold text-zinc-200 select-none">
          {initials}
        </span>
        {d.recentActivity && <NewBadge />}
      </div>
      <span className="text-[9px] text-zinc-400 max-w-[72px] truncate text-center select-none">
        {label}
      </span>
    </div>
  );
}

// ── Organization node ─────────────────────────────────────────────────────────

function BuildingIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-zinc-300"
      aria-hidden="true"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

export function KGOrganizationNode({ data, selected }: NodeProps) {
  const d = data as KGNodeData;
  const focused = d.focused;
  const ringWidth = focused ? "ring-[3px]" : "ring-1";
  const scale = focused ? "scale-125" : "scale-100";
  const label = d.label ?? "";

  return (
    <div
      className={`relative flex flex-col items-center gap-1 transition-transform duration-200 ${scale}`}
      role="button"
      aria-label={`Organization: ${label}`}
      aria-pressed={selected}
    >
      <KGHandles />
      <div
        className={`w-12 h-9 rounded-lg bg-zinc-800 ${ringWidth} ring-violet-500 flex items-center justify-center cursor-pointer hover:ring-violet-400 transition-shadow relative`}
      >
        <BuildingIcon />
        {d.recentActivity && <NewBadge />}
      </div>
      <span className="text-[9px] text-zinc-400 max-w-[72px] truncate text-center select-none">
        {label}
      </span>
    </div>
  );
}

// ── Topic node ────────────────────────────────────────────────────────────────

function TagIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-zinc-300"
      aria-hidden="true"
    >
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

export function KGTopicNode({ data, selected }: NodeProps) {
  const d = data as KGNodeData;
  const focused = d.focused;
  const ringWidth = focused ? "ring-[3px]" : "ring-1";
  const scale = focused ? "scale-125" : "scale-100";
  const label = d.label ?? "";

  return (
    <div
      className={`relative flex flex-col items-center gap-1 transition-transform duration-200 ${scale}`}
      role="button"
      aria-label={`Topic: ${label}`}
      aria-pressed={selected}
    >
      <KGHandles />
      <div
        className={`px-3 py-1.5 rounded-full bg-zinc-800 ${ringWidth} ring-amber-500 flex items-center gap-1.5 cursor-pointer hover:ring-amber-400 transition-shadow relative`}
      >
        <TagIcon />
        <span className="text-[9px] font-medium text-zinc-300 max-w-[60px] truncate select-none">
          {label}
        </span>
        {d.recentActivity && <NewBadge />}
      </div>
    </div>
  );
}

// ── nodeTypes map ─────────────────────────────────────────────────────────────

export const kgNodeTypes = {
  "kg-person": KGPersonNode,
  "kg-organization": KGOrganizationNode,
  "kg-topic": KGTopicNode,
};
