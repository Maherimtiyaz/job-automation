import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/connection.js";
import type { ReviewPacket } from "../src/domain/reviewPacket.js";
import { ApplicationRepository } from "../src/repositories/applications.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { addResumeToRegistry, writeResumeRegistryTemplate } from "../src/resume/resumeStore.js";

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
<label for="start">Desired start date</label>
<input id="start" name="desiredStartDate" required>
<label for="resume">Resume</label>
<input id="resume" name="resume" type="file">
<button type="submit">Submit Application</button>
</form>
<p>Powered by Greenhouse</p>
</body></html>`;
}

function jobDetailHtml(): string {
  return `<!doctype html>
<html><head><title>Software Engineer at Acme</title></head>
<body><h1>Software Engineer</h1><p>Build things with us.</p>
<a href="/apply/1">Apply Now</a></body></html>`;
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
    if (path === "/apply/1") {
      send(applicationFormHtml());
      return;
    }
    if (path === "/job/1") {
      send(jobDetailHtml());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  // z.httpUrl() rejects IP-literal hostnames; *.localhost resolves to loopback.
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

function useEnvironment(dir: string, dbPath: string): void {
  process.env.DATABASE_PATH = dbPath;
  process.env.PROFILE_PATH = join(dir, "profile.json");
  process.env.COMPANIES_PATH = join(dir, "companies.json");
  process.env.RESUME_PATH = join(dir, "resumes.json");

  writeFileSync(
    join(dir, "profile.json"),
    `${JSON.stringify(
      {
        fullName: "Ada Lovelace",
        email: "ada@example.test",
        phone: "+10000000000",
        location: "London",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const resumeFile = join(dir, "backend.pdf");
  writeFileSync(resumeFile, "dummy resume", "utf8");
  writeResumeRegistryTemplate(join(dir, "resumes.json"));
  addResumeToRegistry(join(dir, "resumes.json"), {
    filePath: resumeFile,
    label: "Backend Resume",
    kind: "resume",
    isDefault: true,
  });
}

function seed(dir: string, targetUrl: string | null): { dbPath: string; appId: number } {
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
    const applications = new ApplicationRepository(db);
    const application = applications.create({ jobId: job.id });
    if (targetUrl !== null) {
      applications.setApplicationTarget(application.id, {
        url: targetUrl,
        source: "apply_link",
        atsPlatform: "Greenhouse",
      });
    }
    applications.transitionStatus(application.id, "IN_PROGRESS");
    applications.transitionStatus(application.id, "WAITING_FOR_HUMAN");
    return { dbPath, appId: application.id };
  } finally {
    db.close();
  }
}

test("applications queue lists human-action work with the next command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-queue-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/apply/1`);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "queue"]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, new RegExp(`application ${seeded.appId}`));
    assert.match(output, /WAITING_FOR_HUMAN/);
    assert.match(output, new RegExp(`applications review ${seeded.appId}`));
    assert.match(output, /Greenhouse/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("applications review prints a packet and writes JSON without leaking paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-review-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/apply/1`);
    useEnvironment(dir, seeded.dbPath);

    const packetPath = join(dir, "packet.json");
    const code = await runCli([
      "applications",
      "review",
      String(seeded.appId),
      "--output",
      packetPath,
    ]);
    assert.equal(code, 0);

    const output = captured.logs.join("\n");
    assert.match(output, /review packet/);
    assert.match(output, /Target recorded from apply_link/);
    assert.match(output, /Backend Resume/);
    assert.match(output, /Ready to submit: YES/);
    assert.match(output, new RegExp(`applications status ${seeded.appId} APPROVED`));
    assert.match(output, new RegExp(`applications status ${seeded.appId} SUBMITTED`));

    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as ReviewPacket;
    assert.equal(packet.applicationId, seeded.appId);
    assert.equal(packet.summary.readyToSubmit, true);
    assert.equal(packet.documents.resume?.fileName, "backend.pdf");
    assert.equal(packet.target.source, "apply_link");
    assert.equal(packet.target.ats, "Greenhouse");
    // The full local directory must never appear in the packet.
    assert.ok(!readFileSync(packetPath, "utf8").includes(dir));
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("applications review --inspect adds the read-only form summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-review-inspect-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, `${baseUrl}/apply/1`);
    useEnvironment(dir, seeded.dbPath);

    const packetPath = join(dir, "packet.json");
    const code = await runCli([
      "applications",
      "review",
      String(seeded.appId),
      "--inspect",
      "--output",
      packetPath,
    ]);
    assert.equal(code, 0);

    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as ReviewPacket;
    assert.equal(packet.form?.pageKind, "application_form");
    assert.equal(packet.form?.hasApplicationForm, true);
    assert.ok((packet.form?.fields ?? 0) >= 4);
    assert.ok((packet.form?.requiredNeedsInput ?? 0) >= 1);
    assert.ok(packet.form?.needsInputLabels.includes("Desired start date"));
    assert.equal(packet.summary.readyToSubmit, false);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});

test("applications review --inspect fails safely when no target is recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-review-no-target-"));
  const captured = captureConsole();
  try {
    const seeded = seed(dir, null);
    useEnvironment(dir, seeded.dbPath);

    const code = await runCli(["applications", "review", String(seeded.appId), "--inspect"]);
    assert.equal(code, 1);
    assert.match(captured.errors.join("\n"), /has no recorded target/);
  } finally {
    captured.restore();
    await removeDirRecursive(dir);
  }
});
