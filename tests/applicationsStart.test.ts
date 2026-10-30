import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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

function jobDetailHtml(): string {
  return `<!doctype html>
<html><head><title>Software Engineer at Acme</title></head>
<body>
<h1>Software Engineer</h1>
<p>Build things with us.</p>
<a href="/apply/1">Apply Now</a>
<p class="ats">Powered by Greenhouse</p>
</body></html>`;
}

function applicationFormHtml(): string {
  return `<!doctype html>
<html><head><title>Apply - Software Engineer</title></head>
<body>
<h1>Application</h1>
<form method="post" action="/apply/submit">
<label for="full_name">Full name</label>
<input id="full_name" name="fullName" required>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email">
<button type="submit">Submit Application</button>
</form>
<p class="ats">Powered by Greenhouse</p>
</body></html>`;
}

let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const send = (html: string): void => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    };
    if (path === "/job/1") {
      send(jobDetailHtml());
      return;
    }
    if (path === "/apply/1") {
      send(applicationFormHtml());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  baseUrl = `http://foo.localhost:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
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

function seed(dir: string, options: { withApplication?: boolean } = {}): {
  dbPath: string;
  jobId: number;
  applicationId: number | null;
} {
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  try {
    const company = new CompanyRepository(db).create({
      name: "Acme",
      website: "https://acme.test",
    });
    const job = new JobRepository(db).create({
      companyId: company.id,
      title: "Software Engineer",
      url: `${baseUrl}/job/1`,
      source: "acme",
    });
    const application =
      options.withApplication === true
        ? new ApplicationRepository(db).create({ jobId: job.id })
        : null;
    return { dbPath, jobId: job.id, applicationId: application?.id ?? null };
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

test("start creates the application and prepares it for human review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-start-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "start", String(seeded.jobId)]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /Created application 1 for job 1/);
    assert.ok(output.includes("WAITING_FOR_HUMAN"));

    const db = openDatabase(seeded.dbPath);
    try {
      const repo = new ApplicationRepository(db);
      const stored = repo.findByJobId(seeded.jobId);
      assert.ok(stored !== null);
      assert.equal(stored.status, "WAITING_FOR_HUMAN");
      assert.equal(stored.applicationUrl, `${baseUrl}/apply/1`);
      assert.equal(stored.applicationUrlSource, "apply_link");
      assert.equal(stored.applicationAts, "Greenhouse");

      const events = repo.getEventHistory(stored.id);
      assert.deepEqual(
        events.map((event) => event.newStatus),
        ["DRAFT", "IN_PROGRESS", "WAITING_FOR_HUMAN"],
      );
    } finally {
      db.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("start is idempotent once the application awaits human review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-start-idempotent-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir);
    useEnvironment(dir, seeded.dbPath);

    const first = await runCli(["applications", "start", String(seeded.jobId)]);
    assert.equal(first, 0);

    captured.logs.length = 0;
    captured.errors.length = 0;
    const second = await runCli(["applications", "start", String(seeded.jobId)]);
    assert.equal(second, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /already awaits human review/);
    assert.match(output, /Next: applications review 1/);

    const db = openDatabase(seeded.dbPath);
    try {
      const repo = new ApplicationRepository(db);
      const applications = repo.list();
      assert.equal(applications.length, 1);
      const events = repo.getEventHistory(applications[0]!.id);
      assert.equal(events.length, 3);
    } finally {
      db.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("start prepares an existing DRAFT application instead of creating a duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-start-draft-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, { withApplication: true });
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "start", String(seeded.jobId)]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /Starting application 1 for job 1/);

    const db = openDatabase(seeded.dbPath);
    try {
      const applications = new ApplicationRepository(db).list();
      assert.equal(applications.length, 1);
      assert.equal(applications[0]!.status, "WAITING_FOR_HUMAN");
    } finally {
      db.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("start refuses an application that has already been approved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-start-approved-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, { withApplication: true });
    const db = openDatabase(seeded.dbPath);
    try {
      const repo = new ApplicationRepository(db);
      repo.transitionStatus(seeded.applicationId as number, "IN_PROGRESS");
      repo.transitionStatus(seeded.applicationId as number, "APPROVED");
    } finally {
      db.close();
    }
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "start", String(seeded.jobId)]);
    assert.equal(code, 1);
    assert.match(captured.errors.join("\n"), /only DRAFT or IN_PROGRESS applications can be started/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
