"use client";

/**
 * DashboardWidgets — renders the user's selected widget set on Today.
 * Uses dynamic imports to load widget components on demand.
 * Falls back to role-based default preset when no preferences are saved.
 */

import { Suspense, lazy, useMemo } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePreferences } from "@/hooks/usePreferences";
import { resolveWidgets, getDefaultPreset, type WidgetDef } from "@/lib/widget-registry";

// Lazy-loaded widget components — keyed by widget ID.
// Components that exist get real imports; others show a placeholder.
// As widget wrappers are built, replace placeholders with real imports.
const WIDGET_COMPONENTS: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  actions: lazy(() => import("@/components/ActionRequired")),
  "agent-status": lazy(() => import("@/components/widgets/AgentStatusWidget")),
  "cost-24h": lazy(() => import("@/components/widgets/CostWidget")),
  campaigns: lazy(() => import("@/components/widgets/CampaignsWidget")),
  signals: lazy(() => import("@/components/widgets/SignalsWidget")),
  triage: lazy(() => import("@/components/widgets/TriageWidget")),
  services: lazy(() => import("@/components/widgets/ServicesWidget")),
  graph: lazy(() => import("@/components/widgets/SystemGraphWidget")),
  "optimus-mcp": lazy(() => import("@/components/widgets/OptimusMcpWidget")),
};

function WidgetSkeleton({ name }: { name: string }) {
  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4 min-h-[120px] flex items-center justify-center">
      <div className="text-xs text-zinc-600">{name} (coming soon)</div>
    </div>
  );
}

function WidgetLoadingSkeleton() {
  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4 min-h-[120px]">
      <div className="h-4 w-32 rounded bg-white/5 animate-pulse" />
    </div>
  );
}

interface DashboardWidgetsProps {
  /** Whether to include the ActionRequired widget inline (it may already be rendered separately) */
  excludeActions?: boolean;
}

export default function DashboardWidgets({ excludeActions = false }: DashboardWidgetsProps) {
  const { role } = useCurrentUser();
  const { preferences, loading } = usePreferences();

  const widgets = useMemo<WidgetDef[]>(() => {
    const dashboardPrefs = preferences.dashboard;
    if (dashboardPrefs?.widgets?.length) {
      return resolveWidgets(dashboardPrefs.widgets, role);
    }
    // Fall back to role-based default preset
    const preset = getDefaultPreset(role);
    return resolveWidgets(preset.widgets, role);
  }, [preferences, role]);

  // Filter out actions widget if requested (to avoid duplication)
  const filtered = excludeActions ? widgets.filter((w) => w.id !== "actions") : widgets;

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[...Array(3)].map((_, i) => (
          <WidgetLoadingSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (filtered.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {filtered.map((widget) => {
        const Component = WIDGET_COMPONENTS[widget.id];

        if (!Component) {
          return (
            <div
              key={widget.id}
              className={widget.defaultSize.cols === 2 ? "md:col-span-2" : ""}
            >
              <WidgetSkeleton name={widget.name} />
            </div>
          );
        }

        return (
          <div
            key={widget.id}
            className={widget.defaultSize.cols === 2 ? "md:col-span-2" : ""}
          >
            <Suspense fallback={<WidgetLoadingSkeleton />}>
              <Component />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
