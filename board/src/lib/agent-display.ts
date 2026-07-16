/**
 * Shared agent display utility — single source of truth for agent visual identity.
 * No persona names. Functional IDs everywhere.
 */

export interface AgentDisplay {
  displayName: string;
  initials: string;
  color: string;
  textColor: string;
}

/** Static color map for all known agents, keyed by agent ID */
const AGENT_COLORS: Record<string, { color: string; textColor: string }> = {
  orchestrator:        { color: "bg-blue-500",   textColor: "text-blue-400" },
  strategist:          { color: "bg-purple-500",  textColor: "text-purple-400" },
  "executor-triage":   { color: "bg-teal-500",   textColor: "text-teal-400" },
  "executor-intake":   { color: "bg-teal-500",   textColor: "text-teal-400" },
  "executor-responder":{ color: "bg-amber-500",  textColor: "text-amber-400" },
  reviewer:            { color: "bg-emerald-500", textColor: "text-emerald-400" },
  architect:           { color: "bg-indigo-500",  textColor: "text-indigo-400" },
  "executor-ticket":   { color: "bg-orange-500",  textColor: "text-orange-400" },
  "executor-coder":    { color: "bg-cyan-500",   textColor: "text-cyan-400" },
  "executor-research": { color: "bg-pink-500",   textColor: "text-pink-400" },
  "executor-redesign": { color: "bg-rose-500",   textColor: "text-rose-400" },
  "executor-blueprint":{ color: "bg-violet-500",  textColor: "text-violet-400" },
  "claw-explorer":     { color: "bg-lime-500",   textColor: "text-lime-400" },
  "claw-campaigner":   { color: "bg-purple-500",  textColor: "text-purple-400" },
  "claw-workshop":     { color: "bg-indigo-500",  textColor: "text-indigo-400" },
  "board-query":       { color: "bg-zinc-500",   textColor: "text-zinc-400" },
  board:               { color: "bg-accent",     textColor: "text-accent-bright" },
};

/** Deterministic color for unknown agent IDs */
function hashColor(id: string): { color: string; textColor: string } {
  const colors = [
    { color: "bg-sky-500",    textColor: "text-sky-400" },
    { color: "bg-fuchsia-500", textColor: "text-fuchsia-400" },
    { color: "bg-yellow-500",  textColor: "text-yellow-400" },
    { color: "bg-red-500",    textColor: "text-red-400" },
    { color: "bg-green-500",  textColor: "text-green-400" },
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Convert agent ID to display name.
 * "executor-triage" -> "Executor Triage"
 * "claw-campaigner" -> "Claw Campaigner"
 */
export function formatAgentId(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Get initials from agent ID.
 * "executor-triage" -> "ET"
 * "claw-campaigner" -> "CC"
 */
export function getInitials(id: string): string {
  const parts = id.split("-");
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return id.slice(0, 2).toUpperCase();
}

/** Full display bundle for an agent */
export function getAgentDisplay(id: string): AgentDisplay {
  const colors = AGENT_COLORS[id] || hashColor(id);
  return {
    displayName: formatAgentId(id),
    initials: getInitials(id),
    ...colors,
  };
}

/**
 * Format a model string to a human-readable label.
 * "deepseek/deepseek-chat-v3-0324" -> "DeepSeek v3"
 * "claude-sonnet-4-6"              -> "Claude Sonnet"
 * "claude-haiku-4-5-20251001"      -> "Claude Haiku"
 * "google/gemini-2.5-pro"          -> "Gemini 2.5 Pro"
 */
export function formatModelLabel(model: string): string {
  if (!model) return "Unknown";
  const m = model.toLowerCase();

  // DeepSeek
  if (m.includes("deepseek")) {
    if (m.includes("v3")) return "DeepSeek v3";
    return "DeepSeek";
  }

  // Gemini
  if (m.includes("gemini")) {
    const match = m.match(/gemini[- ]?([\d.]+)[- ]?(pro|flash|ultra)?/);
    if (match) {
      const ver = match[1];
      const variant = match[2] ? ` ${match[2].charAt(0).toUpperCase() + match[2].slice(1)}` : "";
      return `Gemini ${ver}${variant}`;
    }
    return "Gemini";
  }

  // Claude
  if (m.includes("claude")) {
    if (m.includes("opus")) return "Claude Opus";
    if (m.includes("sonnet")) return "Claude Sonnet";
    if (m.includes("haiku")) return "Claude Haiku";
    return "Claude";
  }

  // GPT
  if (m.includes("gpt-4o")) return "GPT-4o";
  if (m.includes("gpt-4")) return "GPT-4";
  if (m.includes("gpt")) return "GPT";

  // Fallback: strip provider prefix, return as-is
  const stripped = model.includes("/") ? model.split("/").pop()! : model;
  return stripped;
}
