import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/connection.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobReviewRepository } from "../src/repositories/jobReviews.js";
import { JobRepository } from "../src/repositories/jobs.js";

async function removeDirRecursive(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface Capture {
  logs: string[];
  errors: string[];
  restore(): void;
}

function captureConsole(): Capture {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  (console as unknown as { log: (...args: unknown[]) => void }).log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  (console as unknown as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  return {
    logs,
    errors,
    restore() {
      (console as unknown as { log: (...args: unknown[]) => void }).log = originalLog;
      (console as unknown as { error: (...args: unknown[]) => void }).error = originalError;
    },
  };
}

interface Seeded {
  dbPath: string;
  readyHighId: number;
  readyLowId: number;
  appliedReadyId: number;
  shortlistedId: number;
}

function seed(dir: string): Seeded {
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  try {
    const company = new CompanyRepository(db).create({
      name: "Acme",
      website: "https://acme.test",
    });
    const jobs = new JobRepository(db);
    const reviews = new JobReviewRepository(db);
    const applications = new ApplicationRepository(db);

    const createJob = (slug: string, score: number): number => {
      const job = jobs.create({
        companyId: company.id,
        title: `Role ${slug}`,
        url: `https://acme.test/jobs/${slug}`,
        source: "acme",
      });
      db.prepare(
        "UPDATE jobs SET score_total = ?, score_recommendation = ? WHERE id = ?",
      ).run(score, "GOODMATCH", job.id);
      return job.id;
    };

    const readyHighId = createJob("high", 88);
    const readyLowId = createJob("low", 61);
    const appliedReadyId = createJob("applied", 95);
    const shortlistedId = createJob("shortlisted", 99);

    reviews.transitionStatus(readyHighId, "READY_TO_APPLY");
    reviews.transitionStatus(readyLowId, "READY_TO_APPLY");
    reviews.transitionStatus(appliedReadyId, "READY_TO_APPLY");
    reviews.transitionStatus(shortlistedId, "SHORTLISTED");
    applications.create({ jobId: appliedReadyId });

    return { dbPath, readyHighId, readyLowId, appliedReadyId, shortlistedId };
  } finally {
    db.close();
  }
}

function useEnvironment(dir: string, dbPath: string): void {
  process.env.DATABASE_PATH = dbPath;
  process.env.PROFILE_PATH = join(dir, "profile.json");
  process.env.COMPANIES_PATH = join(dir, "companies.json");
  process.env.RESUME_PATH = join(dir, "resumes.json");
}

test("apply-queue lists READY_TO_APPLY jobs without applications, best first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-apply-queue-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["jobs", "apply-queue"]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /Apply queue: 2 READY_TO_APPLY job\(s\) without an application/);
    assert.ok(output.includes(`job ${seeded.readyHighId} [88.0 GOODMATCH]`));
    assert.ok(output.includes(`job ${seeded.readyLowId} [61.0 GOODMATCH]`));
    assert.ok(output.includes(`next: applications start ${seeded.readyHighId}`));
    assert.ok(!output.includes(`job ${seeded.appliedReadyId}`));
    assert.ok(!output.includes(`job ${seeded.shortlistedId}`));
    assert.ok(
      output.indexOf(`job ${seeded.readyHighId}`) < output.indexOf(`job ${seeded.readyLowId}`),
    );
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("apply-queue honors --limit and reports the remainder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-apply-queue-limit-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["jobs", "apply-queue", "--limit", "1"]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /\(showing 1\)/);
    assert.match(output, /\.\.\. 1 more \(raise --limit to see them\)/);
    assert.ok(output.includes(`job ${seeded.readyHighId}`));
    assert.ok(!output.includes(`job ${seeded.readyLowId}`));
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("apply-queue explains how to fill an empty queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-apply-queue-empty-"));
  const captured = captureConsole();
  try {
    const dbPath = join(dir, "test.db");
    const db = openDatabase(dbPath);
    try {
      new CompanyRepository(db).create({ name: "Acme", website: "https://acme.test" });
    } finally {
      db.close();
    }
    useEnvironment(dir, dbPath);

    const code = await runCli(["jobs", "apply-queue"]);
    assert.equal(code, 0);
    assert.match(captured.logs.join("\n"), /Apply queue is empty/);
    assert.match(captured.logs.join("\n"), /jobs ready <id>/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
