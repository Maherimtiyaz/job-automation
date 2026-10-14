import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigError,
  DEFAULT_DATABASE_PATH,
  DEFAULT_PROFILE_PATH,
  loadConfig,
} from "../src/config.js";
import { DEFAULT_MIN_RELEVANCE_SCORE, DEFAULT_MIN_ROLE_SCORE } from "../src/scoring/relevance.js";

test("loadConfig accepts valid environment values", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: "data/test.db",
    RELEVANCE_MIN_SCORE: "70",
    RELEVANCE_MIN_ROLE_SCORE: "40",
  });
  assert.equal(config.NODE_ENV, "test");
  assert.equal(config.DATABASE_PATH, "data/test.db");
  assert.equal(config.RELEVANCE_MIN_SCORE, 70);
  assert.equal(config.RELEVANCE_MIN_ROLE_SCORE, 40);
});

test("loadConfig applies defaults for missing values", () => {
  const config = loadConfig({});
  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.DATABASE_PATH, DEFAULT_DATABASE_PATH);
  assert.equal(config.PROFILE_PATH, DEFAULT_PROFILE_PATH);
  assert.equal(config.RELEVANCE_MIN_SCORE, DEFAULT_MIN_RELEVANCE_SCORE);
  assert.equal(config.RELEVANCE_MIN_ROLE_SCORE, DEFAULT_MIN_ROLE_SCORE);
});

test("loadConfig rejects unknown NODE_ENV", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "staging" }), ConfigError);
});

test("loadConfig rejects blank DATABASE_PATH", () => {
  assert.throws(() => loadConfig({ DATABASE_PATH: "   " }), ConfigError);
});
