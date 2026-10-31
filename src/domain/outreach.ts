import { z } from "zod";
import type { Job } from "./job.js";
import type { CandidateProfile, Skill, WorkExperience } from "./profile.js";

export const OUTREACH_FORMATS = ["text", "json", "eml"] as const;

export type OutreachFormat = (typeof OUTREACH_FORMATS)[number];

export const OutreachFormatSchema = z.enum(OUTREACH_FORMATS);

/** A factual claim in the draft and where it came from. */
export const OutreachEvidenceSchema = z.object({
  claim: z.string().trim().min(1),
  source: z.string().trim().min(1),
});

export type OutreachEvidence = z.infer<typeof OutreachEvidenceSchema>;

/** Something the draft could not say because the stored data does not have it. */
export const OutreachGapSchema = z.object({
  field: z.string().trim().min(1),
  message: z.string().trim().min(1),
});

export type OutreachGap = z.infer<typeof OutreachGapSchema>;

export const OutreachDraftSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.number().int().positive(),
  recipientName: z.string().trim().min(1).nullable(),
  recipientEmail: z.string().trim().min(1).nullable(),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  wordCount: z.number().int().positive(),
  evidence: z.array(OutreachEvidenceSchema),
  gaps: z.array(OutreachGapSchema),
  createdAt: z.string().trim().min(1),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;

export interface OutreachDraftContent {
  subject: string;
  body: string;
  wordCount: number;
  recipientName: string | null;
  recipientEmail: string | null;
  evidence: OutreachEvidence[];
  gaps: OutreachGap[];
}

export interface BuildOutreachDraftInput {
  job: Job;
  companyName: string | null;
  profile: CandidateProfile | null;
  /** Basename of the default resume, if one is registered. Never a full path. */
  resumeFileName?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
}

/** Keep the note under this many words; recruiters skim. */
export const OUTREACH_MAX_WORDS = 150;

const MAX_HOOK_LENGTH = 180;
const MIN_HOOK_LENGTH = 40;
/** Shortest acceptable clause boundary when a long sentence must be shortened. */
const MIN_CLAUSE_CUT = 100;
/** Words that read as dangling when a sentence is cut right after them. */
const DANGLING_TAIL =
  /\s+(?:and|or|but|the|a|an|of|to|in|on|for|with|by|as|at|from|into|under|over|that|which|when|where|while|than|then|every|each)$/i;

const PROFICIENCY_WEIGHT: Record<Skill["proficiency"], number> = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Lines that never make a good opening hook. */
const BOILERPLATE =
  /(equal opportunity|eoe\b|privacy|gdpr|salary|compensation range|benefits?\b|perks?\b|background check|apply now\b|apply here\b|apply if\b|how to apply|about (us|the company)|our mission is|we are an\b|registered users|fortune \d|trademark|trust .{0,40} to |customers include|is a leading provider|backed by|raised \$|series [a-e]\b|profitable|location:)/i;

/** Lines that sound like real work rather than marketing. */
const SIGNAL =
  /\b(you'?ll|you will|own|owns|build|building|design|ship|shipping|work with|responsible|backend|api|infrastructure|scale|distributed|service|database)\b/i;

/** Lines written about the role itself, not about the company. */
const ROLE_SIGNAL =
  /\b(you'?ll|you will|your (role|team|code|work)|this role|the role|as an? [a-z -]{0,30}engineer|responsibilit)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-phrase, case-insensitive matcher. A fresh RegExp is built per call. */
function phrasePattern(phrase: string): RegExp {
  const parts = phrase.trim().split(/\s+/).map(escapeRegExp);
  return new RegExp(`(?<![a-z0-9])${parts.join("\\s+")}(?![a-z0-9])`, "gi");
}

function countPhrase(phrase: string, text: string): number {
  if (phrase.trim() === "" || text === "") {
    return 0;
  }
  const found = text.match(phrasePattern(phrase));
  return found === null ? 0 : found.length;
}

export interface SkillMatch {
  skill: Skill;
  inTitle: boolean;
  occurrences: number;
  score: number;
}

/**
 * Rank profile skills by how strongly they appear in the posting.
 *
 * Title hits outrank description hits; proficiency and stated years break ties.
 * Deterministic: equal scores sort by skill name.
 */
export function matchSkills(
  profile: CandidateProfile,
  title: string,
  description: string,
): SkillMatch[] {
  const matches: SkillMatch[] = [];

  for (const skill of profile.skills) {
    const name = skill.name.trim();
    if (name === "") {
      continue;
    }
    const inTitle = countPhrase(name, title) > 0;
    const occurrences = countPhrase(name, description);
    if (!inTitle && occurrences === 0) {
      continue;
    }
    matches.push({
      skill,
      inTitle,
      occurrences,
      score:
        (inTitle ? 30 : 0) +
        Math.min(occurrences, 5) * 4 +
        PROFICIENCY_WEIGHT[skill.proficiency] * 2 +
        (skill.years ?? 0),
    });
  }

  return matches.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.skill.name.localeCompare(right.skill.name);
  });
}

/** Most recent work experience: open-ended roles first, then latest end date. */
export function mostRecentExperience(
  experience: readonly WorkExperience[],
): WorkExperience | null {
  if (experience.length === 0) {
    return null;
  }
  const sorted = [...experience].sort((left, right) => {
    const leftEnd = left.endDate ?? "9999-99-99";
    const rightEnd = right.endDate ?? "9999-99-99";
    if (leftEnd !== rightEnd) {
      return leftEnd < rightEnd ? 1 : -1;
    }
    if (left.startDate !== right.startDate) {
      return left.startDate < right.startDate ? 1 : -1;
    }
    return left.company.localeCompare(right.company);
  });
  return sorted[0] ?? null;
}

export function formatMonth(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (match === null) {
    return isoDate;
  }
  const year = match[1] ?? "";
  const monthIndex = Number(match[2]) - 1;
  const month = MONTHS[monthIndex];
  if (month === undefined) {
    return year;
  }
  return `${month} ${year}`;
}

export function formatExperienceDates(experience: WorkExperience): string {
  const start = formatMonth(experience.startDate);
  const end = experience.endDate === null ? "present" : formatMonth(experience.endDate);
  return `${start} - ${end}`;
}

/** Stored descriptions come from feeds that may still carry raw HTML. */
export function stripMarkup(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function candidateSentences(description: string): string[] {
  return stripMarkup(description)
    .replace(/\r/g, "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= MIN_HOOK_LENGTH);
}

/** Prose reads like a sentence; a bare list of tools does not. */
function looksLikeProse(sentence: string): boolean {
  return SIGNAL.test(sentence) || sentence.split(",").length <= 2;
}

function trimHook(sentence: string): string {
  const cleaned = sentence.replace(/[.!?;:,]+$/, "").trim();
  if (cleaned.length <= MAX_HOOK_LENGTH) {
    return cleaned;
  }

  const cut = cleaned.slice(0, MAX_HOOK_LENGTH);
  const clauseIndex = Math.max(
    cut.lastIndexOf(", "),
    cut.lastIndexOf("; "),
    cut.lastIndexOf(": "),
  );
  const body = clauseIndex >= MIN_CLAUSE_CUT ? cut.slice(0, clauseIndex) : cut;
  const spaced = body.lastIndexOf(" ") > 0 ? body.slice(0, body.lastIndexOf(" ")) : body;

  let trimmed = spaced.replace(/[,;:-]+$/, "").trim();
  while (DANGLING_TAIL.test(trimmed) || /\b(?:the|a|an)\s+\S*-\S*$/i.test(trimmed)) {
    trimmed = trimmed
      .replace(/\b(?:the|a|an)\s+\S+$/i, "")
      .replace(DANGLING_TAIL, "")
      .replace(/[,;:-]+$/, "")
      .trim();
  }
  return trimmed;
}

/**
 * Pick the one line from the posting worth quoting back.
 *
 * Preference order: a sentence naming the top matched skill, then a sentence
 * that sounds like real work, then the first usable sentence. Boilerplate is
 * filtered out. Returns null when the description has nothing quotable.
 */
export function findPostingHook(description: string, preferredSkill: string | null): string | null {
  if (description.trim() === "") {
    return null;
  }

  const sentences = candidateSentences(description).filter(
    (sentence) => !BOILERPLATE.test(sentence),
  );
  if (sentences.length === 0) {
    return null;
  }

  // Score every line, then prefer the best one that fits whole so the quote is
  // not cut mid-clause. Document order breaks ties, so a posting always yields
  // the same hook.
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    if (ROLE_SIGNAL.test(sentence)) {
      score += 3;
    }
    if (SIGNAL.test(sentence)) {
      score += 2;
    }
    if (preferredSkill !== null && countPhrase(preferredSkill, sentence) > 0) {
      score += 2;
    }
    if (looksLikeProse(sentence)) {
      score += 1;
    }
    return { sentence, index, score };
  });

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const bestScore = scored[0]?.score ?? 0;
  const complete = scored.find(
    (entry) => entry.sentence.length <= MAX_HOOK_LENGTH && entry.score >= bestScore - 1,
  );
  const chosen = complete ?? scored[0];
  return chosen === undefined ? null : trimHook(chosen.sentence);
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function contactLine(profile: CandidateProfile): string {
  return [profile.email, profile.githubUrl, profile.linkedinUrl, profile.websiteUrl]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" · ");
}

function skillPhrase(matches: readonly SkillMatch[]): string | null {
  const first = matches[0];
  if (first === undefined) {
    return null;
  }
  const second = matches[1];
  return second === undefined
    ? first.skill.name
    : `${first.skill.name} and ${second.skill.name}`;
}

/**
 * Compose a short, specific outreach email from stored data only.
 *
 * Every factual sentence is recorded in `evidence`; anything the profile does
 * not contain becomes a `gap` instead of invented copy. The function is pure
 * and deterministic — same inputs, same output, no clock, no I/O, no network.
 */
export function buildOutreachDraft(input: BuildOutreachDraftInput): OutreachDraftContent {
  const { job, profile } = input;
  const company = input.companyName ?? "your team";
  const evidence: OutreachEvidence[] = [];
  const gaps: OutreachGap[] = [];

  if (profile === null) {
    gaps.push({
      field: "profile",
      message: "No candidate profile is loaded; the draft cannot cite real experience.",
    });
  }

  const fullName = profile?.fullName ?? null;
  if (fullName === null) {
    gaps.push({
      field: "fullName",
      message: "Sign-off has no name. Add fullName to the profile before sending.",
    });
  }
  if (profile !== null && !profile.email) {
    gaps.push({
      field: "email",
      message: "No contact email in the profile; the sign-off has no way to reply.",
    });
  }

  const description = job.description ?? "";
  const matches = profile === null ? [] : matchSkills(profile, job.title, description);
  const skills = skillPhrase(matches);
  const topSkill = matches[0]?.skill.name ?? null;

  if (profile !== null && profile.skills.length === 0) {
    gaps.push({
      field: "skills",
      message: "The profile has no skills; the email cannot show technical overlap.",
    });
  } else if (profile !== null && matches.length === 0) {
    gaps.push({
      field: "skills",
      message: "None of the profile skills appear in this posting; the proof line is generic.",
    });
  }

  if (description.trim() === "") {
    gaps.push({
      field: "description",
      message: "The job has no stored description; nothing from the posting can be quoted.",
    });
  }

  const hook = findPostingHook(description, topSkill);
  if (description.trim() !== "" && hook === null) {
    gaps.push({
      field: "description",
      message: "No quotable line was found in the posting; the opening is generic.",
    });
  }

  const experience = profile === null ? null : mostRecentExperience(profile.workExperience);
  if (profile !== null && experience === null) {
    gaps.push({
      field: "workExperience",
      message: "No work experience in the profile; the proof line is skills-only.",
    });
  }

  if (!input.recipientName) {
    gaps.push({
      field: "recipientName",
      message:
        "No recipient name; the email greets the team generically. " +
        "Address the hiring manager with --recipient before sending.",
    });
  }

  const opening =
    hook === null
      ? `I'm writing about the ${job.title} role at ${company}.`
      : `I'm writing about the ${job.title} role at ${company} - the line about "${hook}" is what made me write.`;
  if (hook !== null) {
    evidence.push({ claim: hook, source: "job.description" });
  }

  let proof: string | null = null;
  if (experience !== null) {
    const dates = formatExperienceDates(experience);
    proof =
      skills === null
        ? `Most recently I was ${experience.title} at ${experience.company} (${dates}).`
        : `Most recently I was ${experience.title} at ${experience.company} (${dates}), working mostly in ${skills}.`;
    evidence.push({
      claim: `${experience.title} at ${experience.company} (${dates})`,
      source: "profile.workExperience",
    });
  } else if (skills !== null) {
    proof = `I work mostly in ${skills}.`;
  }
  for (const match of matches.slice(0, 2)) {
    evidence.push({ claim: match.skill.name, source: "profile.skills" });
  }

  const resumeHint =
    typeof input.resumeFileName === "string" && input.resumeFileName.trim() !== ""
      ? `my resume (${input.resumeFileName})`
      : "my resume";
  if (typeof input.resumeFileName === "string" && input.resumeFileName.trim() !== "") {
    evidence.push({ claim: input.resumeFileName, source: "resume store default" });
  }

  const ask =
    `If it's useful, I can send ${resumeHint} or take 20 minutes this week ` +
    `to talk about how you're building ${topSkill ?? "the backend"}.`;

  const greeting = input.recipientName ? `Hi ${input.recipientName},` : "Hello,";
  const signOff = fullName === null ? "Best," : `Best,\n${fullName}`;
  const contact = profile === null ? "" : contactLine(profile);
  const signature = contact === "" ? signOff : `${signOff}\n${contact}`;

  const paragraphs: string[] = [greeting, opening];
  if (proof !== null) {
    paragraphs.push(proof);
  }
  paragraphs.push(ask);
  paragraphs.push(signature);
  const body = paragraphs.join("\n\n");

  const wordCount = countWords(body);
  if (wordCount > OUTREACH_MAX_WORDS) {
    gaps.push({
      field: "length",
      message: `Draft is ${wordCount} words; trim it under ${OUTREACH_MAX_WORDS}.`,
    });
  }

  const subject =
    fullName === null
      ? job.title
      : topSkill === null
        ? `${job.title} - ${fullName}`
        : `${job.title} - ${fullName}, ${topSkill}`;

  return {
    subject,
    body,
    wordCount,
    recipientName: input.recipientName ?? null,
    recipientEmail: input.recipientEmail ?? null,
    evidence,
    gaps,
  };
}

function assertHeaderSafe(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain line breaks`);
  }
  return value;
}

/** Plain-text rendering for the terminal: headers, body, then provenance. */
export function renderOutreachText(draft: OutreachDraftContent): string {
  const lines: string[] = [
    `Subject: ${draft.subject}`,
    `To: ${draft.recipientEmail ?? draft.recipientName ?? "(hiring manager)"}`,
    `Words: ${draft.wordCount}`,
    "",
    draft.body,
  ];

  if (draft.evidence.length > 0) {
    lines.push("", "Evidence (verify before sending):");
    for (const item of draft.evidence) {
      lines.push(`  - ${item.claim}  <- ${item.source}`);
    }
  }

  if (draft.gaps.length > 0) {
    lines.push("", "Gaps (the draft does not invent these):");
    for (const gap of draft.gaps) {
      lines.push(`  ! ${gap.field}: ${gap.message}`);
    }
  }

  return lines.join("\n");
}

/** RFC 822 message you can open in a mail client. Nothing is sent. */
export function renderOutreachEml(draft: OutreachDraftContent, to: string): string {
  const recipient = assertHeaderSafe(to.trim(), "recipient email");
  if (recipient === "") {
    throw new Error("an eml export needs a recipient email (--email)");
  }
  const subject = assertHeaderSafe(draft.subject, "subject");
  const headers = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${draft.body.replace(/\n/g, "\r\n")}\r\n`;
}
