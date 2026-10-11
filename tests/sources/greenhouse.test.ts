import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanyRegistryEntry } from "../../src/registry/companyStore.js";
import type { FetchJson } from "../../src/sources/http.js";
import { GreenhouseAdapter } from "../../src/sources/greenhouse.js";
import { SourceConfigError, SourceError } from "../../src/sources/types.js";

function company(boardToken: string | null): CompanyRegistryEntry {
  return {
    name: "Acme",
    website: null,
    careersUrl: null,
    atsPlatform: "greenhouse",
    boardToken,
    active: true,
    notes: null,
  };
}

function greenhouseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    internal_job_id: 900,
    title: "Backend Engineer",
    location: { name: "Remote, US" },
    absolute_url: "https://acme.greenhouse.io/jobs/42",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const fetchJson =
  (payload: unknown): FetchJson =>
  async (_url) =>
    payload;

test("maps Greenhouse job rows into validated listings", async () => {
  const adapter = new GreenhouseAdapter(
    fetchJson({
      jobs: [
        greenhouseJob({
          title: "Backend Engineer Intern",
          location: { name: "Remote, US" },
        }),
        greenhouseJob({
          id: 7,
          absolute_url: null,
          content: "&amp;lt;p&amp;gt;Build things in Node.js &amp;amp; SQL&amp;lt;/p&amp;gt;",
          location: { name: "Lorem, CA\n Dolor, TX" },
        }),
      ],
      meta: { total: 2 },
    }),
  );

  const result = await adapter.fetchListings({ company: company("acme"), limit: 10 });

  assert.equal(result.requestsMade, 1);
  assert.equal(result.invalid, 0);
  assert.equal(result.listings.length, 2);

  const [first, second] = result.listings;
  assert.equal(first?.id, "42");
  assert.equal(first?.title, "Backend Engineer Intern");
  assert.equal(first?.url, "https://acme.greenhouse.io/jobs/42");
  assert.equal(first?.location, "Remote, US");
  assert.equal(first?.workplaceType, "remote");
  assert.equal(first?.employmentType, null);
  assert.equal(first?.companyName, "Acme");

  assert.equal(second?.url, "https://boards.greenhouse.io/acme/jobs/7");
  assert.equal(second?.workplaceType, "unknown");
  assert.equal(second?.location, "Lorem, CA Dolor, TX");
  assert.equal(second?.description, "Build things in Node.js & SQL");
});

test("does not invent an employment type from Greenhouse data", async () => {
  const adapter = new GreenhouseAdapter(
    fetchJson({
      jobs: [{ id: 1, title: "Engineer", location: { name: "Hybrid" }, content: null }],
    }),
  );

  const result = await adapter.fetchListings({ company: company("acme"), limit: 10 });

  assert.equal(result.listings[0]?.employmentType, null);
  assert.equal(result.listings[0]?.workplaceType, "hybrid");
});

test("respects the per-company listing limit", async () => {
  const jobs = Array.from({ length: 5 }, (_, i) => greenhouseJob({ id: i + 1 }));
  const adapter = new GreenhouseAdapter(fetchJson({ jobs, meta: { total: 5 } }));

  const result = await adapter.fetchListings({ company: company("acme"), limit: 2 });

  assert.equal(result.listings.length, 2);
  assert.equal(result.invalid, 0);
});

test("counts invalid rows and keeps valid ones", async () => {
  const adapter = new GreenhouseAdapter(
    fetchJson({
      jobs: [
        greenhouseJob({ id: 1 }),
        greenhouseJob({ title: "   " }),
        "not-an-object",
      ],
    }),
  );

  const result = await adapter.fetchListings({ company: company("acme"), limit: 10 });

  assert.equal(result.listings.length, 1);
  assert.equal(result.invalid, 2);
});

test("throws SourceConfigError when the board token is missing", async () => {
  const adapter = new GreenhouseAdapter(fetchJson({ jobs: [] }));
  await assert.rejects(
    () => adapter.fetchListings({ company: company(null), limit: 10 }),
    SourceConfigError,
  );
});

test("propagates upstream fetch errors", async () => {
  const adapter = new GreenhouseAdapter(async () => {
    throw new SourceError("board gone");
  });
  await assert.rejects(
    () => adapter.fetchListings({ company: company("acme"), limit: 10 }),
    SourceError,
  );
});

test("throws SourceError on a malformed payload", async () => {
  const adapter = new GreenhouseAdapter(fetchJson({ unexpected: true }));
  await assert.rejects(
    () => adapter.fetchListings({ company: company("acme"), limit: 10 }),
    SourceError,
  );
});