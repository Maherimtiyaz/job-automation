import { z } from "zod";
import { EMPLOYMENT_TYPES } from "./job.js";

export const TARGET_ROLES = [
  "Software Engineer Intern",
  "Backend Engineer Intern",
  "Software Engineer",
  "Backend Engineer",
] as const;

export const SKILL_PROFICIENCIES = ["beginner", "intermediate", "advanced", "expert"] as const;

export type SkillProficiency = (typeof SKILL_PROFICIENCIES)[number];

export const SkillProficiencySchema = z.enum(SKILL_PROFICIENCIES);

export const SALARY_PERIODS = ["HOUR", "DAY", "MONTH", "YEAR"] as const;

export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const SalaryPeriodSchema = z.enum(SALARY_PERIODS);

const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code")
  .transform((currency) => currency.toUpperCase());

export const SkillSchema = z.object({
  name: z.string().trim().min(1, "skill name must not be empty"),
  proficiency: SkillProficiencySchema.default("intermediate"),
  years: z.number().int().nonnegative().max(80).nullish(),
});

export const WorkExperienceSchema = z.object({
  title: z.string().trim().min(1, "work title must not be empty"),
  company: z.string().trim().min(1, "company must not be empty"),
  startDate: z.iso.date(),
  endDate: z.iso.date().nullable().default(null),
  description: z.string().nullish(),
});

export const EducationSchema = z.object({
  institution: z.string().trim().min(1, "institution must not be empty"),
  degree: z.string().trim().min(1).nullish(),
  fieldOfStudy: z.string().trim().min(1).nullish(),
  startDate: z.iso.date().nullish(),
  endDate: z.iso.date().nullish(),
});

export const MinimumSalarySchema = z.object({
  amount: z.number().nonnegative(),
  currency: CurrencySchema,
  period: SalaryPeriodSchema.default("YEAR"),
});

export const TargetRoleSchema = z.object({
  role: z.string().trim().min(1, "role must not be empty"),
  priority: z.number().int().min(1).max(5).default(3),
});

export const CandidateProfileSchema = z.object({
  fullName: z.string().trim().min(1).nullish(),
  headline: z.string().trim().min(1).nullish(),
  email: z.email().nullish(),
  phone: z.string().trim().min(1).nullish(),
  location: z.string().trim().min(1).nullish(),
  linkedinUrl: z.string().trim().min(1).nullish(),
  githubUrl: z.string().trim().min(1).nullish(),
  websiteUrl: z.string().trim().min(1).nullish(),
  targetRoles: z.array(TargetRoleSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  workExperience: z.array(WorkExperienceSchema).default([]),
  education: z.array(EducationSchema).default([]),
  preferredEmploymentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  minimumSalary: MinimumSalarySchema.nullish(),
});

export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
export type TargetRoleEntry = z.infer<typeof TargetRoleSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type WorkExperience = z.infer<typeof WorkExperienceSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type MinimumSalary = z.infer<typeof MinimumSalarySchema>;

export function createEmptyProfile(): CandidateProfile {
  return CandidateProfileSchema.parse({
    fullName: null,
    headline: null,
    email: null,
    phone: null,
    location: null,
    linkedinUrl: null,
    githubUrl: null,
    websiteUrl: null,
    targetRoles: TARGET_ROLES.map((role) => ({ role, priority: 3 })),
    skills: [],
    workExperience: [],
    education: [],
    preferredEmploymentTypes: [],
    minimumSalary: null,
  });
}

export interface ProfileGap {
  field: string;
  message: string;
}

export function describeProfileGaps(profile: CandidateProfile): ProfileGap[] {
  const gaps: ProfileGap[] = [];

  if (!profile.fullName) {
    gaps.push({ field: "fullName", message: "Candidate name is missing." });
  }
  if (!profile.email) {
    gaps.push({ field: "email", message: "Contact email is missing." });
  }
  if (!profile.phone) {
    gaps.push({ field: "phone", message: "Contact phone is missing." });
  }
  if (!profile.location) {
    gaps.push({ field: "location", message: "Candidate location is missing." });
  }
  if (profile.targetRoles.length === 0) {
    gaps.push({ field: "targetRoles", message: "No target roles defined." });
  }
  if (profile.skills.length === 0) {
    gaps.push({ field: "skills", message: "No skills defined; skills cannot be scored." });
  }
  if (profile.workExperience.length === 0) {
    gaps.push({
      field: "workExperience",
      message: "No work experience defined; experience cannot be scored.",
    });
  }
  if (profile.preferredEmploymentTypes.length === 0) {
    gaps.push({
      field: "preferredEmploymentTypes",
      message: "No preferred employment types defined.",
    });
  }
  if (!profile.minimumSalary) {
    gaps.push({ field: "minimumSalary", message: "No minimum salary defined." });
  }

  return gaps;
}
