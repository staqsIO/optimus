import type { SpecSection, SpecDomain, SpecDomainInfo, SpecDomainGroup, SpecStatus } from "@/components/workstation/types";

// Domain definitions — order matters for rendering
export const SPEC_DOMAINS: SpecDomainInfo[] = [
  { id: "foundations", color: "zinc", label: "Foundations" },
  { id: "runtime", color: "blue", label: "Runtime" },
  { id: "infrastructure", color: "teal", label: "Infrastructure" },
  { id: "governance", color: "amber", label: "Governance" },
  { id: "strategy", color: "purple", label: "Strategy" },
];

const DOMAIN_MAP = new Map(SPEC_DOMAINS.map((d) => [d.id, d]));

export function getDomainInfo(domain: SpecDomain): SpecDomainInfo {
  return DOMAIN_MAP.get(domain) || SPEC_DOMAINS[0];
}

/** Group sections by domain, preserving order within each group. */
export function groupByDomain(sections: SpecSection[]): SpecDomainGroup[] {
  const groups = new Map<SpecDomain, SpecSection[]>();
  for (const s of sections) {
    const d = s.domain || "foundations";
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(s);
  }
  return SPEC_DOMAINS
    .filter((d) => groups.has(d.id))
    .map((d) => ({ domain: d, sections: groups.get(d.id)! }));
}

/** Tailwind color classes per domain — left border, bg tint, text */
export const DOMAIN_COLORS: Record<string, {
  border: string;
  bg: string;
  text: string;
  ring: string;
  headerBg: string;
  dot: string;
}> = {
  zinc: {
    border: "border-l-zinc-500/50",
    bg: "bg-zinc-500/[0.06]",
    text: "text-zinc-400",
    ring: "ring-zinc-500/20",
    headerBg: "bg-zinc-500/10",
    dot: "bg-zinc-400",
  },
  blue: {
    border: "border-l-blue-500/50",
    bg: "bg-blue-500/[0.06]",
    text: "text-blue-400",
    ring: "ring-blue-500/20",
    headerBg: "bg-blue-500/10",
    dot: "bg-blue-400",
  },
  teal: {
    border: "border-l-teal-500/50",
    bg: "bg-teal-500/[0.06]",
    text: "text-teal-400",
    ring: "ring-teal-500/20",
    headerBg: "bg-teal-500/10",
    dot: "bg-teal-400",
  },
  amber: {
    border: "border-l-amber-500/50",
    bg: "bg-amber-500/[0.06]",
    text: "text-amber-400",
    ring: "ring-amber-500/20",
    headerBg: "bg-amber-500/10",
    dot: "bg-amber-400",
  },
  purple: {
    border: "border-l-purple-500/50",
    bg: "bg-purple-500/[0.06]",
    text: "text-purple-400",
    ring: "ring-purple-500/20",
    headerBg: "bg-purple-500/10",
    dot: "bg-purple-400",
  },
};

/** Status badge config */
export const STATUS_CONFIG: Record<SpecStatus, {
  border: string;
  badge?: string;
  badgeText?: string;
  icon?: string; // "count" | "spinner" | "check" | "avatar"
}> = {
  stable: { border: "border-l-transparent" },
  active: { border: "border-l-indigo-500/50", badge: "bg-indigo-500/15 text-indigo-400", icon: "count" },
  "has-proposal": { border: "border-l-green-500/50", badge: "bg-green-500/15 text-green-400", icon: "avatar" },
  "under-review": { border: "border-l-amber-500/50", badge: "bg-amber-500/15 text-amber-300", icon: "spinner" },
  "recently-updated": { border: "border-l-emerald-500/50", badge: "bg-emerald-500/15 text-emerald-400", icon: "check" },
};

/** Compute effective status from _index.yaml status + live agenda data */
export function computeEffectiveStatus(
  baseStatus: SpecStatus | undefined,
  agendaCount: number,
  hasProjection: boolean,
): SpecStatus {
  if (hasProjection) return "under-review";
  if (agendaCount > 0) return "active";
  return baseStatus || "stable";
}

/** Summary text for a domain group: "3 stable, 1 active" */
export function domainStatusSummary(sections: SpecSection[], activityMap: Map<string, { count: number }>): string {
  let stable = 0;
  let active = 0;
  for (const s of sections) {
    if (activityMap.has(s.id) || s.status === "active") active++;
    else stable++;
  }
  const parts: string[] = [];
  if (stable > 0) parts.push(`${stable} stable`);
  if (active > 0) parts.push(`${active} active`);
  return parts.join(", ");
}
