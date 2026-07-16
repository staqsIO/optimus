"use client";

/**
 * WidgetPicker — toggle widgets on/off and select presets.
 * Used on the Settings page to customize the Today dashboard.
 */

import { useState, useCallback } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePreferences } from "@/hooks/usePreferences";
import {
  getAvailableWidgets,
  PRESETS,
  type WidgetDef,
  type DashboardPreset,
} from "@/lib/widget-registry";

const CATEGORY_LABELS: Record<string, string> = {
  monitoring: "Monitoring",
  operations: "Operations",
  data: "Data",
  system: "System",
};

export default function WidgetPicker() {
  const { role } = useCurrentUser();
  const { preferences, updateDashboard } = usePreferences();
  const [saving, setSaving] = useState(false);

  const dashboard = preferences.dashboard || {};
  const activeWidgets = new Set(dashboard.widgets || []);
  const available = getAvailableWidgets(role);

  // Group widgets by category
  const byCategory = available.reduce<Record<string, WidgetDef[]>>((acc, w) => {
    (acc[w.category] = acc[w.category] || []).push(w);
    return acc;
  }, {});

  const toggleWidget = useCallback(
    async (widgetId: string) => {
      const current = new Set(dashboard.widgets || []);
      if (current.has(widgetId)) {
        current.delete(widgetId);
      } else {
        current.add(widgetId);
      }
      setSaving(true);
      await updateDashboard({
        ...dashboard,
        widgets: Array.from(current),
      });
      setSaving(false);
    },
    [dashboard, updateDashboard]
  );

  const applyPreset = useCallback(
    async (preset: DashboardPreset) => {
      // Filter preset widgets to only those available for this role
      const availableIds = new Set(available.map((w) => w.id));
      const widgets = preset.widgets.filter((id) => availableIds.has(id));
      setSaving(true);
      await updateDashboard({
        ...dashboard,
        widgets,
        preset: preset.id,
      });
      setSaving(false);
    },
    [available, dashboard, updateDashboard]
  );

  return (
    <div className="space-y-6">
      {/* Presets */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Presets</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {PRESETS.map((preset) => {
            const isActive = dashboard.preset === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset)}
                disabled={saving}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  isActive
                    ? "border-accent/40 bg-accent/10"
                    : "border-white/5 bg-surface-overlay hover:border-white/10"
                } disabled:opacity-50`}
              >
                <div className="text-sm font-medium text-zinc-200">{preset.name}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">{preset.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Individual widget toggles */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">
          Widgets
          {saving && <span className="ml-2 text-xs text-zinc-500">Saving...</span>}
        </h3>
        <div className="space-y-4">
          {Object.entries(byCategory).map(([category, widgets]) => (
            <div key={category}>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-2">
                {CATEGORY_LABELS[category] || category}
              </div>
              <div className="space-y-1">
                {widgets.map((widget) => {
                  const isOn = activeWidgets.has(widget.id);
                  return (
                    <div
                      key={widget.id}
                      className="flex items-center justify-between rounded-md bg-surface-overlay px-4 py-2.5"
                    >
                      <div>
                        <div className="text-sm text-zinc-200">{widget.name}</div>
                        <div className="text-[11px] text-zinc-500">{widget.description}</div>
                      </div>
                      <button
                        onClick={() => toggleWidget(widget.id)}
                        disabled={saving}
                        className={`relative w-9 h-5 rounded-full transition-colors ${
                          isOn ? "bg-accent" : "bg-zinc-700"
                        } disabled:opacity-50`}
                        aria-label={`Toggle ${widget.name}`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                            isOn ? "translate-x-4" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
