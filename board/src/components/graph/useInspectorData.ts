import { useState, useEffect, useRef } from "react";
import type { SectionConfig } from "./inspector-registry";

export interface SectionState {
  id: string;
  loading: boolean;
  error: string | null;
  data: unknown;
}

/**
 * Fetches data for all inspector sections of a selected node.
 * Each section loads independently. Cleans up in-flight requests on node change.
 *
 * Supports "static" sections that populate from node.data without fetching.
 * Keyed on `nodeId` (string) to avoid infinite re-render loops from
 * unstable object references.
 */
export function useInspectorData(
  sections: SectionConfig[],
  node: { id: string; type: string; data: Record<string, unknown> } | null,
) {
  const [sectionStates, setSectionStates] = useState<Record<string, SectionState>>({});
  const abortRef = useRef<AbortController | null>(null);
  // Store latest values in refs so the effect closure always reads current data
  // without re-triggering on every render.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const nodeId = node?.id ?? null;

  // Primary fetch — triggers only when selected node changes
  useEffect(() => {
    const currentSections = sectionsRef.current;
    const currentNode = nodeRef.current;

    if (!currentNode || currentSections.length === 0) {
      setSectionStates({});
      return;
    }

    // Cancel previous in-flight requests
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Initialize all sections as loading
    const initial: Record<string, SectionState> = {};
    for (const s of currentSections) {
      initial[s.id] = { id: s.id, loading: true, error: null, data: null };
    }
    setSectionStates(initial);

    // Fetch each section independently (fire all in parallel)
    for (const section of currentSections) {
      // Static sections — populate immediately from node data, no fetch
      if (section.endpoint === "static") {
        const data = section.staticData ? section.staticData(currentNode) : currentNode.data;
        setSectionStates((prev) => ({
          ...prev,
          [section.id]: { id: section.id, loading: false, error: null, data },
        }));
        continue;
      }

      const params = section.params ? section.params(currentNode) : {};
      const qs = new URLSearchParams(params).toString();
      const path = `${section.endpoint}${qs ? `?${qs}` : ""}`;

      fetch(`/api/ops?path=${encodeURIComponent(path)}`, {
        signal: controller.signal,
      })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res.ok) {
            setSectionStates((prev) => ({
              ...prev,
              [section.id]: { id: section.id, loading: false, error: `HTTP ${res.status}`, data: null },
            }));
            return;
          }
          return res.json().then((raw) => {
            if (controller.signal.aborted) return;
            const data = section.transform ? section.transform(raw, currentNode) : raw;
            setSectionStates((prev) => ({
              ...prev,
              [section.id]: { id: section.id, loading: false, error: null, data },
            }));
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setSectionStates((prev) => ({
            ...prev,
            [section.id]: {
              id: section.id,
              loading: false,
              error: err instanceof Error ? err.message : "Fetch failed",
              data: null,
            },
          }));
        });
    }

    return () => {
      controller.abort();
    };
  }, [nodeId]); // stable string key — no object reference churn

  // Set up refresh intervals for sections that need them
  useEffect(() => {
    const currentNode = nodeRef.current;
    const currentSections = sectionsRef.current;
    if (!currentNode) return;

    const timers: ReturnType<typeof setInterval>[] = [];
    for (const section of currentSections) {
      // Skip static sections — they don't need refresh
      if (section.refreshInterval && section.endpoint !== "static") {
        const timer = setInterval(() => {
          const latestNode = nodeRef.current;
          if (!latestNode) return;
          const params = section.params ? section.params(latestNode) : {};
          const qs = new URLSearchParams(params).toString();
          const path = `${section.endpoint}${qs ? `?${qs}` : ""}`;

          fetch(`/api/ops?path=${encodeURIComponent(path)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((raw) => {
              if (raw != null) {
                const data = section.transform ? section.transform(raw, latestNode) : raw;
                setSectionStates((prev) => ({
                  ...prev,
                  [section.id]: { id: section.id, loading: false, error: null, data },
                }));
              }
            })
            .catch(() => {});
        }, section.refreshInterval);
        timers.push(timer);
      }
    }

    return () => timers.forEach(clearInterval);
  }, [nodeId]); // also keyed on stable string

  return sectionStates;
}
