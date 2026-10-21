import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationStatus } from "../src/domain/status.js";
import {
  ConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  ValidationError,
} from "../src/domain/errors.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { createTestDatabase, seedCompanyAndJob } from "./support/db.js";

test("creates an application with an initial audit event", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);

    const application = applications.create({ jobId });

    assert.equal(application.status, "DRAFT");
    assert.equal(application.startedAt, null);
    assert.equal(application.submittedAt, null);
    assert.equal(application.createdAt, application.lastUpdatedAt);

    const history = applications.getEventHistory(application.id);
    assert.equal(history.length, 1);
    const first = history[0];
    assert.ok(first);
    assert.equal(first.eventType, "CREATED");
    assert.equal(first.previousStatus, null);
    assert.equal(first.newStatus, "DRAFT");
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

    applications.transitionStatus(application.id, "IN_PROGRESS", { message: "manual start" });
    applications.transitionStatus(application.id, "WAITING_FOR_HUMAN");

    const history = applications.getEventHistory(application.id);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((event) => event.eventType),
      ["CREATED", "STATUS_CHANGED", "STATUS_CHANGED"],
    );
    const firstChange = history[1];
    assert.ok(firstChange);
    assert.equal(firstChange.previousStatus, "DRAFT");
    assert.equal(firstChange.newStatus, "IN_PROGRESS");
    assert.equal(firstChange.message, "manual start");
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
    applications.transitionStatus(application.id, "IN_PROGRESS");

    assert.equal(applications.listByStatus("IN_PROGRESS").length, 1);
    assert.equal(applications.listByStatus("DRAFT").length, 0);
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

test("stores and exposes a resolved application target", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    assert.equal(application.applicationUrl, null);
    assert.equal(application.applicationUrlSource, null);
    assert.equal(application.applicationAts, null);
    assert.equal(application.applicationResolvedAt, null);

    const updated = applications.setApplicationTarget(application.id, {
      url: "https://boards.greenhouse.io/acme/jobs/1",
      source: "apply_link",
      atsPlatform: "Greenhouse",
    });

    assert.equal(updated.applicationUrl, "https://boards.greenhouse.io/acme/jobs/1");
    assert.equal(updated.applicationUrlSource, "apply_link");
    assert.equal(updated.applicationAts, "Greenhouse");
    assert.ok(updated.applicationResolvedAt !== null);
    assert.equal(updated.status, "DRAFT");

    const reloaded = applications.getById(application.id);
    assert.equal(reloaded.applicationUrl, updated.applicationUrl);
    assert.equal(reloaded.applicationUrlSource, "apply_link");
  } finally {
    close();
  }
});

test("rejects an invalid application target", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId });

    assert.throws(
      () => applications.setApplicationTarget(application.id, { url: "not-a-url", source: "apply_link" }),
      (error: unknown) => error instanceof ValidationError,
    );
  } finally {
    close();
  }
});

test("migration v4 adds the application target columns", () => {
  const { db, close } = createTestDatabase();
  try {
    const columns = db.prepare("PRAGMA table_info(applications)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    for (const expected of [
      "application_url",
      "application_url_source",
      "application_ats",
      "application_resolved_at",
    ]) {
      assert.ok(names.has(expected), `applications should have column ${expected}`);
    }
  } finally {
    close();
  }
});