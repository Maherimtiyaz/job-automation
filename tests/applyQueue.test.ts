import assert from "node:assert/strict";
import { test } from "node:test";

import { selectApplyQueue } from "../src/domain/applyQueue.js";
import type { Job } from "../src/domain/job.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    companyId: 1,
    title: "Software Engineer",
    canonicalUrl: "https://acme.test/jobs/1",
    source: "greenhouse",
    externalJobId: "1",
    location: "Remote",
    employmentType: "FULL_TIME",
    workplaceType: "remote",
    description: "Build things.",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    matchScore: null,
    reviewStatus: "READY_TO_APPLY",
    scoreVersion: 1,
    scoreTotal: 70,
    scoreCoverage: 0.8,
    scoreConfidence: "high",
    scoreRecommendation: "GOODMATCH",
    scoreBreakdown: null,
    scoredAt: "2026-10-01T00:00:00.000Z",
    discoveredAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-02T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

test("keeps only READY_TO_APPLY jobs without an application", () => {
  const ready = makeJob({ id: 1 });
  const shortlisted = makeJob({ id: 2, reviewStatus: "SHORTLISTED" });
  const dismissed = makeJob({ id: 3, reviewStatus: "DISMISSED" });
  const applied = makeJob({ id: 4 });

  const queue = selectApplyQueue([ready, shortlisted, dismissed, applied], new Set([4]));

  assert.deepEqual(
    queue.map((job) => job.id),
    [1],
  );
});

test("orders by score descending and puts unscored jobs last", () => {
  const low = makeJob({ id: 1, scoreTotal: 60 });
  const high = makeJob({ id: 2, scoreTotal: 90 });
  const unscored = makeJob({ id: 3, scoreTotal: null });
  const middle = makeJob({ id: 4, scoreTotal: 75 });

  const queue = selectApplyQueue([low, unscored, high, middle], new Set());

  assert.deepEqual(
    queue.map((job) => job.id),
    [2, 4, 1, 3],
  );
});

test("breaks score ties by lowest job id for a stable order", () => {
  const newer = makeJob({ id: 9, scoreTotal: 80 });
  const older = makeJob({ id: 2, scoreTotal: 80 });

  const queue = selectApplyQueue([newer, older], new Set());

  assert.deepEqual(
    queue.map((job) => job.id),
    [2, 9],
  );
});
