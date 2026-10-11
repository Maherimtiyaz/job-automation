import type { CandidateProfile } from "../domain/profile.js";
import type {
  JobScore,
  JobScoreComponent,
  ScorableJob,
  ScoreComponentKey,
  ScoreImpact,
  ScoreReason,
} from "../domain/scoring.js";
import {
  NEUTRAL_COMPONENT_SCORE,
  SCORE_COMPONENT_WEIGHTS,
  SCORING_VERSION,
} from "../domain/scoring.js";

const SKILL_POINTS_PER_MATCH = 34;
const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365.25;

export interface ScoreJobOptions {
  now: string;
}

interface ComponentOutcome {
  key: ScoreComponentKey;
  score: number;
  applicable: boolean;
  impact: ScoreImpact;
  message: string;
}

const ROLE_SYNONYMS: Record<string, readonly string[]> = {
  developer: ["engineer"],
  dev: ["engineer"],
  programmer: ["engineer"],
  swe: ["software", "engineer"],
  sde: ["software", "engineer"],
};

const ROLE_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "for",
  "with",
  "senior",
  "sr",
  "junior",
  "jr",
  "mid",
  "middle",
  "staff",
  "principal",
  "lead",
  "leader",
  "head",
  "chief",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
]);

const PRIORITY_WEIGHTS: Record<number, number> = {
  1: 0.6,
  2: 0.7,
  3: 0.8,
  4: 0.9,
  5: 1,
};

function collapseHyphenated(text: string): string {
  return text
    .replace(/back[\s_-]?end/g, "backend")
    .replace(/front[\s_-]?end/g, "frontend")
    .replace(/full[\s_-]?stack/g, "fullstack");
}

function tokenize(text: string): string[] {
  return collapseHyphenated(text.toLowerCase())
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export function normalizeRoleTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of tokenize(text)) {
    const word = raw.replace(/\.+$/, "");
    if (word.length === 0 || ROLE_STOPWORDS.has(word)) {
      continue;
    }
    const synonyms = ROLE_SYNONYMS[word];
    if (synonyms) {
      for (const synonym of synonyms) {
        tokens.add(synonym);
      }
    } else {
      tokens.add(word);
    }
  }
  return tokens;
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type SeniorityLevel = "intern" | "entry" | "mid" | "senior" | "unknown";

export function classifySeniority(title: string): SeniorityLevel {
  const lowered = title.toLowerCase();
  if (/\bintern(ship)?\b/.test(lowered)) {
    return "intern";
  }
  if (/\b(senior|sr\.?|lead|principal|staff|distinguished)\b/.test(lowered)) {
    return "senior";
  }
  if (/\b(junior|jr\.?|entry|graduate|new grad)\b/.test(lowered)) {
    return "entry";
  }
  return "mid";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsSkill(text: string, skill: string): boolean {
  const pattern = new RegExp(`(?<![a-z0-9+#])${escapeRegExp(skill)}(?![a-z0-9+#])`, "i");
  return pattern.test(text);
}

export function extractRequiredYears(description: string | null): number | null {
  if (description === null) {
    return null;
  }
  const patterns: readonly RegExp[] = [
    /(\d{1,2})\s*\+\s*(?:years?|yrs?)/i,
    /(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*(?:years?|yrs?)/i,
    /(?:at least|minimum(?: of)?|min\.?)\s*(\d{1,2})\s*(?:years?|yrs?)/i,
    /(\d{1,2})\s*(?:years?|yrs?)(?:\s+of)?\s+experience/i,
  ];
  for (const pattern of patterns) {
    const captured = pattern.exec(description)?.[1];
    if (captured !== undefined) {
      const years = Number.parseInt(captured, 10);
      if (Number.isFinite(years)) {
        return years;
      }
    }
  }
  return null;
}

function totalExperienceYears(profile: CandidateProfile, referenceDate: string): number {
  const reference = Date.parse(referenceDate);
  let milliseconds = 0;
  for (const entry of profile.workExperience) {
    const start = Date.parse(entry.startDate);
    const end = entry.endDate === null ? reference : Date.parse(entry.endDate);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      continue;
    }
    milliseconds += end - start;
  }
  return milliseconds / MS_PER_YEAR;
}

function normalizeLocation(location: string): Set<string> {
  return new Set(
    location
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
}

function overlapRatio(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.min(left.size, right.size);
}

function priorityWeight(priority: number): number {
  return PRIORITY_WEIGHTS[priority] ?? 0.8;
}

function scoreRole(job: ScorableJob, profile: CandidateProfile): ComponentOutcome {
  if (profile.targetRoles.length === 0) {
    return {
      key: "role",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Profile has no target roles.",
    };
  }

  const titleTokens = normalizeRoleTokens(job.title);
  if (titleTokens.size === 0) {
    return {
      key: "role",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Job title has no role keywords.",
    };
  }

  const bestWeight = Math.max(
    ...profile.targetRoles.map((entry) => priorityWeight(entry.priority)),
  );

  let bestRole = profile.targetRoles[0]?.role ?? "";
  let bestSimilarity = 0;
  let bestScore = 0;
  for (const entry of profile.targetRoles) {
    const similarity = jaccard(titleTokens, normalizeRoleTokens(entry.role));
    const weighted = similarity * (priorityWeight(entry.priority) / bestWeight);
    if (weighted > bestScore) {
      bestScore = weighted;
      bestSimilarity = similarity;
      bestRole = entry.role;
    }
  }

  const score = Math.round(bestScore * 100);
  const seniority = classifySeniority(job.title);
  const impact: ScoreImpact =
    bestSimilarity >= 0.5 ? "positive" : bestSimilarity > 0 ? "neutral" : "negative";
  const message =
    bestSimilarity > 0
      ? `Title "${job.title}" (${seniority}) matches target role "${bestRole}" ` +
        `(${Math.round(bestSimilarity * 100)}% token overlap).`
      : `Title "${job.title}" does not match any target role.`;

  return { key: "role", score, applicable: true, impact, message };
}

function scoreSkills(job: ScorableJob, profile: CandidateProfile): ComponentOutcome {
  if (profile.skills.length === 0) {
    return {
      key: "skills",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Profile has no skills.",
    };
  }

  const haystack = [job.title, job.description ?? ""].join("\n");
  const matched = profile.skills.filter((skill) => containsSkill(haystack, skill.name));

  if (job.description === null && matched.length === 0) {
    return {
      key: "skills",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Job has no description to match skills against.",
    };
  }

  const score = Math.min(100, matched.length * SKILL_POINTS_PER_MATCH);
  const impact: ScoreImpact = matched.length > 0 ? "positive" : "negative";
  const message =
    matched.length > 0
      ? `Matched ${matched.length}/${profile.skills.length} profile skills: ` +
        `${matched.map((skill) => skill.name).join(", ")}.`
      : `None of the ${profile.skills.length} profile skills appear in the job text.`;

  return { key: "skills", score, applicable: true, impact, message };
}

function scoreExperience(
  job: ScorableJob,
  profile: CandidateProfile,
  referenceDate: string,
): ComponentOutcome {
  if (profile.workExperience.length === 0) {
    return {
      key: "experience",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Profile has no work experience.",
    };
  }

  const required = extractRequiredYears(job.description);
  if (required === null) {
    return {
      key: "experience",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Job description states no explicit years of experience.",
    };
  }

  const candidate = totalExperienceYears(profile, referenceDate);
  const ratio = required <= 0 ? 1 : candidate / required;
  const score = Math.round(Math.min(1, ratio) * 100);
  const impact: ScoreImpact = score >= 100 ? "positive" : score >= 60 ? "neutral" : "negative";
  const message = `Requires ${required} year(s); profile shows ${candidate.toFixed(1)} year(s).`;

  return { key: "experience", score, applicable: true, impact, message };
}

function scoreLocation(job: ScorableJob, profile: CandidateProfile): ComponentOutcome {
  if (job.workplaceType === "remote") {
    return {
      key: "location",
      score: 100,
      applicable: true,
      impact: "positive",
      message: "Job is remote and open to candidates anywhere.",
    };
  }

  if (profile.location === null || profile.location === undefined) {
    return {
      key: "location",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Profile has no location.",
    };
  }

  if (job.location === null) {
    return {
      key: "location",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Job posting has no location.",
    };
  }

  const ratio = overlapRatio(normalizeLocation(profile.location), normalizeLocation(job.location));
  const score = Math.round(ratio * 100);
  const impact: ScoreImpact = score >= 75 ? "positive" : score > 0 ? "neutral" : "negative";
  const message =
    score > 0
      ? `Profile location "${profile.location}" overlaps job location "${job.location}".`
      : `Profile location "${profile.location}" does not overlap job location "${job.location}".`;

  return { key: "location", score, applicable: true, impact, message };
}

function scoreEmploymentType(job: ScorableJob, profile: CandidateProfile): ComponentOutcome {
  if (profile.preferredEmploymentTypes.length === 0) {
    return {
      key: "employmentType",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Profile lists no preferred employment types.",
    };
  }

  if (job.employmentType === null) {
    return {
      key: "employmentType",
      score: NEUTRAL_COMPONENT_SCORE,
      applicable: false,
      impact: "missing",
      message: "Job posting has no employment type.",
    };
  }

  const match = profile.preferredEmploymentTypes.includes(job.employmentType);
  const score = match ? 100 : 0;
  const impact: ScoreImpact = match ? "positive" : "negative";
  const message = match
    ? `Employment type ${job.employmentType} is preferred.`
    : `Employment type ${job.employmentType} is not in the preferred list.`;

  return { key: "employmentType", score, applicable: true, impact, message };
}

function scoreOther(job: ScorableJob): ComponentOutcome {
  const signals = [
    (job.description ?? "").trim().length > 0,
    (job.location ?? "").trim().length > 0,
    job.employmentType !== null,
    (job.companyName ?? "").trim().length > 0,
  ];
  const present = signals.filter(Boolean).length;
  const score = Math.round((present / signals.length) * 100);
  const impact: ScoreImpact = score >= 75 ? "positive" : score >= 50 ? "neutral" : "negative";
  const message =
    `Posting completeness: ${present}/${signals.length} signals present ` +
    `(description, location, employment type, company).`;

  return { key: "other", score, applicable: true, impact, message };
}

export function confidenceFor(coverage: number): JobScore["confidence"] {
  if (coverage < 0.45) {
    return "low";
  }
  if (coverage < 0.75) {
    return "medium";
  }
  return "high";
}

export function recommendationFor(total: number, coverage: number): JobScore["recommendation"] {
  if (total >= 80 && coverage >= 0.6) {
    return "HIGHPRIORITY";
  }
  if (total >= 65 && coverage >= 0.45) {
    return "GOODMATCH";
  }
  if (total >= 45) {
    return "REVIEW";
  }
  return "LOW_MATCH";
}

export function scoreJob(
  job: ScorableJob,
  profile: CandidateProfile,
  options: ScoreJobOptions,
): JobScore {
  const outcomes: readonly ComponentOutcome[] = [
    scoreRole(job, profile),
    scoreSkills(job, profile),
    scoreExperience(job, profile, options.now),
    scoreLocation(job, profile),
    scoreEmploymentType(job, profile),
    scoreOther(job),
  ];

  let total = 0;
  let coverage = 0;
  const components: JobScoreComponent[] = [];
  const reasons: ScoreReason[] = [];

  for (const outcome of outcomes) {
    const weight = SCORE_COMPONENT_WEIGHTS[outcome.key];
    total += weight * outcome.score;
    if (outcome.applicable) {
      coverage += weight;
    }
    components.push({
      key: outcome.key,
      weight,
      applicable: outcome.applicable,
      score: outcome.score,
    });
    reasons.push({
      component: outcome.key,
      impact: outcome.impact,
      message: outcome.message,
    });
  }

  const roundedTotal = Math.round(total);
  const roundedCoverage = Math.round(coverage * 1000) / 1000;

  return {
    jobId: job.id,
    version: SCORING_VERSION,
    total: roundedTotal,
    coverage: roundedCoverage,
    confidence: confidenceFor(roundedCoverage),
    recommendation: recommendationFor(roundedTotal, roundedCoverage),
    components,
    reasons,
    scoredAt: options.now,
  };
}
