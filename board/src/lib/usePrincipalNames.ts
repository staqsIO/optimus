// usePrincipalNames — hydrate {type, id} pairs to display names.
//
// ADR-017 follow-up: the Sharing page (and any RAG provenance chip) needs to
// turn `user:abc12345` into "Daniel Tovar". Resolution is batched per render
// and cached for the session (Map-backed; cleared on full reload).
//
// Use:
//   const names = usePrincipalNames([
//     { type: 'user', id: '…' },
//     { type: 'org',  id: '…' },
//   ]);
//   names['user:…']?.name ?? '…' // short id fallback
//
// Behavior: missing principals (deleted/unknown) resolve to { name: null,
// slug: null } — caller decides the fallback text.

import { useEffect, useState } from "react";
import { opsPost } from "@/lib/ops-api";

export type PrincipalRef = { type: "user" | "group" | "org"; id: string };
export type PrincipalInfo = PrincipalRef & {
  name: string | null;
  slug: string | null;
  email: string | null;
};

const cache = new Map<string, PrincipalInfo>();
const inflight = new Map<string, Promise<PrincipalInfo | null>>();

function keyOf(p: PrincipalRef): string {
  return `${p.type}:${p.id}`;
}

async function resolveBatch(needed: PrincipalRef[]): Promise<void> {
  if (needed.length === 0) return;
  const res = await opsPost<{ principals: PrincipalInfo[] }>(
    "/api/sharing/principals/resolve",
    { principals: needed },
  );
  if (!res.ok) {
    // Cache a null-named record so we don't loop on it; surface short id.
    for (const p of needed) {
      cache.set(keyOf(p), { ...p, name: null, slug: null, email: null });
    }
    return;
  }
  for (const info of res.data.principals) {
    cache.set(keyOf(info), info);
  }
}

export function usePrincipalNames(refs: PrincipalRef[]): Record<string, PrincipalInfo | null> {
  const [, force] = useState(0);

  useEffect(() => {
    const missing = refs.filter((r) => r && r.id && !cache.has(keyOf(r)));
    if (missing.length === 0) return;

    // Dedupe inflight by key. If a batch is already in flight for one of the
    // keys, wait on it; otherwise spawn one batch for everything missing.
    const allInflight = missing.every((r) => inflight.has(keyOf(r)));
    if (allInflight) {
      Promise.all(missing.map((r) => inflight.get(keyOf(r))!))
        .then(() => force((n) => n + 1))
        .catch(() => force((n) => n + 1));
      return;
    }

    const p = resolveBatch(missing).then(() => force((n) => n + 1));
    for (const r of missing) inflight.set(keyOf(r), p as unknown as Promise<PrincipalInfo | null>);
    p.finally(() => {
      for (const r of missing) inflight.delete(keyOf(r));
    });
  // refs identity changes per render; we only care about ids.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.map(keyOf).join("|")]);

  const out: Record<string, PrincipalInfo | null> = {};
  for (const r of refs) {
    if (!r || !r.id) continue;
    out[keyOf(r)] = cache.get(keyOf(r)) ?? null;
  }
  return out;
}

/** One-off escape hatch for components that just want a name string. */
export function formatPrincipal(
  ref: PrincipalRef,
  info: PrincipalInfo | null | undefined,
): string {
  if (info?.name) return info.name;
  if (info?.slug) return info.slug;
  return `${ref.type}:${ref.id.slice(0, 8)}`;
}
