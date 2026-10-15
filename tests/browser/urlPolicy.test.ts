import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserUrlError } from "../../src/browser/errors.js";
import { classifyNetwork, validateInspectUrl } from "../../src/browser/urlPolicy.js";

test("validateInspectUrl accepts http and https URLs", () => {
  assert.equal(validateInspectUrl("http://example.com/jobs/1").href, "http://example.com/jobs/1");
  assert.equal(validateInspectUrl("https://example.com/jobs/1").href, "https://example.com/jobs/1");
});

test("validateInspectUrl rejects non-http protocols", () => {
  for (const raw of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com"]) {
    assert.throws(() => validateInspectUrl(raw), BrowserUrlError);
  }
});

test("validateInspectUrl rejects URLs with embedded credentials", () => {
  assert.throws(
    () => validateInspectUrl("https://user:secret@example.com/jobs/1"),
    (error: unknown) => error instanceof BrowserUrlError && /credentials/.test(error.message),
  );
});

test("validateInspectUrl rejects malformed URLs", () => {
  for (const raw of ["not a url", "", "https://", "example.com/jobs"]) {
    assert.throws(() => validateInspectUrl(raw), BrowserUrlError);
  }
});

test("classifyNetwork maps localhost addresses and hostnames", () => {
  for (const host of ["localhost", "foo.localhost", "127.localhost", "127.0.0.1", "127.8.8.8", "0.0.0.0", "[::1]", "::1"]) {
    assert.equal(classifyNetwork(host), "localhost", host);
  }
});

test("classifyNetwork maps private ranges", () => {
  for (const host of ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "fd00::1", "fc00::1"]) {
    assert.equal(classifyNetwork(host), "private", host);
  }
});

test("classifyNetwork maps link-local ranges", () => {
  for (const host of ["169.254.1.1", "169.254.255.255", "fe80::1", "foo.local"]) {
    assert.equal(classifyNetwork(host), "link_local", host);
  }
});

test("classifyNetwork treats public and dotted-quad boundaries correctly", () => {
  assert.equal(classifyNetwork("example.com"), "public");
  assert.equal(classifyNetwork("127.example.com"), "public");
  assert.equal(classifyNetwork("8.8.8.8"), "public");
  assert.equal(classifyNetwork("172.32.0.1"), "public");
  assert.equal(classifyNetwork("172.15.0.1"), "public");
  assert.equal(classifyNetwork("2606:4700:4700::1111"), "public");
});

test("classifyNetwork accepts URL objects", () => {
  const url = new URL("https://192.168.0.5/jobs/1");
  assert.equal(classifyNetwork(url), "private");
});