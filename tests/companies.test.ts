import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { normalizeCompanyName } from "../src/domain/normalize.js";
import { CompanyRepository } from "../src/repositories/companies.js";
import { createTestDatabase } from "./support/db.js";

test("creates and retrieves a company", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    const created = repository.create({
      name: "Acme",
      website: "https://acme.test",
      careersUrl: "https://acme.test/careers",
      atsPlatform: "greenhouse",
    });

    assert.ok(created.id > 0);
    assert.equal(created.name, "Acme");
    assert.equal(created.website, "https://acme.test");
    assert.equal(created.atsPlatform, "greenhouse");
    assert.equal(created.createdAt, created.updatedAt);

    const fetched = repository.getById(created.id);
    assert.deepEqual(fetched, created);
  } finally {
    close();
  }
});

test("stores a normalized company name", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    const company = repository.create({ name: "Acme, Inc." });
    assert.equal(company.normalizedName, "acme");
    assert.deepEqual(repository.findByNormalizedName("acme"), company);
  } finally {
    close();
  }
});

test("getOrCreate deduplicates equivalent company names", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    const first = repository.getOrCreate({ name: "Acme Inc" });
    const second = repository.getOrCreate({ name: "  ACME,  Inc. " });

    assert.equal(first.id, second.id);
    assert.equal(repository.count(), 1);
  } finally {
    close();
  }
});

test("rejects a duplicate company", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    repository.create({ name: "Acme" });
    assert.throws(() => repository.create({ name: "Acme Inc" }), ConflictError);
  } finally {
    close();
  }
});

test("rejects an empty company name", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    assert.throws(() => repository.create({ name: "   " }), ValidationError);
  } finally {
    close();
  }
});

test("rejects a malformed website URL", () => {
  const { db, close } = createTestDatabase();
  try {
    const repository = new CompanyRepository(db);
    assert.throws(() => repository.create({ name: "Acme", website: "not-a-url" }), ValidationError);
  } finally {
    close();
  }
});

test("normalizeCompanyName strips legal suffixes and punctuation", () => {
  assert.equal(normalizeCompanyName("Stripe, Inc."), "stripe");
  assert.equal(normalizeCompanyName("  North   Star LLC "), "north star");
  assert.equal(normalizeCompanyName("Acme"), "acme");
});
