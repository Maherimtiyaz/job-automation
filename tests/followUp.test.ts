import assert from "node:assert/strict";
import { test } from "node:test";
import type { Application } from "../src/domain/application.js";
import {
  DEFAULT_FOLLOW_UP_DAYS,
  daysSince,
  selectFollowUps,
} from "../src/domain/followUp.js";

function makeApplication(overrides: Partial<Application> = {}): Application {
  return {
    id: 1,
    jobId: 1,
    status: "SUBMITTED",
    resumeVersion: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    submittedAt: "2026-10-10T00:00:00.000Z",
    lastUpdatedAt: "2026-10-10T00:00:00.000Z",
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
    applicationUrlSource: "apply_link",
    applicationAts: "Greenhouse",
    applicationResolvedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = "2026-10-24T00:00:00.000Z";

test("selects only SUBMITTED applications past the threshold", () => {
  const old = makeApplication({ id: 1, submittedAt: "2026-10-10T00:00:00.000Z" });
  const fresh = makeApplication({ id: 2, submittedAt: "2026-10-22T00:00:00.000Z" });
  const interview = makeApplication({
    id: 3,
    status: "INTERVIEW",
    submittedAt: "2026-10-01T00:00:00.000Z",
  });
  const missing = makeApplication({ id: 4, submittedAt: null });

  const items = selectFollowUps([old, fresh, interview, missing], { now: NOW, minDays: 7 });

  assert.deepEqual(
    items.map((item) => item.application.id),
    [1],
  );
  assert.equal(items[0]?.daysWaiting, 14);
  assert.equal(DEFAULT_FOLLOW_UP_DAYS, 7);
});

test("sorts the most overdue submission first", () => {
  const tenDays = makeApplication({ id: 1, submittedAt: "2026-10-14T00:00:00.000Z" });
  const thirtyDays = makeApplication({ id: 2, submittedAt: "2026-09-24T00:00:00.000Z" });

  const items = selectFollowUps([tenDays, thirtyDays], { now: NOW, minDays: 7 });

  assert.deepEqual(
    items.map((item) => item.application.id),
    [2, 1],
  );
  assert.equal(items[0]?.daysWaiting, 30);
});

test("minDays 0 includes a same-day submission", () => {
  const today = makeApplication({ id: 1, submittedAt: NOW });

  const items = selectFollowUps([today], { now: NOW, minDays: 0 });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.daysWaiting, 0);
});

test("ignores applications with invalid submission timestamps", () => {
  const invalid = makeApplication({ id: 1, submittedAt: "not-a-date" });

  assert.deepEqual(selectFollowUps([invalid], { now: NOW, minDays: 0 }), []);
  assert.equal(daysSince("not-a-date", NOW), null);
});
