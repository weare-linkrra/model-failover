# model-failover

Fallback/routing between OpenAI-compatible model providers, so one
provider's rate limit or quota exhaustion never stops your app.

```
provider[0] fails (retryable) -> provider[1] fails (retryable) -> provider[2] succeeds
```

Zero required runtime dependencies. Works with **any** OpenAI-compatible
chat completions endpoint — you give it a list of `{ name, baseURL, apiKey,
model }` and it does the rest. It has no idea, and does not need to know,
who's actually behind each URL.

## Why

If you call a single model provider directly, you are one `429` away from
your app being down: a free-tier quota runs out, a billing limit trips, a
region has an outage, or — worse — the provider just hangs and never
answers at all. `model-failover` tries providers in order and automatically
moves to the next one whenever a failure looks "retryable" (rate limit,
5xx, timeout, network error, or a provider-side quota/billing-exhaustion
signal). A failure that looks like *your* request's fault (bad request,
real auth failure) is **not** retried against every remaining provider —
it fails fast with the real error, because trying five more providers
won't fix a malformed payload.

If every provider in the chain genuinely fails, you get one aggregate
error that tells you exactly what was tried and why each attempt failed —
never a bare "all providers failed".

## Install

```sh
npm install model-failover
```

## Quickstart

A chain spanning three independent providers — OpenAI, DeepSeek, and
[Synap](https://synap402.com) (Linkrra's own OpenAI-compatible inference
API) — so no single vendor's outage or quota limit takes the app down.
Any of these three could be first; order is just priority, not a
recommendation of one provider over another.

```ts
import { ModelFailoverChain } from "model-failover";

const chain = new ModelFailoverChain([
  {
    name: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-mini",
  },
  {
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: "deepseek-chat",
  },
  {
    name: "synap",
    baseURL: "https://synap402.com/v1",
    apiKey: process.env.SYNAP_API_KEY!,
    model: "qwen3-coder-30b", // Synap's free-tier coding model
  },
]);

const result = await chain.chatCompletion({
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(result.choices[0].message.content);
console.log("answered by:", result.provider); // "openai", "deepseek", or "synap"
```

Synap's live model and price list (useful if you want to pick a different
model than the example above) is published at
<https://synap402.com/v1/models> — no account needed to view it.

Swap in whichever providers you actually use; nothing in this library
knows or cares which one is "the real one". A chain of just OpenAI +
DeepSeek, or OpenAI + Synap, or four self-hosted vLLM boxes, works exactly
the same way.

## Streaming

```ts
for await (const chunk of chain.streamChatCompletion({
  messages: [{ role: "user", content: "Count to five." }],
  stream: true,
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Failover for streaming happens while the connection is being established
(bad status code, network error, or timeout) — once a provider answers 200
and starts sending tokens, the stream is passed through from that provider
to the end. A provider that dies mid-stream, after already sending output,
is not retried on a different provider (there's no way to un-send tokens
your caller already received); this matches how every OpenAI-compatible
SDK behaves.

## How retryable vs. fatal is decided

The built-in classifier (`defaultClassifier`) treats these as **retryable**
(fall through to the next provider):

- HTTP `429` and `5xx`
- network/connection errors (DNS failure, connection refused/reset)
- timeouts, including a provider that hangs and never answers at all
- a response body that can't be parsed as JSON
- a `400`/`402`/`403` whose body matches a known quota/billing-exhaustion
  phrase (`insufficient_quota`, `insufficient balance`, `exceeded your
  current quota`, `payment required`, etc.) — different OpenAI-compatible
  providers signal "you're out of credits" very differently, and several
  use a 400 instead of a clean 429

Everything else — a plain `400` (malformed request), a plain `401`/`403`
(real auth failure, no quota wording), `404`, `422`, etc. — is **fatal**:
the chain stops immediately and throws `ProviderRequestError` with the
real underlying error attached as `.cause`, instead of silently trying
every remaining provider against a request that was never going to
succeed anywhere.

### Overriding the classifier

Some providers don't follow that convention at all — pass your own
`classify` function and it completely replaces the default:

```ts
import { ModelFailoverChain, type ProviderAttemptError } from "model-failover";

const chain = new ModelFailoverChain(providers, {
  classify(err: ProviderAttemptError) {
    // This provider always answers 400 for both "bad request" and
    // "out of credits", distinguishable only by its error `code` field.
    if (err.status === 400) {
      const code = (err.body as any)?.error?.code;
      if (code === "out_of_credits") return "retryable";
      return "fatal";
    }
    return err.status === 429 || (err.status ?? 0) >= 500 ? "retryable" : "fatal";
  },
});
```

## API reference

### `new ModelFailoverChain(providers, options?)`

- `providers: ProviderConfig[]` — ordered list, attempted first to last.
  - `name: string` — label used in errors and in `.provider` on results.
  - `baseURL: string` — e.g. `"https://api.openai.com/v1"`.
  - `apiKey: string` — sent as `Authorization: Bearer <apiKey>`.
  - `model: string` — used unless the request itself sets `model`.
  - `headers?: Record<string, string>` — extra headers for this provider.
  - `timeoutMs?: number` — per-provider timeout override.
- `options?`
  - `classify?: (err: ProviderAttemptError) => "retryable" | "fatal"` —
    overrides `defaultClassifier` entirely.
  - `timeoutMs?: number` — default request timeout, in ms (default `30000`).
  - `path?: string` — path appended to `baseURL` (default
    `"/chat/completions"`).
  - `fetchImpl?: typeof fetch` — override fetch, mainly for testing.

### `chain.chatCompletion(request)`

Sends an OpenAI-style chat completion request (`{ messages, model?,
temperature?, ... }`, any extra fields are passed through) and returns the
winning provider's raw JSON response with `.provider` added. Throws
`ProviderRequestError` on a fatal failure, or `AllProvidersFailedError`
if every provider failed retryably.

### `chain.streamChatCompletion(request)`

Same request shape, returns an `AsyncGenerator` yielding OpenAI-style
`chat.completion.chunk` objects (each with `.provider` added). Same error
behavior as `chatCompletion` for the connection-establishment phase.

### Errors

- `ProviderRequestError` — thrown immediately on a fatal failure.
  `.provider`, `.status`, `.cause` (the original error).
- `AllProvidersFailedError` — thrown when every provider failed retryably.
  `.attempts: Array<{ provider, ok, error, status?, retryable? }>` and a
  `.message` that already lists every provider and its failure reason.
- `defaultClassifier(error: ProviderAttemptError)` — exported so you can
  call it from your own custom classifier (e.g. to fall back to default
  behavior for statuses you don't special-case).

## What this is not

This is a plain, provider-agnostic chat-completions failover client. It
does not do load balancing, cost-based routing, response caching, or
prompt management, and it does not depend on or know anything about any
specific vendor's internal pricing or routing engine — it's just HTTP plus
a retry decision.

## Roadmap

A Python port is a documented next step; it was intentionally not built in
this first release so the TypeScript package could ship complete, tested,
and correct first.

## License

MIT — see [LICENSE](./LICENSE).
