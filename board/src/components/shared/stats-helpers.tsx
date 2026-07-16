export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

export function CriterionBar({
  label,
  valueText,
  pct,
  target,
  pass,
  inverted = false,
}: {
  label: string;
  valueText: string;
  pct: number;
  target: string;
  pass: boolean;
  inverted?: boolean;
}) {
  const barColor = pass
    ? "bg-emerald-400/80"
    : inverted
      ? "bg-amber-400/80"
      : "bg-zinc-500/60";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-0.5">
        <span className="text-zinc-400">{label}</span>
        <span className="tabular-nums text-zinc-300">
          {valueText}{" "}
          <span className="text-zinc-600 text-[10px]">{target}</span>{" "}
          {pass ? (
            <span className="text-emerald-400 text-[10px]">PASS</span>
          ) : (
            <span className="text-zinc-600 text-[10px]">…</span>
          )}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}
