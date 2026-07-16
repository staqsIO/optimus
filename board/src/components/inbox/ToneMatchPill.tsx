"use client";

/** Compact voice/tone confidence for headers and queue rows. */
export default function ToneMatchPill({
  toneScore,
  className = "",
}: {
  toneScore: number | null | undefined;
  className?: string;
}) {
  if (toneScore == null || Number.isNaN(Number(toneScore))) {
    return (
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-500 ring-1 ring-inset ring-white/5 shrink-0 ${className}`}
        title="Tone match not scored yet"
      >
        Tone —
      </span>
    );
  }
  const pct = Math.round(Number(toneScore) * 100);
  const label = pct >= 80 ? "Strong match" : pct >= 50 ? "OK" : "Check tone";
  const color =
    pct >= 80 ? "text-emerald-400 ring-emerald-500/20" : pct >= 50 ? "text-amber-400 ring-amber-500/20" : "text-red-400 ring-red-500/20";
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay tabular-nums ring-1 ring-inset shrink-0 ${color} ${className}`}
      title="Voice/tone match vs profile"
    >
      {label} · {pct}%
    </span>
  );
}
