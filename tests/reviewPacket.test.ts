import assert from "node:assert/strict";
import { test } from "node:test";
import type { Application } from "../src/domain/application.js";
import type { Job } from "../src/domain/job.js";
import type { CandidateProfile } from "../src/domain/profile.js";
import {
  buildReviewPacket,
  describeHumanAction,
  type BuildReviewPacketInput,
} from "../src/domain/reviewPacket.js";

function makeApplication(overrides: Partial<Application> = {}): Application {
  return {
    id: 1,
    jobId: 1,
    status: "WAITING_FOR_HUMAN",
    resumeVersion: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: null,
    lastUpdatedAt: "2026-01-02T00:00:00.000Z",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
    applicationUrlSource: "apply_link",
    applicationAts: "Greenhouse",
    applicationResolvedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    companyId: 1,
    title: "Software Engineer",
    canonicalUrl: "https://acme.test/jobs/1",
    source: "greenhouse",
    externalJobId: null,
    location: "Remote",
    employmentType: "FULL_TIME",
    workplaceType: "remote",
    description: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    matchScore: null,
    reviewStatus: "READY_TO_APPLY",
    scoreVersion: 1,
    scoreTotal: 82,
    scoreCoverage: 0.8,
    scoreConfidence: "high",
    scoreRecommendation: "HIGHPRIORITY",
    scoreBreakdown: null,
    scoredAt: "2026-01-01T00:00:00.000Z",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    fullName: "Ada Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+10000000000",
    location: "London",
    linkedinUrl: null,
    githubUrl: null,
    websiteUrl: null,
    targetRoles: [],
    skills: [],
    workExperience: [],
    education: [],
    preferredEmploymentTypes: [],
    minimumSalary: null,
    ...overrides,
  };
}

const RESUME = {
  id: "backend",
  label: "Backend Resume",
  kind: "resume" as const,
  fileName: "backend.pdf",
};

const COVER = {
  id: "cover",
  label: "Cover Letter",
  kind: "cover_letter" as const,
  fileName: "cover.pdf",
};

function completePacket(overrides: Partial<BuildReviewPacketInput> = {}) {
  return buildReviewPacket({
    application: makeApplication(),
    job: makeJob(),
    companyName: "Acme",
    resumeDocument: RESUME,
    coverLetterDocument: COVER,
    profile: makeProfile(),
    form: {
      pageKind: "application_form",
      hasApplicationForm: true,
      forms: 1,
      fields: 6,
      provide: 5,
      needsInput: 1,
      skip: 0,
      requiredNeedsInput: 0,
      needsInputLabels: ["Desired start date"],
    },
    ...overrides,
  });
}

test("a complete packet is ready and guides approval then manual submission", () => {
  const packet = completePacket();

  assert.equal(packet.summary.readyToSubmit, true);
  assert.equal(packet.summary.block, 0);
  assert.equal(packet.job.company, "Acme");
  assert.equal(packet.documents.resume?.fileName, "backend.pdf");
  assert.ok(packet.nextSteps[0]?.includes("Resume review"));
  assert.ok(packet.nextSteps.some((step) => step.includes("status 1 IN_PROGRESS")));
  assert.ok(packet.nextSteps.some((step) => step.includes("status 1 APPROVED")));
  assert.ok(packet.nextSteps.some((step) => step.includes("status 1 SUBMITTED")));
  assert.ok(packet.checklist.some((item) => item.id === "target" && item.severity === "ok"));
});

test("an IN_PROGRESS application is approved before manual submission", () => {
  const packet = completePacket({ application: makeApplication({ status: "IN_PROGRESS" }) });

  assert.ok(packet.nextSteps.some((step) => step.includes("status 1 APPROVED")));
  assert.ok(!packet.nextSteps.some((step) => step.includes("Resume review")));
});

test("an APPROVED application goes straight to manual submission", () => {
  const packet = completePacket({ application: makeApplication({ status: "APPROVED" }) });

  assert.ok(!packet.nextSteps.some((step) => step.includes("status 1 APPROVED")));
  assert.ok(packet.nextSteps.some((step) => step.includes("status 1 SUBMITTED")));
});

test("a terminal status gets no submission steps", () => {
  const packet = completePacket({ application: makeApplication({ status: "REJECTED" }) });

  assert.ok(!packet.nextSteps.some((step) => step.includes("SUBMITTED")));
  assert.ok(packet.nextSteps.some((step) => step.includes("no submission steps")));
});

test("a missing target blocks submission", () => {
  const packet = completePacket({
    application: makeApplication({
      applicationUrl: null,
      applicationUrlSource: null,
      applicationAts: null,
      applicationResolvedAt: null,
    }),
  });

  assert.equal(packet.summary.readyToSubmit, false);
  assert.equal(packet.summary.block, 1);
  assert.ok(packet.checklist.some((item) => item.id === "target" && item.severity === "block"));
  assert.ok(packet.nextSteps[0]?.includes("blocking"));
});

test("required fields that still need input block submission", () => {
  const packet = completePacket({
    form: {
      pageKind: "application_form",
      hasApplicationForm: true,
      forms: 1,
      fields: 6,
      provide: 4,
      needsInput: 2,
      skip: 0,
      requiredNeedsInput: 2,
      needsInputLabels: ["Desired start date", "Work authorization"],
    },
  });

  assert.equal(packet.summary.readyToSubmit, false);
  const item = packet.checklist.find((entry) => entry.id === "required-fields");
  assert.equal(item?.severity, "block");
  assert.match(item?.message ?? "", /Desired start date, Work authorization/);
});

test("missing profile, cover letter, and inspection are warnings, not blocks", () => {
  const packet = completePacket({
    profile: null,
    coverLetterDocument: null,
    form: null,
  });

  assert.equal(packet.summary.readyToSubmit, true);
  assert.ok(packet.checklist.some((item) => item.id === "profile" && item.severity === "warn"));
  assert.ok(
    packet.checklist.some((item) => item.id === "cover-letter" && item.severity === "warn"),
  );
  assert.ok(packet.checklist.some((item) => item.id === "form" && item.severity === "warn"));
});

test("an application outside the human-review statuses is flagged", () => {
  const packet = completePacket({ application: makeApplication({ status: "DRAFT" }) });

  const item = packet.checklist.find((entry) => entry.id === "status");
  assert.equal(item?.severity, "warn");
  assert.match(item?.message ?? "", /DRAFT/);
});

test("describeHumanAction maps each queue status to the next command", () => {
  assert.equal(describeHumanAction({ id: 3, status: "WAITING_FOR_HUMAN" }), "applications review 3");
  assert.equal(
    describeHumanAction({ id: 3, status: "APPROVED" }),
    "apply manually, then applications status 3 SUBMITTED",
  );
  assert.equal(describeHumanAction({ id: 3, status: "IN_PROGRESS" }), "applications prepare 3");
  assert.equal(describeHumanAction({ id: 3, status: "DRAFT" }), "-");
});
