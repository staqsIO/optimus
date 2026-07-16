"use client";

import { useEffect, useCallback, useState, useMemo } from "react";
import type { ProjectionStatus } from "./types";

interface UseSpecKeyboardOptions {
  /** Whether the keyboard shortcuts are active (panel must be open) */
  enabled: boolean;
  /** Flat list of visible section IDs in display order */
  visibleSectionIds: string[];
  /** Current focused section ID */
  focusedSectionId: string | null;
  /** Sections with ready/editing projections */
  projectionStatus: Record<string, ProjectionStatus>;
  /** Callbacks */
  onFocusSection: (sectionId: string) => void;
  onEditProjection: (sectionId: string) => void;
  onSubmitProjections: () => void;
  onFocusSearch: () => void;
}

export function useSpecKeyboard({
  enabled,
  visibleSectionIds,
  focusedSectionId,
  projectionStatus,
  onFocusSection,
  onEditProjection,
  onSubmitProjections,
  onFocusSearch,
}: UseSpecKeyboardOptions) {
  const [showHelp, setShowHelp] = useState(false);

  const projectionSectionIds = useMemo(
    () => Object.entries(projectionStatus)
      .filter(([, s]) => s === "ready" || s === "editing")
      .map(([id]) => id),
    [projectionStatus]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      // Skip if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }

      const currentIdx = focusedSectionId
        ? visibleSectionIds.indexOf(focusedSectionId)
        : -1;

      switch (e.key) {
        case "j": {
          // Next section
          e.preventDefault();
          const nextIdx = currentIdx + 1;
          if (nextIdx < visibleSectionIds.length) {
            onFocusSection(visibleSectionIds[nextIdx]);
          }
          break;
        }
        case "k": {
          // Previous section
          e.preventDefault();
          const prevIdx = currentIdx - 1;
          if (prevIdx >= 0) {
            onFocusSection(visibleSectionIds[prevIdx]);
          }
          break;
        }
        case "n": {
          // Next projection
          e.preventDefault();
          if (projectionSectionIds.length === 0) break;
          const currentProjIdx = focusedSectionId
            ? projectionSectionIds.indexOf(focusedSectionId)
            : -1;
          const nextProjIdx = (currentProjIdx + 1) % projectionSectionIds.length;
          onFocusSection(projectionSectionIds[nextProjIdx]);
          break;
        }
        case "N": {
          // Previous projection
          e.preventDefault();
          if (projectionSectionIds.length === 0) break;
          const currentProjIdx = focusedSectionId
            ? projectionSectionIds.indexOf(focusedSectionId)
            : -1;
          const prevProjIdx =
            currentProjIdx <= 0
              ? projectionSectionIds.length - 1
              : currentProjIdx - 1;
          onFocusSection(projectionSectionIds[prevProjIdx]);
          break;
        }
        case "e": {
          // Edit current projection
          e.preventDefault();
          if (
            focusedSectionId &&
            (projectionStatus[focusedSectionId] === "ready" ||
              projectionStatus[focusedSectionId] === "editing")
          ) {
            onEditProjection(focusedSectionId);
          }
          break;
        }
        case "Enter": {
          // Submit projections (Ctrl/Cmd+Enter)
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            onSubmitProjections();
          }
          break;
        }
        case "?": {
          // Toggle help
          e.preventDefault();
          setShowHelp((v) => !v);
          break;
        }
        case "Escape": {
          if (showHelp) {
            e.preventDefault();
            setShowHelp(false);
          }
          break;
        }
        // Note: "/" for search is handled by SearchBar's own listener
      }
    },
    [
      enabled,
      focusedSectionId,
      visibleSectionIds,
      projectionSectionIds,
      projectionStatus,
      onFocusSection,
      onEditProjection,
      onSubmitProjections,
      showHelp,
    ]
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleKeyDown]);

  return { showHelp, setShowHelp };
}

export const KEYBOARD_SHORTCUTS = [
  { key: "/", description: "Focus search" },
  { key: "j", description: "Next section" },
  { key: "k", description: "Previous section" },
  { key: "n", description: "Next projection" },
  { key: "N", description: "Previous projection" },
  { key: "e", description: "Edit focused projection" },
  { key: "\u2318+Enter", description: "Submit all projections" },
  { key: "?", description: "Toggle this help" },
] as const;
