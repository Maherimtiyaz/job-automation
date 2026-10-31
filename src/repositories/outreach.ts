import type { Db } from "../db/connection.js";
import { NotFoundError } from "../domain/errors.js";
import type {
  OutreachDraft,
  OutreachDraftContent,
  OutreachEvidence,
  OutreachGap,
} from "../domain/outreach.js";
import {
  OutreachEvidenceSchema,
  OutreachGapSchema,
} from "../domain/outreach.js";
import { nowIso } from "../domain/time.js";
import { JobRepository } from "./jobs.js";

interface OutreachDraftRow {
  id: number;
  job_id: number;
  recipient_name: string | null;
  recipient_email: string | null;
  subject: string;
  body: string;
  word_count: number;
  evidence: string;
  gaps: string;
  created_at: string;
}

const INSERT_DRAFT = `
INSERT INTO outreach_drafts
  (job_id, recipient_name, recipient_email, subject, body, word_count, evidence, gaps, created_at)
VALUES
  (@jobId, @recipientName, @recipientEmail, @subject, @body, @wordCount, @evidence, @gaps, @createdAt)
`;

function parseEvidence(raw: string): OutreachEvidence[] {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    const parsed = OutreachEvidenceSchema.array().safeParse(decoded);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseGaps(raw: string): OutreachGap[] {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    const parsed = OutreachGapSchema.array().safeParse(decoded);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function mapRow(row: OutreachDraftRow): OutreachDraft {
  return {
    id: row.id,
    jobId: row.job_id,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    body: row.body,
    wordCount: row.word_count,
    evidence: parseEvidence(row.evidence),
    gaps: parseGaps(row.gaps),
    createdAt: row.created_at,
  };
}

export class OutreachRepository {
  private readonly jobs: JobRepository;

  constructor(private readonly db: Db) {
    this.jobs = new JobRepository(db);
  }

  /** Persist a composed draft. The job must exist; nothing is sent. */
  save(jobId: number, draft: OutreachDraftContent): OutreachDraft {
    this.jobs.getById(jobId);
    const timestamp = nowIso();
    const result = this.db
      .prepare(INSERT_DRAFT)
      .run({
        jobId,
        recipientName: draft.recipientName,
        recipientEmail: draft.recipientEmail,
        subject: draft.subject,
        body: draft.body,
        wordCount: draft.wordCount,
        evidence: JSON.stringify(draft.evidence),
        gaps: JSON.stringify(draft.gaps),
        createdAt: timestamp,
      });
    const id = Number(result.lastInsertRowid);
    const saved = this.findById(id);
    if (saved === null) {
      throw new Error(`outreach draft ${id} was not stored`);
    }
    return saved;
  }

  findById(id: number): OutreachDraft | null {
    const row = this.db
      .prepare("SELECT * FROM outreach_drafts WHERE id = ?")
      .get(id) as OutreachDraftRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  getById(id: number): OutreachDraft {
    const draft = this.findById(id);
    if (draft === null) {
      throw new NotFoundError("Outreach draft", id);
    }
    return draft;
  }

  /** Newest draft for a job, or null when none was ever saved. */
  latestForJob(jobId: number): OutreachDraft | null {
    this.jobs.getById(jobId);
    const row = this.db
      .prepare("SELECT * FROM outreach_drafts WHERE job_id = ? ORDER BY id DESC LIMIT 1")
      .get(jobId) as OutreachDraftRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  list(limit = 25): OutreachDraft[] {
    const rows = this.db
      .prepare("SELECT * FROM outreach_drafts ORDER BY id DESC LIMIT ?")
      .all(limit) as OutreachDraftRow[];
    return rows.map(mapRow);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM outreach_drafts")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
