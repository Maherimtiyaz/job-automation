import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MIN_RELEVANCE_SCORE, DEFAULT_MIN_ROLE_SCORE } from "../src/scoring/relevance.js";
import { classifyRelevance } from "../src/scoring/relevance.js";

const TARGET_ROLES = ["Backend Engineer", "Software Engineer", "Data Scientist", "Site Reliability Engineer"];
const policy = {
  minScore: DEFAULT_MIN_RELEVANCE_SCORE,
  minRoleScore: DEFAULT_MIN_ROLE_SCORE,
};

test("marks a job UNSCORED without a stored score", () => {
  const result = classifyRelevance(
    {
      title: "Backend Engineer",
      scoreTotal: null,
      roleScore: null,
      recommendation: null,
      targetRoles: TARGET_ROLES,
    },
    policy,
  );
  assert.equal(result.verdict, "UNSCORED");
  assert.equal(result.reasons.length, 1);
});

test("a strong recommendation is RELEVANT regardless of stored score", () => {
  const result = classifyRelevance(
    {
      title: "Data Scientist",
      scoreTotal: 60,
      roleScore: 40,
      recommendation: "HIGHPRIORITY",
      targetRoles: TARGET_ROLES,
    },
    policy,
  );
  assert.equal(result.verdict, "RELEVANT");
  assert.equal(result.nearestTargetRole, "Data Scientist");
});

test("meets both thresholds -> RELEVANT", () => {
  const result = classifyRelevance(
    {
      title: "Backend Engineer",
      scoreTotal: 80,
      roleScore: 70,
      recommendation: "LOW_MATCH",
      targetRoles: TARGET_ROLES,
    },
    policy,
  );
  assert.equal(result.verdict, "RELEVANT");
  assert.equal(result.nearestTargetRole, "Backend Engineer");
});

test("meets one threshold -> POSSIBLE with an explanation", () => {
  const result = classifyRelevance(
    {
      title: "Platform Engineer",
      scoreTotal: DEFAULT_MIN_RELEVANCE_SCORE + 5,
      roleScore: 10,
      recommendation: null,
      targetRoles: TARGET_ROLES,
    },
    policy,
  );
  assert.equal(result.verdict, "POSSIBLE");
  assert.ok(result.reasons.some((reason) => reason.includes("Meets one threshold")));
});

test("meets neither threshold -> UNLIKELY with reasons", () => {
  const result = classifyRelevance(
    {
      title: "Customer Support Manager",
      scoreTotal: 20,
      roleScore: 5,
      recommendation: null,
      targetRoles: TARGET_ROLES,
    },
    policy,
  );
  assert.equal(result.verdict, "UNLIKELY");
  assert.ok(result.reasons.some((reason) => reason.includes("Below min score")));
});

test("a Backend Engineer title is not dropped for lacking 'Software'", () => {
  const result = classifyRelevance(
    {
      title: "Senior Backend Engineer",
      scoreTotal: 70,
      roleScore: 60,
      recommendation: "GOODMATCH",
      targetRoles: ["Backend Engineer"],
    },
    policy,
  );
  assert.equal(result.verdict, "RELEVANT");
  assert.equal(result.nearestTargetRole, "Backend Engineer");
});

test("policy thresholds are configurable", () => {
  const strict = { minScore: 90, minRoleScore: 90 };
  const result = classifyRelevance(
    {
      title: "Backend Engineer",
      scoreTotal: 80,
      roleScore: 85,
      recommendation: null,
      targetRoles: TARGET_ROLES,
    },
    strict,
  );
  assert.equal(result.verdict, "UNLIKELY");
});