"use client";

import { useState } from "react";

export default function SystemActions({
  readinessReady,
}: {
  readinessReady: boolean;
}) {
  const [renewing, setRenewing] = useState(false);
  const [renewResult, setRenewResult] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateResult, setActivateResult] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureResult, setMeasureResult] = useState<string | null>(null);

  const renewSwitch = async () => {
    setRenewing(true);
    setRenewResult(null);
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/phase/dead-man-switch/renew" }),
      });
      if (res.ok) {
        setRenewResult("Switch renewed successfully.");
      } else {
        const data = await res.json().catch(() => null);
        setRenewResult(data?.error ?? `Failed (${res.status})`);
      }
    } catch {
      setRenewResult("Request failed — API unavailable.");
    }
    setRenewing(false);
  };

  const activatePhase = async () => {
    setActivating(true);
    setActivateResult(null);
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/phase/activate" }),
      });
      if (res.ok) {
        setActivateResult("Phase activated successfully.");
      } else {
        const data = await res.json().catch(() => null);
        setActivateResult(data?.error ?? `Failed (${res.status})`);
      }
    } catch {
      setActivateResult("Request failed — API unavailable.");
    }
    setActivating(false);
  };

  const measureGates = async () => {
    setMeasuring(true);
    setMeasureResult(null);
    try {
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/api/gates/measure", method: "GET" }),
      });
      if (res.ok) {
        const data = await res.json();
        const passing = data?.snapshot?.gates_passing ?? "?";
        const total = data?.snapshot?.gates_total ?? 5;
        setMeasureResult(`Measured: ${passing}/${total} gates passing. Refresh page to see results.`);
      } else {
        const data = await res.json().catch(() => null);
        setMeasureResult(data?.error ?? `Failed (${res.status})`);
      }
    } catch {
      setMeasureResult("Request failed — API unavailable.");
    }
    setMeasuring(false);
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Actions</h2>
      <div className="flex flex-wrap gap-4">
        <div>
          <button
            onClick={measureGates}
            disabled={measuring}
            className="px-4 py-2 text-sm rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
          >
            {measuring ? "Measuring..." : "Measure Gates Now"}
          </button>
          {measureResult && (
            <p className="text-xs text-zinc-400 mt-2">{measureResult}</p>
          )}
        </div>
        <div>
          <button
            onClick={renewSwitch}
            disabled={renewing}
            className="px-4 py-2 text-sm rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
          >
            {renewing ? "Renewing..." : "Renew Dead-Man Switch"}
          </button>
          {renewResult && (
            <p className="text-xs text-zinc-400 mt-2">{renewResult}</p>
          )}
        </div>

        {readinessReady && (
          <div>
            <button
              onClick={activatePhase}
              disabled={activating}
              className="px-4 py-2 text-sm rounded-md bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors disabled:opacity-50"
            >
              {activating ? "Activating..." : "Activate Phase"}
            </button>
            {activateResult && (
              <p className="text-xs text-zinc-400 mt-2">{activateResult}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
