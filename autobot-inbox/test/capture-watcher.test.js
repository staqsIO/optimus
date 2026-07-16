// capture-watcher.test.js — OPT-98: multi-folder Drive watcher → typed artifacts.
//
// Exercises pollCaptureSources() with fully injected deps (a scripted fake Drive
// client, a fake createArtifact spy, and a fake query function) so the test never
// touches real Drive, an LLM, or a DB. The invariants under test:
//   1. a passing file → createArtifact called with the SOURCE ROW's owner_org_id /
//      owner_id + source_system='drive' + the row's default_kind.
//   2. allowlist: a disallowed mime/ext and an over-max_bytes file are skipped
//      (createArtifact NOT called).
//   3. cursor advances + persists; a second poll with no changes is a no-op.
//   4. a source whose processing throws does not prevent a sibling enabled source
//      from processing (failure isolation), and stamps last_error.
//   5. two enabled sources mapped to different orgs → each file lands with its own
//      source's org (the tenancy invariant).
//
// hasServiceAccount() reads GOOGLE_SERVICE_ACCOUNT_KEY at runtime; we set a dummy
// in this process so the early-return guard in pollCaptureSources is satisfied
// without a real key (the driveClientFactory is injected, so no key is used).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_SERVICE_ACCOUNT_KEY =
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY || JSON.stringify({ client_email: 'x@x', private_key: 'x' });

const { pollCaptureSources } = await import('../src/drive/watcher.js');

const FOLDER_A = 'folder-A';
const ORG_A = 'org-aaaaaaaa';
const FOLDER_B = 'folder-B';
const ORG_B = 'org-bbbbbbbb';

// A capture_sources row, defaulted for convenience.
function sourceRow(overrides = {}) {
  return {
    id: 'src-1',
    source_type: 'drive_folder',
    external_id: FOLDER_A,
    label: 'Source A',
    owner_org_id: ORG_A,
    owner_id: 'owner-a',
    default_kind: 'doc',
    allowlist: { mime: ['text/plain'], ext: [], max_bytes: 1_000_000 },
    enabled: true,
    cursor: 'tok-1', // non-null → steady-state path (not first-enable)
    ...overrides,
  };
}

// A Drive changes.list change entry wrapping a file in the watched folder.
function change(file, { removed = false } = {}) {
  return { fileId: file.id, removed, file };
}

function driveFile(overrides = {}) {
  return {
    id: 'file-1',
    name: 'note.txt',
    mimeType: 'text/plain',
    size: '100',
    parents: [FOLDER_A],
    trashed: false,
    ...overrides,
  };
}

/**
 * Build a fake Drive client. `changesPages` is an array of changes.list response
 * `data` objects returned in order; `startPageToken` is what getStartPageToken
 * yields. File bodies for text/plain come from `fileBodies[fileId]`.
 */
function fakeDrive({ changesPages = [], startPageToken = 'start-tok', fileBodies = {}, failFileIds = [] } = {}) {
  let page = 0;
  const failSet = new Set(failFileIds);
  return {
    changes: {
      getStartPageToken: async () => ({ data: { startPageToken } }),
      list: async () => {
        const data = changesPages[page] || { changes: [], newStartPageToken: `adv-${page}` };
        page++;
        return { data };
      },
    },
    files: {
      // fetchDriveFileText's non-GoogleDoc path: files.get({alt:'media'}).
      // failFileIds simulate a transient read failure (fetch throw) for a file.
      get: async ({ fileId }) => {
        if (failSet.has(fileId)) throw new Error(`transient read fail for ${fileId}`);
        return { data: fileBodies[fileId] ?? 'body text' };
      },
      export: async ({ fileId }) => {
        if (failSet.has(fileId)) throw new Error(`transient read fail for ${fileId}`);
        return { data: fileBodies[fileId] ?? 'body text' };
      },
    },
  };
}

// A query spy that returns scripted SELECT rows and records UPDATEs.
function makeQuery({ sources = [] } = {}) {
  const updates = [];
  const queryFn = async (sql, params) => {
    if (/SELECT/i.test(sql) && /capture_sources/.test(sql) && /WHERE/i.test(sql)) {
      return { rows: sources };
    }
    if (/UPDATE\s+content\.capture_sources/i.test(sql)) {
      updates.push({ sql, params });
      return { rows: [] };
    }
    return { rows: [] };
  };
  queryFn.updates = updates;
  return queryFn;
}

function makeCreateArtifactSpy() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { ok: true, artifactId: 'art-' + calls.length, deduped: false };
  };
  fn.calls = calls;
  return fn;
}

test('passing file → createArtifact gets SOURCE ROW owner + source_system=drive + default_kind', async () => {
  const src = sourceRow();
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'hello world' },
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 1);
  assert.equal(createArtifactFn.calls.length, 1);
  const call = createArtifactFn.calls[0];
  assert.equal(call.ownerOrgId, ORG_A);
  assert.equal(call.ownerId, 'owner-a');
  assert.equal(call.source_system, 'drive');
  assert.equal(call.kind, 'doc');
  assert.equal(call.title, 'note.txt');
  assert.equal(call.raw, 'hello world');
  assert.equal(call.metadata.drive_file_id, 'file-1');
  assert.equal(call.metadata.capture_source_id, 'src-1');
});

test('allowlist: disallowed mime/ext and over-max_bytes files are skipped (no createArtifact)', async () => {
  // allowlist accepts mime text/plain OR ext "md", max 1000 bytes.
  const src = sourceRow({ allowlist: { mime: ['text/plain'], ext: ['md'], max_bytes: 1000 } });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    changesPages: [{
      changes: [
        change(driveFile({ id: 'bad-mime', name: 'x.pdf', mimeType: 'application/pdf' })),
        change(driveFile({ id: 'bad-ext', name: 'x.exe', mimeType: 'application/octet-stream' })),
        change(driveFile({ id: 'too-big', name: 'big.txt', mimeType: 'text/plain', size: '5000' })),
      ],
      newStartPageToken: 'adv-1',
    }],
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 0);
  assert.equal(createArtifactFn.calls.length, 0);
});

test('empty allowlist (no mime + no ext) → accept-none default, file skipped', async () => {
  const src = sourceRow({ allowlist: { mime: [], ext: [], max_bytes: 1_000_000 } });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 0);
  assert.equal(createArtifactFn.calls.length, 0);
});

test('first enable (cursor null) primes startPageToken, processes nothing (no backfill)', async () => {
  const src = sourceRow({ cursor: null });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    startPageToken: 'fresh-start',
    // even if changes existed they must NOT be processed on first enable
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 0);
  assert.equal(createArtifactFn.calls.length, 0);
  // cursor primed to the fresh startPageToken
  const cursorUpdate = queryFn.updates.find(u => u.params && u.params[0] === 'fresh-start');
  assert.ok(cursorUpdate, 'expected cursor primed to fresh-start');
});

test('cursor advances + persists; a second poll with no changes is a no-op', async () => {
  const src = sourceRow();
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-cursor' }],
    fileBodies: { 'file-1': 'hi' },
  });

  await pollCaptureSources({ driveClientFactory: () => drive, createArtifactFn, queryFn });

  // cursor persisted to the advanced newStartPageToken
  const cursorUpdate = queryFn.updates.find(u => u.params && u.params[0] === 'adv-cursor');
  assert.ok(cursorUpdate, 'expected cursor advanced to adv-cursor');

  // Second poll: empty changes feed → no new artifacts.
  const calmDrive = fakeDrive({ changesPages: [{ changes: [], newStartPageToken: 'adv-cursor' }] });
  const total2 = await pollCaptureSources({
    driveClientFactory: () => calmDrive,
    createArtifactFn,
    queryFn,
  });
  assert.equal(total2, 0);
  assert.equal(createArtifactFn.calls.length, 1, 'no new createArtifact on the calm poll');
});

test('a source that throws does not block a sibling; last_error stamped (failure isolation)', async () => {
  const bad = sourceRow({ id: 'src-bad', external_id: FOLDER_A, owner_org_id: ORG_A, label: 'Bad' });
  const good = sourceRow({ id: 'src-good', external_id: FOLDER_B, owner_org_id: ORG_B, owner_id: 'owner-b', label: 'Good' });
  const queryFn = makeQuery({ sources: [bad, good] });
  const createArtifactFn = makeCreateArtifactSpy();

  const goodDrive = fakeDrive({
    changesPages: [{ changes: [change(driveFile({ id: 'gfile', parents: [FOLDER_B] }))], newStartPageToken: 'adv-g' }],
    fileBodies: { gfile: 'good body' },
  });
  const driveClientFactory = (_email) => {
    // dispatch by which source is being polled: the bad one throws on changes.list
    return {
      changes: {
        getStartPageToken: async () => ({ data: { startPageToken: 's' } }),
        list: async () => { throw new Error('boom'); },
      },
      files: goodDrive.files,
    };
  };

  // Route per-source: bad → throwing client, good → working client. We can't key
  // on email (both null), so wrap the factory to return the throwing client only
  // for the first invocation (bad is iterated first).
  let nth = 0;
  const factory = () => (nth++ === 0 ? driveClientFactory() : goodDrive);

  const total = await pollCaptureSources({
    driveClientFactory: factory,
    createArtifactFn,
    queryFn,
  });

  // good source still captured its file despite bad throwing
  assert.equal(total, 1);
  assert.equal(createArtifactFn.calls.length, 1);
  assert.equal(createArtifactFn.calls[0].ownerOrgId, ORG_B);

  // bad source stamped last_error (UPDATE ... last_error = $1 WHERE id = src-bad)
  const errUpdate = queryFn.updates.find(
    u => /last_error\s*=\s*\$1/i.test(u.sql) && u.params && u.params[1] === 'src-bad'
  );
  assert.ok(errUpdate, 'expected last_error stamped on the failing source');
  assert.match(String(errUpdate.params[0]), /boom/);
});

test('two enabled sources / different orgs → each file lands under its own org (tenancy invariant)', async () => {
  const srcA = sourceRow({ id: 'src-A', external_id: FOLDER_A, owner_org_id: ORG_A, owner_id: 'owner-a' });
  const srcB = sourceRow({ id: 'src-B', external_id: FOLDER_B, owner_org_id: ORG_B, owner_id: 'owner-b' });
  const queryFn = makeQuery({ sources: [srcA, srcB] });
  const createArtifactFn = makeCreateArtifactSpy();

  const driveA = fakeDrive({
    changesPages: [{ changes: [change(driveFile({ id: 'fa', name: 'a.txt', parents: [FOLDER_A] }))], newStartPageToken: 'adv-a' }],
    fileBodies: { fa: 'a' },
  });
  const driveB = fakeDrive({
    changesPages: [{ changes: [change(driveFile({ id: 'fb', name: 'b.txt', parents: [FOLDER_B] }))], newStartPageToken: 'adv-b' }],
    fileBodies: { fb: 'b' },
  });
  let nth = 0;
  const factory = () => (nth++ === 0 ? driveA : driveB);

  const total = await pollCaptureSources({
    driveClientFactory: factory,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 2);
  assert.equal(createArtifactFn.calls.length, 2);
  const byTitle = Object.fromEntries(createArtifactFn.calls.map(c => [c.title, c.ownerOrgId]));
  assert.equal(byTitle['a.txt'], ORG_A);
  assert.equal(byTitle['b.txt'], ORG_B);
});

test('transient read error on file 2 of 3 → cursor NOT advanced (held at prior token) + last_error stamped', async () => {
  // BLOCKER regression: an error-skip must HOLD the cursor so the page retries
  // next tick. Files 1 and 3 capture; file 2's read throws → cursor held.
  const src = sourceRow({ cursor: 'prior-tok' });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const drive = fakeDrive({
    changesPages: [{
      changes: [
        change(driveFile({ id: 'f1', name: 'one.txt' })),
        change(driveFile({ id: 'f2', name: 'two.txt' })),  // this read throws
        change(driveFile({ id: 'f3', name: 'three.txt' })),
      ],
      newStartPageToken: 'would-advance-to',
    }],
    fileBodies: { f1: 'one', f3: 'three' },
    failFileIds: ['f2'],
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  // files 1 and 3 still captured (error on 2 doesn't block the rest)
  assert.equal(total, 2);
  assert.equal(createArtifactFn.calls.length, 2);

  // cursor was NOT advanced: no UPDATE set cursor = 'would-advance-to'
  const advanced = queryFn.updates.find(u => u.params && u.params[0] === 'would-advance-to');
  assert.equal(advanced, undefined, 'cursor must NOT advance past the errored page');

  // last_error stamped with the cursor-held marker (and cursor untouched in SQL)
  const held = queryFn.updates.find(
    u => /last_error\s*=\s*\$1/i.test(u.sql) && !/cursor\s*=/i.test(u.sql)
      && u.params && u.params[1] === src.id
  );
  assert.ok(held, 'expected a cursor-hold UPDATE (last_error set, cursor not written)');
  assert.match(String(held.params[0]), /cursor held/);
});

test('Google Doc over max_bytes by EXTRACTED text → intentional skip, cursor still advances', async () => {
  // MAJOR regression: native Docs report size 0/absent, so the declared-size gate
  // is a no-op. The post-fetch byte-length check must catch an over-limit Doc.
  // This is an INTENTIONAL skip (too big by policy), so the cursor MUST advance.
  const src = sourceRow({
    external_id: FOLDER_A,
    allowlist: { mime: ['application/vnd.google-apps.document'], ext: [], max_bytes: 10 },
    cursor: 'prior',
  });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const bigText = 'x'.repeat(5000); // far over 10 bytes
  const drive = fakeDrive({
    changesPages: [{
      changes: [change(driveFile({
        id: 'gdoc', name: 'big.gdoc',
        mimeType: 'application/vnd.google-apps.document',
        size: undefined, parents: [FOLDER_A],
      }))],
      newStartPageToken: 'adv-after-skip',
    }],
    fileBodies: { gdoc: bigText },
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn,
    queryFn,
  });

  assert.equal(total, 0);
  assert.equal(createArtifactFn.calls.length, 0, 'over-byte Doc must be skipped');
  // intentional skip → cursor advances to the page's newStartPageToken
  const advanced = queryFn.updates.find(u => u.params && u.params[0] === 'adv-after-skip');
  assert.ok(advanced, 'cursor must advance past an intentional (over-byte) skip');
});

test('same file in two sources mapped to different orgs → captured into BOTH orgs (intended)', async () => {
  // Drive files can have multiple parents. A file in folderA AND folderB, where
  // each folder is an enabled source owned by a DIFFERENT org, is legitimately
  // owned in each folder → captured once per source under that source's own org.
  const srcA = sourceRow({ id: 'src-A', external_id: FOLDER_A, owner_org_id: ORG_A, owner_id: 'owner-a' });
  const srcB = sourceRow({ id: 'src-B', external_id: FOLDER_B, owner_org_id: ORG_B, owner_id: 'owner-b' });
  const queryFn = makeQuery({ sources: [srcA, srcB] });
  const createArtifactFn = makeCreateArtifactSpy();

  // The SAME file, parented in both folders.
  const shared = () => driveFile({ id: 'shared', name: 'shared.txt', parents: [FOLDER_A, FOLDER_B] });
  const driveA = fakeDrive({
    changesPages: [{ changes: [change(shared())], newStartPageToken: 'adv-a' }],
    fileBodies: { shared: 'shared body' },
  });
  const driveB = fakeDrive({
    changesPages: [{ changes: [change(shared())], newStartPageToken: 'adv-b' }],
    fileBodies: { shared: 'shared body' },
  });
  let nth = 0;
  const factory = () => (nth++ === 0 ? driveA : driveB);

  const total = await pollCaptureSources({
    driveClientFactory: factory,
    createArtifactFn,
    queryFn,
  });

  // captured once per source, each under its own org
  assert.equal(total, 2);
  assert.equal(createArtifactFn.calls.length, 2);
  const orgs = createArtifactFn.calls.map(c => c.ownerOrgId).sort();
  assert.deepEqual(orgs, [ORG_A, ORG_B].sort());
  // both calls reference the same drive file id
  assert.ok(createArtifactFn.calls.every(c => c.metadata.drive_file_id === 'shared'));
});

// ── D1 (ADR-016): prefer SA-direct over DWD impersonation ──────────────────────

test('D1: impersonated source whose folder the SA CAN see → read as SA (no impersonation), access_resolved=sa_direct', async () => {
  const src = sourceRow({ owner_email: 'eric@staqs.io' });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  // One SA client serves both the membership probe (files.get on the folder id,
  // returns a body → no throw → SA is a member) and the real read.
  const saDrive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'hello' },
  });
  const emails = [];
  const factory = (email) => { emails.push(email); return saDrive; };

  const total = await pollCaptureSources({ driveClientFactory: factory, createArtifactFn, queryFn });

  assert.equal(total, 1);
  assert.equal(createArtifactFn.calls.length, 1);
  // Both the probe and the read built a null-email (SA-direct) client — never
  // impersonated, even though the source was registered 'impersonated'.
  assert.ok(emails.length >= 2 && emails.every(e => e === null), 'expected SA-direct (null) client for probe + read');
  const upd = queryFn.updates.find(u => /access_resolved/.test(u.sql) && u.params.includes('sa_direct'));
  assert.ok(upd, 'expected access_resolved=sa_direct stamped');
});

test('D1: SA CANNOT see folder (404) → fall back to impersonation, capture via DWD, access_resolved=impersonated', async () => {
  // The silent-drop guard. A non-member SA-direct changes feed returns 200+empty
  // (no throw) — a naive "fall back only on throw against changes.list" would
  // capture 0 here. The membership probe (files.get → 404) is what triggers the
  // impersonation fallback, so the file is still captured.
  const src = sourceRow({ owner_email: 'eric@staqs.io' });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();

  const saDrive = {
    // Real googleapis GaxiosError shape: err.code is a STRING, err.response.status
    // is the number. The probe must treat this as 404 and fall back.
    files: { get: async () => { const e = new Error('not found'); e.code = '404'; e.response = { status: 404 }; throw e; } },
    // An EMPTY changes feed, deliberately — proves we never fall through to it.
    changes: {
      getStartPageToken: async () => ({ data: { startPageToken: 's' } }),
      list: async () => ({ data: { changes: [], newStartPageToken: 'adv-empty' } }),
    },
  };
  const impDrive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'hello' },
  });
  const factory = (email) => (email ? impDrive : saDrive);

  const total = await pollCaptureSources({ driveClientFactory: factory, createArtifactFn, queryFn });

  assert.equal(total, 1, 'must capture via impersonation, NOT silently drop via empty SA feed');
  assert.equal(createArtifactFn.calls[0].ownerOrgId, ORG_A);
  const upd = queryFn.updates.find(u => /access_resolved/.test(u.sql) && u.params.includes('impersonated'));
  assert.ok(upd, 'expected access_resolved=impersonated stamped');
});

test('D1: probe 403 exposed ONLY as a string err.code (no response.status) → still falls back', async () => {
  // Regression lock for the googleapis GaxiosError string-code trap: err.code is
  // "403" (string), and `"403" === 403` is false. The probe must coerce it.
  const src = sourceRow({ owner_email: 'eric@staqs.io' });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const saDrive = {
    files: { get: async () => { const e = new Error('forbidden'); e.code = '403'; throw e; } },
    changes: { getStartPageToken: async () => ({ data: { startPageToken: 's' } }), list: async () => ({ data: { changes: [] } }) },
  };
  const impDrive = fakeDrive({
    changesPages: [{ changes: [change(driveFile())], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'hello' },
  });
  const factory = (email) => (email ? impDrive : saDrive);

  const total = await pollCaptureSources({ driveClientFactory: factory, createArtifactFn, queryFn });
  assert.equal(total, 1, 'string "403" err.code must coerce and trigger the impersonation fallback');
  const upd = queryFn.updates.find(u => /access_resolved/.test(u.sql) && u.params.includes('impersonated'));
  assert.ok(upd, 'expected access_resolved=impersonated stamped');
});

test('D1: transient probe error (5xx) → source stamped last_error, no silent access flip', async () => {
  const src = sourceRow({ owner_email: 'eric@staqs.io', label: 'Imp' });
  const queryFn = makeQuery({ sources: [src] });
  const createArtifactFn = makeCreateArtifactSpy();
  const saDrive = {
    files: { get: async () => { const e = new Error('backend error'); e.code = '500'; e.response = { status: 500 }; throw e; } },
    changes: { getStartPageToken: async () => ({ data: {} }), list: async () => ({ data: { changes: [] } }) },
  };
  const factory = () => saDrive;

  const total = await pollCaptureSources({ driveClientFactory: factory, createArtifactFn, queryFn });

  assert.equal(total, 0);
  assert.equal(createArtifactFn.calls.length, 0, 'a 5xx probe must NOT silently fall back to impersonation');
  const errUpdate = queryFn.updates.find(
    u => /last_error\s*=\s*\$1/i.test(u.sql) && u.params && u.params[1] === 'src-1'
  );
  assert.ok(errUpdate, 'expected last_error stamped on transient probe failure');
  assert.match(String(errUpdate.params[0]), /backend error/);
});

// ── D4 (ADR-016): transcript sources reach /api/meetings parity ────────────────

test('D4 + Feature 007: transcript source → meeting pipeline (inbox.messages + work_item + owner_org_id) AND registry registration over the SAME document', async () => {
  const src = sourceRow({ default_kind: 'transcript', owner_org_id: ORG_A });
  const createArtifactFn = makeCreateArtifactSpy();
  const inserts = [];
  const queryFn = async (sql, params) => {
    if (/SELECT/i.test(sql) && /capture_sources/.test(sql) && /WHERE/i.test(sql)) return { rows: [src] };
    if (/SELECT 1 FROM inbox\.messages/i.test(sql)) return { rows: [] };           // no dedup hit
    if (/INSERT INTO inbox\.messages/i.test(sql)) { inserts.push({ sql, params }); return { rows: [{ id: 'msg-1' }] }; }
    if (/UPDATE inbox\.messages SET work_item_id/i.test(sql)) return { rows: [] };
    if (/UPDATE\s+content\.capture_sources/i.test(sql)) return { rows: [] };
    return { rows: [] };                                                            // incl. reconciler → no calendar match
  };
  const workItems = [];
  const createWorkItemFn = async (wi) => { workItems.push(wi); return { id: 'wi-1' }; };
  const ragCalls = [];
  const ingestRagFn = async (...a) => { ragCalls.push(a); return { documentId: 'doc-1' }; };
  const emits = [];
  const emitMeetingReceivedFn = async (args) => { emits.push(args); return null; };

  const drive = fakeDrive({
    changesPages: [{ changes: [change(driveFile({ name: 'Standup - 2026/06/03 10:00 PDT - Notes by Gemini', mimeType: 'text/plain' }))], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'transcript body' },
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn, queryFn, createWorkItemFn, ingestRagFn, emitMeetingReceivedFn,
  });

  assert.equal(total, 1);
  assert.equal(inserts.length, 1, 'one inbox.messages INSERT');
  assert.ok(/owner_org_id/.test(inserts[0].sql), 'INSERT must include owner_org_id column for a capture transcript');
  assert.ok(inserts[0].params.includes(ORG_A), 'owner_org_id must be the SOURCE org');
  const labelsParam = inserts[0].params.find(p => Array.isArray(p) && p.some(x => String(x).startsWith('webhook:')));
  assert.ok(labelsParam && labelsParam.includes('webhook:gemini'), 'preset detected from filename → webhook:gemini label (meetings UI keys on this)');
  assert.equal(workItems.length, 1, 'triage work_item created');
  assert.equal(workItems[0].assignedTo, 'executor-triage');
  assert.equal(ragCalls.length, 1, 'RAG ingest called');

  // Feature 007: the registry registers the SAME document (documentId reuse — a
  // second ingest would duplicate embeddings) with the meeting envelope, and
  // meeting.received fires so the classifier runs for org-captured notes.
  assert.equal(createArtifactFn.calls.length, 1, 'transcript registers ONE registry artifact');
  const art = createArtifactFn.calls[0];
  assert.equal(art.kind, 'transcript');
  assert.equal(art.documentId, 'doc-1', 'registry write must REUSE the RAG document (no second ingest)');
  assert.equal(art.ownerOrgId, ORG_A, 'owner threads from the SOURCE row');
  assert.ok(art.meeting && art.meeting.fallbackId === 'file-1', 'meeting envelope present (weak identity, file id fallback)');
  assert.equal(art.meeting.participantsAreAttendees, false, 'doc-owner emails are not attendees → confidence caps at weak');
  assert.equal(emits.length, 1, 'meeting.received fired once');
  assert.equal(emits[0].documentId, 'doc-1');
  assert.equal(emits[0].ownerOrgId, ORG_A);
});

test('D4: transcript dedup — file already has a webhook message → skip (no INSERT, no work_item)', async () => {
  const src = sourceRow({ default_kind: 'transcript', owner_org_id: ORG_A });
  const inserts = [];
  const queryFn = async (sql) => {
    if (/SELECT/i.test(sql) && /capture_sources/.test(sql) && /WHERE/i.test(sql)) return { rows: [src] };
    if (/SELECT 1 FROM inbox\.messages/i.test(sql)) return { rows: [{ exists: 1 }] };   // dedup HIT
    if (/INSERT INTO inbox\.messages/i.test(sql)) { inserts.push(sql); return { rows: [{ id: 'x' }] }; }
    return { rows: [] };
  };
  const createWorkItemFn = async () => { throw new Error('must not create a work_item on dedup'); };
  const drive = fakeDrive({
    changesPages: [{ changes: [change(driveFile({ mimeType: 'text/plain' }))], newStartPageToken: 'adv-1' }],
    fileBodies: { 'file-1': 'body' },
  });

  const total = await pollCaptureSources({
    driveClientFactory: () => drive,
    createArtifactFn: makeCreateArtifactSpy(), queryFn, createWorkItemFn, ingestRagFn: async () => null,
  });

  assert.equal(total, 0, 'a deduped transcript contributes 0 captured');
  assert.equal(inserts.length, 0, 'no INSERT when the message already exists');
});
