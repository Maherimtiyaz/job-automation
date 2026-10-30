import assert from "node:assert/strict";
import { test } from "node:test";

import { ImportedJobSchema, JobImportFileSchema } from "../src/domain/jobImport.js";

test("accepts a complete listing and normalizes defaults", () => {
  const parsed = ImportedJobSchema.parse({
    company: "Acme",
    title: "Backend Engineer",
    url: "https://acme.test/jobs/1",
    salaryCurrency: "inr",
  });

  assert.equal(parsed.company, "Acme");
  assert.equal(parsed.workplaceType, "unknown");
  assert.equal(parsed.salaryCurrency, "INR");
  assert.equal(parsed.description, undefined);
});

test("rejects a listing without a usable company, title, or URL", () => {
  assert.equal(
    ImportedJobSchema.safeParse({ company: "", title: "Role", url: "https://acme.test/1" })
      .success,
    false,
  );
  assert.equal(
    ImportedJobSchema.safeParse({ company: "Acme", title: "", url: "https://acme.test/1" })
      .success,
    false,
  );
  assert.equal(
    ImportedJobSchema.safeParse({ company: "Acme", title: "Role", url: "ftp://acme.test/1" })
      .success,
    false,
  );
});

test("rejects an inverted salary range and a bad currency", () => {
  assert.equal(
    ImportedJobSchema.safeParse({
      company: "Acme",
      title: "Role",
      url: "https://acme.test/1",
      salaryMin: 20,
      salaryMax: 10,
    }).success,
    false,
  );
  assert.equal(
    ImportedJobSchema.safeParse({
      company: "Acme",
      title: "Role",
      url: "https://acme.test/1",
      salaryCurrency: "rupees",
    }).success,
    false,
  );
});

test("the import file requires a non-empty jobs array", () => {
  assert.equal(JobImportFileSchema.safeParse({ version: 1, jobs: [] }).success, false);
  assert.equal(JobImportFileSchema.safeParse({ jobs: [{ anything: true }] }).success, true);
});
