"use client";

import { useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { usePreferences } from "@/hooks/usePreferences";

const MAX_RECENT = 10;
const DEBOUNCE_MS = 2000;

/**
 * Tracks recently visited pages in user preferences.
 * Debounces persistence to avoid hammering the API on fast navigation.
 */
export function useRecentPages() {
  const { preferences, updatePreference } = usePreferences();
  const recentPages = preferences.recent_pages || [];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string[] | null>(null);
  const pathname = usePathname();

  const flush = useCallback(() => {
    if (pendingRef.current) {
      updatePreference("recent_pages", pendingRef.current);
      pendingRef.current = null;
    }
  }, [updatePreference]);

  // Track page visits on route change
  useEffect(() => {
    if (!pathname) return;
    // Extract slug from pathname (e.g. "/today" → "today", "/agents/123" → "agents")
    const slug = pathname.split("/").filter(Boolean)[0];
    if (!slug) return;

    const current = pendingRef.current || [...recentPages];
    const deduped = [slug, ...current.filter((s) => s !== slug)].slice(0, MAX_RECENT);

    // Skip if nothing changed
    if (deduped.length === current.length && deduped.every((s, i) => s === current[i])) return;

    pendingRef.current = deduped;

    // Debounce the persistence
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, DEBOUNCE_MS);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      flush();
    };
  }, [flush]);

  return { recentPages };
}
