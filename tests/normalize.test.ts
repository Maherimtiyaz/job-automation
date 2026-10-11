import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { buildJobDedupeKey, canonicalizeUrl } from "../src/domain/normalize.js";

test("canonicalizeUrl lowercases host, drops tracking params and fragment, and sorts params", () => {
  const canonical = canonicalizeUrl("https://Acme.test/jobs/1/?b=2&utm_source=news&a=1#frag");
  assert.equal(canonical, "https://acme.test/jobs/1?a=1&b=2");
});

test("canonicalizeUrl removes a trailing slash but keeps the root path", () => {
  assert.equal(canonicalizeUrl("https://acme.test/jobs/1/"), "https://acme.test/jobs/1");
  assert.equal(canonicalizeUrl("https://acme.test/"), "https://acme.test/");
});

test("canonicalizeUrl rejects non-http protocols", () => {
  assert.throws(() => canonicalizeUrl("ftp://acme.test/job"), DomainError);
});

test("buildJobDedupeKey prefers the external job id and normalizes the source", () => {
  const key = buildJobDedupeKey({
    source: "  Greenhouse ",
    externalJobId: "12345",
    canonicalUrl: "https://acme.test/jobs/1",
  });
  assert.equal(key, "ext:greenhouse:12345");
});

test("buildJobDedupeKey falls back to the canonical URL", () => {
  const key = buildJobDedupeKey({
    source: "acme",
    externalJobId: null,
    canonicalUrl: "https://acme.test/jobs/1",
  });
  assert.equal(key, "url:https://acme.test/jobs/1");
});
