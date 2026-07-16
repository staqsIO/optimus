import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(__dirname, 'fixtures', 'gmail');

/**
 * Gmail digital twin (Phase 2.4) — DEV/TEST SUBSTITUTION ONLY.
 *
 * Wraps the real gmail InputAdapter so verification/dev runs are deterministic
 * and offline. This is NOT a production resilience mechanism: surviving a real
 * 429/outage is a separate circuit-breaker concern (per Neo's boundary review).
 * Don't point a live run at stale fixtures.
 *
 * Modes (TWIN_GMAIL):
 *   replay — fetchContent returns a recorded fixture; never hits the network.
 *   record — fetchContent proxies the real adapter and writes the fixture.
 *   mock   — fetchContent returns a synthetic body (no fixtures needed).
 *
 * Implements the same InputAdapter interface (channel/fetchContent/
 * buildPromptContext) so it passes validateInputAdapter. buildPromptContext is a
 * pure transform and always delegates to the real adapter (no network).
 */
export function gmailTwin(realAdapter, { mode = 'replay', fixtures = null, fixturesDir = DEFAULT_FIXTURES_DIR } = {}) {
  function loadFixture(id) {
    if (fixtures && (fixtures instanceof Map ? fixtures.has(id) : id in fixtures)) {
      return fixtures instanceof Map ? fixtures.get(id) : fixtures[id];
    }
    const p = join(fixturesDir, `${id}.json`);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')).body ?? null; } catch { return null; }
    }
    return null;
  }
  function saveFixture(id, body) {
    try {
      if (!existsSync(fixturesDir)) mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(join(fixturesDir, `${id}.json`), JSON.stringify({ body }, null, 2));
    } catch { /* best-effort */ }
  }

  return {
    channel: realAdapter?.channel || 'email',

    async fetchContent(message) {
      const id = message?.id;
      if (mode === 'mock') return `[twin:mock body for message ${id}]`;
      if (mode === 'replay') {
        const body = loadFixture(id);
        if (body == null) throw new Error(`gmail-twin replay: no fixture for message ${id}`);
        return body;
      }
      if (mode === 'record') {
        const body = await realAdapter.fetchContent(message);
        saveFixture(id, body);
        return body;
      }
      // Unknown mode → passthrough.
      return realAdapter.fetchContent(message);
    },

    // Pure transform — always real (no network).
    buildPromptContext(message, body) {
      return realAdapter.buildPromptContext(message, body);
    },
  };
}
