"use client";

interface Props {
  data: unknown;
  fields?: string[];
}

export default function KeyValueRenderer({ data, fields }: Props) {
  if (!data || typeof data !== "object") {
    return <div className="text-[10px] text-zinc-600 italic">No data</div>;
  }

  const entries = Object.entries(data as Record<string, unknown>);
  const filtered = fields ? entries.filter(([k]) => fields.includes(k)) : entries;

  if (filtered.length === 0) {
    return <div className="text-[10px] text-zinc-600 italic">No data</div>;
  }

  return (
    <div className="space-y-1.5">
      {filtered.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-500 truncate">{formatKey(key)}</span>
          <span className="text-[10px] font-medium text-zinc-300 tabular-nums">{formatValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

function formatKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}
