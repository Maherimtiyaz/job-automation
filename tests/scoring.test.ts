import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateProfile } from "../src/domain/profile.js";
import { CandidateProfileSchema, createEmptyProfile } from "../src/domain/profile.js";
import type { ScorableJob } from "../src/domain/scoring.js";
import {
  NEUTRAL_COMPONENT_SCORE,
  SCORE_COMPONENT_KEYS,
  SCORING_VERSION,
} from "../src/domain/scoring.js";
import {
  classifySeniority,
  confidenceFor,
  containsSkill,
  extractRequiredYears,
  jaccard,
  normalizeRoleTokens,
  recommendationFor,
  scoreJob,
} from "../src/scoring/scoreJob.js";

const NOW = "2024-01-01T00:00:00.000Z";

function makeJob(overrides: Partial<ScorableJob> = {}): ScorableJob {
  return {
    id: 1,
    title: "Backend Engineer Intern",
    description: null,
    location: null,
    workplaceType: "unknown",
    employmentType: null,
    companyName: "Acme",
    ...overrides,
  };
}

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return CandidateProfileSchema.parse({ ...createEmptyProfile(), ...overrides });
}

test("scores all six components deterministically", () => {
  const job = makeJob({
    description: "Backend Engineer Intern. TypeScript and SQL used daily.",
    location: "Remote",
    employmentType: "INTERNSHIP",
    workplaceType: "remote",
  });
  const score = scoreJob(job, makeProfile(), { now: NOW });

  assert.equal(score.jobId, 1);
  assert.equal(score.version, SCORING_VERSION);
  assert.equal(score.scoredAt, NOW);
  assert.deepEqual(
    score.components.map((component) => component.key),
    [...SCORE_COMPONENT_KEYS],
  );
  score.reasons.forEach((reason) => {
    assert.equal(typeof reason.message, "string");
    assert.ok(reason.message.length > 0);
  });
});

test("empty profile keeps non-applicable components neutral at 50", () => {
  const job = makeJob({ title: "Tickle Monster", companyName: null, workplaceType: "onsite" });
  const score = scoreJob(job, makeProfile(), { now: NOW });

  const skills = score.components.find((component) => component.key === "skills");
  const experience = score.components.find((component) => component.key === "experience");
  const employmentType = score.components.find((component) => component.key === "employmentType");
  const location = score.components.find((component) => component.key === "location");
  const role = score.components.find((component) => component.key === "role");

  assert.equal(skills?.applicable, false);
  assert.equal(experience?.applicable, false);
  assert.equal(employmentType?.applicable, false);
  assert.equal(location?.applicable, false);
  assert.equal(skills?.score, NEUTRAL_COMPONENT_SCORE);
  assert.equal(role?.applicable, true);
  assert.equal(role?.score, 0);

  assert.equal(score.coverage, 0.35);
  assert.equal(score.confidence, "low");
  assert.equal(score.recommendation, "LOW_MATCH");
});

test("complete profile on a strong job scores a good match", () => {
  const profile = makeProfile({
    location: "Remote",
    skills: [{ name: "TypeScript", proficiency: "intermediate" }, { name: "SQL", proficiency: "intermediate" }],
    workExperience: [{ title: "SWE", company: "Acme", startDate: "2021-01-01", endDate: "2023-01-01" }],
    preferredEmploymentTypes: ["INTERNSHIP"],
  });
  const job = makeJob({
    description: "Backend intern. TypeScript and SQL. Requires 1+ years of experience.",
    location: "Remote",
    employmentType: "INTERNSHIP",
    workplaceType: "remote",
  });

  const score = scoreJob(job, profile, { now: NOW });

  assert.equal(score.coverage, 1);
  assert.equal(score.confidence, "high");
  assert.ok(score.total >= 80);
  assert.equal(score.recommendation, "HIGHPRIORITY");
});

test("role matching ignores seniority stopwords and maps developer to engineer", () => {
  const profile = makeProfile();
  const senior = scoreJob(makeJob({ title: "Senior Software Engineer" }), profile, { now: NOW });
  const developer = scoreJob(makeJob({ title: "Backend Developer" }), profile, { now: NOW });

  const seniorRole = senior.components.find((component) => component.key === "role");
  const developerRole = developer.components.find((component) => component.key === "role");

  assert.equal(seniorRole?.score, 100);
  assert.equal(developerRole?.score, 100);
});

test("skills score caps at 34 points per matched profile skill", () => {
  const profile = makeProfile({
  skills: [
    { name: "TypeScript", proficiency: "intermediate" },
    { name: "SQL", proficiency: "intermediate" },
    { name: "Rust", proficiency: "intermediate" },
  ],
});
  const job = makeJob({ description: "We use TypeScript and SQL every day." });

  const score = scoreJob(job, profile, { now: NOW });
  const skills = score.components.find((component) => component.key === "skills");

  assert.equal(skills?.applicable, true);
  assert.equal(skills?.score, 68);
  assert.ok(score.reasons.some((reason) => reason.component === "skills" && reason.impact === "positive"));
});

test("skills can match against the title when the description is missing", () => {
  const profile = makeProfile({ skills: [{ name: "Rust", proficiency: "intermediate" }] });
  const job = makeJob({ title: "Rust Backend Engineer", description: null });

  const skills = scoreJob(job, profile, { now: NOW })
    .components.find((component) => component.key === "skills");

  assert.equal(skills?.applicable, true);
  assert.equal(skills?.score, 34);
});

test("skills are not applicable when the job has no description and nothing matched", () => {
  const profile = makeProfile({ skills: [{ name: "TypeScript", proficiency: "intermediate" }] });
  const job = makeJob({ description: null });

  const skills = scoreJob(job, profile, { now: NOW })
    .components.find((component) => component.key === "skills");

  assert.equal(skills?.applicable, false);
  assert.equal(skills?.score, NEUTRAL_COMPONENT_SCORE);
});

test("experience compares extracted requirements to profile years", () => {
  const profile = makeProfile({
    workExperience: [{ title: "SWE", company: "Acme", startDate: "2021-01-01", endDate: "2023-01-01" }],
  });

  const shortfall = scoreJob(makeJob({ description: "5+ years of experience required" }), profile, {
    now: NOW,
  });
  const met = scoreJob(makeJob({ description: "At least 2 years of experience" }), profile, { now: NOW });

  const shortfallExp = shortfall.components.find((component) => component.key === "experience");
  const metExp = met.components.find((component) => component.key === "experience");

  assert.equal(shortfallExp?.score, 40);
  assert.equal(metExp?.score, 100);
});

test("experience is not applicable without a stated requirement or profile history", () => {
  const noRequirement = scoreJob(makeJob({ description: "No years mentioned" }), makeProfile({
    workExperience: [{ title: "SWE", company: "Acme", startDate: "2021-01-01", endDate: "2023-01-01" }],
  }), { now: NOW });
  const noHistory = scoreJob(makeJob({ description: "3+ years required" }), makeProfile(), { now: NOW });

  const noRequirementExp = noRequirement.components.find((component) => component.key === "experience");
  const noHistoryExp = noHistory.components.find((component) => component.key === "experience");

  assert.equal(noRequirementExp?.applicable, false);
  assert.equal(noHistoryExp?.applicable, false);
  assert.equal(noRequirementExp?.score, NEUTRAL_COMPONENT_SCORE);
});

test("location scores 100 for remote jobs regardless of the profile", () => {
  const job = makeJob({ workplaceType: "remote" });
  const location = scoreJob(job, makeProfile(), { now: NOW })
    .components.find((component) => component.key === "location");

  assert.equal(location?.applicable, true);
  assert.equal(location?.score, 100);
});

test("location overlap uses the smaller token set", () => {
  const profile = makeProfile({ location: "Bengaluru, India" });
  const same = scoreJob(
    makeJob({ workplaceType: "onsite", location: "Bengaluru" }),
    profile,
    { now: NOW },
  );
  const far = scoreJob(
    makeJob({ workplaceType: "onsite", location: "Berlin" }),
    profile,
    { now: NOW },
  );

  const sameLoc = same.components.find((component) => component.key === "location");
  const farLoc = far.components.find((component) => component.key === "location");

  assert.equal(sameLoc?.score, 100);
  assert.equal(farLoc?.score, 0);
});

test("employment type matches the preferred list", () => {
  const profile = makeProfile({ preferredEmploymentTypes: ["INTERNSHIP"] });
  const good = scoreJob(makeJob({ employmentType: "INTERNSHIP" }), profile, { now: NOW });
  const bad = scoreJob(makeJob({ employmentType: "FULL_TIME" }), profile, { now: NOW });

  const goodType = good.components.find((component) => component.key === "employmentType");
  const badType = bad.components.find((component) => component.key === "employmentType");

  assert.equal(goodType?.score, 100);
  assert.equal(badType?.score, 0);
});

test("confidence thresholds", () => {
  assert.equal(confidenceFor(0.44), "low");
  assert.equal(confidenceFor(0.45), "medium");
  assert.equal(confidenceFor(0.74), "medium");
  assert.equal(confidenceFor(0.75), "high");
});

test("recommendation thresholds combine score and coverage", () => {
  assert.equal(recommendationFor(85, 0.6), "HIGHPRIORITY");
  assert.equal(recommendationFor(80, 0.59), "GOODMATCH");
  assert.equal(recommendationFor(70, 0.45), "GOODMATCH");
  assert.equal(recommendationFor(70, 0.44), "REVIEW");
  assert.equal(recommendationFor(50, 0.2), "REVIEW");
  assert.equal(recommendationFor(44, 0.2), "LOW_MATCH");
});

test("containsSkill respects word boundaries", () => {
  assert.equal(containsSkill("Experience with JavaScript", "Java"), false);
  assert.equal(containsSkill("Write C++ and C# in the codebase", "C"), false);
  assert.equal(containsSkill("Node.js preferred", "Node"), true);
  assert.equal(containsSkill("Knowledge of SQL", "SQL"), true);
});

test("extractRequiredYears recognizes common phrasings", () => {
  assert.equal(extractRequiredYears("3+ years experience"), 3);
  assert.equal(extractRequiredYears("2-4 years of experience"), 2);
  assert.equal(extractRequiredYears("at least 5 years"), 5);
  assert.equal(extractRequiredYears("minimum of 6 yrs"), 6);
  assert.equal(extractRequiredYears(null), null);
  assert.equal(extractRequiredYears("No experience necessary"), null);
});

test("title normalization synonyms and stopwords", () => {
  assert.deepEqual(
    [...normalizeRoleTokens("Senior SWE II")].sort(),
    ["engineer", "software"],
  );
  assert.ok(jaccard(normalizeRoleTokens("Backend Developer"), normalizeRoleTokens("Backend Engineer")) === 1);
  assert.ok(jaccard(normalizeRoleTokens("Software Engineer"), normalizeRoleTokens("Accountant")) === 0);
});

test("classifySeniority detects seniority levels", () => {
  assert.equal(classifySeniority("Software Engineer Intern"), "intern");
  assert.equal(classifySeniority("Senior Staff Backend Engineer"), "senior");
  assert.equal(classifySeniority("Junior Frontend Engineer"), "entry");
  assert.equal(classifySeniority("Backend Engineer"), "mid");
});