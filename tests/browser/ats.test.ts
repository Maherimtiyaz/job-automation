import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAts } from "../../src/browser/ats.js";

test("detects a known ATS from the hostname", () => {
  const verdict = detectAts({ hostname: "jobs.ashbyhq.com", textSample: "" });
  assert.equal(verdict.platform, "Ashby");
  assert.equal(verdict.confidence, "medium");
  assert.deepEqual(verdict.signals, ["ashbyhq.com"]);
});

test("raises confidence when the page also names the ATS", () => {
  const verdict = detectAts({
    hostname: "jobs.ashbyhq.com",
    textSample: "This application is Powered by Ashby",
  });
  assert.equal(verdict.platform, "Ashby");
  assert.equal(verdict.confidence, "high");
  assert.ok(verdict.signals.includes("powered by ashby"));
});

test("falls back to on-page text when the hostname is unknown", () => {
  const verdict = detectAts({
    hostname: "careers.example.com",
    textSample: "Powered by Greenhouse",
  });
  assert.equal(verdict.platform, "Greenhouse");
  assert.equal(verdict.confidence, "medium");
});

test("reports UNKNOWN when nothing matches", () => {
  const verdict = detectAts({ hostname: "careers.example.com", textSample: "Apply now" });
  assert.equal(verdict.platform, "UNKNOWN");
  assert.equal(verdict.confidence, "low");
  assert.deepEqual(verdict.signals, []);
});
