"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

export interface DashboardPreferences {
  default_view?: "board" | "personal";
  collapsed_nav?: boolean;
  pinned_projects?: string[];
  pinned_pages?: string[];
  recent_pages?: string[];
  /** OPT-126: teammates' calendar emails the viewer opted into on /calendar.
   *  Own calendars are always shown; absent/empty = only mine (the default). */
  calendar_included_calendars?: string[];
  dashboard?: {
    widgets?: string[];
    layout?: "grid" | "list";
    preset?: string;
  };
  [key: string]: unknown;
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<DashboardPreferences>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await opsFetch<{ preferences: DashboardPreferences }>("/api/preferences");
    if (data?.preferences) {
      setPreferences(data.preferences);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updatePreference = useCallback(
    async <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) => {
      // Optimistic update
      setPreferences((prev) => ({ ...prev, [key]: value }));

      const result = await opsPost("/api/preferences", {
        preferences: { [key]: value },
      });

      if (!result.ok) {
        // Revert on failure
        load();
      }
    },
    [load]
  );

  const updateDashboard = useCallback(
    async (dashboard: DashboardPreferences["dashboard"]) => {
      setPreferences((prev) => ({ ...prev, dashboard }));

      const result = await opsPost("/api/preferences", {
        preferences: { dashboard },
      });

      if (!result.ok) {
        load();
      }
    },
    [load]
  );

  return {
    preferences,
    loading,
    updatePreference,
    updateDashboard,
    reload: load,
  };
}
