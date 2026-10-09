import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, DEFAULT_DATABASE_PATH, loadConfig } from "../src/config.js";

test("loadConfig accepts valid environment values", () => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.db" });
  assert.equal(config.NODE_ENV, "test");
  assert.equal(config.DATABASE_PATH, "data/test.db");
});

test("loadConfig applies defaults for missing values", () => {
  const config = loadConfig({});
  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.DATABASE_PATH, DEFAULT_DATABASE_PATH);
});

test("loadConfig rejects unknown NODE_ENV", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "staging" }), ConfigError);
});

test("loadConfig rejects blank DATABASE_PATH", () => {
  assert.throws(() => loadConfig({ DATABASE_PATH: "   " }), ConfigError);
});
