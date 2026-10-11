import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/db/connection.js";
import { runCli } from "../src/cli.js";
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