import type { Application } from "./application.js";
import type { Job } from "./job.js";
import type { CandidateProfile } from "./profile.js";
import type { ResumeKind } from "./resume.js";
import type { ApplicationStatus } from "./status.js";

export type ChecklistSeverity = "ok" | "warn" | "block";

export interface ChecklistItem {
  id: string;
  severity: ChecklistSeverity;
  message: string;
}

export interface PacketDocument {
  id: string;
  label: string;
  kind: ResumeKind;
  /** Basename only; the full local path is never exposed. */
  fileName: string;
}

export interface PacketContact {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  websiteUrl: string | null;
}

export interface PacketForm {
  pageKind: "job_detail" | "application_form" | "unknown";
  hasApplicationForm: boolean | null;
  forms: number;
  fields: number;
  provide: number;
  needsInput: number;
  skip: number;
  requiredNeedsInput: number;
  /** Field labels/names only; form values are never part of the packet. */
  needsInputLabels: readonly string[];
}

export interface ReviewPacket {
  applicationId: number;
  status: ApplicationStatus;
  job: {
    id: number;
    title: string;
    company: string | null;
    url: string;
    source: string;
    scoreTotal: number | null;
    recommendation: string | null;
  };
  application: {
    createdAt: string;
    lastUpdatedAt: string;
    resumeVersion: string | null;
    notes: string | null;
  };
  target: {
    url: string | null;
    source: string | null;
    ats: string | null;
    resolvedAt: string | null;
  };
  documents: {
    resume: PacketDocument | null;
    coverLetter: PacketDocument | null;
  };
  contact: PacketContact;
  form: PacketForm | null;
  checklist: ChecklistItem[];
  summary: {
    ok: number;
    warn: number;
    block: number;
    readyToSubmit: boolean;
  };
  nextSteps: string[];
}

export interface BuildReviewPacketInput {
  application: Application;
  job: Job;
  companyName: string | null;
  resumeDocument: PacketDocument | null;
  coverLetterDocument: PacketDocument | null;
  profile: CandidateProfile | null;
  form: PacketForm | null;
}

/**
 * Statuses where the next move belongs to a human: resolve the target, review
 * the packet, or apply manually and record the real submission.
 */
export const HUMAN_ACTION_STATUSES: readonly ApplicationStatus[] = [
  "WAITING_FOR_HUMAN",
  "APPROVED",
  "IN_PROGRESS",
];

/** The single next command a human should run for an application in the queue. */
export function describeHumanAction(application: Pick<Application, "id" | "status">): string {
  switch (application.status) {
    case "WAITING_FOR_HUMAN":
      return `applications review ${application.id}`;
    case "APPROVED":
      return `apply manually, then applications status ${application.id} SUBMITTED`;
    case "IN_PROGRESS":
      return `applications prepare ${application.id}`;
    default:
      return "-";
  }
}

function contactFromProfile(profile: CandidateProfile | null): PacketContact {
  return {
    fullName: profile?.fullName ?? null,
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
    location: profile?.location ?? null,
    linkedinUrl: profile?.linkedinUrl ?? null,
    githubUrl: profile?.githubUrl ?? null,
    websiteUrl: profile?.websiteUrl ?? null,
  };
}

function countSeverity(items: readonly ChecklistItem[], severity: ChecklistSeverity): number {
  return items.filter((item) => item.severity === severity).length;
}

/**
 * Build a deterministic, read-only pre-submission packet.
 *
 * The packet never fills or submits anything and never carries form values. It
 * only turns already-stored data (target, documents, profile) plus an optional
 * fill-plan summary into a human review checklist.
 */
export function buildReviewPacket(input: BuildReviewPacketInput): ReviewPacket {
  const { application, job } = input;
  const checklist: ChecklistItem[] = [];

  if (application.applicationUrl === null) {
    checklist.push({
      id: "target",
      severity: "block",
      message: "No application target is recorded. Run `applications prepare <id>` first.",
    });
  } else {
    checklist.push({
      id: "target",
      severity: "ok",
      message:
        `Target recorded from ${application.applicationUrlSource ?? "unknown source"}` +
        `${application.applicationAts !== null ? ` (${application.applicationAts})` : ""}.`,
    });
  }

  if (application.status === "WAITING_FOR_HUMAN" || application.status === "APPROVED") {
    checklist.push({
      id: "status",
      severity: "ok",
      message: `Application is ${application.status}.`,
    });
  } else {
    checklist.push({
      id: "status",
      severity: "warn",
      message:
        `Application is ${application.status}; expected WAITING_FOR_HUMAN or APPROVED ` +
        "before submitting.",
    });
  }

  if (input.resumeDocument === null) {
    checklist.push({
      id: "resume",
      severity: "warn",
      message: "No default resume is registered. Add one with `resumes:add --file <path> --default`.",
    });
  } else {
    checklist.push({
      id: "resume",
      severity: "ok",
      message: `Default resume: ${input.resumeDocument.label} (${input.resumeDocument.fileName}).`,
    });
  }

  if (input.coverLetterDocument === null) {
    checklist.push({
      id: "cover-letter",
      severity: "warn",
      message: "No default cover letter; attach one if the form asks for it.",
    });
  } else {
    checklist.push({
      id: "cover-letter",
      severity: "ok",
      message:
        `Default cover letter: ${input.coverLetterDocument.label} ` +
        `(${input.coverLetterDocument.fileName}).`,
    });
  }

  if (input.profile === null) {
    checklist.push({
      id: "profile",
      severity: "warn",
      message: "Candidate profile not found; contact fields cannot be checked.",
    });
  } else {
    if (!input.profile.fullName) {
      checklist.push({
        id: "full-name",
        severity: "warn",
        message: "Candidate full name is missing from the profile.",
      });
    }
    if (!input.profile.email) {
      checklist.push({
        id: "email",
        severity: "warn",
        message: "Contact email is missing from the profile.",
      });
    }
    if (!input.profile.phone) {
      checklist.push({
        id: "phone",
        severity: "warn",
        message: "Contact phone is missing from the profile.",
      });
    }
  }

  if (input.form === null) {
    checklist.push({
      id: "form",
      severity: "warn",
      message: "Target form was not inspected; re-run with --inspect to check field readiness.",
    });
  } else {
    if (input.form.hasApplicationForm !== true) {
      checklist.push({
        id: "form",
        severity: "warn",
        message: "No application form was detected at the recorded target.",
      });
    } else {
      checklist.push({
        id: "form",
        severity: "ok",
        message:
          `Application form detected (${input.form.fields} field(s) ` +
          `across ${input.form.forms} form(s)).`,
      });
    }

    if (input.form.requiredNeedsInput > 0) {
      checklist.push({
        id: "required-fields",
        severity: "block",
        message:
          `${input.form.requiredNeedsInput} required field(s) still need input: ` +
          `${input.form.needsInputLabels.join(", ")}.`,
      });
    } else if (input.form.needsInput > 0) {
      checklist.push({
        id: "required-fields",
        severity: "warn",
        message: `${input.form.needsInput} field(s) need input, but none are required.`,
      });
    } else {
      checklist.push({
        id: "required-fields",
        severity: "ok",
        message: "No field on the plan is missing input.",
      });
    }
  }

  const ok = countSeverity(checklist, "ok");
  const warn = countSeverity(checklist, "warn");
  const block = countSeverity(checklist, "block");

  const nextSteps: string[] = [];
  if (block > 0) {
    nextSteps.push(`Resolve the ${block} blocking item(s) above.`);
    nextSteps.push(`Re-run applications review ${application.id}.`);
  } else {
    const id = application.id;

    // The lifecycle resumes a human-blocked application through IN_PROGRESS
    // before APPROVED; emit only transitions the policy actually allows.
    if (application.status === "WAITING_FOR_HUMAN") {
      nextSteps.push(
        `Resume review: applications status ${id} IN_PROGRESS --message "Resuming review"`,
      );
      nextSteps.push(`Approve the packet: applications status ${id} APPROVED --message "Reviewed"`);
    } else if (application.status === "DRAFT") {
      nextSteps.push(`Start the application: applications status ${id} IN_PROGRESS`);
      nextSteps.push(`Approve the packet: applications status ${id} APPROVED --message "Reviewed"`);
    } else if (application.status === "IN_PROGRESS") {
      nextSteps.push(`Approve the packet: applications status ${id} APPROVED --message "Reviewed"`);
    } else if (application.status !== "APPROVED") {
      nextSteps.push(`Application is ${application.status}; no submission steps apply.`);
    }

    if (
      application.status === "DRAFT" ||
      application.status === "WAITING_FOR_HUMAN" ||
      application.status === "IN_PROGRESS" ||
      application.status === "APPROVED"
    ) {
      nextSteps.push(`Apply manually at ${application.applicationUrl ?? "the recorded target"}.`);
      nextSteps.push(
        `Record the real submission: applications status ${id} SUBMITTED ` +
          '--message "Submitted manually"',
      );
    }
  }

  return {
    applicationId: application.id,
    status: application.status,
    job: {
      id: job.id,
      title: job.title,
      company: input.companyName,
      url: job.canonicalUrl,
      source: job.source,
      scoreTotal: job.scoreTotal,
      recommendation: job.scoreRecommendation,
    },
    application: {
      createdAt: application.createdAt,
      lastUpdatedAt: application.lastUpdatedAt,
      resumeVersion: application.resumeVersion,
      notes: application.notes,
    },
    target: {
      url: application.applicationUrl,
      source: application.applicationUrlSource,
      ats: application.applicationAts,
      resolvedAt: application.applicationResolvedAt,
    },
    documents: {
      resume: input.resumeDocument,
      coverLetter: input.coverLetterDocument,
    },
    contact: contactFromProfile(input.profile),
    form: input.form,
    checklist,
    summary: {
      ok,
      warn,
      block,
      readyToSubmit: block === 0,
    },
    nextSteps,
  };
}
