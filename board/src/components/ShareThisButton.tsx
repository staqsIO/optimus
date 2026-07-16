// ShareThisButton — drop-in "Share" button that links to /sharing with the
// composer pre-filled by scope_type + scope_ref. Use on document and
// collection surfaces.
//
// Example:
//   <ShareThisButton scopeType="document" scopeRef={doc.id} />
//   <ShareThisButton scopeType="collection" scopeRef={collection.id} compact />

"use client";

import Link from "next/link";

export function ShareThisButton({
  scopeType,
  scopeRef,
  compact = false,
}: {
  scopeType: "document" | "collection";
  scopeRef: string;
  compact?: boolean;
}) {
  const href = `/sharing?scope_type=${scopeType}&scope_ref=${encodeURIComponent(scopeRef)}`;
  if (compact) {
    return (
      <Link
        href={href}
        title={`Share this ${scopeType}`}
        className="text-[10px] px-1.5 py-0.5 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
      >
        Share
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className="text-xs px-2.5 py-1 rounded border border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
    >
      Share this {scopeType}
    </Link>
  );
}
