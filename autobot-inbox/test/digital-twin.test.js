import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { twinMode, isTwinEnabled, wrapWithTwin } from '../../lib/twins/twin-registry.js';
import { gmailTwin } from '../../lib/twins/gmail-twin.js';
import { validateInputAdapter } from '../../lib/adapters/input-adapter.js';

// A minimal real adapter that hits the "network" (which we must avoid in replay).
function fakeRealAdapter() {
  return {
    channel: 'email',
    fetchContent: async () => { throw new Error('NETWORK CALLED — twin should have prevented this'); },
    buildPromptContext: (message, body) => ({ channel: 'email', body, id: message?.id }),
  };
}

describe('digital twin — twin-registry (Phase 2.4)', () => {
  const KEY = 'TWIN_GMAIL';
  beforeEach(() => { delete process.env[KEY]; });

  it('disabled by default (no env) → no-op passthrough', () => {
    assert.equal(isTwinEnabled('gmail'), false);
    const real = fakeRealAdapter();
    assert.equal(wrapWithTwin('gmail', real), real, 'returns the SAME adapter object when off');
  });

  it('twinMode parses replay/record/mock, rejects garbage', () => {
    process.env[KEY] = 'replay'; assert.equal(twinMode('gmail'), 'replay');
    process.env[KEY] = 'RECORD'; assert.equal(twinMode('gmail'), 'record');
    process.env[KEY] = 'nonsense'; assert.equal(twinMode('gmail'), null);
  });

  it('enabled → wraps with a twin that still satisfies the InputAdapter interface', () => {
    process.env[KEY] = 'replay';
    const wrapped = wrapWithTwin('gmail', fakeRealAdapter());
    assert.notEqual(wrapped, null);
    assert.equal(validateInputAdapter(wrapped).valid, true, 'twin must pass adapter validation');
  });
});

describe('digital twin — gmail-twin behavior', () => {
  it('replay returns the fixture and NEVER hits the network', async () => {
    const twin = gmailTwin(fakeRealAdapter(), { mode: 'replay', fixtures: { 'msg-1': 'recorded body' } });
    assert.equal(await twin.fetchContent({ id: 'msg-1' }), 'recorded body');
  });

  it('replay with a missing fixture throws (so a gap is loud, not silent)', async () => {
    const twin = gmailTwin(fakeRealAdapter(), { mode: 'replay', fixtures: {} });
    await assert.rejects(() => twin.fetchContent({ id: 'absent' }), /no fixture/i);
  });

  it('mock returns a synthetic body with no fixtures and no network', async () => {
    const twin = gmailTwin(fakeRealAdapter(), { mode: 'mock' });
    const body = await twin.fetchContent({ id: 'x' });
    assert.match(body, /twin:mock/);
  });

  it('buildPromptContext is a pure delegate (no network)', () => {
    const twin = gmailTwin(fakeRealAdapter(), { mode: 'replay', fixtures: {} });
    assert.deepEqual(twin.buildPromptContext({ id: 'x' }, 'b'), { channel: 'email', body: 'b', id: 'x' });
  });
});
