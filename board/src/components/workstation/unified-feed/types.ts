import type { FeedCard } from "../types";

/** Actor in the unified feed — either a human board member or an agent */
export interface FeedActor {
  type: "human" | "agent";
  id: string;
}

/** Base shape for all unified feed items */
interface UnifiedFeedItemBase {
  id: string;
  timestamp: number;
  actor: FeedActor;
  verb: string;
  requiresAction: boolean;
  boardRelevance: number;
}

/** Feed card from command bar (change, ask, research, intake) */
export interface FeedCardItem extends UnifiedFeedItemBase {
  source: "feed_card";
  card: FeedCard;
}

/** Completed agent work from /api/pipeline/completions */
export interface AgentWorkItem extends UnifiedFeedItemBase {
  source: "agent_work";
  completion: {
    id: string;
    title: string;
    type: string;
    agent: string;
    status: string;
    costUsd: number | null;
    completedAt: string;
    campaignGoal: string | null;
  };
}

/** In-progress agent work */
export interface AgentWorkInProgressItem extends UnifiedFeedItemBase {
  source: "agent_work_ip";
  inProgress: {
    id: string;
    title: string;
    type: string;
    agent: string;
    status: string;
    updatedAt: string;
  };
}

/** Governance feed event */
export interface GovernanceItem extends UnifiedFeedItemBase {
  source: "governance";
  item: {
    id: string;
    feed_type: string;
    title: string;
    summary: string;
    metadata: Record<string, unknown>;
    requires_action: boolean;
  };
}

/** Agent activity step from /api/activity */
export interface ActivityStepItem extends UnifiedFeedItemBase {
  source: "activity_step";
  step: {
    id: string;
    agent_id: string;
    step_type: string;
    description: string;
    status: string;
    duration_ms: number | null;
    work_item_title: string | null;
  };
}

/** Pending agent intent needing board action */
export interface AgentIntentItem extends UnifiedFeedItemBase {
  source: "agent_intent";
  intent: {
    id: string;
    agent_id: string;
    intent_type: string;
    decision_tier: string;
    title: string;
    reasoning: string;
    status: string;
  };
}

export type UnifiedFeedItem =
  | FeedCardItem
  | AgentWorkItem
  | AgentWorkInProgressItem
  | GovernanceItem
  | ActivityStepItem
  | AgentIntentItem;

export type FeedFilter = "all" | "attention" | "human" | "agent";
