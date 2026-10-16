import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

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
import {
  closeSharedBrowserService,
  sharedBrowserService,
} from "../../src/browser/browserService.js";
import { writeInspectionReport } from "../../src/browser/report.js";
import type { InspectionReport } from "../../src/browser/types.js";
import { runCli } from "../../src/cli.js";
import { openDatabase } from "../../src/db/connection.js";
import { ApplicationRepository } from "../../src/repositories/applications.js";
import { CompanyRepository } from "../../src/repositories/companies.js";
import { JobRepository } from "../../src/repositories/jobs.js";
import { JobReviewRepository } from "../../src/repositories/jobReviews.js";

function jobDetailHtml(): string {
  return `<!doctype html>
<html><head><title>Senior Software Engineer at Acme</title></head>
<body>
<h1>Senior Software Engineer</h1>
<p>We are looking for a Senior Software Engineer to join our platform team. You will work on large-scale services with a modern stack.</p>
<a href="/apply/1">Apply Now</a>
<p class="ats">Powered by Greenhouse</p>
</body></html>`;
}

function applicationFormHtml(): string {
  return `<!doctype html>
<html><head><title>Apply - Senior Software Engineer</title></head>
<body>
<h1>Application</h1>
<form method="post" action="/apply/submit">
<input type="hidden" name="csrf" value="hidden-token-abc">
<label for="full_name">Full name</label>
<input id="full_name" name="fullName" value="Jane Secret Doe" required>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email">
<label for="password">Password</label>
<input id="password" name="password" type="password" value="p@ssw0rd-topsecret">
<label for="cover_letter">Cover letter</label>
<textarea id="cover_letter" name="coverLetter" placeholder="Introduce yourself"></textarea>
<label for="source">How did you hear about us?</label>
<select id="source" name="source"><option value="">Select...</option><option value="linkedin">LinkedIn</option><option value="referral">Friend</option></select>
<button type="submit">Submit Application</button>
</form>
<p class="ats">Powered by Greenhouse</p>
</body></html>`;
}

function plainHtml(): string {
  return `<!doctype html>
<html><head><title>A Plain Page</title></head>
<body>
<h1>Just a page</h1>
<p>Some text with no forms or links on it.</p>
</body></html>`;
}

let server: Server;
let baseUrl = "";
let loopbackAliasUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/slow") {
      return;
    }
    if (path === "/job/1") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(jobDetailHtml());
      return;
    }
    if (path === "/apply/1") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(applicationFormHtml());
      return;
    }
    if (path === "/redirect") {
      res.writeHead(302, { Location: "/apply/1" });
      res.end();
      return;
    }
    if (path === "/notfound") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>Not found</h1>");
      return;
    }
    if (path === "/plain") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(plainHtml());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  loopbackAliasUrl = `http://foo.localhost:${address.port}`;
  await sharedBrowserService();
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await closeSharedBrowserService();
});

test("inspects a job detail page and detects the ATS from page text", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/job/1`);
  assert.equal(report.status, "ok");
  assert.equal(report.httpStatus, 200);
  assert.equal(report.title, "Senior Software Engineer at Acme");
  assert.equal(report.pageKind, "job_detail");
  assert.equal(report.pageKindReliability, "heuristic");
  assert.ok(report.headings.includes("Senior Software Engineer"));
  assert.equal(report.applyLinks.length, 1);
  assert.equal(report.applyLinks[0]?.text, "Apply Now");
  assert.equal(report.applyLinks[0]?.url, `${baseUrl}/apply/1`);
  assert.equal(report.ats.platform, "Greenhouse");
  assert.equal(report.ats.confidence, "medium");
  assert.equal(report.hasApplicationForm, false);
  assert.equal(report.forms.length, 0);
  assert.ok(report.warnings.some((warning) => warning.message.includes("localhost")));
});

test("inspects an application form and never leaks field values", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/apply/1`);
  assert.equal(report.status, "ok");
  assert.equal(report.pageKind, "application_form");
  assert.equal(report.pageKindReliability, "observed");
  assert.equal(report.hasApplicationForm, true);
  assert.equal(report.forms.length, 1);

  const form = report.forms[0];
  assert.ok(form);
  assert.ok(form.submitButtons.includes("Submit Application"));
  assert.equal(form.note, "action or submit text suggests an application form");

  const nameField = form.fields.find((field) => field.name === "fullName");
  assert.ok(nameField);
  assert.equal(nameField.required, true);
  assert.equal(nameField.label, "Full name");

  const emailField = form.fields.find((field) => field.name === "email");
  assert.ok(emailField);
  assert.equal(emailField.autocomplete, "email");

  const passwordField = form.fields.find((field) => field.name === "password");
  assert.ok(passwordField);
  assert.equal(passwordField.sensitive, true);
  assert.equal(passwordField.inputType, "password");

  const sourceField = form.fields.find((field) => field.name === "source");
  assert.ok(sourceField);
  assert.equal(sourceField.kind, "select");
  assert.deepEqual(sourceField.selectOptions, ["Select...", "LinkedIn", "Friend"]);

  assert.ok(report.hiddenFieldCount >= 1);
  assert.ok(!form.fields.some((field) => field.name === "csrf"));

  const json = JSON.stringify(report);
  for (const secret of ["Jane Secret Doe", "p@ssw0rd-topsecret", "hidden-token-abc"]) {
    assert.ok(!json.includes(secret), `report must not contain ${secret}`);
  }
});

test("treats a page with no ATS signals as UNKNOWN", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/plain`);
  assert.equal(report.status, "ok");
  assert.equal(report.ats.platform, "UNKNOWN");
  assert.equal(report.ats.confidence, "low");
  assert.equal(report.pageKind, "unknown");
});

test("reports a navigation timeout as a failed inspection", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/slow`, {
    navigationTimeoutMs: 600,
    operationTimeoutMs: 1500,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.problems.some((problem) => problem.kind === "timeout"));
  assert.ok(report.loadDurationMs >= 600);
});

test("reports a connection failure as a failed inspection", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const report = await sharedBrowserService().inspect(`http://127.0.0.1:${port}/`, {
    navigationTimeoutMs: 5000,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.problems.some((problem) => problem.kind === "navigation"));
});

test("follows redirects and warns about the final URL", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/redirect`);
  assert.equal(report.status, "ok");
  assert.ok(report.finalUrl?.endsWith("/apply/1"));
  assert.ok(report.warnings.some((warning) => warning.message.startsWith("Redirected to")));
});

test("reports a 404 status as a warning without failing", async () => {
  const report = await sharedBrowserService().inspect(`${baseUrl}/notfound`);
  assert.equal(report.status, "ok");
  assert.equal(report.httpStatus, 404);
  assert.ok(report.warnings.some((warning) => warning.message.includes("404")));
});

test("writes a screenshot when requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-shot-"));
  try {
    const target = join(dir, "shot.png");
    const report = await sharedBrowserService().inspect(`${baseUrl}/apply/1`, {
      screenshot: target,
    });
    assert.equal(report.screenshotPath, target);
    assert.ok(existsSync(target), "screenshot file should exist");
    assert.ok(readFileSync(target).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeInspectionReport emits a sanitized JSON file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-report-"));
  try {
    const report: InspectionReport = await sharedBrowserService().inspect(`${baseUrl}/apply/1`);
    const target = join(dir, "report.json");
    writeInspectionReport(target, report);

    const raw = readFileSync(target, "utf8");
    for (const secret of ["Jane Secret Doe", "p@ssw0rd-topsecret", "hidden-token-abc"]) {
      assert.ok(!raw.includes(secret), `report file must not contain ${secret}`);
    }
    const parsed = JSON.parse(raw) as InspectionReport;
    assert.equal(parsed.title, "Apply - Senior Software Engineer");
    assert.equal(parsed.pageKind, "application_form");
    assert.ok(parsed.hiddenFieldCount >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureConsole(): {
  logs: string[];
  errors: string[];
  restore(): void;
} {
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

test("CLI browser inspect-job does not mutate application or review state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-browser-cli-"));
  const captured = captureConsole();
  try {
    const dbPath = join(dir, "test.db");
    process.env.DATABASE_PATH = dbPath;
    process.env.PROFILE_PATH = join(dir, "profile.json");
    process.env.COMPANIES_PATH = join(dir, "companies.json");

    const db = openDatabase(dbPath);
    let jobId: number;
    try {
      const company = new CompanyRepository(db).create({
        name: "Acme",
        website: "https://acme.test",
      });
      const job = new JobRepository(db).create({
        companyId: company.id,
        title: "Software Engineer Intern",
        url: `${loopbackAliasUrl}/job/1`,
        source: "acme",
      });
      jobId = job.id;
    } finally {
      db.close();
    }

    const code = await runCli(["browser", "inspect-job", String(jobId)]);
    assert.equal(code, 0);
    assert.ok(captured.logs.join("\n").includes("Inspection: job_detail"));
    assert.ok(captured.logs.join("\n").includes("Apply Now"));

    const db2 = openDatabase(dbPath);
    try {
      assert.equal(new ApplicationRepository(db2).list().length, 0);
      assert.equal(new JobReviewRepository(db2).getReviewHistory(jobId).length, 0);
      const stored = new JobRepository(db2).getById(jobId);
      assert.equal(stored.title, "Software Engineer Intern");
    } finally {
      db2.close();
    }
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});