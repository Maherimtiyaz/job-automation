import type { CandidateProfile } from "../domain/profile.js";
import type { Recommendation, StoredScoreBreakdown } from "../domain/scoring.js";
import { jaccard, normalizeRoleTokens } from "./scoreJob.js";

export type RelevanceVerdict = "RELEVANT" | "POSSIBLE" | "UNLIKELY" | "UNSCORED";

export interface RelevancePolicy {
  minScore: number;
  minRoleScore: number;
}

export const DEFAULT_MIN_RELEVANCE_SCORE = 55;
export const DEFAULT_MIN_ROLE_SCORE = 25;

export const DEFAULT_RELEVANCE_POLICY: RelevancePolicy = {
  minScore: DEFAULT_MIN_RELEVANCE_SCORE,
  minRoleScore: DEFAULT_MIN_ROLE_SCORE,
};

export interface RelevanceInput {
  title: string;
  scoreTotal: number | null;
  roleScore: number | null;
  recommendation: Recommendation | null;
  targetRoles: readonly string[];
}

export interface RelevanceResult {
  verdict: RelevanceVerdict;
  nearestTargetRole: string | null;
  reasons: string[];
}

const PRIORITY_RECOMMENDATIONS: readonly Recommendation[] = ["HIGHPRIORITY", "GOODMATCH"];

function nearestTargetRole(title: string, targetRoles: readonly string[]): string | null {
  const titleTokens = normalizeRoleTokens(title);
  let best: string | null = null;
  let bestScore = 0;
  for (const role of targetRoles) {
    const similarity = jaccard(titleTokens, normalizeRoleTokens(role));
    if (similarity > bestScore) {
      bestScore = similarity;
      best = role;
    }
  }
  return best;
}

export function classifyRelevance(input: RelevanceInput, policy?: RelevancePolicy): RelevanceResult {
  const resolved = policy ?? DEFAULT_RELEVANCE_POLICY;
  const reasons: string[] = [];
  const target = nearestTargetRole(input.title, input.targetRoles);

  if (input.scoreTotal === null || input.roleScore === null) {
    return {
      verdict: "UNSCORED",
      nearestTargetRole: target,
      reasons: ["Job has not been scored yet (run `score` first)."],
    };
  }

  const { scoreTotal, roleScore, recommendation } = input;
  if (target !== null) {
    reasons.push(`Nearest target role: "${target}".`);
  }
  reasons.push(`Total score ${scoreTotal} / 100, role score ${roleScore} / 100.`);
  if (recommendation !== null) {
    reasons.push(`Recommendation: ${recommendation}.`);
  }

  if (recommendation !== null && PRIORITY_RECOMMENDATIONS.includes(recommendation)) {
    reasons.push(`Recommendation ${recommendation} indicates a strong match.`);
    return { verdict: "RELEVANT", nearestTargetRole: target, reasons };
  }

  if (scoreTotal >= resolved.minScore && roleScore >= resolved.minRoleScore) {
    reasons.push(
      `Score ${scoreTotal} >= ${resolved.minScore} and role score ${roleScore} >= ${resolved.minRoleScore}.`,
    );
    return { verdict: "RELEVANT", nearestTargetRole: target, reasons };
  }

  if (scoreTotal >= resolved.minScore || roleScore >= resolved.minRoleScore) {
    reasons.push(
      `Meets one threshold (min score ${resolved.minScore}, min role score ${resolved.minRoleScore}).`,
    );
    return { verdict: "POSSIBLE", nearestTargetRole: target, reasons };
  }

  reasons.push(
    `Below min score (${scoreTotal} < ${resolved.minScore}) and below min role score ` +
      `(${roleScore} < ${resolved.minRoleScore}).`,
  );
  return { verdict: "UNLIKELY", nearestTargetRole: target, reasons };
}

export function relevanceFromProfile(
  title: string,
  profile: CandidateProfile | null,
  input: Omit<RelevanceInput, "title" | "targetRoles">,
  policy?: RelevancePolicy,
): RelevanceResult {
  const targetRoles = profile ? profile.targetRoles.map((entry) => entry.role) : [];
  return classifyRelevance({ ...input, title, targetRoles }, policy);
}

export function roleScoreFromBreakdown(breakdown: StoredScoreBreakdown | null): number | null {
  if (breakdown === null) {
    return null;
  }
  const role = breakdown.components.find((component) => component.key === "role");
  if (role === undefined || !role.applicable) {
    return null;
  }
  return role.score;
}