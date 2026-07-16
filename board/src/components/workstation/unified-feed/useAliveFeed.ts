"use client";

/**
 * useAliveFeed — polls /api/activity/feed for lay-user-legible agent events.
 *
 * Designed for the Workstation "alive" surface: shows what agents did recently
 * in plain English, noise-filtered. Incremental poll every 20 seconds.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { AliveFeedEvent } from "@/app/api/activity/feed/route";

export type { AliveFeedEvent };

const POLL_INTERVAL_MS = 20_000;
const MAX_CACHED = 60;

export function useAliveFeed(limit = 30) {
  const [events, setEvents] = useState<AliveFeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const fetchFeed = useCallback(async () => {
    try {
      const since = sinceRef.current;
      const url = since
        ? `/api/activity/feed?limit=${limit}&since=${encodeURIComponent(since)}`
        : `/api/activity/feed?limit=${limit}`;

      const res = await fetch(url);
      if (!res.ok) {
        // 401 = not logged in; 502 = backend offline — both are non-fatal
        if (res.status !== 401) setError("Feed unavailable");
        return;
      }

      const data = (await res.json()) as { events: AliveFeedEvent[]; total: number };
      if (!mountedRef.current) return;

      setEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const fresh = data.events.filter((e) => !existingIds.has(e.id));
        if (fresh.length === 0) return prev;

        // Prepend new events, keep sorted newest-first, cap total
        const merged = [...fresh, ...prev];
        merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return merged.slice(0, MAX_CACHED);
      });

      // Track the newest timestamp for incremental polling
      if (data.events.length > 0) {
        const latest = data.events.reduce(
          (max, e) => (e.timestamp > max ? e.timestamp : max),
          data.events[0].timestamp
        );
        sinceRef.current = latest;
      }

      setError(null);
    } catch {
      // Network error — surface only if we have no data yet
      if (events.length === 0) setError("Could not reach backend");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  useEffect(() => {
    mountedRef.current = true;
    fetchFeed();
    const timer = setInterval(fetchFeed, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchFeed]);

  return { events, loading, error };
}
