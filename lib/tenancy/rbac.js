// lib/tenancy/rbac.js — ADR-012 §4.3
// The ONLY place role→capability lives. With 4 roles and N≈3 orgs a
// data-driven permission table is pure ceremony (ADR §8): roles are an enum +
// this constant. Promote to a table only when a real per-resource grant
// appears — the resolution predicate (lib/tenancy/scope.js) does not change,
// only its ROLE_CAPS lookup does.
//
//   read:'org'  → may read org-shared rows for orgs where the user holds this role
//   read:'own'  → own rows only

export const ROLE_CAPS = {
  owner:  { read: 'org', write: 'org',  manageMembers: true,  grantFederation: true  },
  admin:  { read: 'org', write: 'org',  manageMembers: true,  grantFederation: false },
  member: { read: 'org', write: 'own',  manageMembers: false, grantFederation: false },
  viewer: { read: 'own', write: 'none', manageMembers: false, grantFederation: false },
};

export const VALID_ROLES = Object.keys(ROLE_CAPS);

/** True if this role grants org-shared READ scope (owner/admin/member, not viewer). */
export function readsOrgShared(role) {
  return ROLE_CAPS[role]?.read === 'org';
}

/** True if this role grants org-shared WRITE scope (owner/admin). */
export function writesOrgShared(role) {
  return ROLE_CAPS[role]?.write === 'org';
}
