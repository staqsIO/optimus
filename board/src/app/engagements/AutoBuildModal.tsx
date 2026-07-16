"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// React deliberately imported above; useState inside CandidateGroup needs nothing extra.

export type AutoBuildContext =
  | { mode: "create" }
  | { mode: "append"; engagementId: string; clientName: string; engagementName: string };

type Candidate = {
  id: string;
  kind: "calendar_event" | "transcript" | "email" | "signal";
  title: string;
  date: string | null;
  organizer?: string;
  attendee_emails?: string[];
  speakers?: string[];
  from?: string;
  to?: string[];
  signal_type?: string;
  direction?: string;
  domain?: string;
  snippet?: string;
  group_key?: string;
  group_size?: number;
  is_group_primary?: boolean;
};

type SearchResult = {
  client_name: string;
  expanded: {
    domains: string[];
    names: string[];
    aliases: string[];
    rationale?: string;
  };
  sources: {
    calendar: Candidate[];
    transcripts: Candidate[];
    emails: Candidate[];
    signals: Candidate[];
  };
  counts: { calendar: number; transcripts: number; emails: number; signals: number; total: number };
};

type Phase = "input" | "searching" | "review" | "building" | "done" | "error";

type BuildResult = {
  engagement_id: string;
  is_new?: boolean;
  status?: "building";
  message?: string;
  ingested_count?: number;
  synth_error?: string | null;
};

export default function AutoBuildModal({
  onClose,
  context = { mode: "create" },
  onAppended,
}: {
  onClose: () => void;
  context?: AutoBuildContext;
  onAppended?: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [clientName, setClientName] = useState(
    context.mode === "append" ? context.clientName : ""
  );
  const [domainsInput, setDomainsInput] = useState("");
  const [aliasesInput, setAliasesInput] = useState("");
  const [namesInput, setNamesInput] = useState("");
  const [sinceInput, setSinceInput] = useState("");
  const [untilInput, setUntilInput] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selected, setSelected] = useState<{
    calendar: Set<string>;
    transcripts: Set<string>;
    emails: Set<string>;
    signals: Set<string>;
  }>({ calendar: new Set(), transcripts: new Set(), emails: new Set(), signals: new Set() });
  const [error, setError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);

  function toList(s: string) {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }

  async function runSearch() {
    if (!clientName.trim()) return;
    setPhase("searching");
    setError(null);
    try {
      const body: Record<string, unknown> = { client_name: clientName.trim() };
      const customDomains = toList(domainsInput);
      const customAliases = toList(aliasesInput);
      const customNames = toList(namesInput);
      if (customDomains.length || customAliases.length || customNames.length) {
        body.expanded = {
          domains: customDomains,
          aliases: customAliases.length ? customAliases : [clientName.trim()],
          names: customNames,
        };
      }
      if (sinceInput) body.since = sinceInput;
      if (untilInput) body.until = untilInput;
      const res = await fetch("/api/engagements/client-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const ct = res.headers.get("content-type") || "(none)";
      if (!res.ok) {
        throw new Error(`[v2] client-search HTTP ${res.status} (${ct}): ${text.slice(0, 240)}`);
      }
      let data: SearchResult;
      try {
        data = JSON.parse(text);
      } catch {
        const looksLikeHtml = text.trimStart().startsWith("<");
        const hint = looksLikeHtml
          ? "[v2] client-search returned HTML — proxy or upstream timed out, or the route handler isn't in the running build."
          : `[v2] client-search returned non-JSON (content-type "${ct}").`;
        throw new Error(`${hint} First 200 chars of body: ${text.slice(0, 200)}`);
      }
      setResult(data);
      // Preselect only group primaries by default. A recurring weekly that
      // shows up 50 times shouldn't get 50 default-checked rows — just the
      // most-recent representative. Items without group metadata (signals,
      // pre-dedup payloads) get treated as their own group.
      const pickPrimaries = (xs: Candidate[]) =>
        new Set(xs.filter((c) => c.is_group_primary !== false).map((c) => c.id));
      setSelected({
        calendar: pickPrimaries(data.sources.calendar),
        transcripts: pickPrimaries(data.sources.transcripts),
        emails: pickPrimaries(data.sources.emails),
        signals: pickPrimaries(data.sources.signals),
      });
      // Sync the inputs with what the LLM found, so the user can edit them.
      if (!customDomains.length) setDomainsInput(data.expanded.domains.join(", "));
      if (!customAliases.length) setAliasesInput(data.expanded.aliases.join(", "));
      if (!customNames.length) setNamesInput(data.expanded.names.join(", "));
      setPhase("review");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }

  function toggle(group: keyof typeof selected, id: string) {
    setSelected((s) => {
      const next = new Set(s[group]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...s, [group]: next };
    });
  }

  function selectedTotal() {
    return selected.calendar.size + selected.transcripts.size + selected.emails.size + selected.signals.size;
  }

  async function runBuild() {
    if (!result) return;
    if (selectedTotal() === 0) return;
    setPhase("building");
    setError(null);
    try {
      const res = await fetch("/api/engagements/auto-build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: result.client_name,
          existing_engagement_id: context.mode === "append" ? context.engagementId : undefined,
          confirmed_domains: result.expanded.domains,
          selections: {
            calendar_ids: [...selected.calendar],
            transcript_ids: [...selected.transcripts],
            message_ids: [...selected.emails],
            signal_ids: [...selected.signals],
          },
        }),
      });
      const text = await res.text();
      const ct = res.headers.get("content-type") || "(none)";
      let data: { engagement_id: string; ingested_count: number; synth_error: string | null; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        const head = text.slice(0, 200);
        if (text.trimStart().startsWith("<")) {
          throw new Error(
            `[v2] auto-build returned HTML (status ${res.status}, content-type ${ct}). This means the proxy or upstream timed out before the response could come back. The engagement may have been created anyway — check /engagements. First 200 chars: ${head}`
          );
        }
        throw new Error(`[v2] auto-build returned non-JSON (status ${res.status}, content-type ${ct}). First 200 chars: ${head}`);
      }
      if (!res.ok) throw new Error(data?.error || `[v2] auto-build returned status ${res.status}`);
      setBuildResult(data as BuildResult);
      setPhase("done");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }

  function fmtDate(d: string | null | undefined) {
    if (!d) return "";
    try {
      return new Date(d).toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={phase === "building" ? undefined : onClose}
    >
      <div
        className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-100">
            {context.mode === "append"
              ? `Add more sources to "${context.engagementName}"`
              : "Auto-build engagement from client knowledge"}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* PHASE: input / searching / error */}
          {(phase === "input" || phase === "searching" || phase === "error") && (
            <div className="space-y-4 max-w-2xl">
              <div>
                <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                  Client name
                </label>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="e.g. Xyz Corp, Principal Venture Partners"
                  className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                  autoFocus
                />
              </div>
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer hover:text-zinc-300">
                  Override the LLM expansion (optional)
                </summary>
                <div className="mt-3 space-y-2 pl-3 border-l border-white/10">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                      Domains (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={domainsInput}
                      onChange={(e) => setDomainsInput(e.target.value)}
                      placeholder="xyzcorp.com, xyz.com"
                      className="w-full px-2 py-1 text-xs bg-zinc-950 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                      Title aliases
                    </label>
                    <input
                      type="text"
                      value={aliasesInput}
                      onChange={(e) => setAliasesInput(e.target.value)}
                      placeholder="Xyz Corp, Xyz"
                      className="w-full px-2 py-1 text-xs bg-zinc-950 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                      Contact names
                    </label>
                    <input
                      type="text"
                      value={namesInput}
                      onChange={(e) => setNamesInput(e.target.value)}
                      placeholder="Jane Doe, John Roe"
                      className="w-full px-2 py-1 text-xs bg-zinc-950 border border-white/10 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                        Since (YYYY-MM-DD)
                      </label>
                      <input
                        type="date"
                        value={sinceInput}
                        onChange={(e) => setSinceInput(e.target.value)}
                        className="w-full px-2 py-1 text-xs bg-zinc-950 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                        Until
                      </label>
                      <input
                        type="date"
                        value={untilInput}
                        onChange={(e) => setUntilInput(e.target.value)}
                        className="w-full px-2 py-1 text-xs bg-zinc-950 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>
                </div>
              </details>
              {error && <div className="text-sm text-red-400">{error}</div>}
              {phase === "searching" && (
                <div className="text-sm text-zinc-400">Searching knowledge base…</div>
              )}
            </div>
          )}

          {/* PHASE: review */}
          {phase === "review" && result && (
            <div className="space-y-4">
              <div className="bg-zinc-950 border border-white/5 rounded p-3 text-xs text-zinc-400">
                <div className="mb-1">
                  <span className="text-zinc-500">Searching for:</span>{" "}
                  <span className="text-zinc-200">{result.client_name}</span>
                </div>
                <div className="mb-1">
                  <span className="text-zinc-500">Domains:</span> {result.expanded.domains.join(", ") || "—"}
                </div>
                <div className="mb-1">
                  <span className="text-zinc-500">Aliases:</span> {result.expanded.aliases.join(", ") || "—"}
                </div>
                {result.expanded.names.length > 0 && (
                  <div className="mb-1">
                    <span className="text-zinc-500">Names:</span> {result.expanded.names.join(", ")}
                  </div>
                )}
                {result.expanded.rationale && (
                  <div className="mt-2 text-[10px] text-zinc-600 italic">
                    {result.expanded.rationale}
                  </div>
                )}
              </div>

              <CandidateGroup
                title="Meetings (calendar)"
                items={result.sources.calendar}
                selected={selected.calendar}
                onToggle={(id) => toggle("calendar", id)}
                onToggleAll={(check) =>
                  setSelected((s) => ({
                    ...s,
                    calendar: check ? new Set(result.sources.calendar.map((c) => c.id)) : new Set(),
                  }))
                }
                renderMeta={(c) => `${fmtDate(c.date)} · ${c.attendee_emails?.length || 0} attendees`}
              />
              <CandidateGroup
                title="Transcripts"
                items={result.sources.transcripts}
                selected={selected.transcripts}
                onToggle={(id) => toggle("transcripts", id)}
                onToggleAll={(check) =>
                  setSelected((s) => ({
                    ...s,
                    transcripts: check ? new Set(result.sources.transcripts.map((c) => c.id)) : new Set(),
                  }))
                }
                renderMeta={(c) => `${fmtDate(c.date)} · ${c.speakers?.length || 0} speakers`}
              />
              <CandidateGroup
                title="Emails"
                items={result.sources.emails}
                selected={selected.emails}
                onToggle={(id) => toggle("emails", id)}
                onToggleAll={(check) =>
                  setSelected((s) => ({
                    ...s,
                    emails: check ? new Set(result.sources.emails.map((c) => c.id)) : new Set(),
                  }))
                }
                renderMeta={(c) => `${fmtDate(c.date)} · from ${c.from || "?"}`}
              />
              <CandidateGroup
                title="Signals"
                items={result.sources.signals}
                selected={selected.signals}
                onToggle={(id) => toggle("signals", id)}
                onToggleAll={(check) =>
                  setSelected((s) => ({
                    ...s,
                    signals: check ? new Set(result.sources.signals.map((c) => c.id)) : new Set(),
                  }))
                }
                renderMeta={(c) => `${fmtDate(c.date)} · ${c.signal_type} · ${c.direction || ""}`}
              />

              {result.counts.total === 0 && (
                <div className="text-sm text-zinc-500 text-center py-6">
                  Nothing matched. Try editing the domains/aliases above and search again.
                </div>
              )}
            </div>
          )}

          {/* PHASE: building / done */}
          {phase === "building" && (
            <div className="py-8 text-center">
              <div className="text-sm text-zinc-300 mb-2">Starting the build…</div>
              <div className="text-xs text-zinc-500">
                Kicking off ingest of {selectedTotal()} source{selectedTotal() === 1 ? "" : "s"}.
              </div>
            </div>
          )}

          {phase === "done" && buildResult && (
            <div className="space-y-3">
              <div className="text-sm text-emerald-400">
                {buildResult.status === "building"
                  ? (context.mode === "append"
                      ? "Appending to engagement in the background."
                      : "Engagement created. Ingest and synth are running in the background.")
                  : context.mode === "append"
                    ? `Added ${buildResult.ingested_count ?? 0} source${buildResult.ingested_count === 1 ? "" : "s"}.`
                    : `Engagement created. ${buildResult.ingested_count ?? 0} sources ingested.`}
                {buildResult.message && (
                  <div className="text-xs text-zinc-400 mt-1">{buildResult.message}</div>
                )}
                {buildResult.synth_error && (
                  <div className="text-amber-400 mt-1 text-xs">
                    Synth had an issue: {buildResult.synth_error}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                {context.mode === "append" ? (
                  <button
                    onClick={() => {
                      onAppended?.();
                      onClose();
                    }}
                    className="px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded"
                  >
                    Refresh engagement
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      router.push(`/engagements/${buildResult.engagement_id}`);
                      onClose();
                    }}
                    className="px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded"
                  >
                    Open engagement →
                  </button>
                )}
              </div>
              <p className="text-[10px] text-zinc-600">
                Proposals and sections will appear on the engagement page as ingest and synth complete. Refresh to see progress.
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          {phase === "input" || phase === "error" ? (
            <>
              <button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded">
                Cancel
              </button>
              <button
                onClick={runSearch}
                disabled={!clientName.trim()}
                className="px-3 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded"
              >
                Find content
              </button>
            </>
          ) : phase === "review" ? (
            <>
              <button
                onClick={() => setPhase("input")}
                className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded"
              >
                ← Back
              </button>
              <button
                onClick={runBuild}
                disabled={selectedTotal() === 0}
                className="px-3 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded"
              >
                Create engagement with {selectedTotal()} source{selectedTotal() === 1 ? "" : "s"}
              </button>
            </>
          ) : phase === "done" ? (
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded">
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CandidateGroup({
  title,
  items,
  selected,
  onToggle,
  onToggleAll,
  renderMeta,
}: {
  title: string;
  items: Candidate[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (allSelected: boolean) => void;
  renderMeta: (c: Candidate) => string;
}) {
  if (!items.length) return null;
  const [showDetailFor, setShowDetailFor] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const allSelected = items.every((c) => selected.has(c.id));

  // Build group map preserving date-desc order: each group rendered once at
  // the position of its primary; members listed inside an expander.
  const groups: { key: string; primary: Candidate; members: Candidate[] }[] = [];
  const seen = new Set<string>();
  for (const c of items) {
    const key = c.group_key || c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const all = items.filter((x) => (x.group_key || x.id) === key);
    const primary = all.find((x) => x.is_group_primary) || all[0];
    const members = all.filter((x) => x !== primary);
    groups.push({ key, primary, members });
  }

  function toggleDetails(id: string) {
    setShowDetailFor((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleGroupExpansion(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderItem(c: Candidate, isMember = false) {
    return (
      <div
        key={c.id}
        className={`hover:bg-zinc-900/50 ${isMember ? "bg-zinc-950/40" : ""}`}
      >
        <label className={`flex items-start gap-2 px-3 py-2 cursor-pointer ${isMember ? "pl-8" : ""}`}>
          <input
            type="checkbox"
            checked={selected.has(c.id)}
            onChange={() => onToggle(c.id)}
            className="mt-1 accent-emerald-600"
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-200 truncate">{c.title}</div>
            <div className="text-[10px] text-zinc-500">{renderMeta(c)}</div>
            {c.snippet && (
              <div className="text-[10px] text-zinc-600 italic mt-1 line-clamp-2">
                {c.snippet}
              </div>
            )}
          </div>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleDetails(c.id);
            }}
            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 self-start mt-1"
            title="Show all candidate details"
          >
            {showDetailFor.has(c.id) ? "less" : "more"}
          </button>
        </label>
        {showDetailFor.has(c.id) && (
          <div className="text-[10px] text-zinc-400 bg-zinc-950 px-3 py-2 border-t border-white/5">
            <CandidateDetail c={c} />
          </div>
        )}
      </div>
    );
  }

  return (
    <details open className="border border-white/5 rounded">
      <summary className="cursor-pointer select-none px-3 py-2 bg-zinc-950/60 hover:bg-zinc-950 text-xs flex items-center">
        <span className="text-zinc-300">{title}</span>
        <span className="text-zinc-500 ml-2">
          ({selected.size}/{items.length}
          {groups.length !== items.length ? ` · ${groups.length} groups` : ""})
        </span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleAll(!allSelected);
          }}
          className="ml-auto text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded hover:bg-zinc-800"
        >
          {allSelected ? "uncheck all" : "check all"}
        </button>
      </summary>
      <div className="divide-y divide-white/5">
        {groups.map((g) => (
          <div key={g.key}>
            {renderItem(g.primary)}
            {g.members.length > 0 && (
              <>
                <button
                  onClick={() => toggleGroupExpansion(g.key)}
                  className="w-full text-left px-3 py-1.5 pl-8 text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50 border-t border-white/5"
                >
                  {expandedGroups.has(g.key)
                    ? `▼ Hide ${g.members.length} more in this recurring series`
                    : `▶ ${g.members.length} more in this recurring series (collapsed by default)`}
                </button>
                {expandedGroups.has(g.key) && (
                  <div className="divide-y divide-white/5">
                    {g.members.map((m) => renderItem(m, true))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function CandidateDetail({ c }: { c: Candidate }) {
  return (
    <dl className="space-y-1">
      <DetailRow label="id" value={c.id} />
      <DetailRow label="date" value={c.date || "—"} />
      {c.organizer && <DetailRow label="organizer" value={c.organizer} />}
      {c.attendee_emails && c.attendee_emails.length > 0 && (
        <DetailRow label="attendees" value={c.attendee_emails.join(", ")} />
      )}
      {c.speakers && c.speakers.length > 0 && (
        <DetailRow label="speakers" value={c.speakers.join(", ")} />
      )}
      {c.from && <DetailRow label="from" value={c.from} />}
      {c.to && c.to.length > 0 && <DetailRow label="to" value={c.to.join(", ")} />}
      {c.signal_type && <DetailRow label="type" value={c.signal_type} />}
      {c.direction && <DetailRow label="direction" value={c.direction} />}
      {c.domain && <DetailRow label="domain" value={c.domain} />}
      {c.snippet && <DetailRow label="snippet" value={c.snippet} />}
    </dl>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-zinc-600 w-20 shrink-0">{label}</dt>
      <dd className="text-zinc-400 break-words flex-1">{value}</dd>
    </div>
  );
}
