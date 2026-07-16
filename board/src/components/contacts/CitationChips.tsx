"use client";

export interface Citation {
  text: string;
  similarity: number;
  rerankScore?: number;
  documentId: string;
  metadata: {
    document_title?: string | null;
    document_source?: string | null;
    document_created_at?: string | null;
    [key: string]: unknown;
  };
}

interface Props {
  citations: Citation[];
}

const SOURCE_LABELS: Record<string, string> = {
  email: "email",
  gmail: "email",
  tldv: "transcript",
  meeting: "transcript",
  gdrive: "drive",
  drive: "drive",
  brainrag: "brain",
  contract: "contract",
  manual: "doc",
};

function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function CitationChips({ citations }: Props) {
  if (!citations || citations.length === 0) return null;

  // Deduplicate by documentId — multiple chunks from one doc collapse to one chip.
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    if (!c.documentId || c.documentId === "graph") return false;
    if (seen.has(c.documentId)) return false;
    seen.add(c.documentId);
    return true;
  });

  if (unique.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {unique.slice(0, 8).map((c) => {
        const sourceRaw = (c.metadata.document_source || "").toLowerCase();
        const sourceLabel = SOURCE_LABELS[sourceRaw] || sourceRaw || "doc";
        const title = c.metadata.document_title || "Untitled";
        const date = relativeDate(c.metadata.document_created_at);
        return (
          <div
            key={c.documentId}
            title={`${title}${date ? ` · ${date}` : ""}`}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/60 border border-white/5 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors max-w-[220px]"
          >
            <span className="text-[9px] uppercase tracking-wide text-zinc-500 shrink-0">
              {sourceLabel}
            </span>
            <span className="truncate">{title}</span>
            {date && <span className="text-zinc-600 shrink-0">{date}</span>}
          </div>
        );
      })}
    </div>
  );
}
