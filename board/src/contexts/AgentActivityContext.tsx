"use client";

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useEventStream } from "@/hooks/useEventStream";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkItemStatus =
  | "created"
  | "assigned"
  | "in_progress"
  | "review"
  | "completed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "cancelled";

export type AgentTier =
  | "strategist"
  | "architect"
  | "orchestrator"
  | "reviewer"
  | "executor"
  | "utility"
  | "external"
  | "unknown";

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";

export interface GateResult {
  gate: GateId;
  passed: boolean;
  score: number; // 0–1
  reason?: string;
}

export interface AgentActivityEvent {
  id: string;
  workItemId: string;
  workItemTitle: string;
  workItemType: string;
  agentId: string;
  tier: AgentTier;
  fromState: WorkItemStatus | null;
  toState: WorkItemStatus;
  timestamp: string; // ISO
  reason: string | null;
  costUsd: number | null;
  gateResults: GateResult[];
  /** Derived: overall confidence across all gates */
  confidenceScore: number; // 0–1
}

export interface AgentActivityState {
  events: AgentActivityEvent[];
  /** keyed by workItemId — latest status only */
  liveStatuses: Record<string, WorkItemStatus>;
  /** Filter: show only events where all selected gates passed */
  gateFilter: GateId[];
  isLoaded: boolean;
}

// ── Gate metadata ──────────────────────────────────────────────────────────────

export const GATE_META: Record<GateId, { label: string; description: string }> = {
  G1: { label: "Financial", description: "$20/day LLM ceiling" },
  G2: { label: "Legal", description: "Commitment/contract scan" },
  G3: { label: "Reputational", description: "Tone match ≥ 0.80" },
  G4: { label: "Autonomy", description: "Autonomy level check" },
  G5: { label: "Reversibility", description: "Prefer drafts over sends" },
  G6: { label: "Stakeholder", description: "No spam/misleading content" },
  G7: { label: "Precedent", description: "Pricing/timeline/policy flag" },
};

export const ALL_GATES: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];

const MAX_EVENTS = 200; // virtualization threshold

// ── Confidence scoring ─────────────────────────────────────────────────────────

function deriveConfidence(guardrailJson: unknown): { score: number; gates: GateResult[] } {
  if (!guardrailJson || typeof guardrailJson !== "object") {
    return { score: 1, gates: [] };
  }

  const raw = guardrailJson as Record<string, unknown>;
  const gates: GateResult[] = [];

  for (const gateId of ALL_GATES) {
    const entry = raw[gateId] as Record<string, unknown> | undefined;
    if (!entry) continue;

    const passed = entry.passed === true || entry.status === "pass" || entry.status === "passed";
    // Normalize score: use provided score, or 1 if passed, 0 if failed
    const rawScore =
      typeof entry.score === "number"
        ? entry.score
        : typeof entry.confidence === "number"
          ? entry.confidence
          : passed
            ? 1
            : 0;

    gates.push({
      gate: gateId,
      passed,
      score: Math.max(0, Math.min(1, rawScore)),
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    });
  }

  if (gates.length === 0) return { score: 1, gates: [] };

  const avg = gates.reduce((sum, g) => sum + g.score, 0) / gates.length;
  return { score: Math.round(avg * 100) / 100, gates };
}

function inferTier(agentId: string): AgentTier {
  if (!agentId) return "unknown";
  const id = agentId.toLowerCase();
  if (id.includes("strategist")) return "strategist";
  if (id.includes("architect") || id.includes("claw-explorer")) return "architect";
  if (id.includes("orchestrator") || id.includes("claw-workshop") || id.includes("claw-campaign")) return "orchestrator";
  if (id.includes("reviewer")) return "reviewer";
  if (id.includes("executor") || id.includes("triage") || id.includes("intake") || id.includes("responder")) return "executor";
  if (id.includes("board-query") || id.includes("utility")) return "utility";
  if (id.includes("nemoclaw")) return "external";
  return "unknown";
}

// ── Reducer ────────────────────────────────────────────────────────────────────

type Action =
  | { type: "APPEND_EVENT"; event: AgentActivityEvent }
  | { type: "LOAD_HISTORY"; events: AgentActivityEvent[] }
  | { type: "SET_GATE_FILTER"; gates: GateId[] }
  | { type: "TOGGLE_GATE"; gate: GateId };

function reducer(state: AgentActivityState, action: Action): AgentActivityState {
  switch (action.type) {
    case "APPEND_EVENT": {
      const events = [action.event, ...state.events].slice(0, MAX_EVENTS);
      return {
        ...state,
        events,
        liveStatuses: {
          ...state.liveStatuses,
          [action.event.workItemId]: action.event.toState,
        },
      };
    }
    case "LOAD_HISTORY": {
      const liveStatuses: Record<string, WorkItemStatus> = {};
      for (const e of action.events) {
        liveStatuses[e.workItemId] = e.toState;
      }
      return { ...state, events: action.events.slice(0, MAX_EVENTS), liveStatuses, isLoaded: true };
    }
    case "SET_GATE_FILTER":
      return { ...state, gateFilter: action.gates };
    case "TOGGLE_GATE": {
      const has = state.gateFilter.includes(action.gate);
      const gateFilter = has
        ? state.gateFilter.filter((g) => g !== action.gate)
        : [...state.gateFilter, action.gate];
      return { ...state, gateFilter };
    }
    default:
      return state;
  }
}

const initialState: AgentActivityState = {
  events: [],
  liveStatuses: {},
  gateFilter: [],
  isLoaded: false,
};

// ── Context ────────────────────────────────────────────────────────────────────

interface AgentActivityContextValue {
  state: AgentActivityState;
  toggleGate: (gate: GateId) => void;
  setGateFilter: (gates: GateId[]) => void;
  /** Filtered events: only show items where any active gate filter passes */
  filteredEvents: AgentActivityEvent[];
}

const AgentActivityContext = createContext<AgentActivityContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────────

interface Props {
  children: ReactNode;
}

export function AgentActivityProvider({ children }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const loadedRef = useRef(false);

  // Load recent history on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    async function load() {
      try {
        const res = await fetch("/api/debug/pipeline");
        if (!res.ok) return;
        const data = await res.json();

        const transitions: Array<Record<string, unknown>> = data.transitions || [];
        const workItems: Array<Record<string, unknown>> = data.work_items || [];

        const itemMap = new Map(workItems.map((w) => [w.id as string, w]));

        const events: AgentActivityEvent[] = transitions
          .slice(0, MAX_EVENTS)
          .map((t) => {
            const item = itemMap.get(t.work_item_id as string);
            const { score, gates } = deriveConfidence(t.guardrail_checks_json);
            return {
              id: t.id as string,
              workItemId: t.work_item_id as string,
              workItemTitle: (item?.title as string) || (t.work_item_id as string),
              workItemType: (item?.type as string) || "task",
              agentId: (t.agent_id as string) || "unknown",
              tier: inferTier((t.agent_id as string) || ""),
              fromState: (t.from_state as WorkItemStatus) || null,
              toState: (t.to_state as WorkItemStatus) || "created",
              timestamp: (t.created_at as string) || new Date().toISOString(),
              reason: (t.reason as string) || null,
              costUsd: typeof t.cost_usd === "number" ? t.cost_usd : null,
              gateResults: gates,
              confidenceScore: score,
            };
          });

        dispatch({ type: "LOAD_HISTORY", events });
      } catch {
        dispatch({ type: "LOAD_HISTORY", events: [] });
      }
    }

    load();
  }, []);

  // SSE-driven live updates
  useEventStream(
    "state_changed",
    useCallback(
      (event) => {
        const e = event as Record<string, unknown>;
        const { score, gates } = deriveConfidence(e.guardrail_checks_json);

        const activity: AgentActivityEvent = {
          id: (e.transition_id as string) || `live-${Date.now()}`,
          workItemId: (e.work_item_id as string) || "",
          workItemTitle: (e.title as string) || (e.work_item_id as string) || "Unknown",
          workItemType: (e.item_type as string) || "task",
          agentId: (e.agent_id as string) || "unknown",
          tier: inferTier((e.agent_id as string) || ""),
          fromState: (e.from_state as WorkItemStatus) || null,
          toState: (e.to_state as WorkItemStatus) || "created",
          timestamp: new Date().toISOString(),
          reason: (e.reason as string) || null,
          costUsd: typeof e.cost_usd === "number" ? e.cost_usd : null,
          gateResults: gates,
          confidenceScore: score,
        };

        dispatch({ type: "APPEND_EVENT", event: activity });
      },
      [],
    ),
  );

  const toggleGate = useCallback((gate: GateId) => {
    dispatch({ type: "TOGGLE_GATE", gate });
  }, []);

  const setGateFilter = useCallback((gates: GateId[]) => {
    dispatch({ type: "SET_GATE_FILTER", gates });
  }, []);

  // Apply gate filter: show events that pass ALL active gate filters
  const filteredEvents =
    state.gateFilter.length === 0
      ? state.events
      : state.events.filter((ev) => {
          for (const gateId of state.gateFilter) {
            const result = ev.gateResults.find((g) => g.gate === gateId);
            if (!result || !result.passed) return false;
          }
          return true;
        });

  return (
    <AgentActivityContext.Provider value={{ state, toggleGate, setGateFilter, filteredEvents }}>
      {children}
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity() {
  const ctx = useContext(AgentActivityContext);
  if (!ctx) throw new Error("useAgentActivity must be used inside <AgentActivityProvider>");
  return ctx;
}
