import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  certDaysRemaining,
  evaluateTarget,
  getMonitorTargets,
} from '../src/monitoring/uptime-cert-monitor.js';

const NOW = Date.parse('2026-06-02T00:00:00Z');

describe('certDaysRemaining', () => {
  it('counts whole days to NotAfter (ISO and OpenSSL formats)', () => {
    assert.equal(certDaysRemaining('2026-06-12T00:00:00Z', NOW), 10);
    assert.equal(certDaysRemaining('Jun 12 00:00:00 2026 GMT', NOW), 10);
  });
  it('is negative for an already-expired cert', () => {
    assert.ok(certDaysRemaining('2026-05-30T00:00:00Z', NOW) < 0);
  });
  it('returns null for an unparseable date', () => {
    assert.equal(certDaysRemaining('not-a-date', NOW), null);
    assert.equal(certDaysRemaining(null, NOW), null);
  });
});

describe('evaluateTarget', () => {
  const target = { name: 'board', url: 'https://board.staqs.io/', host: 'board.staqs.io' };
  const healthyCert = { ok: true, validTo: '2026-08-01T00:00:00Z' }; // ~60d out

  it('no alerts when http ok (2xx/3xx) and cert healthy', () => {
    const a = evaluateTarget(target, { ok: true, status: 307 }, healthyCert, 21, NOW);
    assert.deepEqual(a, []);
  });

  it('alerts DOWN on non-2xx/3xx (e.g. 525)', () => {
    const a = evaluateTarget(target, { ok: false, status: 525 }, healthyCert, 21, NOW);
    assert.equal(a.length, 1);
    assert.match(a[0], /DOWN: board .* 525/);
  });

  it('alerts CERT EXPIRING when within the warning window', () => {
    const cert = { ok: true, validTo: '2026-06-12T00:00:00Z' }; // 10d < 21d
    const a = evaluateTarget(target, { ok: true, status: 200 }, cert, 21, NOW);
    assert.equal(a.length, 1);
    assert.match(a[0], /CERT EXPIRING: board\.staqs\.io in 10d/);
  });

  it('does NOT alert on a cert comfortably beyond the window', () => {
    const cert = { ok: true, validTo: '2026-07-15T00:00:00Z' }; // ~43d
    const a = evaluateTarget(target, { ok: true, status: 200 }, cert, 21, NOW);
    assert.deepEqual(a, []);
  });

  it('alerts CERT CHECK FAILED when the TLS handshake fails', () => {
    const a = evaluateTarget(target, { ok: true, status: 200 }, { ok: false, error: 'tls handshake timeout' }, 21, NOW);
    assert.equal(a.length, 1);
    assert.match(a[0], /CERT CHECK FAILED: board\.staqs\.io/);
  });

  it('can raise both a DOWN and a CERT alert at once', () => {
    const cert = { ok: true, validTo: '2026-06-05T00:00:00Z' }; // 3d
    const a = evaluateTarget(target, { ok: false, status: 0, error: 'timeout' }, cert, 21, NOW);
    assert.equal(a.length, 2);
  });
});

describe('getMonitorTargets', () => {
  it('defaults to board + api with host derived from url', () => {
    const t = getMonitorTargets({});
    assert.equal(t.length, 2);
    assert.deepEqual(t.map((x) => x.name).sort(), ['api', 'board']);
    assert.equal(t.find((x) => x.name === 'board').host, 'board.staqs.io');
  });

  it('parses MONITOR_TARGETS="name=url,name=url"', () => {
    const t = getMonitorTargets({ MONITOR_TARGETS: 'x=https://x.example.com/health,y=https://y.example.org/' });
    assert.equal(t.length, 2);
    assert.equal(t[0].name, 'x');
    assert.equal(t[0].host, 'x.example.com');
    assert.equal(t[1].host, 'y.example.org');
  });

  it('drops malformed entries (no "=" or bad url)', () => {
    const t = getMonitorTargets({ MONITOR_TARGETS: 'bad,ok=https://ok.example.com/,nourl=not a url' });
    assert.equal(t.length, 1);
    assert.equal(t[0].name, 'ok');
  });
});
