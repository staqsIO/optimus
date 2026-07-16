"use client";

/**
 * Brand profiles management.
 *
 * Each profile drives how a contract PDF/DOCX is styled at render time:
 * heading font + brand color, body font, page-header logo, footer
 * chrome. A profile can be marked as the system default (rendered when
 * neither the draft nor the counterparty names a profile explicitly).
 *
 * Asset uploads (logo PNG + 8 TTF font weights) round-trip through
 * /api/brand-profiles/:id/assets/:kind as base64-in-JSON. We don't use
 * multipart because the existing ops proxy only speaks JSON.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { opsFetch, opsPost, opsPatch, opsDelete } from "@/lib/ops-api";

interface BrandProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  heading_font_family: string;
  body_font_family: string;
  brand_color_hex: string;
  show_logo_in_header: boolean;
  footer_left_text: string;
  footer_show_page_number: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  asset_count: number;
  counterparty_count: number;
}

interface AssetSummary {
  asset_kind: string;
  mime_type: string;
  size_bytes: number;
  width_px: number | null;
  height_px: number | null;
  updated_at: string;
}

const ASSET_LABELS: Record<string, string> = {
  logo: "Logo (PNG)",
  font_heading_regular:     "Heading – Regular",
  font_heading_bold:        "Heading – Bold",
  font_heading_italic:      "Heading – Italic",
  font_heading_bold_italic: "Heading – Bold Italic",
  font_body_regular:        "Body – Regular",
  font_body_bold:           "Body – Bold",
  font_body_italic:         "Body – Italic",
  font_body_bold_italic:    "Body – Bold Italic",
};

const FONT_WEIGHTS: { kind: string; label: string }[] = [
  { kind: "font_heading_regular",     label: "Heading – Regular" },
  { kind: "font_heading_bold",        label: "Heading – Bold" },
  { kind: "font_heading_italic",      label: "Heading – Italic" },
  { kind: "font_heading_bold_italic", label: "Heading – Bold Italic" },
  { kind: "font_body_regular",        label: "Body – Regular" },
  { kind: "font_body_bold",           label: "Body – Bold" },
  { kind: "font_body_italic",         label: "Body – Italic" },
  { kind: "font_body_bold_italic",    label: "Body – Bold Italic" },
];

// Curated suggestions for the font dropdowns. Operators can type any other
// family name, but these are the ones we've validated end-to-end.
const SUGGESTED_FONTS = [
  "Calibri",
  "Cormorant Garamond",
  "DM Sans",
  "Georgia",
  "Helvetica",
  "Inter",
  "Lato",
  "Merriweather",
  "Open Sans",
  "Playfair Display",
  "Source Sans Pro",
  "Times New Roman",
];

export default function BrandingPage() {
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailAssets, setDetailAssets] = useState<AssetSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    name: "",
    slug: "",
    description: "",
    heading_font_family: "Cormorant Garamond",
    body_font_family: "DM Sans",
    brand_color_hex: "C9A96E",
    show_logo_in_header: true,
    footer_left_text: "Confidential",
    footer_show_page_number: true,
  });
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId]
  );

  const reloadList = useCallback(async () => {
    const d = await opsFetch<{ profiles: BrandProfile[] }>("/api/brand-profiles");
    setProfiles(d?.profiles || []);
    setLoading(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const d = await opsFetch<{ profile: BrandProfile; assets: AssetSummary[] }>(
      `/api/brand-profiles/${id}`
    );
    if (!d?.profile) return;
    setDetailAssets(d.assets || []);
    setForm({
      name: d.profile.name,
      slug: d.profile.slug,
      description: d.profile.description || "",
      heading_font_family: d.profile.heading_font_family,
      body_font_family: d.profile.body_font_family,
      brand_color_hex: d.profile.brand_color_hex,
      show_logo_in_header: d.profile.show_logo_in_header,
      footer_left_text: d.profile.footer_left_text,
      footer_show_page_number: d.profile.footer_show_page_number,
    });
  }, []);

  useEffect(() => { reloadList(); }, [reloadList]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  function startNew() {
    setCreating(true);
    setSelectedId(null);
    setDetailAssets([]);
    setError(null);
    setForm({
      name: "",
      slug: "",
      description: "",
      heading_font_family: "Calibri",
      body_font_family: "Calibri",
      brand_color_hex: "111111",
      show_logo_in_header: false,
      footer_left_text: "Confidential",
      footer_show_page_number: true,
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (creating) {
        const res = await opsPost<{ ok: boolean; id: string }>("/api/brand-profiles", form);
        if (!res.ok) { setError(res.error); return; }
        await reloadList();
        setCreating(false);
        setSelectedId(res.data.id);
      } else if (selectedId) {
        // PATCH only the editable fields (slug is immutable post-create).
        const { slug: _slug, ...patchable } = form;
        void _slug;
        const res = await opsPatch<{ ok: boolean }>(
          `/api/brand-profiles/${selectedId}`,
          patchable
        );
        if (!res.ok) { setError(res.error); return; }
        await reloadList();
      }
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(id: string) {
    const res = await opsPost(`/api/brand-profiles/${id}/make-default`);
    if (!res.ok) { setError(res.error); return; }
    await reloadList();
  }

  async function archive(id: string) {
    if (!confirm("Archive this brand profile? Contracts using it will fall back to the default.")) return;
    const res = await opsPost(`/api/brand-profiles/${id}/archive`);
    if (!res.ok) { setError(res.error); return; }
    setSelectedId(null);
    await reloadList();
  }

  async function uploadAsset(kind: string, file: File) {
    const buf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const isLogo = kind === "logo";
    const mime = isLogo ? "image/png" : "font/ttf";

    let width: number | undefined;
    let height: number | undefined;
    if (isLogo) {
      const dims = await pngDimensions(file);
      width = dims.width;
      height = dims.height;
    }

    const res = await opsPost(`/api/brand-profiles/${selectedId}/assets/${kind}`, {
      mime_type: mime,
      content_base64: b64,
      width_px: width,
      height_px: height,
    });
    if (!res.ok) { setError(res.error); return; }
    if (selectedId) await loadDetail(selectedId);
    await reloadList();
  }

  async function removeAsset(kind: string) {
    if (!confirm(`Remove ${ASSET_LABELS[kind] || kind}?`)) return;
    const res = await opsDelete(`/api/brand-profiles/${selectedId}/assets/${kind}`);
    if (!res.ok) { setError(res.error); return; }
    if (selectedId) await loadDetail(selectedId);
    await reloadList();
  }

  const hasAsset = (kind: string) => detailAssets.some((a) => a.asset_kind === kind);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/contracts" className="text-xs text-zinc-500 hover:text-zinc-300">
              ← Contracts
            </Link>
            <h1 className="text-2xl font-semibold mt-1">Branding</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Fonts, color, logo, and footer chrome applied at PDF / DOCX render time.
            </p>
          </div>
          <button
            onClick={startNew}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500"
          >
            + New profile
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-800 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="grid grid-cols-12 gap-6">
          {/* Profile list */}
          <div className="col-span-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              {loading ? (
                <div className="p-4 text-sm text-zinc-500">Loading…</div>
              ) : profiles.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500">No brand profiles yet.</div>
              ) : (
                profiles.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setCreating(false); setSelectedId(p.id); }}
                    className={`w-full text-left p-3 border-b border-zinc-800 transition-colors ${
                      selectedId === p.id ? "bg-zinc-800" : "hover:bg-zinc-800/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-sm border border-zinc-700 flex-shrink-0"
                        style={{ backgroundColor: `#${p.brand_color_hex}` }}
                      />
                      <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                      {p.is_default && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 flex gap-3">
                      <span>{p.heading_font_family}</span>
                      <span>·</span>
                      <span>{p.asset_count} assets</span>
                      {p.counterparty_count > 0 && (
                        <>
                          <span>·</span>
                          <span>{p.counterparty_count} clients</span>
                        </>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="col-span-8">
            {(selected || creating) ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
                <div className="space-y-4">
                  {/* Name + slug */}
                  <div className="grid grid-cols-2 gap-3">
                    <FieldText
                      label="Name"
                      value={form.name}
                      onChange={(v) => setForm({ ...form, name: v })}
                    />
                    <FieldText
                      label="Slug"
                      value={form.slug}
                      onChange={(v) => setForm({ ...form, slug: v })}
                      disabled={!creating}
                      help={!creating ? "Slug is fixed after creation" : "lowercase-hyphen"}
                    />
                  </div>

                  <FieldText
                    label="Description"
                    value={form.description}
                    onChange={(v) => setForm({ ...form, description: v })}
                  />

                  {/* Color + fonts */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Brand color</Label>
                      <div className="flex gap-2">
                        <input
                          type="color"
                          value={`#${form.brand_color_hex}`}
                          onChange={(e) =>
                            setForm({ ...form, brand_color_hex: e.target.value.replace(/^#/, "").toUpperCase() })
                          }
                          className="w-12 h-9 rounded bg-zinc-800 border border-zinc-700 cursor-pointer"
                        />
                        <input
                          type="text"
                          value={form.brand_color_hex}
                          onChange={(e) =>
                            setForm({ ...form, brand_color_hex: e.target.value.replace(/[^0-9A-Fa-f]/g, "").slice(0, 6).toUpperCase() })
                          }
                          className="flex-1 px-2 py-1.5 text-sm font-mono bg-zinc-800 border border-zinc-700 rounded"
                          maxLength={6}
                          placeholder="C9A96E"
                        />
                      </div>
                    </div>
                    <FieldFont
                      label="Heading font"
                      value={form.heading_font_family}
                      onChange={(v) => setForm({ ...form, heading_font_family: v })}
                    />
                    <FieldFont
                      label="Body font"
                      value={form.body_font_family}
                      onChange={(v) => setForm({ ...form, body_font_family: v })}
                    />
                  </div>

                  {/* Header / Footer toggles */}
                  <div className="grid grid-cols-3 gap-3 items-end">
                    <Toggle
                      label="Show logo in page header"
                      value={form.show_logo_in_header}
                      onChange={(v) => setForm({ ...form, show_logo_in_header: v })}
                    />
                    <FieldText
                      label="Footer label (left)"
                      value={form.footer_left_text}
                      onChange={(v) => setForm({ ...form, footer_left_text: v })}
                    />
                    <Toggle
                      label="Show page number"
                      value={form.footer_show_page_number}
                      onChange={(v) => setForm({ ...form, footer_show_page_number: v })}
                    />
                  </div>

                  {/* Save row */}
                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                    <div className="flex gap-2">
                      {selected && !selected.is_default && (
                        <>
                          <button
                            onClick={() => makeDefault(selected.id)}
                            className="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                          >
                            Make default
                          </button>
                          <button
                            onClick={() => archive(selected.id)}
                            className="px-3 py-1.5 text-sm rounded bg-red-900/30 text-red-300 hover:bg-red-900/50"
                          >
                            Archive
                          </button>
                        </>
                      )}
                    </div>
                    <button
                      onClick={save}
                      disabled={saving}
                      className="px-4 py-1.5 text-sm font-medium rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {saving ? "Saving…" : creating ? "Create" : "Save changes"}
                    </button>
                  </div>
                </div>

                {/* Assets (only on existing profiles) */}
                {selected && (
                  <div className="mt-6 pt-5 border-t border-zinc-800">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-sm font-medium text-zinc-300">Assets</h2>
                      <span className="text-xs text-zinc-500">
                        Fonts embed into DOCX / @font-face into PDF. Logo replaces the page-header default.
                      </span>
                    </div>
                    <AssetRow
                      label="Logo (PNG)"
                      kind="logo"
                      present={hasAsset("logo")}
                      detail={detailAssets.find((a) => a.asset_kind === "logo")}
                      accept="image/png"
                      previewSrc={hasAsset("logo")
                        ? `/api/ops?path=${encodeURIComponent(`/api/brand-profiles/${selectedId}/assets/logo`)}`
                        : null}
                      onUpload={(f) => uploadAsset("logo", f)}
                      onRemove={() => removeAsset("logo")}
                    />
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                      {FONT_WEIGHTS.map((w) => (
                        <AssetRow
                          key={w.kind}
                          label={w.label}
                          kind={w.kind}
                          present={hasAsset(w.kind)}
                          detail={detailAssets.find((a) => a.asset_kind === w.kind)}
                          accept=".ttf,font/ttf"
                          compact
                          onUpload={(f) => uploadAsset(w.kind, f)}
                          onRemove={() => removeAsset(w.kind)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center text-sm text-zinc-500">
                Select a profile to edit, or create a new one.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny field components ────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-zinc-400 mb-1">{children}</label>;
}

function FieldText({
  label, value, onChange, disabled, help,
}: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; help?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded disabled:opacity-60"
      />
      {help && <div className="text-[11px] text-zinc-500 mt-1">{help}</div>}
    </div>
  );
}

function FieldFont({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const listId = `fonts-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div>
      <Label>{label}</Label>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded"
        placeholder="Font family name"
      />
      <datalist id={listId}>
        {SUGGESTED_FONTS.map((f) => <option key={f} value={f} />)}
      </datalist>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4"
      />
      <span className="text-xs text-zinc-300">{label}</span>
    </label>
  );
}

function AssetRow({
  label, kind, present, detail, accept, compact, previewSrc, onUpload, onRemove,
}: {
  label: string;
  kind: string;
  present: boolean;
  detail?: AssetSummary;
  accept: string;
  compact?: boolean;
  previewSrc?: string | null;
  onUpload: (f: File) => void;
  onRemove: () => void;
}) {
  const inputId = `asset-${kind}`;
  return (
    <div className={`flex items-center gap-3 p-2 rounded border border-zinc-800 ${compact ? "" : "bg-zinc-950"}`}>
      {previewSrc && (
        <div className="w-24 h-10 bg-zinc-800 rounded overflow-hidden flex-shrink-0 flex items-center justify-center">
          <img src={previewSrc} alt="" className="max-w-full max-h-full" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-zinc-300">{label}</div>
        {detail ? (
          <div className="text-[11px] text-zinc-500">
            {(detail.size_bytes / 1024).toFixed(1)} KB
            {detail.width_px ? ` · ${detail.width_px}×${detail.height_px}` : ""}
          </div>
        ) : (
          <div className="text-[11px] text-zinc-600">Not uploaded</div>
        )}
      </div>
      <label
        htmlFor={inputId}
        className="px-2 py-1 text-[11px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
      >
        {present ? "Replace" : "Upload"}
      </label>
      <input
        id={inputId}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
      {present && (
        <button
          onClick={onRemove}
          className="px-2 py-1 text-[11px] rounded bg-red-900/30 text-red-300 hover:bg-red-900/50"
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

async function pngDimensions(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
