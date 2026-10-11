import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, NotFoundError, ValidationError } from "../src/domain/errors.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { JobRepository } from "../src/repositories/jobs.js";
import { createTestDatabase } from "./support/db.js";

test("creates a job for an existing company", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);

    const job = jobs.create({
      companyId: company.id,
      title: "Backend Engineer Intern",
      url: "https://acme.test/jobs/1",
      source: "Greenhouse",
      location: "Remote",
      employmentType: "INTERNSHIP",
      workplaceType: "remote",
      salaryMin: 40000,
      salaryMax: 60000,
      salaryCurrency: "usd",
      matchScore: 87.5,
    });

    assert.ok(job.id > 0);
    assert.equal(job.companyId, company.id);
    assert.equal(job.title, "Backend Engineer Intern");
    assert.equal(job.source, "greenhouse");
    assert.equal(job.salaryCurrency, "USD");
    assert.equal(job.matchScore, 87.5);
    assert.equal(job.workplaceType, "remote");
    assert.equal(job.discoveredAt, job.createdAt);
    assert.deepEqual(jobs.getById(job.id), job);
  } finally {
    close();
  }
});

test("canonicalizes the job URL before storing", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const job = new JobRepository(db).create({
      companyId: company.id,
      title: "SWE",
      url: "https://Acme.test/jobs/1/?utm_source=news&utm_medium=email#frag",
      source: "acme",
    });

    assert.equal(job.canonicalUrl, "https://acme.test/jobs/1");
    const found = new JobRepository(db).findByCanonicalUrl("https://acme.test/jobs/1");
    assert.ok(found);
    assert.equal(found.id, job.id);
  } finally {
    close();
  }
});

test("deduplicates jobs by canonical URL using upsert", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);
    const base = {
      companyId: company.id,
      url: "https://acme.test/jobs/1",
      source: "acme",
    };

    const first = jobs.upsert({ ...base, title: "SWE" });
    const second = jobs.upsert({ ...base, title: "Senior SWE", matchScore: 90 });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.job.id, second.job.id);
    assert.equal(second.job.title, "Senior SWE");
    assert.equal(jobs.count(), 1);
  } finally {
    close();
  }
});

test("deduplicates jobs by external job id across different URLs", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);

    const first = jobs.upsert({
      companyId: company.id,
      title: "SWE",
      url: "https://acme.test/jobs/1",
      source: "greenhouse",
      externalJobId: "12345",
    });
    const second = jobs.upsert({
      companyId: company.id,
      title: "SWE",
      url: "https://boards.greenhouse.io/acme/jobs/12345",
      source: "Greenhouse",
      externalJobId: "12345",
    });

    assert.equal(first.job.id, second.job.id);
    assert.equal(second.created, false);
    assert.equal(jobs.count(), 1);
  } finally {
    close();
  }
});

test("rejects a duplicate job on create", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);
    const input = {
      companyId: company.id,
      title: "SWE",
      url: "https://acme.test/jobs/1",
      source: "acme",
    };

    jobs.create(input);
    assert.throws(() => jobs.create(input), ConflictError);
  } finally {
    close();
  }
});

test("rejects a job for a missing company", () => {
  const { db, close } = createTestDatabase();
  try {
    const jobs = new JobRepository(db);
    assert.throws(
      () =>
        jobs.create({
          companyId: 999,
          title: "SWE",
          url: "https://acme.test/jobs/1",
          source: "acme",
        }),
      NotFoundError,
    );
  } finally {
    close();
  }
});

test("lists and filters jobs", () => {
  const { db, close } = createTestDatabase();
  try {
    const companies = new CompanyRepository(db);
    const jobs = new JobRepository(db);
    const acme = companies.create({ name: "Acme" });
    const other = companies.create({ name: "Globex" });

    jobs.create({
      companyId: acme.id,
      title: "Remote Intern",
      url: "https://acme.test/jobs/1",
      source: "acme",
      workplaceType: "remote",
      employmentType: "INTERNSHIP",
      matchScore: 80,
    });
    jobs.create({
      companyId: acme.id,
      title: "Onsite Engineer",
      url: "https://acme.test/jobs/2",
      source: "acme",
      workplaceType: "onsite",
      matchScore: 40,
    });
    jobs.create({
      companyId: other.id,
      title: "Contractor",
      url: "https://globex.test/jobs/1",
      source: "globex",
      matchScore: 95,
    });

    assert.equal(jobs.list().length, 3);
    assert.equal(jobs.list({ companyId: acme.id }).length, 2);
    assert.equal(jobs.list({ workplaceType: "remote" }).length, 1);
    assert.equal(jobs.list({ source: "GLOBEX" }).length, 1);
    assert.equal(jobs.list({ minMatchScore: 90 }).length, 1);
  } finally {
    close();
  }
});

test("rejects a malformed job URL", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);
    assert.throws(
      () =>
        jobs.create({
          companyId: company.id,
          title: "SWE",
          url: "definitely not a url",
          source: "acme",
        }),
      ValidationError,
    );
  } finally {
    close();
  }
});

test("rejects invalid salary ranges", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);
    const base = {
      companyId: company.id,
      title: "SWE",
      url: "https://acme.test/jobs/1",
      source: "acme",
    };

    assert.throws(() => jobs.create({ ...base, salaryMin: 200000, salaryMax: 100000 }), ValidationError);
    assert.throws(() => jobs.create({ ...base, salaryMin: -1 }), ValidationError);
  } finally {
    close();
  }
});

test("rejects match scores outside the 0-100 range", () => {
  const { db, close } = createTestDatabase();
  try {
    const company = new CompanyRepository(db).create({ name: "Acme" });
    const jobs = new JobRepository(db);
    const base = {
      companyId: company.id,
      title: "SWE",
      url: "https://acme.test/jobs/1",
      source: "acme",
    };

    assert.throws(() => jobs.create({ ...base, matchScore: 101 }), ValidationError);
    assert.throws(() => jobs.create({ ...base, matchScore: -5 }), ValidationError);
  } finally {
    close();
  }
});
