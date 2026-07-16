import { describe, it, expect } from "vitest";
import {
  assessSyncHealth,
  STALE_POLL_MS,
  type CalendarWatch,
} from "./calendar-sync-health";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");

function watch(overrides: Partial<CalendarWatch> = {}): CalendarWatch {
  return {
    id: "w1",
    account_email: "eric@staqs.io",
    calendar_id: "primary",
    label: "Eric's Calendar",
    is_active: true,
    last_poll_at: new Date(NOW - 60_000).toISOString(), // 1 min ago: healthy
    last_error: null,
    created_at: new Date(NOW - 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("assessSyncHealth", () => {
  it("reports no problems for a recently-polled, error-free watch", () => {
    const h = assessSyncHealth([watch()], NOW);
    expect(h.errored).toHaveLength(0);
    expect(h.stale).toHaveLength(0);
  });

  it("classifies a watch with last_error as errored (not stale)", () => {
    const h = assessSyncHealth(
      [watch({ last_error: "invalid_grant: service account delegation denied" })],
      NOW,
    );
    expect(h.errored).toHaveLength(1);
    expect(h.stale).toHaveLength(0);
  });

  it("treats a null last_poll_at as stale", () => {
    const h = assessSyncHealth([watch({ last_poll_at: null })], NOW);
    expect(h.stale).toHaveLength(1);
    expect(h.errored).toHaveLength(0);
  });

  it("treats a poll older than STALE_POLL_MS as stale", () => {
    const old = new Date(NOW - STALE_POLL_MS - 1_000).toISOString();
    const h = assessSyncHealth([watch({ last_poll_at: old })], NOW);
    expect(h.stale).toHaveLength(1);
  });

  it("does not flag a poll exactly at the staleness boundary", () => {
    const boundary = new Date(NOW - STALE_POLL_MS).toISOString();
    const h = assessSyncHealth([watch({ last_poll_at: boundary })], NOW);
    expect(h.stale).toHaveLength(0);
  });

  it("ignores inactive watches entirely", () => {
    const h = assessSyncHealth(
      [
        watch({ is_active: false, last_error: "boom" }),
        watch({ is_active: false, last_poll_at: null }),
      ],
      NOW,
    );
    expect(h.errored).toHaveLength(0);
    expect(h.stale).toHaveLength(0);
  });

  it("treats an unparseable last_poll_at as stale", () => {
    const h = assessSyncHealth([watch({ last_poll_at: "not-a-date" })], NOW);
    expect(h.stale).toHaveLength(1);
  });

  it("partitions a mixed set correctly", () => {
    const h = assessSyncHealth(
      [
        watch({ id: "ok" }),
        watch({ id: "err", last_error: "forbidden" }),
        watch({ id: "stale", last_poll_at: null }),
        watch({ id: "inactive", is_active: false, last_error: "x" }),
      ],
      NOW,
    );
    expect(h.errored.map((w) => w.id)).toEqual(["err"]);
    expect(h.stale.map((w) => w.id)).toEqual(["stale"]);
  });
});
