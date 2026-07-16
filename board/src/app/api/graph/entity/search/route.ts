import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * GET /api/graph/entity/search?q=<term>
 *
 * Searches contacts, organizations, and topics for the entity autocomplete
 * in the Knowledge Graph Tier 1 topbar. Returns max 8 results.
 *
 * Fans out to the three existing signal-entity endpoints in parallel and
 * merges, deduping by id.
 */
export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  const qs = `q=${encodeURIComponent(q)}&limit=8`;

  // Try native endpoint first
  const nativeRes = await fetch(
    `${OPS_API_URL}/api/graph/entity/search?${qs}`,
    { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  ).catch(() => null);

  if (nativeRes?.ok) {
    return NextResponse.json(await nativeRes.json());
  }

  // Fallback: fan out to contacts + orgs + topics in parallel
  const [contactsRes, orgsRes, topicsRes] = await Promise.all([
    fetch(`${OPS_API_URL}/api/contacts?${qs}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => null),
    fetch(`${OPS_API_URL}/api/organizations?${qs}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => null),
    fetch(`${OPS_API_URL}/api/signals/topics?${qs}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => null),
  ]);

  type SearchHit = { id: string; label: string; type: string };
  const seen = new Set<string>();
  const results: SearchHit[] = [];

  function addHits(
    res: Response | null,
    type: "person" | "organization" | "topic",
    nameKey = "name"
  ) {
    if (!res) return;
    // We parse synchronously after the awaited parallel block
  }
  void addHits; // suppress unused-var lint — actual merging below

  type ContactItem = { id?: string; name?: string; email?: string };
  type OrgItem = { id?: string; name?: string };
  type TopicItem = { id?: string; label?: string; name?: string };

  const [contacts, orgs, topics] = await Promise.all([
    contactsRes?.ok
      ? (contactsRes.json() as Promise<ContactItem[] | { contacts: ContactItem[] }>)
      : Promise.resolve([]),
    orgsRes?.ok
      ? (orgsRes.json() as Promise<OrgItem[] | { organizations: OrgItem[] }>)
      : Promise.resolve([]),
    topicsRes?.ok
      ? (topicsRes.json() as Promise<TopicItem[] | { topics: TopicItem[] }>)
      : Promise.resolve([]),
  ]);

  // Normalise array vs envelope shapes
  const contactList: ContactItem[] = Array.isArray(contacts)
    ? contacts
    : (contacts as { contacts: ContactItem[] }).contacts ?? [];
  const orgList: OrgItem[] = Array.isArray(orgs)
    ? orgs
    : (orgs as { organizations: OrgItem[] }).organizations ?? [];
  const topicList: TopicItem[] = Array.isArray(topics)
    ? topics
    : (topics as { topics: TopicItem[] }).topics ?? [];

  for (const c of contactList) {
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    results.push({ id: c.id, label: c.name || c.email || c.id, type: "person" });
    if (results.length >= 8) break;
  }
  for (const o of orgList) {
    if (!o.id || seen.has(o.id)) continue;
    seen.add(o.id);
    results.push({ id: o.id, label: o.name || o.id, type: "organization" });
    if (results.length >= 8) break;
  }
  for (const t of topicList) {
    if (!t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    results.push({ id: t.id, label: t.label || t.name || t.id, type: "topic" });
    if (results.length >= 8) break;
  }

  return NextResponse.json({ results: results.slice(0, 8) });
}
