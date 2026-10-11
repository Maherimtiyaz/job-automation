import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationStatus } from "../src/domain/status.js";
import {
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
} from "../src/domain/errors.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { createTestDatabase, seedCompanyAndJob } from "./support/db.js";

test("creates an application with an initial audit event", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);

    const application = applications.create({ jobId });

    assert.equal(application.status, "DISCOVERED");
    assert.equal(application.startedAt, null);
    assert.equal(application.submittedAt, null);
    assert.equal(application.createdAt, application.lastUpdatedAt);

    const history = applications.getEventHistory(application.id);
    assert.equal(history.length, 1);
    const first = history[0];
    assert.ok(first);
    assert.equal(first.eventType, "CREATED");
    assert.equal(first.previousStatus, null);
    assert.equal(first.newStatus, "DISCOVERED");
  } finally {
    close();
  }
});

test("prevents duplicate applications for the same job", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);

    applications.create({ jobId });
    assert.throws(() => applications.create({ jobId }), ConflictError);
    assert.equal(applications.count(), 1);
  } finally {
    close();
  }
});

test("rejects an application for a missing job", () => {
  const { db, close } = createTestDatabase();
  try {
    const applications = new ApplicationRepository(db);
    assert.throws(() => applications.create({ jobId: 999 }), NotFoundError);
  } finally {
    close();
  }
});

test("supports the full happy-path status chain", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    const chain: ApplicationStatus[] = [
      "MATCHED",
      "REVIEW",
      "READY_TO_APPLY",
      "IN_PROGRESS",
      "WAITING_FOR_HUMAN",
      "IN_PROGRESS",
      "APPROVED",
      "SUBMITTED",
      "INTERVIEW",
      "OFFER",
    ];

    let current = application;
    for (const status of chain) {
      current = applications.transitionStatus(application.id, status);
      assert.equal(current.status, status);
    }

    assert.notEqual(current.startedAt, null);
    assert.notEqual(current.submittedAt, null);
  } finally {
    close();
  }
});

test("supports recovery transitions from FAILED", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    applications.transitionStatus(application.id, "MATCHED");
    applications.transitionStatus(application.id, "REVIEW");
    applications.transitionStatus(application.id, "READY_TO_APPLY");
    applications.transitionStatus(application.id, "IN_PROGRESS");
    const failed = applications.transitionStatus(application.id, "FAILED");
    assert.equal(failed.status, "FAILED");

    const recovered = applications.transitionStatus(application.id, "IN_PROGRESS");
    assert.equal(recovered.status, "IN_PROGRESS");
  } finally {
    close();
  }
});

test("rejects an invalid status transition", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    assert.throws(
      () => applications.transitionStatus(application.id, "SUBMITTED"),
      InvalidStatusTransitionError,
    );
  } finally {
    close();
  }
});

test("does not write an event when a transition is rejected", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    assert.throws(() => applications.transitionStatus(application.id, "OFFER"));
    assert.equal(applications.getEventHistory(application.id).length, 1);
  } finally {
    close();
  }
});

test("writes an atomic audit event per status change", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    applications.transitionStatus(application.id, "MATCHED", { message: "auto matched" });
    applications.transitionStatus(application.id, "REVIEW");

    const history = applications.getEventHistory(application.id);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((event) => event.eventType),
      ["CREATED", "STATUS_CHANGED", "STATUS_CHANGED"],
    );
    const matched = history[1];
    assert.ok(matched);
    assert.equal(matched.previousStatus, "DISCOVERED");
    assert.equal(matched.newStatus, "MATCHED");
    assert.equal(matched.message, "auto matched");
  } finally {
    close();
  }
});

test("lists applications by status", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });
    applications.transitionStatus(application.id, "MATCHED");

    assert.equal(applications.listByStatus("MATCHED").length, 1);
    assert.equal(applications.listByStatus("DISCOVERED").length, 0);
  } finally {
    close();
  }
});

test("records timestamps for IN_PROGRESS and SUBMITTED", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    applications.transitionStatus(application.id, "MATCHED");
    applications.transitionStatus(application.id, "REVIEW");
    applications.transitionStatus(application.id, "READY_TO_APPLY");
    const inProgress = applications.transitionStatus(application.id, "IN_PROGRESS");
    assert.notEqual(inProgress.startedAt, null);
    assert.equal(inProgress.submittedAt, null);

    applications.transitionStatus(application.id, "APPROVED");
    const submitted = applications.transitionStatus(application.id, "SUBMITTED");
    assert.notEqual(submitted.submittedAt, null);
  } finally {
    close();
  }
});
