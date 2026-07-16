"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";

interface Signal {
  id: string;
  content: string;
  signal_type: string;
  source_channel: string;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  request: "text-amber-300",
  info: "text-blue-300",
  fyi: "text-zinc-400",
};

export default function SignalsWidget() {
  const [signals, setSignals] = useState<Signal[]>([]);

  useEffect(() => {
    opsFetch<{ signals: Signal[] }>("/api/signals?limit=6")
      .then((data) => setSignals(data?.signals || []))
      .catch(() => {});
  }, []);

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
      <h3 className="text-sm font-medium text-zinc-300 mb-3">Recent Signals</h3>
      {signals.length === 0 ? (
        <div className="text-xs text-zinc-600">No recent signals</div>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => (
            <div key={s.id} className="text-xs">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`text-[10px] font-medium ${TYPE_COLORS[s.signal_type] || "text-zinc-400"}`}>
                  {s.signal_type}
                </span>
                <span className="text-zinc-600">{s.source_channel}</span>
              </div>
              <div className="text-zinc-400 truncate">{s.content?.slice(0, 80)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
