"use client";

/**
 * Board-only signature-chain verification page.
 *
 * Shows the full hash-chained audit trail for the latest signing request
 * on a contract, plus the stored document_hash anchor vs a currently-
 * recomputed hash. If they disagree, the body or attachments have changed
 * since send — surfaced as a prominent tamper banner.
 *
 * Per SPEC §3, signature_events form a hash chain: every event's
 * hash_chain_current covers the previous event's hash plus its own payload.
 * signatures.verify_signature_chain() walks the chain for a signer and
 * returns (is_valid, broken_at_id, rows_checked). Each signer's chain is
 * verified independently.
 *
 * Intentionally board-only — exposing a public /verify/<id> surface would
 * leak counterparty metadata (signer emails, signing times) for anyone
 * with the id. If we ever want a public-facing verify, it needs a fresh
 * designed endpoint with redacted fields and an explicit tenancy check.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { opsFetch } from "@/lib/ops-api";

interface Request {
  id: string;
  draft_id: string;
  document_hash: string;
  computed_hash: string;
  tamper_detected: boolean;
  hash_version: number;
  status: string;
  signing_mode: "parallel" | "sequential";
  title: string;
  message: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface Signer {
  id: string;
  display_name: string;
  email: string;
  status: string;
  signing_order: number | null;
  completed_at: string | null;
  created_at: string;
}

interface ChainResult {
  signer_id: string;
  is_valid: boolean | null;
  broken_at_id: string | null;
  broken_at_time: string | null;
  expected_prev: string | null;
  actual_prev: string | null;
  rows_checked: number | null;
  error?: string;
}

interface Event {
  id: string;
  event_type: string;
  typed_name: string | null;
  consent_text: string | null;
  document_hash_at_event: string | null;
  hash_chain_prev_hex: string | null;
  hash_chain_current_hex: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  signer_name: string;
  signer_email: string;
}

interface VerifyPayload {
  request: Request | null;
  signers?: Signer[];
  chain_results?: ChainResult[];
  events?: Event[];
}

function Hash({ value, label }: { value: string | null; label?: string }) {
  if (!value) return <span className="text-zinc-600">—</span>;
  return (
    <span
      className="font-mono text-[10px] text-zinc-300 break-all"
      title={label ? `${label}: ${value}` : value}
    >
      {value.slice(0, 8)}…{value.slice(-8)}
    </span>
  );
}

export default function VerifyPage() {
  const params = useParams();
  const contractId = params.contractId as string;
  const [data, setData] = useState<VerifyPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contractId) return;
    opsFetch<VerifyPayload>(`/api/contracts/${contractId}/verify`).then((d) => {
      setData(d);
      setLoading(false);
    });
  }, [contractId]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">Loading chain…</div>;
  }
  if (!data?.request) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-zinc-200 mb-2">No signing request</h1>
          <p className="text-sm text-zinc-500">This contract has not been sent for signature yet.</p>
        </div>
      </div>
    );
  }

  const { request, signers = [], chain_results = [], events = [] } = data;
  const anyChainBroken = chain_results.some((c) => c.is_valid === false);
  const chainErrored = chain_results.some((c) => c.is_valid === null);
  const overallOk = !request.tamper_detected && !anyChainBroken && !chainErrored;

  return (
    <div className="min-h-screen px-6 py-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Signature chain verification
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">{request.title}</h1>
          <div className="text-xs text-zinc-500 mt-1">
            Request <span className="font-mono text-zinc-400">{request.id.slice(0, 8)}</span>
            {" · "}
            Created {new Date(request.created_at).toLocaleString()} by {request.created_by}
            {" · "}
            Status <span className="text-zinc-300">{request.status}</span>
          </div>
        </div>

        {/* Overall verdict */}
        <div className={`rounded-lg border p-4 mb-6 ${
          overallOk ? "border-emerald-500/40 bg-emerald-500/5" :
                      "border-red-500/40 bg-red-500/5"
        }`}>
          <div className="flex items-center gap-3">
            {overallOk ? (
              <>
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-300 text-base font-bold">✓</div>
                <div>
                  <div className="text-sm font-semibold text-emerald-200">Chain verified</div>
                  <div className="text-[11px] text-emerald-400/80">
                    Document hash matches the send-time anchor. All signer event chains are intact.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-300 text-base font-bold">!</div>
                <div>
                  <div className="text-sm font-semibold text-red-200">
                    {request.tamper_detected ? "Tamper detected" : anyChainBroken ? "Broken signer chain" : "Verification error"}
                  </div>
                  <div className="text-[11px] text-red-400/80">
                    {request.tamper_detected
                      ? "The current document hash does not match the value stored when the request was sent."
                      : anyChainBroken
                      ? "One or more signer event chains failed walk verification."
                      : "verify_signature_chain() returned an error. See per-signer details below."}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Hash anchor comparison */}
        <div className="rounded-lg border border-zinc-800 p-4 mb-6 bg-zinc-950/50">
          <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">
            Document hash
          </h2>
          <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-2 text-[11px]">
            <dt className="text-zinc-500">Formula version</dt>
            <dd className="text-zinc-300">v{request.hash_version} ({request.hash_version === 1 ? "body only" : "body + sorted attachments"})</dd>

            <dt className="text-zinc-500">Anchor (at send)</dt>
            <dd><Hash value={request.document_hash} label="anchor" /></dd>

            <dt className="text-zinc-500">Currently computed</dt>
            <dd className={request.tamper_detected ? "text-red-300" : "text-emerald-300"}>
              <Hash value={request.computed_hash} label="current" />
              {request.tamper_detected ? " (mismatch)" : " (match)"}
            </dd>
          </dl>
        </div>

        {/* Signers + per-chain verification */}
        <div className="rounded-lg border border-zinc-800 p-4 mb-6 bg-zinc-950/50">
          <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">
            Signers ({request.signing_mode})
          </h2>
          <ul className="divide-y divide-zinc-800/60">
            {signers.map((s) => {
              const chain = chain_results.find((c) => c.signer_id === s.id);
              return (
                <li key={s.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-medium text-zinc-200">{s.display_name}</span>
                    <span className="text-[10px] text-zinc-500">{s.email}</span>
                    {s.signing_order !== null && (
                      <span className="text-[9px] text-zinc-600">order {s.signing_order}</span>
                    )}
                    <span className={`ml-auto px-1.5 py-0.5 text-[9px] font-medium rounded ${
                      s.status === "signed"   ? "bg-emerald-500/15 text-emerald-300" :
                      s.status === "declined" ? "bg-red-500/15 text-red-300" :
                      s.status === "expired"  ? "bg-zinc-700/50 text-zinc-500" :
                      s.status === "viewed"   ? "bg-sky-500/15 text-sky-300" :
                                                "bg-zinc-800 text-zinc-400"
                    }`}>
                      {s.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-zinc-500 flex items-center gap-3">
                    {chain?.is_valid === true && (
                      <span className="text-emerald-400">chain ok ({chain.rows_checked} events)</span>
                    )}
                    {chain?.is_valid === false && (
                      <span className="text-red-400">chain broken at event {chain.broken_at_id?.slice(0, 8)}</span>
                    )}
                    {chain?.is_valid === null && (
                      <span className="text-zinc-500">chain not verified ({chain.error || "unavailable"})</span>
                    )}
                    {s.completed_at && (
                      <span className="text-zinc-500">completed {new Date(s.completed_at).toLocaleString()}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Event log */}
        <div className="rounded-lg border border-zinc-800 p-4 bg-zinc-950/50">
          <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">
            Event chain ({events.length})
          </h2>
          {events.length === 0 ? (
            <div className="text-[11px] text-zinc-500">No events yet.</div>
          ) : (
            <ol className="space-y-1.5">
              {events.map((e, i) => (
                <li
                  key={e.id}
                  className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[9px] font-mono text-zinc-600 w-8">{(i + 1).toString().padStart(3, "0")}</span>
                    <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${
                      e.event_type === "signed"   ? "bg-emerald-500/15 text-emerald-300" :
                      e.event_type === "declined" ? "bg-red-500/15 text-red-300" :
                      e.event_type === "viewed"   ? "bg-sky-500/15 text-sky-300" :
                                                    "bg-zinc-800 text-zinc-400"
                    }`}>
                      {e.event_type}
                    </span>
                    <span className="text-[10px] text-zinc-300">{e.signer_name}</span>
                    {e.typed_name && (
                      <span className="text-[10px] text-zinc-500">typed “{e.typed_name}”</span>
                    )}
                    <span className="ml-auto text-[9px] text-zinc-600">
                      {new Date(e.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[9px]">
                    <span className="text-zinc-500">prev&nbsp;<Hash value={e.hash_chain_prev_hex} label="hash_chain_prev" /></span>
                    <span className="text-zinc-500">curr&nbsp;<Hash value={e.hash_chain_current_hex} label="hash_chain_current" /></span>
                    <span className="text-zinc-500">doc&nbsp;<Hash value={e.document_hash_at_event} label="document_hash_at_event" /></span>
                    {e.ip_address && <span className="text-zinc-600">ip {e.ip_address}</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
