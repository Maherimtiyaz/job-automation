import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/connection.js";
import { CandidateProfileSchema, type CandidateProfile } from "../src/domain/profile.js";
import { importJobs } from "../src/ingest/importJobs.js";
import { CompanyRepository } from "../src/repositories/companies.js";
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

function makeProfile(): CandidateProfile {
  return CandidateProfileSchema.parse({
    fullName: "Test Candidate",
    email: "test@example.com",
    targetRoles: [{ role: "Backend Engineer", priority: 3 }],
    skills: [{ name: "Python" }, { name: "PostgreSQL" }],
    workExperience: [
      {
        title: "Backend Engineer",
        company: "Acme",
        startDate: "2024-01-01",
        endDate: null,
        description: "Built Python services.",
      },
    ],
    education: [],
    preferredEmploymentTypes: ["FULL_TIME"],
    minimumSalary: { amount: 0, currency: "INR", period: "YEAR" },
  });
}

function rows(): unknown[] {
  return [
    {
      company: "Acme",
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
      description: "Python and PostgreSQL. 1+ years of experience.",
      location: "Remote",
      workplaceType: "remote",
    },
    {
      company: "Beta",
      title: "Python Developer",
      url: "https://beta.test/jobs/2",
      description: "Python APIs.",
      location: "Remote",
      workplaceType: "remote",
      source: "other",
    },
    { company: "Broken", title: "", url: "https://broken.test/1" },
    {
      company: "Acme",
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
    },
  ];
}

test("imports companies and jobs, scores them, and reports duplicates/invalid rows", () => {
  const db = openDatabase(":memory:");
  try {
    const result = importJobs(db, rows(), { profile: makeProfile(), defaultSource: "remotive" });

    assert.equal(result.summary.rows, 4);
    assert.equal(result.summary.inserted, 2);
    assert.equal(result.summary.updated, 0);
    assert.equal(result.summary.duplicates, 1);
    assert.equal(result.summary.invalid, 1);
    assert.equal(result.summary.scoringFailures, 0);

    const companies = new CompanyRepository(db).list();
    assert.deepEqual(
      companies.map((company) => company.name).sort(),
      ["Acme", "Beta"],
    );

    const jobs = new JobRepository(db).list();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.some((job) => job.source === "remotive"));
    assert.ok(jobs.some((job) => job.source === "other"));
    assert.ok(jobs.every((job) => job.scoreVersion !== null));
    assert.ok(jobs.every((job) => job.scoreTotal !== null));
  } finally {
    db.close();
  }
});

test("re-importing the same listings updates instead of duplicating", () => {
  const db = openDatabase(":memory:");
  try {
    importJobs(db, rows().slice(0, 2), { profile: makeProfile(), defaultSource: "remotive" });
    const second = importJobs(db, rows().slice(0, 2), {
      profile: makeProfile(),
      defaultSource: "remotive",
    });

    assert.equal(second.summary.inserted, 0);
    assert.equal(second.summary.updated, 2);
    assert.equal(new JobRepository(db).count(), 2);
    assert.equal(new CompanyRepository(db).count(), 2);
  } finally {
    db.close();
  }
});

test("dry run reports what would happen without writing", () => {
  const db = openDatabase(":memory:");
  try {
    const result = importJobs(db, rows().slice(0, 2), {
      profile: makeProfile(),
      defaultSource: "remotive",
      dryRun: true,
    });

    assert.equal(result.summary.inserted, 2);
    assert.equal(new JobRepository(db).count(), 0);
    assert.equal(new CompanyRepository(db).count(), 0);
    assert.ok(result.records.every((record) => record.message === "dry run - nothing written"));
  } finally {
    db.close();
  }
});

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

test("jobs import reads a JSON file and scores with the local profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-import-"));
  const captured = captureConsole();
  try {
    const dbPath = join(dir, "test.db");
    const profilePath = join(dir, "profile.json");
    const importPath = join(dir, "listings.json");
    writeFileSync(profilePath, JSON.stringify(makeProfile(), null, 2), "utf8");
    writeFileSync(importPath, JSON.stringify({ version: 1, jobs: rows().slice(0, 2) }), "utf8");

    process.env.DATABASE_PATH = dbPath;
    process.env.PROFILE_PATH = profilePath;
    process.env.COMPANIES_PATH = join(dir, "companies.json");
    process.env.RESUME_PATH = join(dir, "resumes.json");

    const first = await runCli(["jobs", "import", "--file", importPath]);
    assert.equal(first, 0);
    assert.match(captured.logs.join("\n"), /Imported 2 row\(s\)/);
    assert.match(captured.logs.join("\n"), /inserted: 2/);
    assert.match(captured.logs.join("\n"), /profile: loaded/);

    const db = openDatabase(dbPath);
    try {
      assert.equal(new JobRepository(db).count(), 2);
      assert.equal(new CompanyRepository(db).count(), 2);
    } finally {
      db.close();
    }

    captured.logs.length = 0;
    const second = await runCli(["jobs", "import", "--file", importPath]);
    assert.equal(second, 0);
    assert.match(captured.logs.join("\n"), /updated: 2/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("jobs import rejects a missing or malformed file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-import-bad-"));
  const captured = captureConsole();
  try {
    const dbPath = join(dir, "test.db");
    const importPath = join(dir, "bad.json");
    writeFileSync(importPath, "{not json", "utf8");

    process.env.DATABASE_PATH = dbPath;
    process.env.PROFILE_PATH = join(dir, "profile.json");
    process.env.COMPANIES_PATH = join(dir, "companies.json");
    process.env.RESUME_PATH = join(dir, "resumes.json");

    assert.equal(await runCli(["jobs", "import", "--file", join(dir, "missing.json")]), 1);
    assert.match(captured.errors.join("\n"), /could not read/);

    captured.errors.length = 0;
    assert.equal(await runCli(["jobs", "import", "--file", importPath]), 1);
    assert.match(captured.errors.join("\n"), /not valid JSON/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
