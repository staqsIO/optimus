"use client";

interface Props {
  data: unknown;
  columns?: string[];
}

export default function TableRenderer({ data, columns }: Props) {
  const rows = Array.isArray(data) ? data : [];

  if (rows.length === 0) {
    return <div className="text-[10px] text-zinc-600 italic">No data</div>;
  }

  // Derive columns from first row if not specified
  const cols = columns || Object.keys(rows[0] || {});

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-white/10">
            {cols.map((col) => (
              <th key={col} className="text-left py-1.5 px-1.5 text-zinc-500 font-medium whitespace-nowrap">
                {formatHeader(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 25).map((row, i) => (
            <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
              {cols.map((col) => (
                <td key={col} className="py-1.5 px-1.5 text-zinc-300 whitespace-nowrap truncate max-w-[120px]">
                  {formatCell(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 25 && (
        <div className="text-[9px] text-zinc-600 mt-1 text-center">
          Showing 25 of {rows.length}
        </div>
      )}
    </div>
  );
}

function formatHeader(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCell(value: unknown, col: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  // Format timestamps
  if (col.endsWith("_at") && typeof value === "string") {
    try {
      const d = new Date(value);
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch {
      return String(value);
    }
  }
  return String(value);
}
