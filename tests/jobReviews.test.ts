import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidStatusTransitionError } from "../src/domain/errors.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { JobReviewRepository } from "../src/repositories/jobReviews.js";
import { createTestDatabase, seedCompanyAndJob } from "./support/db.js";

test("new jobs start in the NEW review state", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);
    assert.equal(reviews.getStatus(jobId), "NEW");
    const summary = reviews.summary();
    assert.equal(summary.total, 1);
    assert.equal(summary.byStatus.NEW, 1);
  } finally {
    close();
  }
});

test("shortlist, ready, and reopen follow the review transitions", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);

    const shortlisted = reviews.transitionStatus(jobId, "SHORTLISTED", { reason: "good stack" });
    assert.equal(shortlisted.reviewStatus, "SHORTLISTED");

    const ready = reviews.transitionStatus(jobId, "READY_TO_APPLY");
    assert.equal(ready.reviewStatus, "READY_TO_APPLY");

    const reopened = reviews.transitionStatus(jobId, "SHORTLISTED").reviewStatus;
    const backToNew = reviews.transitionStatus(jobId, "NEW");
    assert.equal(reopened, "SHORTLISTED");
    assert.equal(backToNew.reviewStatus, "NEW");
  } finally {
    close();
  }
});

test("dismissing records a reason in the review history", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);

    reviews.transitionStatus(jobId, "DISMISSED", { reason: "not in target role" });
    const history = reviews.getReviewHistory(jobId);
    assert.equal(history.length, 1);
    const event = history[0];
    assert.ok(event);
    assert.equal(event.eventType, "STATUS_CHANGED");
    assert.equal(event.previousStatus, "NEW");
    assert.equal(event.newStatus, "DISMISSED");
    assert.equal(event.reason, "not in target role");
  } finally {
    close();
  }
});

test("repeated identical actions are idempotent and write no extra event", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);

    const first = reviews.transitionStatus(jobId, "SHORTLISTED");
    const second = reviews.transitionStatus(jobId, "SHORTLISTED");
    assert.equal(first.reviewStatus, "SHORTLISTED");
    assert.equal(second.reviewStatus, "SHORTLISTED");
    assert.equal(reviews.getReviewHistory(jobId).length, 1);
  } finally {
    close();
  }
});

test("rejects an invalid review transition", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);

    reviews.transitionStatus(jobId, "READY_TO_APPLY");
    assert.throws(
      () => reviews.transitionStatus(jobId, "NEW"),
      InvalidStatusTransitionError,
    );
  } finally {
    close();
  }
});

test("rejected transitions write no review event", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);
    const reviews = new JobReviewRepository(db);

    reviews.transitionStatus(jobId, "DISMISSED");
    assert.throws(() => reviews.transitionStatus(jobId, "READY_TO_APPLY"));
    assert.equal(reviews.getReviewHistory(jobId).length, 1);
  } finally {
    close();
  }
});

test("lists jobs by review state", () => {
  const { db, close } = createTestDatabase();
  try {
    const { companyId } = seedCompanyAndJob(db);
    const jobs = new JobRepository(db);
    const reviews = new JobReviewRepository(db);

    jobs.create({
      companyId,
      title: "Second Role",
      url: "https://acme.test/jobs/2",
      source: "acme",
    });
    const byState = reviews.listByStatus("NEW");
    assert.equal(byState.length, 2);

    const second = jobs.list().find((job) => job.title === "Second Role");
    assert.ok(second);
    reviews.transitionStatus(second.id, "DISMISSED");
    const remaining = reviews.listByStatus("NEW");
    assert.equal(remaining.length, 1);
  } finally {
    close();
  }
});