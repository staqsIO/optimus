"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

interface GovernanceFeedItem {
  id: string;
  feed_type: string;
  title: string;
  summary: string;
  created_at: string;
  metadata: Record<string, unknown>;
  priority: number;
  requires_action: boolean;
  board_relevance: number;
}

const POLL_INTERVAL = 45_000;

export function useGovernanceFeedData() {
  const [items, setItems] = useState<GovernanceFeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFeed = useCallback(async () => {
    try {
      const data = await opsFetch<{ feed: GovernanceFeedItem[] }>("/api/governance/feed");
      if (data?.feed) {
        setItems(data.feed);
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed();
    const timer = setInterval(fetchFeed, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchFeed]);

  return { items, loading, refetch: fetchFeed };
}
