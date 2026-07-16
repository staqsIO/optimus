"use client";

interface BucketEntry {
  bucket?: string;
  hour?: string;
  count?: number;
  value?: number;
}

interface Props {
  data: unknown;
}

export default function SparklineRenderer({ data }: Props) {
  const items = Array.isArray(data) ? (data as BucketEntry[]) : [];

  if (items.length === 0) {
    return <div className="text-[10px] text-zinc-600 italic">No data</div>;
  }

  const values = items.map((d) => d.count ?? d.value ?? 0);
  const max = Math.max(...values, 1);
  const barCount = values.length;

  return (
    <div>
      <div className="flex items-end gap-px h-12">
        {values.map((v, i) => {
          const heightPct = (v / max) * 100;
          const opacity = v === 0 ? 0.15 : 0.4 + (v / max) * 0.6;
          return (
            <div
              key={i}
              className="flex-1 bg-accent rounded-t-sm transition-all"
              style={{ height: `${Math.max(heightPct, 2)}%`, opacity }}
              title={`${items[i]?.bucket || items[i]?.hour || `#${i + 1}`}: ${v}`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[9px] text-zinc-600">
          {items[0]?.bucket || items[0]?.hour || ""}
        </span>
        <span className="text-[9px] text-zinc-500 tabular-nums">
          Total: {values.reduce((a, b) => a + b, 0).toLocaleString()}
        </span>
        <span className="text-[9px] text-zinc-600">
          {items[barCount - 1]?.bucket || items[barCount - 1]?.hour || ""}
        </span>
      </div>
    </div>
  );
}
