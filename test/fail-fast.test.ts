import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelFailoverChain, ProviderRequestError } from "../src/index.ts";
import { sendJson, startMockServer } from "./helpers/mock-server.ts";

test("a non-retryable 400 fails fast and never touches the secondary", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 400, { error: { message: "messages[0].content must be a string", type: "invalid_request_error" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-should-not-happen", choices: [] });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    await assert.rejects(
      chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRequestError);
        assert.equal(err.provider, "primary");
        assert.equal(err.status, 400);
        assert.match(err.message, /invalid_request_error|must be a string/);
        return true;
      },
    );

    assert.equal(primary.requestCount(), 1);
    assert.equal(secondary.requestCount(), 0, "secondary must never be contacted after a fatal failure");
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("a non-retryable 401 (plain auth failure, no quota signal) fails fast", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-should-not-happen", choices: [] });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "bad-key", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    await assert.rejects(chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] }), ProviderRequestError);
    assert.equal(secondary.requestCount(), 0);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("fail-fast also applies mid-chain: a retryable first failure then a fatal second failure stops before a third provider", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 429, { error: { message: "rate limited" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 400, { error: { message: "bad request", type: "invalid_request_error" } });
  });
  const tertiary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-should-not-happen", choices: [] });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
      { name: "tertiary", baseURL: tertiary.baseURL, apiKey: "k3", model: "model-c" },
    ]);

    await assert.rejects(
      chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRequestError);
        assert.equal(err.provider, "secondary");
        return true;
      },
    );
    assert.equal(primary.requestCount(), 1);
    assert.equal(secondary.requestCount(), 1);
    assert.equal(tertiary.requestCount(), 0);
  } finally {
    await primary.close();
    await secondary.close();
    await tertiary.close();
  }
});
