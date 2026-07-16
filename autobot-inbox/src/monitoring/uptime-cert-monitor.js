/**
 * Uptime + TLS-cert-expiry monitor (STAQPRO-606).
 *
 * Motivated by the 2026-06-02 board.staqs.io 525 outage: a Railway Let's Encrypt
 * cert expired (renewal silently blocked by the Cloudflare proxy) and nobody
 * noticed until a human hit the page. This monitor would have alerted ~21 days
 * before expiry AND on the outage itself.
 *
 * Two checks per target:
 *   1. HTTP probe — alert on non-2xx/3xx (525, 5xx, timeouts).
 *   2. TLS cert expiry — read the origin cert's NotAfter; alert when the cert is
 *      within MONITOR_CERT_WARN_DAYS of expiring (default 21) — this catches a
 *      blocked/failing auto-renewal ~30 days early, before it 525s.
 *
 * Runs in-process on the API scheduler. Caveat: it can't fully self-monitor the
 * API host it runs on (if that's down, the monitor is down too) — but it covers
 * the *board* (the surface that actually broke) and cert-expiry on every domain.
 * The exported pure helpers + runUptimeCertMonitor() also make it runnable as a
 * standalone external cron (see scripts/uptime-cert-monitor.mjs).
 */
import tls from 'node:tls';

const DAY_MS = 86_400_000;

/** Default surfaces to watch. Override with MONITOR_TARGETS="name=url,name=url". */
const DEFAULT_TARGETS = [
  { name: 'board', url: 'https://board.staqs.io/' },
  { name: 'api', url: 'https://preview.staqs.io/api/health' },
];

/** Cert-expiry warning threshold in days. */
export function certWarnDays() {
  const n = parseInt(process.env.MONITOR_CERT_WARN_DAYS || '21', 10);
  return Number.isFinite(n) && n > 0 ? n : 21;
}

/**
 * Resolve the target list. Pure given env. MONITOR_TARGETS format is a
 * comma-separated list of `name=url` (host is derived from the url).
 * @returns {Array<{name:string,url:string,host:string}>}
 */
export function getMonitorTargets(env = process.env) {
  const raw = String(env.MONITOR_TARGETS || '').trim();
  const specs = raw
    ? raw.split(',').map((s) => {
        const eq = s.indexOf('=');
        if (eq === -1) return null;
        return { name: s.slice(0, eq).trim(), url: s.slice(eq + 1).trim() };
      }).filter((t) => t && t.name && t.url)
    : DEFAULT_TARGETS;
  return specs
    .map((t) => {
      try {
        return { name: t.name, url: t.url, host: new URL(t.url).hostname };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Whole days until a cert's NotAfter, given the cert's `valid_to` string and
 * a reference timestamp. Pure. Returns null if unparseable.
 */
export function certDaysRemaining(validTo, now = Date.now()) {
  const exp = Date.parse(validTo);
  if (!Number.isFinite(exp)) return null;
  return Math.floor((exp - now) / DAY_MS);
}

/**
 * Decide alert lines for one target from its HTTP + cert probe results. Pure.
 * @returns {string[]} zero or more human-readable alert strings
 */
export function evaluateTarget(target, http, cert, warnDays = 21, now = Date.now()) {
  const alerts = [];
  if (!http.ok) {
    alerts.push(`DOWN: ${target.name} (${target.url}) → ${http.status || http.error || 'no response'}`);
  }
  if (cert.ok && cert.validTo) {
    const days = certDaysRemaining(cert.validTo, now);
    if (days !== null && days < warnDays) {
      alerts.push(`CERT EXPIRING: ${target.host} in ${days}d (NotAfter ${cert.validTo})`);
    }
  } else if (!cert.ok) {
    alerts.push(`CERT CHECK FAILED: ${target.host} → ${cert.error || 'unknown'}`);
  }
  return alerts;
}

/** HTTP probe. 2xx/3xx = ok (3xx covers the board's NextAuth login redirect). */
async function probeHttp(url, timeoutMs = 10_000) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.status >= 200 && r.status < 400, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 100) };
  }
}

/** Read the origin TLS cert's NotAfter via a raw TLS handshake. */
function probeCert(host, port = 443, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      finish({ ok: true, validTo: cert?.valid_to || null });
      socket.end();
    });
    socket.on('error', (e) => { finish({ ok: false, error: String(e?.message || e).slice(0, 100) }); socket.destroy(); });
    socket.on('timeout', () => { finish({ ok: false, error: 'tls handshake timeout' }); socket.destroy(); });
  });
}

/**
 * Probe all targets, evaluate, and (if a notify fn is given) alert on any
 * problem. Best-effort: probe/notify failures never throw out of here.
 * @param {{notify?: (text:string)=>Promise<any>, now?: number}} [opts]
 * @returns {Promise<{summary:Array, alerts:string[]}>}
 */
export async function runUptimeCertMonitor({ notify, now = Date.now() } = {}) {
  const targets = getMonitorTargets();
  const warn = certWarnDays();
  const summary = [];
  const alerts = [];
  for (const t of targets) {
    const [http, cert] = await Promise.all([probeHttp(t.url), probeCert(t.host)]);
    const targetAlerts = evaluateTarget(t, http, cert, warn, now);
    summary.push({
      name: t.name,
      status: http.ok ? http.status : (http.status || http.error),
      certDays: cert.ok && cert.validTo ? certDaysRemaining(cert.validTo, now) : null,
    });
    alerts.push(...targetAlerts);
  }
  if (alerts.length && typeof notify === 'function') {
    try {
      await notify(`🚨 Optimus uptime/cert monitor — ${alerts.length} alert(s):\n• ${alerts.join('\n• ')}`);
    } catch (e) {
      console.error(`[uptime-cert-monitor] notify failed: ${e?.message || e}`);
    }
  }
  return { summary, alerts };
}
