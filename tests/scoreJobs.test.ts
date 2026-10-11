import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../src/db/connection.js";
import { NotFoundError } from "../src/domain/errors.js";
import { createEmptyProfile } from "../src/domain/profile.js";
import { SCORING_VERSION } from "../src/domain/scoring.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { scoreJobs } from "../src/scoring/scoreJobs.js";
import { createTestDatabase } from "./support/db.js";

function seedJob(db: Db): { jobId: number } {
  const company = new CompanyRepository(db).create({ name: "Acme" });
  const job = new JobRepository(db).create({
    companyId: company.id,
    title: "Backend Engineer Intern",
    url: "https://acme.test/jobs/1",
    source: "acme",
    description: "Works on Node.js and SQL. 1+ years of experience.",
    location: "Remote",
    employmentType: "INTERNSHIP",
    workplaceType: "remote",
  });
  return { jobId: job.id };
}

test("scoreJobs scores pending jobs and persists the result", () => {
  const { db, close } = createTestDatabase();
  try {
    const jobsRepo = new JobRepository(db);
    const { jobId } = seedJob(db);

    const result = scoreJobs(db, createEmptyProfile());

    assert.equal(result.scored, 1);
    assert.equal(result.total, 1);

    const job = jobsRepo.getById(jobId);
    assert.equal(job.scoreVersion, SCORING_VERSION);
    assert.ok(job.scoreTotal !== null && job.scoreTotal >= 0 && job.scoreTotal <= 100);
    assert.equal(typeof job.scoreConfidence, "string");
    assert.ok(job.scoredAt !== null);
    assert.equal(jobsRepo.countScored(), 1);
    assert.deepEqual(jobsRepo.listNeedingScoring(SCORING_VERSION), []);
    assert.equal(jobsRepo.listNeedingScoring(0).length, 1);

    const breakdown = jobsRepo.getScoreBreakdown(jobId);
    assert.ok(breakdown);
    assert.equal(breakdown.components.length, 6);
    assert.equal(breakdown.reasons.length, 6);
  } finally {
    close();
  }
});

test("upserting a scored job invalidates its stored score", () => {
  const { db, close } = createTestDatabase();
  try {
    const jobsRepo = new JobRepository(db);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const input = {
      companyId: company.id,
      title: "Backend Engineer Intern",
      url: "https://acme.test/jobs/1",
      source: "acme",
    };
    const { job } = jobsRepo.upsert(input);
    scoreJobs(db, createEmptyProfile());
    assert.ok(jobsRepo.getById(job.id).scoreTotal !== null);

    jobsRepo.upsert({ ...input, title: "Senior Backend Engineer Intern" });

    const refreshed = jobsRepo.getById(job.id);
    assert.equal(refreshed.scoreVersion, null);
    assert.equal(refreshed.scoreTotal, null);
    assert.equal(refreshed.scoredAt, null);
    assert.deepEqual(jobsRepo.listNeedingScoring(SCORING_VERSION).map((j) => j.id), [job.id]);
  } finally {
    close();
  }
});

test("scoreJobs --force rescoring updates existing scores", () => {
  const { db, close } = createTestDatabase();
  try {
    const { jobId } = seedJob(db);
    const first = scoreJobs(db, createEmptyProfile());

    const secondForce = scoreJobs(db, createEmptyProfile(), { force: true });
    const again = scoreJobs(db, createEmptyProfile());

    assert.equal(first.total, 1);
    assert.equal(secondForce.total, 1);
    assert.equal(again.scored, 0);
    assert.ok(new JobRepository(db).getById(jobId).scoreTotal !== null);
  } finally {
    close();
  }
});

test("lists jobs by recommendation and minimum score", () => {
  const { db, close } = createTestDatabase();
  try {
    const jobsRepo = new JobRepository(db);
    const company = new CompanyRepository(db).create({ name: "Acme" });

    const good = jobsRepo.create({
      companyId: company.id,
      title: "Backend Engineer Intern",
      url: "https://acme.test/jobs/1",
      source: "acme",
      description: "TypeScript and SQL. 1+ years.",
      location: "Remote",
      employmentType: "INTERNSHIP",
      workplaceType: "remote",
    });
    const weak = jobsRepo.create({
      companyId: company.id,
      title: "Tickle Monster",
      url: "https://acme.test/jobs/2",
      source: "acme",
    });

    scoreJobs(db, createEmptyProfile());

    const goodRecommendation = jobsRepo.getById(good.id).scoreRecommendation;
    assert.ok(goodRecommendation);
    const byRecommendation = jobsRepo.list({ recommendation: goodRecommendation });
    const quality = jobsRepo.list({ minScore: 50 });

    assert.deepEqual(byRecommendation.map((job) => job.id), [good.id]);
    assert.ok(quality.every((job) => job.scoreTotal !== null && job.scoreTotal >= 50));
    assert.ok(quality.some((job) => job.id === good.id));
    assert.equal(quality.some((job) => job.id === weak.id), false);
  } finally {
    close();
  }
});

test("updateScore throws for a missing job", () => {
  const { db, close } = createTestDatabase();
  try {
    const jobsRepo = new JobRepository(db);
    const score = {
      jobId: 999,
      version: SCORING_VERSION,
      total: 50,
      coverage: 0.5,
      confidence: "medium" as const,
      recommendation: "REVIEW" as const,
      components: [],
      reasons: [],
      scoredAt: "2024-01-01T00:00:00.000Z",
    };
    assert.throws(() => jobsRepo.updateScore(999, score), NotFoundError);
  } finally {
    close();
  }
});