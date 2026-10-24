import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/connection.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
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

function seedSubmitted(dir: string): { dbPath: string; oldId: number; freshId: number } {
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  try {
    const company = new CompanyRepository(db).create({
      name: "Acme",
      website: "https://acme.test",
    });
    const jobs = new JobRepository(db);
    const applications = new ApplicationRepository(db);

    const submit = (index: number): number => {
      const job = jobs.create({
        companyId: company.id,
        title: `Role ${index}`,
        url: `https://acme.test/jobs/${index}`,
        source: "acme",
      });
      const application = applications.create({ jobId: job.id });
      applications.transitionStatus(application.id, "IN_PROGRESS");
      applications.transitionStatus(application.id, "APPROVED");
      applications.transitionStatus(application.id, "SUBMITTED");
      return application.id;
    };

    const oldId = submit(1);
    const freshId = submit(2);

    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    db.prepare("UPDATE applications SET submitted_at = ?, last_updated_at = ? WHERE id = ?").run(
      tenDaysAgo,
      tenDaysAgo,
      oldId,
    );

    return { dbPath, oldId, freshId };
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

test("follow-ups lists only submissions past the threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-followups-"));
  const captured = captureConsole();
  try {
    const seeded = seedSubmitted(dir);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "follow-ups", "--days", "7"]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /Follow-ups due: 1/);
    assert.match(output, new RegExp(`application ${seeded.oldId}:`));
    assert.doesNotMatch(output, new RegExp(`application ${seeded.freshId}:`));
    assert.match(output, /10d ago/);
    assert.match(output, /INTERVIEW\|REJECTED\|OFFER/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("follow-ups --days 0 includes a same-day submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-followups-zero-"));
  const captured = captureConsole();
  try {
    const seeded = seedSubmitted(dir);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "follow-ups", "--days", "0"]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /Follow-ups due: 2/);
    assert.match(output, new RegExp(`application ${seeded.oldId}:`));
    assert.match(output, new RegExp(`application ${seeded.freshId}:`));
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("follow-ups reports an empty queue and honors --limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-followups-limit-"));
  const captured = captureConsole();
  try {
    const seeded = seedSubmitted(dir);
    useEnvironment(dir, seeded.dbPath);

    const limited = await runCli(["applications", "follow-ups", "--days", "0", "--limit", "1"]);
    assert.equal(limited, 0);
    assert.match(captured.logs.join("\n"), /1 more \(raise --limit to see them\)/);

    captured.logs.length = 0;
    const none = await runCli(["applications", "follow-ups", "--days", "365"]);
    assert.equal(none, 0);
    assert.match(captured.logs.join("\n"), /No follow-ups due/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
