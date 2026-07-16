import type { FeedCard } from "../types";
import type {
  UnifiedFeedItem,
  FeedCardItem,
  AgentWorkItem,
  AgentWorkInProgressItem,
  GovernanceItem,
  ActivityStepItem,
  AgentIntentItem,
} from "./types";

const CARD_VERBS: Record<string, string> = {
  change: "requested a code change",
  answer: "asked a question",
  research: "started research",
  intake: "submitted to governance",
};

export function normalizeFeedCard(card: FeedCard): FeedCardItem {
  const isLoading = card.stage === "loading" || card.stage === "submitting";
  return {
    id: `fc-${card.id}`,
    timestamp: card.createdAt,
    actor: { type: "human", id: "board" },
    verb: isLoading ? `is ${card.type === "intake" ? "submitting" : "processing"}...` : (CARD_VERBS[card.type] || "acted"),
    requiresAction: false,
    boardRelevance: 90,
    source: "feed_card",
    card,
  };
}

export function normalizeCompletion(c: {
  id: string;
  title: string;
  type: string;
  agent: string;
  status: string;
  costUsd: number | null;
  completedAt: string;
  campaignGoal: string | null;
}): AgentWorkItem {
  return {
    id: `aw-${c.id}`,
    timestamp: new Date(c.completedAt).getTime(),
    actor: { type: "agent", id: c.agent },
    verb: `completed ${c.type?.replace(/_/g, " ") || "task"}: ${c.title}`,
    requiresAction: false,
    boardRelevance: 60,
    source: "agent_work",
    completion: c,
  };
}

export function normalizeInProgress(ip: {
  id: string;
  title: string;
  type: string;
  agent: string;
  status: string;
  updatedAt: string;
}): AgentWorkInProgressItem {
  return {
    id: `ip-${ip.id}`,
    timestamp: new Date(ip.updatedAt).getTime(),
    actor: { type: "agent", id: ip.agent },
    verb: `is working on: ${ip.title}`,
    requiresAction: false,
    boardRelevance: 40,
    source: "agent_work_ip",
    inProgress: ip,
  };
}

export function normalizeGovernance(g: {
  id: string;
  feed_type: string;
  title: string;
  summary: string;
  created_at: string;
  metadata: Record<string, unknown>;
  requires_action: boolean;
  board_relevance: number;
}): GovernanceItem {
  const verbMap: Record<string, string> = {
    draft_review: "drafted a reply",
    strategic_decision: "proposed a strategic decision",
    budget_warning: "flagged a budget warning",
    blocked_item: "flagged a blocked item",
    agent_intent: "proposed an action",
    intent_executed: "executed an approved action",
    learning_insight: "discovered a pattern",
    event: "logged an event",
  };
  return {
    id: `gov-${g.id}`,
    timestamp: new Date(g.created_at).getTime(),
    actor: { type: "agent", id: (g.metadata?.agent_id as string) || "system" },
    verb: verbMap[g.feed_type] || g.feed_type,
    requiresAction: g.requires_action,
    boardRelevance: g.board_relevance,
    source: "governance",
    item: {
      id: g.id,
      feed_type: g.feed_type,
      title: g.title,
      summary: g.summary,
      metadata: g.metadata,
      requires_action: g.requires_action,
    },
  };
}

export function normalizeActivityStep(s: {
  id: string;
  agent_id: string;
  step_type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  created_at: string;
  work_item_title: string | null;
}): ActivityStepItem {
  return {
    id: `as-${s.id}`,
    timestamp: new Date(s.created_at).getTime(),
    actor: { type: "agent", id: s.agent_id || "unknown" },
    verb: s.description || `${s.step_type || "step"} ${s.status || ""}`.trim(),
    requiresAction: false,
    boardRelevance: 20,
    source: "activity_step",
    step: {
      id: s.id,
      agent_id: s.agent_id,
      step_type: s.step_type,
      description: s.description,
      status: s.status,
      duration_ms: s.duration_ms,
      work_item_title: s.work_item_title,
    },
  };
}

export function normalizeIntent(i: {
  id: string;
  agent_id: string;
  intent_type: string;
  decision_tier: string;
  title: string;
  reasoning: string;
  status: string;
  created_at: string;
}): AgentIntentItem {
  // Shorter verb — title already shows in the card
  const tierLabel = i.decision_tier === "tactical" ? "" : `${i.decision_tier} `;
  return {
    id: `int-${i.id}`,
    timestamp: new Date(i.created_at).getTime(),
    actor: { type: "agent", id: i.agent_id },
    verb: `proposed ${tierLabel}action`,
    requiresAction: i.status === "pending",
    boardRelevance: i.decision_tier === "existential" ? 100 : i.decision_tier === "strategic" ? 80 : 60,
    source: "agent_intent",
    intent: {
      id: i.id,
      agent_id: i.agent_id,
      intent_type: i.intent_type,
      decision_tier: i.decision_tier,
      title: i.title,
      reasoning: i.reasoning,
      status: i.status,
    },
  };
}
