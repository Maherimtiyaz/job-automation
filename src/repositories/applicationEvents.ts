import type { Db } from "../db/connection.js";
import type { ApplicationEvent } from "../domain/application.js";
import type { ApplicationEventType, ApplicationStatus } from "../domain/status.js";
import { nowIso } from "../domain/time.js";

interface ApplicationEventRow {
  id: number;
  application_id: number;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  message: string | null;
  created_at: string;
}

export interface AppendApplicationEventInput {
  applicationId: number;
  eventType: ApplicationEventType;
  previousStatus: ApplicationStatus | null;
  newStatus: ApplicationStatus | null;
  message: string | null;
}

const INSERT_EVENT = `
INSERT INTO application_events (application_id, event_type, previous_status, new_status, message, created_at)
VALUES (@applicationId, @eventType, @previousStatus, @newStatus, @message, @createdAt)
`;

function mapEvent(row: ApplicationEventRow): ApplicationEvent {
  return {
    id: row.id,
    applicationId: row.application_id,
    eventType: row.event_type as ApplicationEventType,
    previousStatus: row.previous_status as ApplicationStatus | null,
    newStatus: row.new_status as ApplicationStatus | null,
    message: row.message,
    createdAt: row.created_at,
  };
}

export class ApplicationEventRepository {
  constructor(private readonly db: Db) {}

  append(input: AppendApplicationEventInput): ApplicationEvent {
    const createdAt = nowIso();
    const result = this.db.prepare(INSERT_EVENT).run({
      applicationId: input.applicationId,
      eventType: input.eventType,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      message: input.message,
      createdAt,
    });

    return {
      id: Number(result.lastInsertRowid),
      applicationId: input.applicationId,
      eventType: input.eventType,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      message: input.message,
      createdAt,
    };
  }

  listForApplication(applicationId: number): ApplicationEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM application_events WHERE application_id = ? ORDER BY id ASC")
      .all(applicationId) as ApplicationEventRow[];
    return rows.map(mapEvent);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM application_events")
      .get() as { count: number };
    return row.count;
  }
}
