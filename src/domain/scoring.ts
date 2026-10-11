import { z } from "zod";
import type {
  EmploymentType,
  Recommendation,
  ScoreConfidence,
  WorkplaceType,
} from "./job.js";

export type { Recommendation, ScoreConfidence } from "./job.js";

export const SCORING_VERSION = 1;

export const NEUTRAL_COMPONENT_SCORE = 50;

export const SCORE_COMPONENT_KEYS = [
  "role",
  "skills",
  "experience",
  "location",
  "employmentType",
  "other",
] as const;

export type ScoreComponentKey = (typeof SCORE_COMPONENT_KEYS)[number];

export const SCORE_COMPONENT_WEIGHTS: Record<ScoreComponentKey, number> = {
  role: 0.3,
  skills: 0.3,
  experience: 0.15,
  location: 0.1,
  employmentType: 0.1,
  other: 0.05,
};

export const SCORE_IMPACTS = ["positive", "negative", "neutral", "missing"] as const;

export type ScoreImpact = (typeof SCORE_IMPACTS)[number];

export interface ScoreReason {
  component: ScoreComponentKey;
  impact: ScoreImpact;
  message: string;
}

export interface JobScoreComponent {
  key: ScoreComponentKey;
  weight: number;
  applicable: boolean;
  score: number;
}

export interface JobScore {
  jobId: number;
  version: number;
  total: number;
  coverage: number;
  confidence: ScoreConfidence;
  recommendation: Recommendation;
  components: JobScoreComponent[];
  reasons: ScoreReason[];
  scoredAt: string;
}

export interface ScorableJob {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  workplaceType: WorkplaceType;
  employmentType: EmploymentType | null;
  companyName: string | null;
}

export interface StoredScoreBreakdown {
  components: JobScoreComponent[];
  reasons: ScoreReason[];
}

export const ScoreComponentKeySchema = z.enum(SCORE_COMPONENT_KEYS);

export const ScoreImpactSchema = z.enum(SCORE_IMPACTS);

export const JobScoreComponentSchema = z.object({
  key: ScoreComponentKeySchema,
  weight: z.number(),
  applicable: z.boolean(),
  score: z.number(),
});

export const ScoreReasonSchema = z.object({
  component: ScoreComponentKeySchema,
  impact: ScoreImpactSchema,
  message: z.string(),
});

export const StoredScoreBreakdownSchema = z.object({
  components: z.array(JobScoreComponentSchema),
  reasons: z.array(ScoreReasonSchema),
});
