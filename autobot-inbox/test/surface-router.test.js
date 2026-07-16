/**
 * OPT-50 — surface-router truth table.
 *
 * Pure module, so we exercise it exhaustively: every rule branch, the
 * quiet-hours demotion, the urgent-override that pierces quiet hours, and the
 * per-owner opt-out. No network, no DB, no clock dependence — `now` is always
 * injected so the tests are fully deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeSurface,
  SURFACES,
  IMPORTANCE,
  EVENT_TYPES,
  inQuietHours,
  isUrgent,
  URGENCY_HORIZON_MS,
} from '../../lib/runtime/signals/surface-router.js';

// A daytime clock that is NOT inside the 22→7 quiet window used below.
const DAYTIME = new Date('2026-06-13T14:00:00Z'); // 14:00 UTC
// A nighttime clock that IS inside the 22→7 quiet window.
const NIGHTTIME = new Date('2026-06-13T03:00:00Z'); // 03:00 UTC
// Quiet hours expressed in UTC so the offset cancels and tests are TZ-stable.
const QH = { start: 22, end: 7, timezoneOffsetMinutes: 0 };

describe('surface-router: enum + contract surface area', () => {
  it('exposes exactly the four surfaces', () => {
    assert.deepEqual(
      new Set(Object.values(SURFACES)),
      new Set(['telegram_dm', 'slack_channel', 'workstation_card', 'silent_log']),
    );
  });

  it('always returns { surface, owner, reason } with a known surface', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.SIGNAL_DETECTED, owner: null },
      { now: DAYTIME },
    );
    assert.ok('surface' in r && 'owner' in r && 'reason' in r);
    assert.ok(Object.values(SURFACES).includes(r.surface));
  });

  it('degrades a non-object event to silent_log (deny by default)', () => {
    assert.equal(routeSurface(null, { now: DAYTIME }).surface, SURFACES.SILENT_LOG);
    assert.equal(routeSurface(undefined).surface, SURFACES.SILENT_LOG);
    assert.equal(routeSurface(42, { now: DAYTIME }).surface, SURFACES.SILENT_LOG);
  });
});

describe('surface-router: rule 1 — owner-actionable + high → telegram_dm', () => {
  it('high importance + actionable + owner → telegram_dm', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
    assert.equal(r.owner, 'ecgang');
    assert.equal(r.reason, 'owner_actionable_high_importance');
  });

  it('critical importance also clears the high bar', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.GATE_FAILURE, owner: 'ecgang', importance: 'critical', actionable: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
  });

  it('numeric importance >= high also routes to telegram_dm', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.TASK_BLOCKED, owner: 'ecgang', importance: IMPORTANCE.high, actionable: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
  });

  it('high importance but NOT actionable does not interrupt', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.ENGAGEMENT_MOVED, owner: 'ecgang', importance: 'high', actionable: false, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.notEqual(r.surface, SURFACES.TELEGRAM_DM);
  });

  it('actionable + high but NO owner cannot DM (no recipient)', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: null, importance: 'high', actionable: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.notEqual(r.surface, SURFACES.TELEGRAM_DM);
  });
});

describe('surface-router: rule 2 — urgent owner item → telegram_dm even if not high', () => {
  it('urgent flag + actionable + owner, normal importance → telegram_dm', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'normal', actionable: true, urgent: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
    assert.equal(r.reason, 'owner_actionable_urgent');
  });

  it('imminent decisionDeadline makes it urgent without an explicit flag', () => {
    const deadline = new Date(DAYTIME.getTime() + 60 * 60 * 1000); // +1h, within horizon
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'normal', actionable: true, scope: 'owner', decisionDeadline: deadline },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
  });

  it('a far-future decisionDeadline is NOT urgent', () => {
    const deadline = new Date(DAYTIME.getTime() + 48 * 60 * 60 * 1000); // +48h
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'normal', actionable: true, scope: 'owner', decisionDeadline: deadline },
      { now: DAYTIME, quietHours: QH },
    );
    assert.notEqual(r.surface, SURFACES.TELEGRAM_DM);
  });
});

describe('surface-router: rule 3 — project/channel → slack_channel', () => {
  it('project-scoped progress → slack_channel', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.TASK_PROGRESS, owner: 'ecgang', importance: 'normal', actionable: false, scope: 'project' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SLACK_CHANNEL);
    assert.equal(r.reason, 'project_channel_progress');
  });

  it('channel-scoped progress → slack_channel', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.BUILD_RESULT, owner: null, scope: 'channel' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SLACK_CHANNEL);
  });

  it('project scope does NOT interrupt even with an actionable owner of normal importance', () => {
    // Only high-importance OR urgent owner items interrupt; plain project
    // progress stays in the channel.
    const r = routeSurface(
      { type: EVENT_TYPES.TASK_PROGRESS, owner: 'ecgang', importance: 'normal', actionable: true, scope: 'project' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SLACK_CHANNEL);
  });
});

describe('surface-router: rule 4 — ambient "what moved" → workstation_card', () => {
  it('ambient-scoped movement → workstation_card', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.ARTIFACT_ENRICHED, owner: null, scope: 'ambient' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.WORKSTATION_CARD);
    assert.equal(r.reason, 'ambient_what_moved');
  });

  it('org-scoped movement → workstation_card', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.ENGAGEMENT_MOVED, owner: null, scope: 'org' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.WORKSTATION_CARD);
  });

  it('owner-relevant but not actionable → workstation_card (a glance, not a DM)', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.ENGAGEMENT_MOVED, owner: 'ecgang', importance: 'normal', actionable: false, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.WORKSTATION_CARD);
  });
});

describe('surface-router: rule 5 — default → silent_log', () => {
  it('owner-less, non-project, non-ambient heartbeat → silent_log', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.HEARTBEAT, owner: null, scope: 'owner' },
      { now: DAYTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SILENT_LOG);
    assert.equal(r.reason, 'default_silent_log');
  });
});

describe('surface-router: quiet-hours demotion', () => {
  it('a daytime telegram_dm DEMOTES to silent_log during quiet hours', () => {
    const event = { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' };
    const day = routeSurface(event, { now: DAYTIME, quietHours: QH });
    const night = routeSurface(event, { now: NIGHTTIME, quietHours: QH });
    assert.equal(day.surface, SURFACES.TELEGRAM_DM);
    assert.equal(night.surface, SURFACES.SILENT_LOG);
    assert.equal(night.reason, 'quiet_hours_demoted');
  });

  it('project progress also demotes to silent_log at night (batched into brief)', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.TASK_PROGRESS, owner: null, scope: 'project' },
      { now: NIGHTTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SILENT_LOG);
  });

  it('with no quiet-hours window configured, nothing demotes', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' },
      { now: NIGHTTIME, quietHours: null },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
  });
});

describe('surface-router: urgent override pierces quiet hours', () => {
  it('urgent + actionable + owner still telegram_dm at night', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'high', actionable: true, urgent: true, scope: 'owner' },
      { now: NIGHTTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
    assert.equal(r.reason, 'quiet_hours_urgent_override');
  });

  it('imminent decision_deadline pierces quiet hours (ADR-011 highest signal)', () => {
    const deadline = new Date(NIGHTTIME.getTime() + 30 * 60 * 1000); // +30m
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'normal', actionable: true, scope: 'owner', decisionDeadline: deadline },
      { now: NIGHTTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
    assert.equal(r.reason, 'quiet_hours_urgent_override');
  });

  it('urgent but NOT actionable does NOT pierce quiet hours', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.GATE_FAILURE, owner: 'ecgang', importance: 'high', actionable: false, urgent: true, scope: 'owner' },
      { now: NIGHTTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SILENT_LOG);
  });

  it('a far-future deadline does NOT pierce quiet hours', () => {
    const deadline = new Date(NIGHTTIME.getTime() + 12 * 60 * 60 * 1000); // +12h
    const r = routeSurface(
      { type: EVENT_TYPES.GATED_APPROVAL, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner', decisionDeadline: deadline },
      { now: NIGHTTIME, quietHours: QH },
    );
    assert.equal(r.surface, SURFACES.SILENT_LOG);
  });
});

describe('surface-router: per-owner preferences', () => {
  it('telegramOptOut demotes a would-be DM to a workstation_card', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' },
      { now: DAYTIME, quietHours: QH, ownerPrefs: { telegramOptOut: true } },
    );
    assert.equal(r.surface, SURFACES.WORKSTATION_CARD);
    assert.match(r.reason, /telegram_opt_out$/);
  });

  it('per-owner quietHours override (null) disables demotion for that owner', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' },
      { now: NIGHTTIME, quietHours: QH, ownerPrefs: { quietHours: null } },
    );
    assert.equal(r.surface, SURFACES.TELEGRAM_DM);
  });

  it('per-owner quietHours override (wider window) demotes when global would not', () => {
    const r = routeSurface(
      { type: EVENT_TYPES.DRAFT_READY, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' },
      // 14:00 UTC is outside global QH but inside this owner's 9→18 window.
      { now: DAYTIME, quietHours: null, ownerPrefs: { quietHours: { start: 9, end: 18, timezoneOffsetMinutes: 0 } } },
    );
    assert.equal(r.surface, SURFACES.SILENT_LOG);
  });
});

describe('surface-router: determinism', () => {
  it('identical inputs yield identical outputs (no hidden state)', () => {
    const event = { type: EVENT_TYPES.SIGNAL_DETECTED, owner: 'ecgang', importance: 'high', actionable: true, scope: 'owner' };
    const opts = { now: DAYTIME, quietHours: QH };
    const a = routeSurface(event, opts);
    const b = routeSurface(event, opts);
    assert.deepEqual(a, b);
  });
});

describe('surface-router: inQuietHours helper (unit)', () => {
  it('overnight wraparound window includes both sides of midnight', () => {
    assert.equal(inQuietHours(new Date('2026-06-13T23:00:00Z'), { start: 22, end: 7, timezoneOffsetMinutes: 0 }), true);
    assert.equal(inQuietHours(new Date('2026-06-13T03:00:00Z'), { start: 22, end: 7, timezoneOffsetMinutes: 0 }), true);
    assert.equal(inQuietHours(new Date('2026-06-13T14:00:00Z'), { start: 22, end: 7, timezoneOffsetMinutes: 0 }), false);
  });

  it('same-day window is exclusive of the end hour', () => {
    assert.equal(inQuietHours(new Date('2026-06-13T01:00:00Z'), { start: 1, end: 5, timezoneOffsetMinutes: 0 }), true);
    assert.equal(inQuietHours(new Date('2026-06-13T05:00:00Z'), { start: 1, end: 5, timezoneOffsetMinutes: 0 }), false);
  });

  it('null / empty window is never quiet', () => {
    assert.equal(inQuietHours(new Date(), null), false);
    assert.equal(inQuietHours(new Date('2026-06-13T03:00:00Z'), { start: 3, end: 3 }), false);
  });
});

describe('surface-router: isUrgent helper (unit)', () => {
  it('explicit urgent flag wins', () => {
    assert.equal(isUrgent({ urgent: true }, DAYTIME), true);
  });

  it('deadline exactly at the horizon edge is urgent; just beyond is not', () => {
    const atEdge = new Date(DAYTIME.getTime() + URGENCY_HORIZON_MS);
    const beyond = new Date(DAYTIME.getTime() + URGENCY_HORIZON_MS + 60 * 1000);
    assert.equal(isUrgent({ decisionDeadline: atEdge }, DAYTIME), true);
    assert.equal(isUrgent({ decisionDeadline: beyond }, DAYTIME), false);
  });

  it('an overdue (past) deadline is urgent', () => {
    const past = new Date(DAYTIME.getTime() - 60 * 1000);
    assert.equal(isUrgent({ decisionDeadline: past }, DAYTIME), true);
  });

  it('no urgency signal at all → not urgent', () => {
    assert.equal(isUrgent({}, DAYTIME), false);
    assert.equal(isUrgent({ decisionDeadline: 'not-a-date' }, DAYTIME), false);
  });
});
