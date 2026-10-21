import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveApplyTarget } from "../../src/browser/applyTarget.js";

test("selects the first apply link", () => {
  const resolution = resolveApplyTarget({
    pageUrl: "https://acme.test/jobs/1",
    applyLinks: [{ text: "Apply Now", url: "https://acme.test/apply/1", applyHint: true }],
  });

  assert.equal(resolution.url, "https://acme.test/apply/1");
  assert.equal(resolution.text, "Apply Now");
  assert.equal(resolution.candidates.length, 1);
  assert.equal(resolution.candidates[0]?.crossOrigin, false);
});

test("ignores the page itself, non-HTTP links, and credentialed URLs", () => {
  const resolution = resolveApplyTarget({
    pageUrl: "https://acme.test/jobs/1",
    applyLinks: [
      { text: "This page", url: "https://acme.test/jobs/1", applyHint: true },
      { text: "Mail us", url: "mailto:jobs@acme.test", applyHint: true },
      { text: "Bad", url: "https://user:secret@acme.test/apply", applyHint: true },
      { text: "Real", url: "https://boards.greenhouse.io/acme/jobs/1", applyHint: true },
    ],
  });

  assert.equal(resolution.url, "https://boards.greenhouse.io/acme/jobs/1");
  assert.equal(resolution.candidates.length, 1);
});

test("deduplicates candidates and marks cross-origin links", () => {
  const resolution = resolveApplyTarget({
    pageUrl: "https://acme.test/jobs/1",
    applyLinks: [
      { text: "Apply", url: "https://ats.example/apply", applyHint: true },
      { text: "Apply again", url: "https://ats.example/apply", applyHint: true },
    ],
  });

  assert.equal(resolution.candidates.length, 1);
  assert.equal(resolution.candidates[0]?.crossOrigin, true);
  assert.match(resolution.reason, /cross-origin/);
});

test("reports when no application link exists", () => {
  const resolution = resolveApplyTarget({
    pageUrl: "https://acme.test/jobs/1",
    applyLinks: [],
  });

  assert.equal(resolution.url, null);
  assert.equal(resolution.text, null);
  assert.equal(resolution.candidates.length, 0);
  assert.match(resolution.reason, /No application link/);
});

test("falls back to apply-hinted general links", () => {
  const resolution = resolveApplyTarget({
    pageUrl: "https://acme.test/jobs/1",
    applyLinks: [],
    links: [
      { text: "About us", url: "https://acme.test/about", applyHint: false },
      { text: "Apply on company site", url: "https://acme.test/careers/apply", applyHint: true },
    ],
  });

  assert.equal(resolution.url, "https://acme.test/careers/apply");
});
