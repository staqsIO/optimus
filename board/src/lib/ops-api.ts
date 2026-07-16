export async function opsFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/ops?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export type OpsPostResult<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: string;
}

export async function opsPatch<T>(path: string, body?: unknown): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    });
    if (!res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { ok: false, error: (err as { error?: string }).error || `HTTP ${res.status}` };
      }
      const text = (await res.text().catch(() => "")).trim().slice(0, 400);
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}

export async function opsPost<T>(path: string, body?: unknown): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    });
    if (!res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { ok: false, error: (err as { error?: string }).error || `HTTP ${res.status}` };
      }
      const text = (await res.text().catch(() => "")).trim().slice(0, 400);
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}

export async function opsDelete<T>(path: string): Promise<OpsPostResult<T>> {
  try {
    const res = await fetch("/api/ops", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return { ok: false, error: (err as { error?: string }).error || `HTTP ${res.status}` };
      }
      const text = (await res.text().catch(() => "")).trim().slice(0, 400);
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Backend unreachable" };
  }
}
