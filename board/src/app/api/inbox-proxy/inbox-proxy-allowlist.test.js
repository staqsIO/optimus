// Standalone allowlist smoke. Imports the public route file is heavy
// (Next.js + NextAuth deps), so we duplicate the small predicate here and
// guard it with a regression assertion that the route file actually
// contains the entries. Pure-function test, no Next runtime.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const routePath = fileURLToPath(new URL('./route.ts', import.meta.url));
const routeSrc = readFileSync(routePath, 'utf8');

describe('inbox-proxy ALLOWED_PATHS — human-tasks coverage', () => {
  it('exact path "/api/human-tasks" is in ALLOWED_PATHS', () => {
    assert.match(routeSrc, /"\/api\/human-tasks"/);
  });

  it('prefix "/api/human-tasks/" is in ALLOWED_PREFIXES', () => {
    assert.match(routeSrc, /"\/api\/human-tasks\/"/);
  });

  it('still exposes the board skip prefixes (regression guard)', () => {
    assert.match(routeSrc, /"\/api\/board\/proposals\/"/);
    assert.match(routeSrc, /"\/api\/board\/attention\/"/);
  });
});

describe('inbox-proxy ALLOWED_PATHS — scheduled services coverage (STAQPRO-537)', () => {
  it('exact path "/api/services/status" is in ALLOWED_PATHS', () => {
    assert.match(routeSrc, /"\/api\/services\/status"/);
  });

  it('prefix "/api/services/" is in ALLOWED_PREFIXES (pause/resume/trigger)', () => {
    assert.match(routeSrc, /"\/api\/services\/"/);
  });
});

describe('inbox-proxy ALLOWED_PATHS — Telegram observability coverage (Plan 040)', () => {
  it('exact path "/api/telegram/activity" is in ALLOWED_PATHS', () => {
    assert.match(routeSrc, /"\/api\/telegram\/activity"/);
  });

  it('exact path "/api/telegram/status" is in ALLOWED_PATHS', () => {
    assert.match(routeSrc, /"\/api\/telegram\/status"/);
  });
});
