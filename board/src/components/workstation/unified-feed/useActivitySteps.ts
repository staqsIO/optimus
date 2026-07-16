"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

interface ActivityStep {
  id: string;
  agent_id: string;
  step_type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  created_at: string;
  work_item_title: string | null;
}

const POLL_INTERVAL = 15_000;
const STEP_TYPES_SHOWN = ["task_execution", "decision", "campaign_iteration", "delegation"];
const STEP_TYPES_HIDDEN = ["state_changed", "heartbeat", "poll", "claim"];

export function useActivitySteps(limit = 30) {
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [loading, setLoading] = useState(true);
  const sinceRef = useRef<string | null>(null);

  const fetchSteps = useCallback(async () => {
    try {
      const since = sinceRef.current;
      const path = since
        ? `/api/activity?limit=${limit}&since=${encodeURIComponent(since)}`
        : `/api/activity?limit=${limit}`;
      const data = await opsFetch<{ steps: ActivityStep[] }>(path);
      if (!data?.steps) return;

      if (since) {
        // Incremental: prepend new steps
        setSteps((prev) => {
          const newIds = new Set(data.steps.map((s) => s.id));
          const deduped = prev.filter((s) => !newIds.has(s.id));
          return [...data.steps, ...deduped].slice(0, limit * 2);
        });
      } else {
        setSteps(data.steps);
      }

      // Track latest timestamp for incremental polling
      if (data.steps.length > 0) {
        const latest = data.steps.reduce((max, s) =>
          s.created_at > max ? s.created_at : max, data.steps[0].created_at
        );
        sinceRef.current = latest;
      }
    } catch {
      // Non-critical — activity is best-effort
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchSteps();
    const timer = setInterval(fetchSteps, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchSteps]);

  // Filter to meaningful step types — exclude noise like state_changed, heartbeat
  const filtered = steps.filter((s) => {
    if (STEP_TYPES_HIDDEN.includes(s.step_type)) return false;
    // Also filter by description content — "state_changed" can appear in description too
    if (s.description && /^(orchestrator|executor|reviewer|architect|strategist):\s*state_changed$/i.test(s.description)) return false;
    return STEP_TYPES_SHOWN.includes(s.step_type) || (s.description && s.description.length > 15);
  });

  return { steps: filtered, loading };
}
