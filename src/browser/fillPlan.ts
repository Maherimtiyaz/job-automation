import type { CandidateProfile } from "../domain/profile.js";
import { defaultResumeForKind, type ResumeDocument, type ResumeRegistry } from "../domain/resume.js";
import type {
  FillDocumentRef,
  FillMatchConfidence,
  FillPlan,
  FillPlanEntry,
  FillPlanSummary,
  FillTarget,
  InspectedField,
  InspectedForm,
  InspectionWarning,
  PageKind,
} from "./types.js";

export interface BuildFillPlanOptions {
  forms: readonly InspectedForm[];
  profile: CandidateProfile | null;
  pageKind: PageKind;
  hasApplicationForm: boolean | null;
  resumes?: ResumeRegistry | null;
  includeValues?: boolean;
}

interface TokenRule {
  target: FillTarget;
  patterns: readonly (readonly string[])[];
}

const TOKEN_RULES: readonly TokenRule[] = [
  { target: "linkedinUrl", patterns: [["linkedin"]] },
  { target: "githubUrl", patterns: [["github"]] },
  { target: "resume", patterns: [["resume"], ["cv"], ["curriculum", "vitae"]] },
  {
    target: "coverLetter",
    patterns: [["cover", "letter"], ["coverletter"], ["motivation", "letter"]],
  },
  { target: "email", patterns: [["email"]] },
  {
    target: "firstName",
    patterns: [["first", "name"], ["firstname"], ["given", "name"], ["forename"]],
  },
  {
    target: "lastName",
    patterns: [["last", "name"], ["lastname"], ["surname"], ["family", "name"]],
  },
  { target: "fullName", patterns: [["full", "name"], ["fullname"], ["your", "name"], ["name"]] },
  {
    target: "phone",
    patterns: [["phone"], ["mobile"], ["telephone"], ["cell"], ["whatsapp"]],
  },
  {
    target: "minimumSalary",
    patterns: [["salary"], ["compensation"], ["expected", "pay"], ["desired", "pay"]],
  },
  {
    target: "location",
    patterns: [["location"], ["city"], ["where", "based"], ["currently", "based"]],
  },
  {
    target: "websiteUrl",
    patterns: [["website"], ["portfolio"], ["homepage"], ["personal", "site"]],
  },
  { target: "headline", patterns: [["headline"], ["bio"], ["about", "you"]] },
];

const EEO_PATTERNS: readonly (readonly string[])[] = [
  ["gender"],
  ["race"],
  ["ethnicity"],
  ["veteran"],
  ["disability"],
  ["pronouns"],
  ["sexual", "orientation"],
];

const WORK_AUTH_PATTERNS: readonly (readonly string[])[] = [
  ["visa"],
  ["sponsorship"],
  ["work", "authorization"],
  ["work", "permit"],
  ["legally", "authorized"],
  ["right", "to", "work"],
];

const SOURCE_PATTERNS: readonly (readonly string[])[] = [
  ["how", "did", "you", "hear"],
  ["referral"],
  ["source"],
];

const NON_PERSON_NAME_PATTERNS: readonly (readonly string[])[] = [
  ["company"],
  ["organization"],
  ["organisation"],
  ["employer"],
  ["school"],
  ["university"],
  ["institution"],
  ["account"],
];

interface MatchResult {
  target: FillTarget | null;
  confidence: FillMatchConfidence | null;
  skipReason: string | null;
  needsReason: string | null;
}

function containsSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  outer: for (let start = 0; start + sequence.length <= tokens.length; start += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[start + offset] !== sequence[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function tokenize(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function matchesAny(tokens: readonly string[], patterns: readonly (readonly string[])[]): boolean {
  return patterns.some((pattern) => containsSequence(tokens, pattern));
}

const AUTOCOMPLETE_TARGETS: Readonly<Record<string, FillTarget>> = {
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  "given-name": "firstName",
  "family-name": "lastName",
  name: "fullName",
  "address-level2": "location",
  url: "websiteUrl",
};

function matchTarget(field: InspectedField): MatchResult {
  const autocomplete = field.autocomplete?.toLowerCase().trim() ?? "";
  const nameTokens = tokenize(field.name);
  const labelTokens = tokenize(field.label);
  const placeholderTokens = tokenize(field.placeholder);
  const combined = [...nameTokens, ...labelTokens, ...placeholderTokens];

  if (matchesAny(combined, EEO_PATTERNS)) {
    return {
      target: null,
      confidence: null,
      skipReason: "demographic/EEO question - answer manually",
      needsReason: null,
    };
  }
  if (matchesAny(combined, WORK_AUTH_PATTERNS)) {
    return {
      target: null,
      confidence: null,
      skipReason: null,
      needsReason: "work-authorization question - answer manually",
    };
  }
  if (matchesAny(combined, SOURCE_PATTERNS)) {
    return {
      target: null,
      confidence: null,
      skipReason: "source/referral question - not applicable",
      needsReason: null,
    };
  }

  const autocompleteTarget = AUTOCOMPLETE_TARGETS[autocomplete];
  if (autocompleteTarget !== undefined && autocomplete !== "url") {
    return { target: autocompleteTarget, confidence: "autocomplete", skipReason: null, needsReason: null };
  }

  for (const tokens of [nameTokens, labelTokens, placeholderTokens]) {
    for (const rule of TOKEN_RULES) {
      for (const pattern of rule.patterns) {
        if (
          rule.target === "fullName" &&
          pattern.length === 1 &&
          matchesAny(combined, NON_PERSON_NAME_PATTERNS)
        ) {
          continue;
        }
        if (containsSequence(tokens, pattern)) {
          const confidence: FillMatchConfidence =
            tokens === nameTokens ? "name" : tokens === labelTokens ? "label" : "placeholder";
          return { target: rule.target, confidence, skipReason: null, needsReason: null };
        }
      }
    }
  }

  if (autocomplete === "url") {
    return { target: "websiteUrl", confidence: "autocomplete", skipReason: null, needsReason: null };
  }

  const inputType = field.inputType?.toLowerCase() ?? "";
  if (inputType === "email") {
    return { target: "email", confidence: "inputType", skipReason: null, needsReason: null };
  }
  if (inputType === "tel") {
    return { target: "phone", confidence: "inputType", skipReason: null, needsReason: null };
  }
  if (inputType === "url") {
    return { target: "websiteUrl", confidence: "inputType", skipReason: null, needsReason: null };
  }

  return { target: null, confidence: null, skipReason: null, needsReason: null };
}

function formatSalary(profile: CandidateProfile): string | null {
  const salary = profile.minimumSalary;
  if (!salary) {
    return null;
  }
  return `${salary.amount} ${salary.currency}/${salary.period}`;
}

interface ResolvedValue {
  value: string | null;
  derived: boolean;
}

function resolveValue(profile: CandidateProfile, target: FillTarget): ResolvedValue {
  switch (target) {
    case "fullName":
      return { value: profile.fullName ?? null, derived: false };
    case "firstName": {
      const parts = profile.fullName?.trim().split(/\s+/) ?? [];
      return { value: parts[0] ?? null, derived: true };
    }
    case "lastName": {
      const parts = profile.fullName?.trim().split(/\s+/) ?? [];
      return { value: parts.length > 1 ? parts.slice(1).join(" ") : null, derived: true };
    }
    case "email":
      return { value: profile.email ?? null, derived: false };
    case "phone":
      return { value: profile.phone ?? null, derived: false };
    case "location":
      return { value: profile.location ?? null, derived: false };
    case "headline":
      return { value: profile.headline ?? null, derived: false };
    case "linkedinUrl":
      return { value: profile.linkedinUrl ?? null, derived: false };
    case "githubUrl":
      return { value: profile.githubUrl ?? null, derived: false };
    case "websiteUrl":
      return { value: profile.websiteUrl ?? null, derived: false };
    case "minimumSalary":
      return { value: formatSalary(profile), derived: false };
    case "resume":
    case "coverLetter":
      return { value: null, derived: false };
    default:
      return { value: null, derived: false };
  }
}

function toDocumentRef(document: ResumeDocument): FillDocumentRef {
  const fileName = document.filePath.split(/[\\/]/).pop() ?? document.filePath;
  return { id: document.id, label: document.label, kind: document.kind, fileName };
}

function resumeNoun(target: FillTarget): string {
  return target === "coverLetter" ? "cover letter" : "resume";
}

function resumeKindForTarget(target: FillTarget): "resume" | "cover_letter" {
  return target === "coverLetter" ? "cover_letter" : "resume";
}

function buildEntry(
  field: InspectedField,
  fieldId: string,
  profile: CandidateProfile | null,
  resumes: ResumeRegistry | null,
  includeValues: boolean,
): FillPlanEntry {
  const required = field.required === true;
  const base = {
    field: fieldId,
    kind: field.kind,
    inputType: field.inputType,
    name: field.name,
    label: field.label,
    required,
    sensitive: field.sensitive,
    document: null,
  };

  if (field.sensitive) {
    return {
      ...base,
      target: null,
      decision: "SKIP",
      value: null,
      valueHidden: false,
      confidence: null,
      reason: "sensitive input (password/payment) - never autofilled",
    };
  }
  if (field.disabled || field.readonly) {
    return {
      ...base,
      target: null,
      decision: "SKIP",
      value: null,
      valueHidden: false,
      confidence: null,
      reason: field.disabled ? "field is disabled" : "field is readonly",
    };
  }

  const match = matchTarget(field);

  if (match.skipReason !== null) {
    return {
      ...base,
      target: null,
      decision: "SKIP",
      value: null,
      valueHidden: false,
      confidence: null,
      reason: match.skipReason,
    };
  }

  if (match.target === "resume" || match.target === "coverLetter") {
    const noun = resumeNoun(match.target);
    const document = resumes ? defaultResumeForKind(resumes, resumeKindForTarget(match.target)) : null;
    if (document !== null) {
      return {
        ...base,
        target: match.target,
        decision: "PROVIDE",
        value: null,
        valueHidden: false,
        confidence: match.confidence,
        document: toDocumentRef(document),
        reason:
          match.target === "coverLetter"
            ? `attach "${document.label}" from the resume store`
            : `${noun} "${document.label}" from the resume store`,
      };
    }
    return {
      ...base,
      target: match.target,
      decision: "NEEDS_INPUT",
      value: null,
      valueHidden: false,
      confidence: match.confidence,
      document: null,
      reason:
        resumes === null
          ? `${noun} - no resume store configured; attach manually`
          : `${noun} - no default ${noun} in the resume store; attach manually`,
    };
  }

  if (match.target !== null) {
    if (profile === null) {
      return {
        ...base,
        target: match.target,
        decision: "NEEDS_INPUT",
        value: null,
        valueHidden: false,
        confidence: match.confidence,
        reason: "no profile loaded - provide this value",
      };
    }
    const resolved = resolveValue(profile, match.target);
    if (resolved.value !== null && resolved.value !== "") {
      return {
        ...base,
        target: match.target,
        decision: "PROVIDE",
        value: includeValues ? resolved.value : null,
        valueHidden: !includeValues,
        confidence: match.confidence,
        reason: resolved.derived
          ? "derived from profile fullName"
          : `from candidate profile (${match.target})`,
      };
    }
    return {
      ...base,
      target: match.target,
      decision: "NEEDS_INPUT",
      value: null,
      valueHidden: false,
      confidence: match.confidence,
      reason: `profile has no ${match.target} value`,
    };
  }

  if (match.needsReason !== null) {
    return {
      ...base,
      target: null,
      decision: "NEEDS_INPUT",
      value: null,
      valueHidden: false,
      confidence: null,
      reason: match.needsReason,
    };
  }

  if (required) {
    return {
      ...base,
      target: null,
      decision: "NEEDS_INPUT",
      value: null,
      valueHidden: false,
      confidence: null,
      reason: "required field not mapped to profile data",
    };
  }

  return {
    ...base,
    target: null,
    decision: "SKIP",
    value: null,
    valueHidden: false,
    confidence: null,
    reason: "not mapped to profile data",
  };
}

export function buildFillPlan(options: BuildFillPlanOptions): FillPlan {
  const entries: FillPlanEntry[] = [];

  options.forms.forEach((form, formIndex) => {
    form.fields.forEach((field, fieldIndex) => {
      const fieldId =
        field.id && field.id.trim().length > 0
          ? `form${formIndex}.${field.id}`
          : `form${formIndex}.field${fieldIndex}`;
      entries.push(
        buildEntry(
          field,
          fieldId,
          options.profile,
          options.resumes ?? null,
          options.includeValues === true,
        ),
      );
    });
  });

  const summary: FillPlanSummary = {
    forms: options.forms.length,
    fields: entries.length,
    provide: entries.filter((entry) => entry.decision === "PROVIDE").length,
    needsInput: entries.filter((entry) => entry.decision === "NEEDS_INPUT").length,
    skip: entries.filter((entry) => entry.decision === "SKIP").length,
    requiredNeedsInput: entries.filter((entry) => entry.decision === "NEEDS_INPUT" && entry.required)
      .length,
  };

  const warnings: InspectionWarning[] = [];
  if (options.profile === null && summary.fields > 0) {
    warnings.push({
      message:
        "No candidate profile loaded; every mapped field needs input. Run profile:init and fill it in.",
    });
  }

  return {
    profileLoaded: options.profile !== null,
    pageKind: options.pageKind,
    hasApplicationForm: options.hasApplicationForm,
    summary,
    entries,
    warnings,
  };
}
