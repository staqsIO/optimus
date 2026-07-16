import { useState, useEffect, useCallback, useRef } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";
import type { AgentIntent, IntentMatchRate } from "./types";

export function useIntents() {
  const [intents, setIntents] = useState<AgentIntent[]>([]);
  const [rates, setRates] = useState<IntentMatchRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchIntents = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError("");
    const result = await opsFetch<{ intents: AgentIntent[] }>("/api/intents?status=pending");
    if (!result) {
      setError("Backend offline");
      setLoading(false);
      return;
    }
    setIntents(result.intents);
    hasLoadedRef.current = true;
    setLoading(false);
  }, []);

  const fetchRates = useCallback(async () => {
    const result = await opsFetch<{ rates: IntentMatchRate[] }>("/api/intents/rates");
    if (result) setRates(result.rates);
  }, []);

  const approveIntent = useCallback(async (id: string) => {
    if (actionInFlight) return;
    setActionInFlight(id);
    // Optimistic remove
    setIntents((prev) => prev.filter((i) => i.id !== id));
    const result = await opsPost(`/api/intents/${id}/approve`);
    setActionInFlight(null);
    if (!result.ok) {
      setError(`Approve failed: ${result.error}`);
      // Re-fetch to restore state
      fetchIntents();
    }
  }, [actionInFlight, fetchIntents]);

  const rejectIntent = useCallback(async (id: string, feedback: string | null) => {
    if (actionInFlight) return;
    setActionInFlight(id);
    setIntents((prev) => prev.filter((i) => i.id !== id));
    const result = await opsPost(`/api/intents/${id}/reject`, { feedback });
    setActionInFlight(null);
    if (!result.ok) {
      setError(`Reject failed: ${result.error}`);
      fetchIntents();
    }
  }, [actionInFlight, fetchIntents]);

  // Initial fetch + 30s polling
  useEffect(() => {
    fetchIntents();
    const interval = setInterval(fetchIntents, 30_000);
    return () => clearInterval(interval);
  }, [fetchIntents]);

  return {
    intents,
    rates,
    loading,
    error,
    actionInFlight,
    fetchIntents,
    fetchRates,
    approveIntent,
    rejectIntent,
  };
}
