/* ───────── Intent-Based Labels ─────────
 * Maps technical signal/tool identifiers to human-readable intent labels.
 * Central to the Delphi design principle: intent-based, not implementation-based.
 */

export const SIGNAL_LABELS: Record<string, { label: string; icon: string; category: string }> = {
  "email.received":     { label: "When a new email arrives",         icon: "mail",     category: "Input" },
  "email.classified":   { label: "When an email is classified",      icon: "tag",      category: "Internal" },
  "slack.message":      { label: "When a Slack message arrives",     icon: "message",  category: "Input" },
  "webhook.payload":    { label: "When a webhook fires",             icon: "zap",      category: "Input" },
  "telegram.message":   { label: "When a Telegram message arrives",  icon: "message",  category: "Input" },
  "campaign.completed": { label: "When a campaign finishes",         icon: "check",    category: "Internal" },
  "campaign.step":      { label: "When a campaign step completes",   icon: "step",     category: "Internal" },
  "task.completed":     { label: "When a task completes",            icon: "check",    category: "Internal" },
  "task.failed":        { label: "When a task fails",                icon: "alert",    category: "Internal" },
  "draft.approved":     { label: "When a draft is approved",         icon: "thumb-up", category: "Internal" },
  "gate.failed":        { label: "When a gate check fails",          icon: "shield",   category: "Internal" },
  "schedule.fired":     { label: "When a scheduled trigger fires",   icon: "clock",    category: "Internal" },
};

export const TOOL_LABELS: Record<string, { label: string; category: string }> = {
  gmail_poll:       { label: "Poll Gmail for new messages",        category: "Email" },
  gmail_fetch:      { label: "Fetch email content",                category: "Email" },
  task_create:      { label: "Create a new task",                  category: "Tasks" },
  task_assign:      { label: "Assign a task to an agent",          category: "Tasks" },
  task_update:      { label: "Update a task",                      category: "Tasks" },
  task_read:        { label: "Read a task",                        category: "Tasks" },
  voice_query:      { label: "Look up voice profile",              category: "Voice" },
  signal_extract:   { label: "Extract signals from content",       category: "Signals" },
  signal_query:     { label: "Query signals and deadlines",        category: "Signals" },
  draft_create:     { label: "Create a draft reply",               category: "Drafts" },
  draft_read:       { label: "Read a draft",                       category: "Drafts" },
  gate_check:       { label: "Run safety gate checks",             category: "Governance" },
  stats_query:      { label: "Query system stats",                 category: "Stats" },
  briefing_create:  { label: "Store a generated briefing",         category: "Briefings" },
  // Agent-dispatch tools
  classify_message: { label: "Classify a message",                 category: "Agents" },
  compose_reply:    { label: "Compose a voice-matched reply",      category: "Agents" },
  create_ticket:    { label: "Create a ticket from feedback",      category: "Agents" },
  research_analyze: { label: "Run research or gap analysis",       category: "Agents" },
  score_priority:   { label: "Score priority and strategy",        category: "Agents" },
  // Flow-native agents (declarative single-shot)
  summarize:        { label: "Summarize text",                     category: "Flow Agents" },
  classify_text:    { label: "Classify text",                      category: "Flow Agents" },
  extract_entities: { label: "Extract entities from text",         category: "Flow Agents" },
  rewrite_tone:     { label: "Rewrite text in a target tone",      category: "Flow Agents" },
  // Flow-native utility tools (pure functions, no LLM)
  json_pick:        { label: "Pick fields from an object",         category: "Data" },
  condition_check:  { label: "Check a condition",                  category: "Logic" },
  html_to_text:     { label: "Strip HTML to plain text",           category: "Data" },
  list_filter:      { label: "Filter a list by a field condition", category: "Logic" },
};

/** Get intent label for a signal type, falling back to formatted raw ID. */
export function getSignalLabel(signalType: string): string {
  return SIGNAL_LABELS[signalType]?.label
    ?? signalType.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Get intent label for a tool ID, falling back to formatted raw ID. */
export function getToolLabel(toolId: string): string {
  return TOOL_LABELS[toolId]?.label
    ?? toolId.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ───────── Auto-Wiring ─────────
 * Given a tool's required parameters and available upstream fields
 * (trigger payload + previous step outputs), compute auto-wire matches.
 */

export interface WireSource {
  field: string;
  from: "trigger" | `step${number}`;
  fromLabel: string;  // e.g. "trigger.provider_msg_id" or "step1.body"
}

/**
 * For each parameter in a tool, find the best matching upstream field.
 * Returns a map of paramName → WireSource (or undefined if no match).
 *
 * Match priority: exact name match in most recent source first (step N, step N-1, ..., trigger).
 */
export function computeAutoWires(
  toolParams: Record<string, unknown>,
  triggerSchema: Record<string, string> | undefined,
  previousStepOutputs: { stepIndex: number; toolId: string; outputSchema: Record<string, string> }[],
): Record<string, WireSource | undefined> {
  const wires: Record<string, WireSource | undefined> = {};

  // Build ordered list of available field sources (most recent first)
  const sources: { fields: string[]; from: WireSource["from"]; label: string }[] = [];

  // Previous steps (reverse order — most recent output first)
  for (let i = previousStepOutputs.length - 1; i >= 0; i--) {
    const step = previousStepOutputs[i];
    sources.push({
      fields: Object.keys(step.outputSchema),
      from: `step${step.stepIndex + 1}` as WireSource["from"],
      label: `step${step.stepIndex + 1}`,
    });
  }

  // Trigger payload (lowest priority)
  if (triggerSchema) {
    sources.push({
      fields: Object.keys(triggerSchema),
      from: "trigger",
      label: "trigger",
    });
  }

  for (const paramName of Object.keys(toolParams)) {
    // Look for exact name match across sources
    for (const source of sources) {
      if (source.fields.includes(paramName)) {
        wires[paramName] = {
          field: paramName,
          from: source.from,
          fromLabel: `${source.label}.${paramName}`,
        };
        break;
      }
    }
    if (!wires[paramName]) {
      wires[paramName] = undefined;
    }
  }

  return wires;
}

/* ───────── Template rehydration ─────────
 * A config value saved as a pure {{source.field}} string is a wire,
 * regardless of whether auto-wire would have produced it. Parse it back
 * into a WireSource for UI rendering.
 */

const PURE_TEMPLATE_RE = /^\{\{(trigger|step\d+)\.(\w+)\}\}$/;

export function parseWireTemplate(value: string | undefined): WireSource | null {
  if (!value) return null;
  const m = value.match(PURE_TEMPLATE_RE);
  if (!m) return null;
  const [, from, field] = m;
  return { field, from: from as WireSource["from"], fromLabel: `${from}.${field}` };
}

/* ───────── Type compatibility ─────────
 * When the operator picks a field to wire, hide fields whose type is
 * clearly wrong, and flag borderline matches with a warning.
 */

export type Compatibility = "exact" | "warn" | "hidden";

function normalizeType(t: string | undefined): string {
  return (t ?? "").toLowerCase().trim();
}

const PRIMITIVES = new Set(["string", "number", "boolean"]);

/**
 * paramType — the tool parameter's declared type (the "slot")
 * sourceType — the upstream field's declared type (the "plug")
 */
export function fieldCompatibility(paramType: string | undefined, sourceType: string | undefined): Compatibility {
  const p = normalizeType(paramType);
  const s = normalizeType(sourceType);

  // Param is array/object — only show matching source types (arrays for arrays, objects for objects).
  if (p === "array") return s === "array" ? "exact" : "hidden";
  if (p === "object") return s === "object" ? "exact" : "hidden";

  // Param is a primitive (or any). Array/object sources into primitives are hidden.
  if (s === "array" || s === "object") return "hidden";

  // Unknown type on either side → warn-but-allow.
  if (!p || p === "any" || !s) return "warn";

  // Exact primitive match.
  if (p === s) return "exact";

  // Cross-primitive: selectable but flagged (e.g. string → number).
  if (PRIMITIVES.has(p) && PRIMITIVES.has(s)) return "warn";

  return "warn";
}

/** Sample payloads for dry-run testing, keyed by signal type. */
export const SAMPLE_PAYLOADS: Record<string, object> = {
  "email.received": {
    from: "sender@example.com",
    subject: "Sample Subject",
    snippet: "This is a sample email body for testing...",
    provider_msg_id: "sample-msg-001",
  },
  "slack.message": {
    channel: "#general",
    user: "U12345",
    text: "Sample Slack message for testing",
  },
  "webhook.payload": {
    source: "external-service",
    event: "trigger",
    data: { key: "value" },
  },
  "campaign.completed": {
    campaign_id: "sample-campaign-001",
    iterations: 5,
    status: "completed",
  },
  "task.completed": {
    work_item_id: "sample-task-001",
    agent_id: "executor-intake",
    result: "classified",
  },
};
