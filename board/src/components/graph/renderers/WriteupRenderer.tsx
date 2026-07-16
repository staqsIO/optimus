"use client";

interface Props {
  data: unknown;
  fields?: string[];
}

interface WriteupData {
  specRef?: string;
  title?: string;
  paragraphs?: string[];
}

export default function WriteupRenderer({ data }: Props) {
  if (!data || typeof data !== "object") {
    return <div className="text-[10px] text-zinc-600 italic">No writeup available</div>;
  }

  const { specRef, title, paragraphs } = data as WriteupData;

  return (
    <div className="space-y-2">
      {/* Spec reference badge + title */}
      {(specRef || title) && (
        <div className="flex items-center gap-2 flex-wrap">
          {specRef && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-mono font-medium whitespace-nowrap">
              SPEC {specRef}
            </span>
          )}
          {title && (
            <span className="text-[10px] font-medium text-zinc-300">{title}</span>
          )}
        </div>
      )}

      {/* Prose paragraphs */}
      {paragraphs?.map((p, i) => (
        <p key={i} className="text-[10px] leading-relaxed text-zinc-400">
          {p}
        </p>
      ))}
    </div>
  );
}
