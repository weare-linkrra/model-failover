import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultClassifier } from "../src/index.ts";

test("defaultClassifier: 429 is retryable", () => {
  assert.equal(defaultClassifier({ provider: "p", kind: "http", status: 429, message: "rate limited" }), "retryable");
});

test("defaultClassifier: 500-504 are retryable", () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(defaultClassifier({ provider: "p", kind: "http", status, message: "oops" }), "retryable");
  }
});

test("defaultClassifier: plain 400 bad request is fatal", () => {
  assert.equal(
    defaultClassifier({ provider: "p", kind: "http", status: 400, message: "invalid_request_error: bad field" }),
    "fatal",
  );
});

test("defaultClassifier: plain 401/403 auth failure (no quota wording) is fatal", () => {
  assert.equal(defaultClassifier({ provider: "p", kind: "http", status: 401, message: "Incorrect API key provided" }), "fatal");
  assert.equal(defaultClassifier({ provider: "p", kind: "http", status: 403, message: "Access denied" }), "fatal");
});

test("defaultClassifier: 400/402/403 with quota/billing wording in the body is retryable", () => {
  assert.equal(
    defaultClassifier({
      provider: "p",
      kind: "http",
      status: 400,
      message: "request failed",
      body: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } },
    }),
    "retryable",
  );
  assert.equal(
    defaultClassifier({
      provider: "p",
      kind: "http",
      status: 402,
      message: "Payment Required",
      body: { error: { message: "insufficient balance, please top up" } },
    }),
    "retryable",
  );
});

test("defaultClassifier: network, timeout and parse failures are retryable", () => {
  assert.equal(defaultClassifier({ provider: "p", kind: "network", message: "ECONNREFUSED" }), "retryable");
  assert.equal(defaultClassifier({ provider: "p", kind: "timeout", message: "timed out" }), "retryable");
  assert.equal(defaultClassifier({ provider: "p", kind: "parse", message: "could not parse" }), "retryable");
});
