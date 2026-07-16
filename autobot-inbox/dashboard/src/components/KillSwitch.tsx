"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export default function KillSwitch() {
  const [halted, setHalted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function checkHalt() {
      try {
        const res = await fetch(`${API_URL}/api/stats`);
        if (res.ok) {
          const data = await res.json();
          setHalted(data.stats?.halt_active === true);
        }
      } catch {
        // API unavailable — status poll failure is non-critical
      }
    }
    checkHalt();
    const interval = setInterval(checkHalt, 10000);
    return () => clearInterval(interval);
  }, []);

  async function handleHalt() {
    if (!window.confirm("Are you sure you want to HALT all agent operations?")) return;
    setError("");
    try {
      const res = await fetch("/api/system/halt", { method: "POST" });
      if (!res.ok) throw new Error("Halt request failed");
      setHalted(true);
    } catch {
      setError("HALT FAILED — agents may still be running");
    }
  }

  async function handleResume() {
    if (!window.confirm("Resume all agent operations?")) return;
    setError("");
    try {
      const res = await fetch("/api/system/resume", { method: "POST" });
      if (!res.ok) throw new Error("Resume request failed");
      setHalted(false);
    } catch {
      setError("RESUME FAILED");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="px-2 py-0.5 text-xs bg-red-500/30 text-red-200 rounded-full border border-red-500/40 font-semibold">
          {error}
        </span>
      )}
      {halted && !error && (
        <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-300 rounded-full border border-red-500/30 animate-pulse">
          HALTED
        </span>
      )}
      <button
        onClick={handleHalt}
        className="px-3 py-1 text-xs bg-red-500/10 text-red-400 rounded hover:bg-red-500/20 transition-colors border border-red-500/20"
      >
        HALT
      </button>
      <button
        onClick={handleResume}
        className="px-3 py-1 text-xs bg-green-500/10 text-green-400 rounded hover:bg-green-500/20 transition-colors border border-green-500/20"
      >
        RESUME
      </button>
    </div>
  );
}
