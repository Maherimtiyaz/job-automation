import type { Db } from "../db/connection.js";
import { isUniqueConstraintError } from "../db/connection.js";
import type { Company } from "../domain/company.js";
import { CompanyCreateSchema } from "../domain/company.js";
import { ConflictError, NotFoundError, validationErrorFromZod } from "../domain/errors.js";
import { normalizeCompanyName } from "../domain/normalize.js";
import { nowIso } from "../domain/time.js";

interface CompanyRow {
  id: number;
  name: string;
  normalized_name: string;
  website: string | null;
  careers_url: string | null;
  ats_platform: string | null;
  created_at: string;
  updated_at: string;
}

const INSERT_COMPANY = `
INSERT INTO companies (name, normalized_name, website, careers_url, ats_platform, created_at, updated_at)
VALUES (@name, @normalizedName, @website, @careersUrl, @atsPlatform, @createdAt, @updatedAt)
`;

function mapCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    website: row.website,
    careersUrl: row.careers_url,
    atsPlatform: row.ats_platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CompanyRepository {
  constructor(private readonly db: Db) {}

  create(input: unknown): Company {
    const parsed = CompanyCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod("Invalid company", parsed.error);
    }

    const normalizedName = normalizeCompanyName(parsed.data.name);
    const timestamp = nowIso();

    try {
      const result = this.db
        .prepare(INSERT_COMPANY)
        .run({
          name: parsed.data.name,
          normalizedName,
          website: parsed.data.website ?? null,
          careersUrl: parsed.data.careersUrl ?? null,
          atsPlatform: parsed.data.atsPlatform ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      return this.getById(Number(result.lastInsertRowid));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(`Company already exists: ${parsed.data.name}`);
      }
      throw error;
    }
  }

  getOrCreate(input: unknown): Company {
    const parsed = CompanyCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw validationErrorFromZod("Invalid company", parsed.error);
    }

    const normalizedName = normalizeCompanyName(parsed.data.name);
    const existing = this.findByNormalizedName(normalizedName);
    if (existing) {
      return existing;
    }

    try {
      return this.create(parsed.data);
    } catch (error) {
      if (error instanceof ConflictError) {
        const created = this.findByNormalizedName(normalizedName);
        if (created) {
          return created;
        }
      }
      throw error;
    }
  }

  getById(id: number): Company {
    const found = this.findById(id);
    if (!found) {
      throw new NotFoundError("Company", id);
    }
    return found;
  }

  findById(id: number): Company | null {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as
      | CompanyRow
      | undefined;
    return row ? mapCompany(row) : null;
  }

  findByNormalizedName(normalizedName: string): Company | null {
    const row = this.db.prepare("SELECT * FROM companies WHERE normalized_name = ?").get(normalizedName) as
      | CompanyRow
      | undefined;
    return row ? mapCompany(row) : null;
  }

  list(): Company[] {
    const rows = this.db.prepare("SELECT * FROM companies ORDER BY name ASC").all() as CompanyRow[];
    return rows.map(mapCompany);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM companies").get() as { count: number };
    return row.count;
  }
}
