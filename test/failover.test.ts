import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelFailoverChain } from "../src/index.ts";
import { readJsonBody, sendJson, startMockServer } from "./helpers/mock-server.ts";

test("429 on the primary falls through to the secondary, which succeeds", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
  });
  const secondary = await startMockServer(async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      id: "cmpl-1",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "hello from secondary" }, finish_reason: "stop" }],
    });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    const result = await chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(result.provider, "secondary");
    assert.equal(primary.requestCount(), 1);
    assert.equal(secondary.requestCount(), 1);
    const choices = result.choices as Array<{ message: { content: string } }>;
    assert.equal(choices[0]?.message.content, "hello from secondary");
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("quota-exhaustion signaled via a 400 body is classified retryable by default", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 400, { error: { message: "You exceeded your current quota, please check your plan", code: "insufficient_quota" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-2", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);
    const result = await chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.provider, "secondary");
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("a custom classifier overrides the default retryable/fatal decision", async () => {
  const primary = await startMockServer((req, res) => {
    // A provider-specific "teapot" code this provider (wrongly, for this test) uses for exhaustion.
    sendJson(res, 418, { error: { message: "I'm a teapot, but really I'm out of budget" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-3", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  });

  try {
    const chain = new ModelFailoverChain(
      [
        { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
        { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
      ],
      {
        classify: (err) => (err.status === 418 ? "retryable" : "fatal"),
      },
    );
    const result = await chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.provider, "secondary");
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("a hung primary (no response within the timeout) is treated as retryable", async () => {
  const primary = await startMockServer(() => {
    // Never respond — simulates a dead/hanging primary that never returns an error at all.
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "cmpl-4", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  });

  try {
    const chain = new ModelFailoverChain(
      [
        { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
        { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
      ],
      { timeoutMs: 200 },
    );
    const result = await chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.provider, "secondary");
  } finally {
    await primary.close();
    await secondary.close();
  }
});
