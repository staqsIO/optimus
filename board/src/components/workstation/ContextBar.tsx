"use client";

interface ContextBarProps {
  files: string[];
  onRemove: (path: string) => void;
  onAttachClick?: () => void;
}

export default function ContextBar({
  files,
  onRemove,
  onAttachClick,
}: ContextBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {files.map((path) => (
        <span
          key={path}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-accent/10 text-accent-bright rounded-full border border-accent/20"
        >
          <span className="max-w-[200px] truncate">{path}</span>
          <button
            onClick={() => onRemove(path)}
            className="text-accent-bright/60 hover:text-accent-bright transition-colors"
            aria-label={`Remove ${path}`}
          >
            &times;
          </button>
        </span>
      ))}
      {onAttachClick && (
        <button
          onClick={onAttachClick}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-300 rounded-full border border-white/10 hover:border-white/20 transition-colors"
        >
          + Attach file
        </button>
      )}
    </div>
  );
}
