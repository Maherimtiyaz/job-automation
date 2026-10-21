import assert from "node:assert/strict";
import { test } from "node:test";
import type { Application, ApplicationEvent } from "../src/domain/application.js";
import type { AnalysisApplication } from "../src/domain/analytics.js";
import { computeApplicationAnalytics } from "../src/domain/analytics.js";
import type { ApplicationStatus } from "../src/domain/status.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { AnalyticsRepository } from "../src/repositories/analytics.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { createTestDatabase, seedCompanyAndJob } from "./support/db.js";

function makeApplication(overrides: Partial<Application> = {}): Application {
  return {
    id: 1,
    jobId: 1,
    status: "DRAFT",
    resumeVersion: null,
    startedAt: null,
    submittedAt: null,
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    applicationUrl: null,
    applicationUrlSource: null,
    applicationAts: null,
    applicationResolvedAt: null,
    ...overrides,
  };
}

function makeEvent(newStatus: ApplicationStatus): ApplicationEvent {
  return {
    id: 1,
    applicationId: 1,
    eventType: "STATUS_CHANGED",
    previousStatus: null,
    newStatus,
    message: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRow(
  application: Application,
  source: string | null,
  companyName: string | null,
  events: readonly ApplicationEvent[],
): AnalysisApplication {
  return { application, source, companyName, events };
}

test("computeApplicationAnalytics computes funnel, outcomes, and rates", () => {
  const draft = makeRow(
    makeApplication({ id: 1, status: "DRAFT" }),
    "greenhouse",
    "Acme",
    [],
  );
  const submitted = makeRow(
    makeApplication({
      id: 2,
      status: "SUBMITTED",
      submittedAt: "2026-01-01T01:00:00.000Z",
    }),
    "greenhouse",
    "Acme",
    [makeEvent("SUBMITTED")],
  );
  const offered = makeRow(
    makeApplication({
      id: 3,
      status: "OFFER",
      createdAt: "2026-01-01T00:00:00.000Z",
      submittedAt: "2026-01-02T00:00:00.000Z",
    }),
    "lever",
    "Beta",
    [makeEvent("SUBMITTED"), makeEvent("INTERVIEW"), makeEvent("OFFER")],
  );
  const rejected = makeRow(
    makeApplication({
      id: 4,
      status: "REJECTED",
      createdAt: "2025-12-31T00:00:00.000Z",
      submittedAt: "2025-12-31T12:00:00.000Z",
    }),
    "greenhouse",
    "Acme",
    [makeEvent("SUBMITTED"), makeEvent("REJECTED")],
  );

  const report = computeApplicationAnalytics([draft, submitted, offered, rejected]);

  assert.equal(report.applications, 4);
  assert.equal(report.everSubmitted, 3);
  assert.equal(report.everInterviewed, 1);
  assert.equal(report.everOffered, 1);
  assert.equal(report.everRejected, 1);
  assert.equal(report.responded, 2);

  assert.equal(report.funnel.DRAFT, 1);
  assert.equal(report.funnel.SUBMITTED, 1);
  assert.equal(report.funnel.OFFER, 1);
  assert.equal(report.funnel.REJECTED, 1);
  assert.equal(report.funnel.INTERVIEW ?? 0, 0);

  assert.deepEqual(report.outcomes, {
    preSubmission: 1,
    pendingResponse: 1,
    responded: 2,
    closed: 0,
    offered: 1,
    rejected: 1,
    withdrawn: 0,
    failed: 0,
  });

  assert.deepEqual(report.rates.submission, {
    numerator: 3,
    denominator: 4,
    percentage: 75,
  });
  assert.equal(report.rates.response.numerator, 2);
  assert.equal(report.rates.response.denominator, 3);
  assert.ok(Math.abs((report.rates.response.percentage ?? 0) - 66.6666) < 0.0001);
  assert.equal(report.rates.interview.numerator, 1);
  assert.equal(report.rates.offer.numerator, 1);

  assert.equal(report.timeToSubmit.count, 3);
  assert.equal(report.timeToSubmit.medianHours, 12);
  assert.ok(Math.abs((report.timeToSubmit.averageHours ?? 0) - 37 / 3) < 1e-9);

  assert.deepEqual(
    report.bySource.map((group) => group.key),
    ["greenhouse", "lever"],
  );
  assert.deepEqual(report.bySource[0], {
    key: "greenhouse",
    applications: 3,
    submitted: 2,
    responded: 1,
    offers: 0,
  });
  assert.deepEqual(report.bySource[1], {
    key: "lever",
    applications: 1,
    submitted: 1,
    responded: 1,
    offers: 1,
  });

  assert.deepEqual(
    report.byCompany.map((group) => group.key),
    ["Acme", "Beta"],
  );
  assert.deepEqual(report.byCompany[0], {
    key: "Acme",
    applications: 3,
    submitted: 2,
    responded: 1,
    offers: 0,
  });
});

test("computeApplicationAnalytics handles an empty input", () => {
  const report = computeApplicationAnalytics([]);

  assert.equal(report.applications, 0);
  assert.equal(report.everSubmitted, 0);
  assert.equal(report.everInterviewed, 0);
  assert.equal(report.everOffered, 0);
  assert.equal(report.everRejected, 0);
  assert.equal(report.responded, 0);
  assert.equal(report.rates.submission.percentage, undefined);
  assert.equal(report.rates.response.percentage, undefined);
  assert.equal(report.timeToSubmit.count, 0);
  assert.equal(report.timeToSubmit.medianHours, null);
  assert.equal(report.timeToSubmit.averageHours, null);
  assert.deepEqual(report.bySource, []);
  assert.deepEqual(report.byCompany, []);
});

test("AnalyticsRepository.applicationRows joins source and company and loads events", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedCompanyAndJob(db);

    const beta = new CompanyRepository(db).create({
      name: "Beta",
      website: "https://beta.test",
    });
    const leverJob = new JobRepository(db).create({
      companyId: beta.id,
      title: "Product Manager Intern",
      url: "https://beta.test/jobs/1",
      source: "lever",
    });

    const applications = new ApplicationRepository(db);
    const first = applications.create({ jobId });
    applications.transitionStatus(first.id, "IN_PROGRESS", {});
    applications.transitionStatus(first.id, "APPROVED", {});
    applications.transitionStatus(first.id, "SUBMITTED", {});
    applications.transitionStatus(first.id, "INTERVIEW", {});

    const second = applications.create({ jobId: leverJob.id });

    const rows = new AnalyticsRepository(db).applicationRows();
    assert.equal(rows.length, 2);

    const [rowA, rowB] = rows;
    assert.equal(rowA?.application.id, first.id);
    assert.equal(rowA?.source, "acme");
    assert.equal(rowA?.companyName, "Acme");
    assert.equal(
      rowA?.events.some((event) => event.newStatus === "SUBMITTED"),
      true,
    );
    assert.equal(rowA?.events.some((event) => event.newStatus === "INTERVIEW"), true);

    assert.equal(rowB?.application.id, second.id);
    assert.equal(rowB?.source, "lever");
    assert.equal(rowB?.companyName, "Beta");
    assert.equal(rowB?.events.some((event) => event.eventType === "CREATED"), true);

    const report = computeApplicationAnalytics(rows);
    assert.equal(report.applications, 2);
    assert.equal(report.everSubmitted, 1);
    assert.equal(report.everInterviewed, 1);
    assert.equal(report.responded, 1);
    assert.equal(report.funnel.INTERVIEW, 1);
    assert.equal(report.funnel.DRAFT, 1);
    assert.equal(report.rates.response.percentage, 100);
    assert.equal(report.rates.offer.percentage, 0);
  } finally {
    close();
  }
});