"use client";

interface MeterData {
  value: number;
  max: number;
  label?: string;
}

interface Props {
  data: unknown;
}

export default function MeterRenderer({ data }: Props) {
  const d = data as MeterData | null;
  if (!d || typeof d.value !== "number" || typeof d.max !== "number") {
    return <div className="text-[10px] text-zinc-600 italic">No data</div>;
  }

  const pct = d.max > 0 ? Math.min((d.value / d.max) * 100, 100) : 0;
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-zinc-500">{d.label || "Usage"}</span>
        <span className="text-[10px] font-medium text-zinc-300 tabular-nums">
          ${d.value.toFixed(2)} / ${d.max.toFixed(2)}
        </span>
      </div>
      <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-right mt-0.5">
        <span className="text-[9px] text-zinc-600 tabular-nums">{pct.toFixed(0)}%</span>
      </div>
    </div>
  );
}
