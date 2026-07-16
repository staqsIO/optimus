"use client";

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { useEventStream, useEventStreamStatus, EventStreamEvent } from "@/hooks/useEventStream";

interface Counters {
  pendingDrafts: number;
  pendingHitl: number;
  unreadFeed: number;
}

interface EventStreamContextValue {
  status: "connected" | "reconnecting" | "disconnected";
  counters: Counters;
}

const EventStreamContext = createContext<EventStreamContextValue>({
  status: "disconnected",
  counters: { pendingDrafts: 0, pendingHitl: 0, unreadFeed: 0 },
});

export function useEventStreamContext() {
  return useContext(EventStreamContext);
}

/**
 * Provides SSE connection status and global counters (pending drafts, HITL, unread)
 * to the entire Board UI. Mount once in layout.tsx.
 */
export default function EventStreamProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [counters, setCounters] = useState<Counters>({
    pendingDrafts: 0,
    pendingHitl: 0,
    unreadFeed: 0,
  });

  useEventStreamStatus(setStatus);

  // Request browser notification permission on first load
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Heartbeat updates counters
  useEventStream("heartbeat", useCallback((event: EventStreamEvent) => {
    setCounters((prev) => ({
      ...prev,
      pendingDrafts: (event.pendingDrafts as number) ?? prev.pendingDrafts,
      pendingHitl: (event.pendingHitl as number) ?? prev.pendingHitl,
    }));
  }, []));

  // HITL requests increment unread + browser notification
  useEventStream("hitl_request", useCallback((event: EventStreamEvent) => {
    setCounters((prev) => ({ ...prev, unreadFeed: prev.unreadFeed + 1, pendingHitl: prev.pendingHitl + 1 }));
    if (typeof window !== "undefined" && Notification.permission === "granted") {
      new Notification("Campaign needs input", {
        body: (event.question as string) || "An agent has a question for you",
        tag: `hitl-${event.campaign_id || "unknown"}`,
      });
    }
  }, []));

  // Draft ready increments unread
  useEventStream("draft_ready", useCallback(() => {
    setCounters((prev) => ({ ...prev, unreadFeed: prev.unreadFeed + 1 }));
  }, []));

  // Campaign outcomes increment unread + browser notification
  useEventStream("campaign_outcome_recorded", useCallback((event: EventStreamEvent) => {
    setCounters((prev) => ({ ...prev, unreadFeed: prev.unreadFeed + 1 }));
    if (typeof window !== "undefined" && Notification.permission === "granted") {
      const outcome = (event.outcome as string) || "completed";
      new Notification(`Campaign ${outcome}`, {
        body: (event.title as string) || (event.goal as string) || "A campaign has finished",
        tag: `campaign-${event.campaign_id || "unknown"}`,
      });
    }
  }, []));

  const value: EventStreamContextValue = { status, counters };

  return (
    <EventStreamContext.Provider value={value}>
      {children}
    </EventStreamContext.Provider>
  );
}
