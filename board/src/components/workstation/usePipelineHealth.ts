import { useState, useEffect, useCallback, useRef } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import type { PipelineHealthData, ThroughputData } from "./types";

export function usePipelineHealth() {
  const [health, setHealth] = useState<PipelineHealthData | null>(null);
  const [throughput, setThroughput] = useState<ThroughputData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasLoadedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const [h, t] = await Promise.all([
        opsFetch<PipelineHealthData>("/api/pipeline/health"),
        opsFetch<ThroughputData>("/api/pipeline/throughput"),
      ]);
      if (!h && !t) {
        setError("Backend offline");
        setHealth(null);
        setThroughput(null);
        setLoading(false);
        return;
      }
      if (h) setHealth(h);
      if (t) setThroughput(t);
      hasLoadedRef.current = true;
      setError("");
    } catch {
      setError("Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const stuckAction = useCallback(async (id: string, action: "cancel" | "retry") => {
    const result = await opsPost<{ success: boolean; error?: string }>(
      `/api/pipeline/stuck/${action}`,
      { id }
    );
    if (!result.ok) throw new Error(result.error);
    if (!result.data.success) throw new Error(result.data.error || "Action failed");
    await fetchAll();
  }, [fetchAll]);

  return { health, throughput, loading, error, refetch: fetchAll, stuckAction };
}
