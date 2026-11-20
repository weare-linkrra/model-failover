import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelFailoverChain } from "../src/index.ts";
import { sendJson, sendSse, startMockServer } from "./helpers/mock-server.ts";

test("streaming passthrough: primary fails before any bytes, secondary streams through transparently", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 429, { error: { message: "rate limited" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendSse(res, [
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
      { id: "c1", choices: [{ index: 0, delta: { content: "lo, " }, finish_reason: null }] },
      { id: "c1", choices: [{ index: 0, delta: { content: "world!" }, finish_reason: "stop" }] },
    ]);
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    const seenProviders = new Set<string>();
    let assembled = "";
    for await (const chunk of chain.streamChatCompletion({ messages: [{ role: "user", content: "hi" }], stream: true })) {
      seenProviders.add(chunk.provider);
      const choices = chunk.choices as Array<{ delta: { content?: string } }>;
      assembled += choices[0]?.delta.content ?? "";
    }

    assert.deepEqual([...seenProviders], ["secondary"]);
    assert.equal(assembled, "Hello, world!");
    assert.equal(primary.requestCount(), 1);
    assert.equal(secondary.requestCount(), 1);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("streaming from the primary directly, with no failover needed", async () => {
  const primary = await startMockServer((req, res) => {
    sendSse(res, [{ id: "c1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
  });
  const secondary = await startMockServer((req, res) => {
    sendJson(res, 200, { id: "should-not-be-used", choices: [] });
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    const chunks = [];
    for await (const chunk of chain.streamChatCompletion({ messages: [{ role: "user", content: "hi" }], stream: true })) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.provider, "primary");
    assert.equal(secondary.requestCount(), 0);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("streaming fails fast on a non-retryable error without touching the secondary", async () => {
  const primary = await startMockServer((req, res) => {
    sendJson(res, 400, { error: { message: "bad request", type: "invalid_request_error" } });
  });
  const secondary = await startMockServer((req, res) => {
    sendSse(res, [{ id: "should-not-happen", choices: [] }]);
  });

  try {
    const chain = new ModelFailoverChain([
      { name: "primary", baseURL: primary.baseURL, apiKey: "k1", model: "model-a" },
      { name: "secondary", baseURL: secondary.baseURL, apiKey: "k2", model: "model-b" },
    ]);

    const iterate = async () => {
      const out = [];
      for await (const chunk of chain.streamChatCompletion({ messages: [{ role: "user", content: "hi" }], stream: true })) {
        out.push(chunk);
      }
      return out;
    };

    await assert.rejects(iterate(), /non-retryable/);
    assert.equal(secondary.requestCount(), 0);
  } finally {
    await primary.close();
    await secondary.close();
  }
});
