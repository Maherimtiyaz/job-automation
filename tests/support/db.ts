import type { Db } from "../../src/db/connection.js";
import { openDatabase } from "../../src/db/connection.js";
import { CompanyRepository } from "../../src/repositories/companies.js";
import { JobRepository } from "../../src/repositories/jobs.js";

export interface TestDatabase {
  db: Db;
  close(): void;
}

export function createTestDatabase(): TestDatabase {
  const db = openDatabase(":memory:");
  return {
    db,
    close(): void {
      if (db.open) {
        db.close();
      }
    },
  };
}

export interface SeededJob {
  companyId: number;
  jobId: number;
}

export function seedCompanyAndJob(db: Db): SeededJob {
  const company = new CompanyRepository(db).create({
    name: "Acme",
    website: "https://acme.test",
  });

  const job = new JobRepository(db).create({
    companyId: company.id,
    title: "Software Engineer Intern",
    url: "https://acme.test/jobs/1",
    source: "acme",
  });

  return { companyId: company.id, jobId: job.id };
}
