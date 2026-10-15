import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFillPlan, type BuildFillPlanOptions } from "../../src/browser/fillPlan.js";
import type { InspectedField, InspectedForm } from "../../src/browser/types.js";
import { createEmptyProfile, type CandidateProfile } from "../../src/domain/profile.js";
import { ResumeRegistrySchema } from "../../src/domain/resume.js";

function field(overrides: Partial<InspectedField> & { id: string }): InspectedField {
  return {
    kind: "input",
    inputType: null,
    name: null,
    label: null,
    placeholder: null,
    autocomplete: null,
    required: false,
    readonly: false,
    disabled: false,
    sensitive: false,
    selectOptions: null,
    ...overrides,
  };
}

function form(fields: readonly InspectedField[]): InspectedForm {
  return { action: null, method: "post", fields, submitButtons: ["Submit"], note: null };
}

function richProfile(): CandidateProfile {
  return {
    ...createEmptyProfile(),
    fullName: "Ada Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.com",
    phone: "+44 20 7946 0958",
    location: "London, UK",
    linkedinUrl: "https://linkedin.com/in/ada",
    githubUrl: "https://github.com/ada",
    websiteUrl: "https://ada.example",
    minimumSalary: { amount: 40000, currency: "USD", period: "YEAR" },
  };
}

function run(fields: readonly InspectedField[], options: Partial<BuildFillPlanOptions> = {}) {
  const base: BuildFillPlanOptions = {
    forms: [form(fields)],
    profile: richProfile(),
    pageKind: "application_form",
    hasApplicationForm: true,
  };
  return buildFillPlan({ ...base, ...options });
}

test("maps profile-backed fields without exposing values by default", () => {
  const report = run([
    field({ id: "a", label: "Email", inputType: "email" }),
    field({ id: "b", label: "First name" }),
    field({ id: "c", label: "Last name" }),
    field({ id: "d", label: "Full name" }),
    field({ id: "e", label: "Phone" }),
    field({ id: "f", label: "City" }),
    field({ id: "g", name: "linkedin_profile" }),
    field({ id: "h", name: "github" }),
    field({ id: "i", label: "Portfolio" }),
    field({ id: "j", label: "Expected salary" }),
  ]);

  assert.deepEqual(
    report.entries.map((entry) => [entry.target, entry.decision]),
    [
      ["email", "PROVIDE"],
      ["firstName", "PROVIDE"],
      ["lastName", "PROVIDE"],
      ["fullName", "PROVIDE"],
      ["phone", "PROVIDE"],
      ["location", "PROVIDE"],
      ["linkedinUrl", "PROVIDE"],
      ["githubUrl", "PROVIDE"],
      ["websiteUrl", "PROVIDE"],
      ["minimumSalary", "PROVIDE"],
    ],
  );
  assert.ok(report.entries.every((entry) => entry.value === null));
  assert.ok(report.entries.every((entry) => entry.valueHidden));
});

test("derives first and last name from full name", () => {
  const report = run([field({ id: "a", label: "First name" }), field({ id: "b", label: "Last name" })]);
  const first = report.entries[0];
  const last = report.entries[1];
  assert.ok(first && last);
  assert.equal(first.reason, "derived from profile fullName");
  assert.equal(last.reason, "derived from profile fullName");
});

test("shows values when includeValues is set", () => {
  const report = run(
    [
      field({ id: "a", label: "Email", inputType: "email" }),
      field({ id: "b", label: "Phone" }),
      field({ id: "c", label: "Expected salary" }),
    ],
    { includeValues: true },
  );

  assert.equal(report.entries[0]?.value, "ada@example.com");
  assert.equal(report.entries[1]?.value, "+44 20 7946 0958");
  assert.equal(report.entries[2]?.value, "40000 USD/YEAR");
  assert.ok(report.entries.every((entry) => entry.valueHidden === false));
});

test("never provides a value for sensitive inputs", () => {
  const report = run([
    field({ id: "p", name: "password", inputType: "password", sensitive: true, required: true }),
  ]);
  const entry = report.entries[0];
  assert.ok(entry);
  assert.equal(entry.decision, "SKIP");
  assert.equal(entry.target, null);
  assert.equal(entry.value, null);
  assert.match(entry.reason, /sensitive/);
});

test("marks mapped fields as needing input when no profile is loaded", () => {
  const report = run([field({ id: "a", label: "Email", inputType: "email", required: true })], {
    profile: null,
  });
  const entry = report.entries[0];
  assert.equal(report.profileLoaded, false);
  assert.ok(entry);
  assert.equal(entry.decision, "NEEDS_INPUT");
  assert.equal(entry.target, "email");
  assert.equal(report.summary.requiredNeedsInput, 1);
  assert.ok(report.warnings.some((warning) => warning.message.includes("No candidate profile")));
});

test("flags required unmapped fields and skips optional unmapped ones", () => {
  const report = run([
    field({ id: "a", label: "Company name", required: true }),
    field({ id: "b", label: "Preferred office" }),
  ]);
  const company = report.entries[0];
  const office = report.entries[1];
  assert.ok(company && office);
  assert.equal(company.decision, "NEEDS_INPUT");
  assert.equal(company.target, null);
  assert.equal(office.decision, "SKIP");
});

test("routes resume and cover letter to manual input", () => {
  const report = run([
    field({ id: "r", name: "resume", inputType: "file", required: true }),
    field({ id: "cv", label: "Cover letter" }),
  ]);
  assert.deepEqual(
    report.entries.map((entry) => [entry.target, entry.decision]),
    [
      ["resume", "NEEDS_INPUT"],
      ["coverLetter", "NEEDS_INPUT"],
    ],
  );
});

test("skips EEO questions and flags work-authorization questions", () => {
  const report = run([
    field({ id: "g", label: "Gender" }),
    field({ id: "v", label: "Are you legally authorized to work here?" }),
  ]);
  assert.equal(report.entries[0]?.decision, "SKIP");
  assert.equal(report.entries[1]?.decision, "NEEDS_INPUT");
});

test("needs input when the profile lacks a mapped value", () => {
  const report = run([field({ id: "g", name: "github" })], {
    profile: { ...richProfile(), githubUrl: null },
  });
  const entry = report.entries[0];
  assert.ok(entry);
  assert.equal(entry.decision, "NEEDS_INPUT");
  assert.match(entry.reason, /githubUrl/);
});

test("summary counts decisions and the plan is deterministic", () => {
  const fields = [
    field({ id: "a", label: "Email", inputType: "email" }),
    field({ id: "b", label: "Password", inputType: "password", sensitive: true }),
    field({ id: "c", label: "Gender" }),
    field({ id: "d", label: "Company name", required: true }),
  ];
  const first = run(fields);
  const second = run(fields);
  assert.deepEqual(first, second);
  assert.deepEqual(first.summary, {
    forms: 1,
    fields: 4,
    provide: 1,
    needsInput: 1,
    skip: 2,
    requiredNeedsInput: 1,
  });
});

test("derives last name only when the full name has multiple tokens", () => {
  const report = run([field({ id: "a", label: "Last name" })], {
    profile: { ...richProfile(), fullName: "Prince" },
  });
  assert.equal(report.entries[0]?.decision, "NEEDS_INPUT");
});

function resumeRegistry(entries: readonly Record<string, unknown>[]) {
  return ResumeRegistrySchema.parse({ version: 1, resumes: entries });
}

test("provides resume and cover letter from the store defaults", () => {
  const resumes = resumeRegistry([
    { id: "r1", label: "Ada_Resume", kind: "resume", filePath: "/docs/Ada_Resume.pdf", isDefault: true, createdAt: "t" },
    { id: "c1", label: "Ada_Cover", kind: "cover_letter", filePath: "/docs/Ada_Cover.pdf", isDefault: true, createdAt: "t" },
  ]);
  const report = run(
    [
      field({ id: "r", name: "resume", inputType: "file", required: true }),
      field({ id: "c", name: "coverLetter" }),
    ],
    { resumes },
  );

  const [resumeEntry, coverEntry] = report.entries;
  assert.ok(resumeEntry && coverEntry);
  assert.equal(resumeEntry.decision, "PROVIDE");
  assert.equal(resumeEntry.target, "resume");
  assert.equal(resumeEntry.value, null);
  assert.equal(resumeEntry.document?.id, "r1");
  assert.equal(resumeEntry.document?.fileName, "Ada_Resume.pdf");
  assert.match(resumeEntry.reason, /Ada_Resume/);

  assert.equal(coverEntry.decision, "PROVIDE");
  assert.equal(coverEntry.target, "coverLetter");
  assert.equal(coverEntry.document?.fileName, "Ada_Cover.pdf");
});

test("needs input when the store has no default of the requested kind", () => {
  const resumes = resumeRegistry([
    { id: "r1", label: "Ada", kind: "resume", filePath: "/a.pdf", isDefault: false, createdAt: "t" },
  ]);
  const report = run([field({ id: "r", name: "resume" }), field({ id: "c", name: "coverLetter" })], {
    resumes,
  });

  assert.equal(report.entries[0]?.decision, "NEEDS_INPUT");
  assert.match(report.entries[0]?.reason ?? "", /no default resume in the resume store/);
  assert.equal(report.entries[1]?.decision, "NEEDS_INPUT");
  assert.match(report.entries[1]?.reason ?? "", /no default cover letter in the resume store/);
});

test("explains a missing resume store instead of a missing default", () => {
  const report = run([field({ id: "r", name: "resume" })]);
  assert.equal(report.entries[0]?.decision, "NEEDS_INPUT");
  assert.match(report.entries[0]?.reason ?? "", /no resume store configured/);
  assert.equal(report.entries[0]?.document, null);
});
