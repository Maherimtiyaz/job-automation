import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConflictError, DomainError } from "../src/domain/errors.js";
import {
  CandidateProfileSchema,
  createEmptyProfile,
  describeProfileGaps,
  TARGET_ROLES,
} from "../src/domain/profile.js";
import {
  loadProfileFromFile,
  profileExists,
  ProfileNotFoundError,
  writeProfileTemplate,
} from "../src/profile/profileStore.js";

test("createEmptyProfile ships the known target roles with default priority", () => {
  const profile = createEmptyProfile();

  assert.equal(profile.fullName, null);
  assert.equal(profile.email, null);
  assert.equal(profile.phone, null);
  assert.equal(profile.location, null);
  assert.equal(profile.minimumSalary, null);
  assert.equal(profile.skills.length, 0);
  assert.equal(profile.workExperience.length, 0);
  assert.equal(profile.preferredEmploymentTypes.length, 0);
  assert.deepEqual(
    profile.targetRoles.map((entry) => entry.role),
    [...TARGET_ROLES],
  );
  assert.ok(profile.targetRoles.every((entry) => entry.priority === 3));
});

test("CandidateProfileSchema parses a fully populated profile", () => {
  const profile = CandidateProfileSchema.parse({
    fullName: "Ada Lovelace",
    headline: "Backend Engineer Intern",
    email: "ada@example.com",
    phone: "+44 20 7946 0958",
    location: "London, UK",
    linkedinUrl: "https://linkedin.com/in/ada",
    githubUrl: "https://github.com/ada",
    websiteUrl: "https://ada.example",
    targetRoles: [{ role: "Backend Engineer", priority: 5 }],
    skills: [{ name: "SQL", proficiency: "advanced", years: 2 }],
    workExperience: [
      { title: "SWE", company: "Acme", startDate: "2022-01-01", endDate: "2023-01-01" },
    ],
    education: [{ institution: "MIT" }],
    preferredEmploymentTypes: ["INTERNSHIP"],
    minimumSalary: { amount: 40000, currency: "usd" },
  });

  assert.equal(profile.fullName, "Ada Lovelace");
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.githubUrl, "https://github.com/ada");
  assert.equal(profile.skills[0]?.proficiency, "advanced");
  assert.equal(profile.minimumSalary?.currency, "USD");
  assert.equal(profile.minimumSalary?.period, "YEAR");
});

test("CandidateProfileSchema rejects an invalid email", () => {
  assert.equal(CandidateProfileSchema.safeParse({ email: "not-an-email" }).success, false);
});

test("CandidateProfileSchema rejects invalid values", () => {
  assert.equal(CandidateProfileSchema.safeParse({ skills: [{}] }).success, false);
  assert.equal(
    CandidateProfileSchema.safeParse({ targetRoles: [{ role: "Backend", priority: 6 }] }).success,
    false,
  );
  assert.equal(
    CandidateProfileSchema.safeParse({
      workExperience: [{ title: "SWE", company: "Acme", startDate: "not a date" }],
    }).success,
    false,
  );
});

test("describeProfileGaps reports every missing signal on an empty profile", () => {
  const gaps = describeProfileGaps(createEmptyProfile());
  const fields = gaps.map((gap) => gap.field);

  assert.ok(fields.includes("fullName"));
  assert.ok(fields.includes("email"));
  assert.ok(fields.includes("phone"));
  assert.ok(fields.includes("location"));
  assert.ok(fields.includes("skills"));
  assert.ok(fields.includes("workExperience"));
  assert.ok(fields.includes("preferredEmploymentTypes"));
  assert.ok(fields.includes("minimumSalary"));
  assert.equal(fields.includes("targetRoles"), false);
});

test("profile template round-trips through the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-automation-profile-"));
  try {
    const path = join(dir, "profile.json");
    assert.equal(profileExists(path), false);

    const written = writeProfileTemplate(path);
    assert.equal(written, path);
    assert.equal(profileExists(path), true);

    const loaded = loadProfileFromFile(path);
    assert.deepEqual(loaded, createEmptyProfile());
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), createEmptyProfile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProfileTemplate refuses to overwrite without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-automation-profile-"));
  try {
    const path = join(dir, "profile.json");
    writeProfileTemplate(path);
    assert.throws(() => writeProfileTemplate(path), ConflictError);
    writeProfileTemplate(path, { overwrite: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProfileFromFile reports missing and malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-automation-profile-"));
  try {
    const missing = join(dir, "missing.json");
    assert.throws(() => loadProfileFromFile(missing), ProfileNotFoundError);

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json", "utf8");
    assert.throws(() => loadProfileFromFile(malformed), DomainError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});