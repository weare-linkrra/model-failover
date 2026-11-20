import assert from "node:assert/strict";
import { test } from "node:test";
import { AllProvidersFailedError, ModelFailoverChain } from "../src/index.ts";
import { sendJson, startMockServer } from "./helpers/mock-server.ts";

test("when every provider fails retryably, one AllProvidersFailedError lists per-provider detail", async () => {
  const a = await startMockServer((req, res) => sendJson(res, 429, { error: { message: "rate limited at a" } }));
  const b = await startMockServer((req, res) => sendJson(res, 503, { error: { message: "overloaded at b" } }));
  const c = await startMockServer((req, res) => sendJson(res, 500, { error: { message: "internal error at c" } }));

  try {
    const chain = new ModelFailoverChain([
      { name: "a", baseURL: a.baseURL, apiKey: "k", model: "m" },
      { name: "b", baseURL: b.baseURL, apiKey: "k", model: "m" },
      { name: "c", baseURL: c.baseURL, apiKey: "k", model: "m" },
    ]);

    await assert.rejects(
      chain.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof AllProvidersFailedError);
        assert.equal(err.attempts.length, 3);

        const byProvider = Object.fromEntries(err.attempts.map((att) => [att.provider, att]));
        assert.equal(byProvider.a?.status, 429);
        assert.match(byProvider.a?.error ?? "", /rate limited at a/);
        assert.equal(byProvider.b?.status, 503);
        assert.match(byProvider.b?.error ?? "", /overloaded at b/);
        assert.equal(byProvider.c?.status, 500);
        assert.match(byProvider.c?.error ?? "", /internal error at c/);

        // The aggregate message itself must name every provider and its reason — never bare.
        assert.match(err.message, /a.*429/s);
        assert.match(err.message, /b.*503/s);
        assert.match(err.message, /c.*500/s);
        return true;
      },
    );

    assert.equal(a.requestCount(), 1);
    assert.equal(b.requestCount(), 1);
    assert.equal(c.requestCount(), 1);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test("constructing a chain with zero providers throws immediately", () => {
  assert.throws(() => new ModelFailoverChain([]), /at least one provider/);
});
