import { useState, useEffect, useCallback, useRef } from "react";
import { opsFetch } from "@/lib/ops-api";
import type { AgentWorkData } from "./types";

export function useAgentWork() {
  const [data, setData] = useState<AgentWorkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasLoadedRef = useRef(false);

  const fetchCompletions = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const result = await opsFetch<AgentWorkData>("/api/pipeline/completions");
      if (!result) {
        setError("Backend offline");
        setLoading(false);
        return;
      }
      setData(result);
      hasLoadedRef.current = true;
      setError("");
    } catch {
      setError("Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompletions();
    const interval = setInterval(fetchCompletions, 30_000);
    return () => clearInterval(interval);
  }, [fetchCompletions]);

  return {
    completions: data?.completions ?? [],
    inProgress: data?.inProgress ?? [],
    loading,
    error,
  };
}
