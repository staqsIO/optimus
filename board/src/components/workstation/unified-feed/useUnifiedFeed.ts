"use client";

import { useMemo } from "react";
import type { FeedCard } from "../types";
import type { UnifiedFeedItem } from "./types";
import { useAgentWork } from "../useAgentWork";
import { useGovernanceFeedData } from "./useGovernanceFeedData";
import { useActivitySteps } from "./useActivitySteps";
import { useIntents } from "../useIntents";
import {
  normalizeFeedCard,
  normalizeCompletion,
  normalizeInProgress,
  normalizeGovernance,
  normalizeActivityStep,
  normalizeIntent,
} from "./normalizers";

export function useUnifiedFeed(feedCards: FeedCard[]) {
  const agentWork = useAgentWork();
  const governance = useGovernanceFeedData();
  const activity = useActivitySteps(30);
  const intents = useIntents();

  const items = useMemo(() => {
    const all: UnifiedFeedItem[] = [
      // User-submitted cards — always included
      ...feedCards.map(normalizeFeedCard),

      // Completed agent work
      ...(agentWork.completions || []).map((c) =>
        normalizeCompletion({
          id: c.id,
          title: c.title,
          type: c.type,
          agent: c.agent,
          status: c.status,
          costUsd: c.costUsd,
          completedAt: c.completedAt,
          campaignGoal: c.campaignGoal,
        })
      ),

      // In-progress agent work
      ...(agentWork.inProgress || []).map((ip) =>
        normalizeInProgress({
          id: ip.id,
          title: ip.title,
          type: ip.type,
          agent: ip.agent,
          status: ip.status,
          updatedAt: ip.updatedAt,
        })
      ),

      // Governance events (board-relevant only)
      ...(governance.items || [])
        .filter((g) => g.board_relevance >= 50)
        .map(normalizeGovernance),

      // Agent activity steps (filtered to meaningful types)
      ...(activity.steps || []).slice(0, 20).map(normalizeActivityStep),

      // Pending intents needing board action (exclude stale — older than 24h)
      ...(intents.intents || [])
        .filter((i) => {
          if (i.status !== "pending") return false;
          // Expire intents older than 24h — they're stale if not acted on
          const age = Date.now() - new Date(i.created_at).getTime();
          if (age > 24 * 60 * 60 * 1000) return false;
          // Skip expired intents
          if (i.expires_at && new Date(i.expires_at).getTime() < Date.now()) return false;
          return true;
        })
        .map((i) => normalizeIntent({ ...i, created_at: i.created_at })),
    ];

    // Sort: attention items first, then reverse chronological
    return all.sort((a, b) => {
      if (a.requiresAction !== b.requiresAction) return a.requiresAction ? -1 : 1;
      return b.timestamp - a.timestamp;
    });
  }, [feedCards, agentWork.completions, agentWork.inProgress, governance.items, activity.steps, intents.intents]);

  const loading = agentWork.loading || governance.loading || activity.loading;

  return {
    items,
    loading,
    intentActions: {
      approve: intents.approveIntent,
      reject: intents.rejectIntent,
    },
  };
}
