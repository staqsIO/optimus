const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiFetch<T>(path: string, opts?: RequestInit & { timeout?: number }): Promise<T> {
  const { timeout: customTimeout, ...fetchOpts } = opts || {};
  const controller = new AbortController();
  const timeoutMs = customTimeout || 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...fetchOpts,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...fetchOpts?.headers },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return res.json();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`API ${path}: timeout after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
