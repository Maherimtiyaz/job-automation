import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runCli } from "../../src/cli.js";
import { openDatabase } from "../../src/db/connection.js";
import { ApplicationRepository } from "../../src/repositories/applications.js";
import { CompanyRepository } from "../../src/repositories/companies.js";
import { JobRepository } from "../../src/repositories/jobs.js";

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

function plainHtml(): string {
  return `<!doctype html>
<html><head><title>A Plain Page</title></head>
<body><h1>Nothing to apply to</h1><p>No links or forms here.</p></body></html>`;
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
    if (path === "/plain") {
      send(plainHtml());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  // z.httpUrl() rejects IP-literal hostnames, so use a *.localhost alias that
  // resolves to the loopback listener (the same pattern as inspection.test.ts).
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

interface Seeded {
  dbPath: string;
  appId: number;
}

function seed(dir: string, jobUrl: string): Seeded {
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
      url: jobUrl,
      source: "acme",
    });
    const application = new ApplicationRepository(db).create({ jobId: job.id });
    return { dbPath, appId: application.id };
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

test("prepare resolves the apply link, records the target, and hands off to a human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-prepare-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/job/1`);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "prepare", String(seeded.appId)]);
    assert.equal(code, 0);
    assert.ok(captured.logs.join("\n").includes("WAITING_FOR_HUMAN"));

    const db = openDatabase(seeded.dbPath);
    try {
      const repo = new ApplicationRepository(db);
      const stored = repo.getById(seeded.appId);
      assert.equal(stored.status, "WAITING_FOR_HUMAN");
      assert.equal(stored.applicationUrl, `${baseUrl}/apply/1`);
      assert.equal(stored.applicationUrlSource, "apply_link");
      assert.equal(stored.applicationAts, "Greenhouse");
      assert.ok(stored.applicationResolvedAt !== null);

      const events = repo.getEventHistory(seeded.appId);
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

test("prepare records the job URL when the posting is itself the application form", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-prepare-form-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/apply/1`);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "prepare", String(seeded.appId)]);
    assert.equal(code, 0);

    const db = openDatabase(seeded.dbPath);
    try {
      const stored = new ApplicationRepository(db).getById(seeded.appId);
      assert.equal(stored.status, "WAITING_FOR_HUMAN");
      assert.equal(stored.applicationUrlSource, "job_url");
      assert.equal(stored.applicationUrl, `${baseUrl}/apply/1`);
    } finally {
      db.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("prepare fails safely when no application target can be resolved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-prepare-none-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/plain`);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "prepare", String(seeded.appId)]);
    assert.equal(code, 1);
    assert.ok(captured.errors.join("\n").includes("No application link"));

    const db = openDatabase(seeded.dbPath);
    try {
      const stored = new ApplicationRepository(db).getById(seeded.appId);
      assert.equal(stored.status, "DRAFT");
      assert.equal(stored.applicationUrl, null);
      assert.equal(stored.applicationUrlSource, null);
    } finally {
      db.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
