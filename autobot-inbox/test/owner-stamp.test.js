// owner-stamp.test.js — STAQPRO-593 write-path owner-stamp helper.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writerOrgId, ownerStamp } from '../../lib/tenancy/owner-stamp.js';

test('writerOrgId returns the writer\'s primary org', () => {
  assert.equal(writerOrgId({ readOrgIds: ['org-1', 'org-2'], userId: 'u1' }), 'org-1');
});

test('writerOrgId is null for an unresolved / org-less / adminBypass principal', () => {
  assert.equal(writerOrgId(null), null);
  assert.equal(writerOrgId(undefined), null);
  assert.equal(writerOrgId({}), null);
  assert.equal(writerOrgId({ readOrgIds: [] }), null);
  // adminBypass agents carry no org → null → column DEFAULT (single-org correct).
  assert.equal(writerOrgId({ adminBypass: true, readOrgIds: [] }), null);
});

test('ownerStamp returns both owner columns from the principal', () => {
  assert.deepEqual(
    ownerStamp({ readOrgIds: ['org-9'], userId: 'user-7' }),
    { owner_org_id: 'org-9', owner_user_id: 'user-7' },
  );
  assert.deepEqual(ownerStamp(null), { owner_org_id: null, owner_user_id: null });
});
