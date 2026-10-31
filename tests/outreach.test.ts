import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/connection.js";
import { getLatestSchemaVersion } from "../src/db/migrations.js";
import { NotFoundError } from "../src/domain/errors.js";
import type { Job } from "../src/domain/job.js";
import {
  buildOutreachDraft,
  countWords,
  findPostingHook,
  matchSkills,
  OUTREACH_MAX_WORDS,
  renderOutreachEml,
  renderOutreachText,
} from "../src/domain/outreach.js";
import type { CandidateProfile } from "../src/domain/profile.js";
import { CandidateProfileSchema } from "../src/domain/profile.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { OutreachRepository } from "../src/repositories/outreach.js";

const POSTING = [
  "About us. We build work infrastructure for teams that need to own their data.",
  "We are an equal opportunity employer and offer great benefits to every employee.",
  "You'll own the Python services that move a customer's history between systems, and you will design the queues and workers behind them.",
  "Our stack is PostgreSQL and Kafka.",
  "Apply now through the portal.",
].join("\n");

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    companyId: 1,
    title: "Software Engineer",
    canonicalUrl: "https://acme.test/jobs/1",
    source: "greenhouse",
    externalJobId: null,
    location: "Remote",
    employmentType: "FULL_TIME",
    workplaceType: "remote",
    description: POSTING,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    matchScore: null,
    reviewStatus: "READY_TO_APPLY",
    scoreVersion: 1,
    scoreTotal: 80,
    scoreCoverage: 0.8,
    scoreConfidence: "high",
    scoreRecommendation: "HIGHPRIORITY",
    scoreBreakdown: null,
    scoredAt: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProfile(overrides: Record<string, unknown> = {}): CandidateProfile {
  return CandidateProfileSchema.parse({
    fullName: "Test Candidate",
    email: "candidate@example.test",
    githubUrl: "https://github.test/candidate",
    skills: [
      { name: "Python", proficiency: "advanced", years: 2 },
      { name: "PostgreSQL", proficiency: "intermediate", years: 1 },
      { name: "Rust", proficiency: "beginner", years: null },
    ],
    workExperience: [
      {
        title: "Backend Engineer",
        company: "Acme",
        startDate: "2024-01-01",
        endDate: null,
        description: null,
      },
    ],
    ...overrides,
  });
}

test("buildOutreachDraft cites the posting and the profile without inventing", () => {
  const draft = buildOutreachDraft({
    job: makeJob(),
    companyName: "Acme",
    profile: makeProfile(),
    resumeFileName: "backend-resume.pdf",
    recipientName: "Dana",
    recipientEmail: "dana@acme.test",
  });

  assert.equal(draft.recipientName, "Dana");
  assert.equal(draft.wordCount, countWords(draft.body));
  assert.ok(draft.wordCount > 0 && draft.wordCount <= OUTREACH_MAX_WORDS);
  assert.equal(draft.subject, "Software Engineer - Test Candidate, Python");
  assert.ok(draft.body.startsWith("Hi Dana,"));
  assert.ok(draft.body.includes(`"You'll own the Python services`));
  assert.ok(draft.body.includes("Backend Engineer at Acme (Jan 2024 - present)"));
  assert.ok(draft.body.includes("Python and PostgreSQL"));
  assert.ok(draft.body.includes("backend-resume.pdf"));
  assert.ok(draft.body.includes("candidate@example.test"));

  const sources = draft.evidence.map((item) => item.source);
  assert.ok(sources.includes("job.description"));
  assert.ok(sources.includes("profile.workExperience"));
  assert.ok(sources.includes("profile.skills"));
  assert.ok(sources.includes("resume store default"));
  assert.deepEqual(draft.gaps, []);
});

test("buildOutreachDraft is deterministic", () => {
  const input = {
    job: makeJob(),
    companyName: "Acme",
    profile: makeProfile(),
    resumeFileName: "backend-resume.pdf",
  };
  assert.deepEqual(buildOutreachDraft(input), buildOutreachDraft(input));
});

test("buildOutreachDraft reports gaps instead of inventing missing data", () => {
  const draft = buildOutreachDraft({
    job: makeJob({ description: null }),
    companyName: "Acme",
    profile: null,
  });

  assert.equal(draft.recipientName, null);
  assert.ok(!draft.body.includes("Most recently"));
  const fields = draft.gaps.map((gap) => gap.field);
  assert.ok(fields.includes("profile"));
  assert.ok(fields.includes("fullName"));
  assert.ok(fields.includes("description"));
  assert.ok(fields.includes("recipientName"));
});

test("buildOutreachDraft never claims a company the profile does not have", () => {
  const draft = buildOutreachDraft({
    job: makeJob(),
    companyName: "Acme",
    profile: makeProfile({ workExperience: [] }),
  });

  assert.ok(!draft.body.includes("Most recently"));
  assert.ok(draft.body.includes("I work mostly in Python and PostgreSQL."));
  assert.ok(draft.gaps.some((gap) => gap.field === "workExperience"));
});

test("matchSkills ranks title hits above description hits", () => {
  const profile = makeProfile();
  const matches = matchSkills(profile, "Python Engineer", "We use PostgreSQL heavily.");
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.skill.name, "Python");
  assert.equal(matches[0]?.inTitle, true);
  assert.equal(matches[1]?.skill.name, "PostgreSQL");
  assert.equal(matches[1]?.inTitle, false);
});

test("findPostingHook skips boilerplate and prefers a line naming the skill", () => {
  const hook = findPostingHook(POSTING, "Python");
  assert.ok(hook !== null);
  assert.ok(hook.startsWith("You'll own the Python services"));
  assert.ok(!hook.includes("equal opportunity"));
  assert.ok(!hook.endsWith("."));
  assert.equal(findPostingHook("", "Python"), null);
});

test("findPostingHook shortens a long sentence without dangling words", () => {
  const long =
    "You will own the Python services that move a customer's history between systems, " +
    "and you will design the queues and workers behind them, including retries, " +
    "idempotency, backpressure, and the jobs that must never run twice under any circumstances at all";
  const hook = findPostingHook(long, "Python");
  assert.ok(hook !== null);
  assert.ok(hook.length <= 180);
  assert.ok(!/\s(and|the|of|to|under)$/i.test(hook));
  assert.ok(!hook.endsWith(","));
});

test("findPostingHook ignores raw markup and bare tool lists", () => {
  const html = [
    "<p>About GitLab</p>",
    "<ul><li>Docker, Kubernetes, Helm, CI/CD, or cloud deployment.</li>",
    "<li>You will own the backend services behind merge requests and keep them fast.</li></ul>",
  ].join("");
  const hook = findPostingHook(html, "Docker");
  assert.ok(hook !== null);
  assert.ok(!hook.includes("<"));
  assert.ok(!hook.includes("</li>"));
  assert.ok(hook.startsWith("You will own the backend services"));
});

test("renderOutreachText shows evidence and gaps", () => {
  const withEvidence = renderOutreachText(
    buildOutreachDraft({
      job: makeJob(),
      companyName: "Acme",
      profile: makeProfile(),
    }),
  );
  assert.ok(withEvidence.includes("Subject:"));
  assert.ok(withEvidence.includes("Evidence (verify before sending):"));

  const withGaps = renderOutreachText(
    buildOutreachDraft({
      job: makeJob({ description: null }),
      companyName: "Acme",
      profile: null,
    }),
  );
  assert.ok(withGaps.includes("Gaps (the draft does not invent these)"));
});

test("renderOutreachEml is an RFC 822 message and rejects header injection", () => {
  const draft = buildOutreachDraft({
    job: makeJob(),
    companyName: "Acme",
    profile: makeProfile(),
  });
  const eml = renderOutreachEml(draft, "dana@acme.test");
  assert.ok(eml.startsWith("To: dana@acme.test\r\n"));
  assert.ok(eml.includes("\r\nSubject: "));
  assert.ok(eml.includes("\r\n\r\n"));
  assert.throws(() => renderOutreachEml(draft, "a@b.test\r\nBcc: x@y.test"), /line breaks/);
  assert.throws(() => renderOutreachEml(draft, "  "), /recipient email/);
});

interface Fixture {
  dir: string;
  dbPath: string;
  jobId: number;
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "jobauto-outreach-"));
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
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      description: POSTING,
    });
    return { dir, dbPath, jobId: job.id };
  } finally {
    db.close();
  }
}

function useEnvironment(fixture: Fixture, profile: CandidateProfile | null): void {
  process.env.DATABASE_PATH = fixture.dbPath;
  process.env.PROFILE_PATH = join(fixture.dir, "profile.json");
  process.env.COMPANIES_PATH = join(fixture.dir, "companies.json");
  process.env.RESUME_PATH = join(fixture.dir, "resumes.json");
  if (profile !== null) {
    writeFileSync(process.env.PROFILE_PATH, JSON.stringify(profile), "utf8");
  }
}

async function captureConsole<TResult>(
  fn: () => Promise<TResult>,
): Promise<{ result: TResult; logs: string[]; errors: string[] }> {
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
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    (console as unknown as { log: (...args: unknown[]) => void }).log = originalLog;
    (console as unknown as { error: (...args: unknown[]) => void }).error = originalError;
  }
}

test("outreach drafts persist and are listed newest first", () => {
  const fixture = createFixture();
  try {
    const db = openDatabase(fixture.dbPath);
    try {
      assert.equal(getLatestSchemaVersion(db), 5);
      const outreach = new OutreachRepository(db);
      const draft = buildOutreachDraft({
        job: new JobRepository(db).getById(fixture.jobId),
        companyName: "Acme",
        profile: makeProfile(),
      });

      assert.equal(outreach.count(), 0);
      const first = outreach.save(fixture.jobId, draft);
      const second = outreach.save(fixture.jobId, draft);

      assert.equal(first.id, 1);
      assert.equal(second.id, 2);
      assert.equal(outreach.count(), 2);
      assert.equal(outreach.latestForJob(fixture.jobId)?.id, 2);
      assert.deepEqual(
        outreach.list().map((row) => row.id),
        [2, 1],
      );
      assert.equal(first.subject, draft.subject);
      assert.deepEqual(first.evidence, draft.evidence);
      assert.throws(() => outreach.save(9_999, draft), NotFoundError);
    } finally {
      db.close();
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("CLI outreach draft --save stores a draft and outreach list shows it", async () => {
  const fixture = createFixture();
  try {
    useEnvironment(fixture, makeProfile());

    const drafted = await captureConsole(() =>
      runCli([
        "outreach",
        "draft",
        String(fixture.jobId),
        "--recipient",
        "Dana",
        "--save",
      ]),
    );
    assert.equal(drafted.result, 0);
    assert.ok(drafted.logs.some((line) => line.includes("Saved outreach draft 1")));
    assert.ok(drafted.logs.some((line) => line.includes("Subject: Software Engineer")));

    const listed = await captureConsole(() => runCli(["outreach", "list"]));
    assert.equal(listed.result, 0);
    assert.ok(listed.logs.some((line) => line.includes("draft 1: job")));
    assert.ok(listed.logs.some((line) => line.includes("to Dana")));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.PROFILE_PATH;
    delete process.env.COMPANIES_PATH;
    delete process.env.RESUME_PATH;
  }
});

test("CLI outreach draft --format eml requires a recipient address", async () => {
  const fixture = createFixture();
  try {
    useEnvironment(fixture, makeProfile());
    const result = await captureConsole(() =>
      runCli(["outreach", "draft", String(fixture.jobId), "--format", "eml"]),
    );
    assert.equal(result.result, 1);
    assert.ok(result.errors.some((line) => line.includes("--email")));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.PROFILE_PATH;
    delete process.env.COMPANIES_PATH;
    delete process.env.RESUME_PATH;
  }
});

test("CLI outreach draft --format json is machine readable and writes a file", async () => {
  const fixture = createFixture();
  try {
    useEnvironment(fixture, makeProfile());
    const output = join(fixture.dir, "draft.json");
    const result = await captureConsole(() =>
      runCli([
        "outreach",
        "draft",
        String(fixture.jobId),
        "--format",
        "json",
        "--output",
        output,
      ]),
    );
    assert.equal(result.result, 0);
    assert.ok(result.logs.some((line) => line.includes(`Wrote outreach draft to ${output}`)));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.PROFILE_PATH;
    delete process.env.COMPANIES_PATH;
    delete process.env.RESUME_PATH;
  }
});
