"use client";

import { useEffect, useRef, useCallback } from "react";

export type EventType =
  | "heartbeat"
  | "state_changed"
  | "task_assigned"
  | "campaign_approved"
  | "campaign_started"
  | "campaign_paused"
  | "campaign_update"
  | "campaign_iteration"
  | "campaign_iterated"
  | "campaign_iterated_and_metrics_updated"
  | "campaign_completed"
  | "campaign_failed"
  | "campaign_outcome_recorded"
  | "hitl_request"
  | "draft_ready"
  | "agent_toggled"
  | "halt_triggered"
  | "halt_cleared"
  | "needs_attention"
  | "unknown";

export interface EventStreamEvent {
  type: string;
  eventType?: string;
  event_type?: string;
  [key: string]: unknown;
}

type EventCallback = (event: EventStreamEvent) => void;

/**
 * Global singleton EventSource shared across all hook instances.
 * Avoids multiple SSE connections per tab.
 */
let globalSource: EventSource | null = null;
let listenerMap = new Map<string, Set<EventCallback>>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 30_000;

// Connection status callbacks
type StatusCallback = (status: "connected" | "reconnecting" | "disconnected") => void;
let statusListeners = new Set<StatusCallback>();

function notifyStatus(status: "connected" | "reconnecting" | "disconnected") {
  statusListeners.forEach((cb) => cb(status));
}

function connect() {
  if (globalSource) return;

  globalSource = new EventSource("/api/ops/events");

  globalSource.onopen = () => {
    reconnectAttempt = 0;
    notifyStatus("connected");
  };

  // Default message handler (for untyped `data:` lines)
  globalSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      dispatch("heartbeat", data);
    } catch { /* malformed */ }
  };

  // Typed event handlers — SSE `event: <type>` lines
  const eventTypes: EventType[] = [
    "heartbeat", "state_changed", "task_assigned",
    "campaign_approved", "campaign_started", "campaign_paused", "campaign_update",
    "campaign_iteration", "campaign_iterated", "campaign_iterated_and_metrics_updated",
    "campaign_completed", "campaign_failed", "campaign_outcome_recorded",
    "hitl_request", "draft_ready",
    "agent_toggled", "halt_triggered", "halt_cleared",
    "needs_attention",
  ];

  for (const type of eventTypes) {
    globalSource.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        dispatch(type, data);
      } catch { /* malformed */ }
    });
  }

  globalSource.onerror = () => {
    globalSource?.close();
    globalSource = null;
    notifyStatus("reconnecting");

    // Exponential backoff
    const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalSource) {
    globalSource.close();
    globalSource = null;
  }
  notifyStatus("disconnected");
}

function dispatch(type: string, data: EventStreamEvent) {
  // Dispatch to type-specific listeners
  const typeListeners = listenerMap.get(type);
  if (typeListeners) {
    typeListeners.forEach((cb) => cb(data));
  }
  // Dispatch to wildcard listeners
  const wildcardListeners = listenerMap.get("*");
  if (wildcardListeners) {
    wildcardListeners.forEach((cb) => cb({ ...data, _eventType: type }));
  }
}

/**
 * Subscribe to a specific event type (or "*" for all events).
 * Manages the global EventSource lifecycle automatically.
 */
export function useEventStream(eventType: EventType | "*", callback: EventCallback) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const stableCallback = useCallback((event: EventStreamEvent) => {
    callbackRef.current(event);
  }, []);

  useEffect(() => {
    // Add listener
    if (!listenerMap.has(eventType)) {
      listenerMap.set(eventType, new Set());
    }
    listenerMap.get(eventType)!.add(stableCallback);

    // Start connection if not active
    if (!globalSource) connect();

    return () => {
      listenerMap.get(eventType)?.delete(stableCallback);

      // Disconnect if no listeners remain
      let totalListeners = 0;
      listenerMap.forEach((set) => (totalListeners += set.size));
      if (totalListeners === 0) disconnect();
    };
  }, [eventType, stableCallback]);
}

/**
 * Subscribe to SSE connection status changes.
 */
export function useEventStreamStatus(callback: StatusCallback) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const cb: StatusCallback = (status) => callbackRef.current(status);
    statusListeners.add(cb);

    // Report current status immediately
    if (globalSource?.readyState === EventSource.OPEN) cb("connected");
    else if (globalSource) cb("reconnecting");
    else cb("disconnected");

    return () => { statusListeners.delete(cb); };
  }, []);
}
