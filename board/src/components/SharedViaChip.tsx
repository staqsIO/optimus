// SharedViaChip — render "shared by X" / "from Org Y" provenance on RAG results.
//
// ADR-017: lib/rag/retriever.js attaches `shared_via: { granter_type, granter_id }`
// to chunk metadata when the chunk was visible via an active share_grant
// (vs. own / org-shared). This chip surfaces that to the board user so they
// can attribute correctly.

"use client";

import { usePrincipalNames, formatPrincipal, type PrincipalRef } from "@/lib/usePrincipalNames";

export type SharedVia = {
  granter_type: "user" | "org" | "group";
  granter_id: string;
} | null | undefined;

export function SharedViaChip({ value }: { value: SharedVia }) {
  // Hooks must run unconditionally — pass an empty array when there's nothing
  // to hydrate so the hook can short-circuit on its own.
  const refs: PrincipalRef[] = value?.granter_id
    ? [{ type: value.granter_type, id: value.granter_id }]
    : [];
  const names = usePrincipalNames(refs);
  if (!value?.granter_id) return null;

  const ref = { type: value.granter_type, id: value.granter_id };
  const info = names[`${ref.type}:${ref.id}`];
  const name = formatPrincipal(ref, info);
  const label = value.granter_type === "org" ? `from ${name}` : `shared by ${name}`;

  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-400/20"
      title={`Visible via knowledge-share grant (${value.granter_type})`}
    >
      {label}
    </span>
  );
}
