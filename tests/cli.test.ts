import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.js";
import { runCli } from "../src/cli.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";

interface Captured {
  logs: string[];
  errors: string[];
  clear(): void;
  restore(): void;
}

function captureConsole(): Captured {
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
    clear() {
      logs.length = 0;
      errors.length = 0;
    },
    restore() {
      (console as unknown as { log: (...args: unknown[]) => void }).log = originalLog;
      (console as unknown as { error: (...args: unknown[]) => void }).error = originalError;
    },
  };
}

function tempEnv(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-cli-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  process.env.PROFILE_PATH = join(dir, "profile.json");
  process.env.COMPANIES_PATH = join(dir, "companies.json");
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("status opens a fresh database and reports zero records", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["status"]);
    assert.equal(code, 0);
    assert.ok(captured.logs.join("\n").includes("Records: companies=0 jobs=0"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("profile:init writes a template and status reports it", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    assert.equal(await runCli(["profile:init"]), 0);
    assert.ok(captured.logs.join("\n").includes("Wrote profile template"));

    captured.clear();
    const code = await runCli(["status"]);
    assert.equal(code, 0);
    assert.ok(captured.logs.join("\n").includes("Profile:"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("companies:init then add then list then disable round-trips", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    assert.equal(await runCli(["companies:init"]), 0);
    assert.ok(captured.logs.join("\n").includes("Wrote company registry template"));

    captured.clear();
    const addCode = await runCli([
      "companies:add",
      "--name",
      "Acme",
      "--ats",
      "greenhouse",
      "--board",
      "acmeboard",
      "--website",
      "https://acme.test",
    ]);
    assert.equal(addCode, 0);
    assert.ok(captured.logs.join("\n").includes("Added Acme (greenhouse)"));

    captured.clear();
    assert.equal(await runCli(["companies:list"]), 0);
    const listLog = captured.logs.join("\n");
    assert.ok(listLog.includes("Acme"));
    assert.ok(listLog.includes("board=acmeboard"));

    captured.clear();
    assert.equal(await runCli(["companies:disable", "--name", "acme"]), 0);

    captured.clear();
    assert.equal(await runCli(["companies:list"]), 0);
    assert.ok(captured.logs.join("\n").includes("[disabled]"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("companies:add without a registry explains the next step", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["companies:add", "--name", "Acme"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("companies:init"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs sources lists both sources with enabled counts", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    await runCli(["companies:init"]);
    await runCli([
      "companies:add",
      "--name",
      "Acme",
      "--ats",
      "greenhouse",
      "--board",
      "acme",
    ]);

    captured.clear();
    const code = await runCli(["jobs", "sources"]);
    assert.equal(code, 0);
    const log = captured.logs.join("\n");
    assert.ok(log.includes("greenhouse"));
    assert.ok(log.includes("lever"));
    assert.ok(log.includes("1 enabled"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs discover with an empty registry prints guidance without any network", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    await runCli(["companies:init"]);

    captured.clear();
    const code = await runCli(["jobs", "discover"]);
    assert.equal(code, 0);
    assert.ok(captured.logs.join("\n").includes("No enabled companies found"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs discover with an unknown company errors before any network", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    await runCli(["companies:init"]);
    await runCli([
      "companies:add",
      "--name",
      "Acme",
      "--ats",
      "greenhouse",
      "--board",
      "acme",
    ]);

    captured.clear();
    const code = await runCli(["jobs", "discover", "--company", "Missing Corp"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("is not in the registry"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs list and jobs show render stored jobs", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    new JobRepository(db).create({
      companyId: company.id,
      title: "Backend Engineer Intern",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "1",
      location: "Remote",
    });
    db.close();

    captured.clear();
    const listCode = await runCli(["jobs", "list"]);
    assert.equal(listCode, 0);
    const listLog = captured.logs.join("\n");
    assert.ok(listLog.includes("Backend Engineer Intern"));
    assert.ok(listLog.includes("(greenhouse)"));

    captured.clear();
    const showCode = await runCli(["jobs", "show", "1"]);
    assert.equal(showCode, 0);
    const showLog = captured.logs.join("\n");
    assert.ok(showLog.includes("Job 1: Backend Engineer Intern"));
    assert.ok(showLog.includes("Source:"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs with no subcommand returns a usage error", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["jobs"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("missing jobs subcommand"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs review lists new jobs with a relevance verdict", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    new JobRepository(db).create({
      companyId: company.id,
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "1",
    });
    db.close();

    captured.clear();
    const code = await runCli(["jobs", "review"]);
    assert.equal(code, 0);
    const log = captured.logs.join("\n");
    assert.ok(log.includes("Backend Engineer"));
    assert.ok(log.includes("UNSCORED"));
    assert.ok(log.includes("jobs shortlist"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs shortlist/dismiss/ready/reopen transitions and history", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    new JobRepository(db).create({
      companyId: company.id,
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "1",
    });
    db.close();

    captured.clear();
    assert.equal(await runCli(["jobs", "shortlist", "1", "--reason", "great stack"]), 0);
    let log = captured.logs.join("\n");
    assert.ok(log.includes("NEW -> SHORTLISTED"));

    captured.clear();
    assert.equal(await runCli(["jobs", "ready", "1"]), 0);
    log = captured.logs.join("\n");
    assert.ok(log.includes("SHORTLISTED -> READY_TO_APPLY"));

    captured.clear();
    assert.equal(await runCli(["jobs", "shortlist", "1"]), 0);
    assert.equal(await runCli(["jobs", "reopen", "1"]), 0);
    assert.ok(captured.logs.join("\n").includes("-> NEW"));

    captured.clear();
    assert.equal(await runCli(["jobs", "review-history", "1"]), 0);
    log = captured.logs.join("\n");
    assert.ok(log.includes("NEW -> SHORTLISTED"));
    assert.ok(log.includes("great stack"));
    assert.match(log, /Review history for job 1/);
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("jobs review only shows the requested review state", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    new JobRepository(db).create({
      companyId: company.id,
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "1",
    });
    db.close();

    await runCli(["jobs", "dismiss", "1"]);
    captured.clear();
    assert.equal(await runCli(["jobs", "review"]), 0);
    assert.ok(!captured.logs.join("\n").includes("Backend Engineer"));

    captured.clear();
    assert.equal(await runCli(["jobs", "review", "--state", "DISMISSED"]), 0);
    assert.ok(captured.logs.join("\n").includes("Backend Engineer"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("applications create/list/status/events workflow", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({ name: "Acme" });
    new JobRepository(db).create({
      companyId: company.id,
      title: "Backend Engineer",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "1",
    });
    db.close();

    captured.clear();
    assert.equal(await runCli(["applications", "create", "1", "--notes", "v1"]), 0);
    assert.ok(captured.logs.join("\n").includes("Created application 1"));

    captured.clear();
    assert.equal(await runCli(["applications", "list"]), 0);
    assert.ok(captured.logs.join("\n").includes("application 1"));
    assert.ok(captured.logs.join("\n").includes("Backend Engineer"));

    captured.clear();
    assert.equal(await runCli(["applications", "status", "1", "IN_PROGRESS"]), 0);
    assert.ok(captured.logs.join("\n").includes("-> IN_PROGRESS"));

    captured.clear();
    assert.equal(await runCli(["applications", "show", "1"]), 0);
    const showLog = captured.logs.join("\n");
    assert.ok(showLog.includes("Status:   IN_PROGRESS"));

    captured.clear();
    assert.equal(await runCli(["applications", "events", "1"]), 0);
    const eventsLog = captured.logs.join("\n");
    assert.ok(eventsLog.includes("CREATED - -> DRAFT"));
    assert.ok(eventsLog.includes("STATUS_CHANGED DRAFT -> IN_PROGRESS"));

    captured.clear();
    assert.equal(await runCli(["applications", "create", "1"]), 1);
    assert.ok(captured.errors.join("\n").includes("already exists"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("browser inspect-url rejects unsupported schemes before launching a browser", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["browser", "inspect-url", "javascript:alert(1)"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("Unsupported URL protocol"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("browser inspect-url rejects malformed URLs", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["browser", "inspect-url", "not a url"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("Invalid URL"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("browser inspect-url rejects URLs with embedded credentials", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["browser", "inspect-url", "https://user:pass@example.com/jobs/1"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("credentials"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("browser inspect-job rejects an unknown job id without launching a browser", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    openDatabase(process.env.DATABASE_PATH as string).close();
    const code = await runCli(["browser", "inspect-job", "999"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("Job not found"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("browser inspect-job rejects a non-numeric job id", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["browser", "inspect-job", "abc"]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("positive job id"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("analytics reports interaction with applications", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({
      name: "Acme",
      website: "https://acme.test",
    });
    const job = new JobRepository(db).create({
      companyId: company.id,
      title: "Software Engineer Intern",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
    });
    const applications = new ApplicationRepository(db);
    const app = applications.create({ jobId: job.id });
    applications.transitionStatus(app.id, "IN_PROGRESS", {});
    applications.transitionStatus(app.id, "APPROVED", {});
    applications.transitionStatus(app.id, "SUBMITTED", {});
    applications.transitionStatus(app.id, "INTERVIEW", {});
    db.close();

    const code = await runCli(["analytics"]);
    assert.equal(code, 0);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("Application analytics (1 application(s), 1 submitted):"));
    assert.ok(output.includes("Funnel (current status):"));
    assert.ok(output.includes("INTERVIEW"));
    assert.ok(output.includes("response (of submitted): 100.0% (1/1)"));
    assert.ok(output.includes("Ever reached (from audit history):"));
    assert.ok(output.includes("submitted: 1"));
    assert.ok(output.includes("By source (top 5):"));
    assert.ok(output.includes("greenhouse"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("analytics filters by --source", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const db = openDatabase(process.env.DATABASE_PATH as string);
    const company = new CompanyRepository(db).create({
      name: "Acme",
      website: "https://acme.test",
    });
    const greenhouseJob = new JobRepository(db).create({
      companyId: company.id,
      title: "Intern A",
      url: "https://acme.test/jobs/a",
      source: "greenhouse",
    });
    const leverJob = new JobRepository(db).create({
      companyId: company.id,
      title: "Intern B",
      url: "https://acme.test/jobs/b",
      source: "lever",
    });
    const applications = new ApplicationRepository(db);
    applications.create({ jobId: greenhouseJob.id });
    applications.transitionStatus(applications.create({ jobId: leverJob.id }).id, "IN_PROGRESS", {});
    db.close();

    const code = await runCli(["analytics", "--source", "greenhouse"]);
    assert.equal(code, 0);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("Application analytics (1 application(s)):"));
    assert.ok(output.includes("DRAFT"));
    assert.ok(!output.includes("lever"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});

test("analytics on an empty database reports zero applications", async () => {
  const env = tempEnv();
  const captured = captureConsole();
  try {
    const code = await runCli(["analytics"]);
    assert.equal(code, 0);
    const output = captured.logs.join("\n");
    assert.ok(output.includes("Application analytics (0 application(s)):"));
    assert.ok(output.includes("median: -"));
    assert.ok(output.includes("none"));
  } finally {
    captured.restore();
    env.cleanup();
  }
});