"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";

interface ApiKeyContextValue {
  hasKey: boolean;
  loading: boolean;
  saveKey: (key: string) => Promise<{ error?: string }>;
  clearKey: () => Promise<void>;
}

const ApiKeyContext = createContext<ApiKeyContextValue>({
  hasKey: false,
  loading: true,
  saveKey: async () => ({}),
  clearKey: async () => {},
});

export function useApiKey() {
  return useContext(ApiKeyContext);
}

export default function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/api-key")
      .then((res) => (res.ok ? res.json() : { hasKey: false }))
      .then((data) => setHasKey(data.hasKey))
      .catch(() => setHasKey(false))
      .finally(() => setLoading(false));
  }, []);

  const saveKey = useCallback(async (key: string): Promise<{ error?: string }> => {
    try {
      const res = await fetch("/api/settings/api-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Failed to save key" };
      setHasKey(data.hasKey);
      return {};
    } catch {
      return { error: "Network error saving key" };
    }
  }, []);

  const clearKey = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/api-key", { method: "DELETE" });
      if (res.ok) setHasKey(false);
    } catch {
      // Keep hasKey as-is on network failure — key still exists server-side
    }
  }, []);

  return (
    <ApiKeyContext.Provider value={{ hasKey, loading, saveKey, clearKey }}>
      {children}
    </ApiKeyContext.Provider>
  );
}
