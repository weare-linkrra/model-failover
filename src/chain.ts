import { defaultClassifier } from "./classify.ts";
import { AllProvidersFailedError, ProviderHttpError, ProviderRequestError } from "./errors.ts";
import { errorFromResponse, parseJsonResponse, rawRequest, type RequestContext } from "./http.ts";
import { parseSseStream } from "./sse.ts";
import type {
  AttemptSummary,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
  ErrorClassifier,
  ProviderAttemptError,
  ProviderConfig,
  ModelFailoverChainOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PATH = "/chat/completions";

function toAttemptError(provider: string, err: unknown): ProviderAttemptError {
  if (err instanceof ProviderHttpError) {
    return {
      provider,
      kind: err.kind,
      status: err.status,
      statusText: err.statusText,
      body: err.body,
      message: err.message,
      cause: err,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { provider, kind: "network", message, cause: err };
}

/**
 * Attempts an ordered list of OpenAI-compatible providers, one at a time,
 * so a single provider's rate limit, outage, or quota exhaustion never
 * stops the request — it just falls through to the next provider.
 *
 * See the README for the retryable-vs-fatal rules and how to override them.
 */
export class ModelFailoverChain {
  private readonly providers: ProviderConfig[];
  private readonly classify: ErrorClassifier;
  private readonly ctx: RequestContext;

  constructor(providers: ProviderConfig[], options: ModelFailoverChainOptions = {}) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error("model-failover: ModelFailoverChain needs at least one provider");
    }
    this.providers = providers;
    this.classify = options.classify ?? defaultClassifier;
    this.ctx = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl ?? fetch,
      path: options.path ?? DEFAULT_PATH,
    };
  }

  /** Providers configured on this chain, in attempt order (read-only copy). */
  get chain(): readonly ProviderConfig[] {
    return this.providers;
  }

  /**
   * Run a non-streaming chat completion. Returns the winning provider's raw
   * response body with `.provider` set to the name of whichever provider
   * actually answered.
   *
   * Throws {@link ProviderRequestError} immediately if a provider fails with
   * a "fatal" verdict (the request itself is the problem — do not mask that
   * by quietly trying everyone else). Throws {@link AllProvidersFailedError}
   * if every provider was tried and every failure was "retryable" but none
   * succeeded.
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const attempts: AttemptSummary[] = [];

    for (const provider of this.providers) {
      try {
        const payload = { ...request, model: request.model ?? provider.model, stream: false };
        const response = await rawRequest(provider, payload, this.ctx);
        if (!response.ok) {
          throw await errorFromResponse(provider, response);
        }
        const body = await parseJsonResponse(provider, response);
        return { ...body, provider: provider.name };
      } catch (err) {
        const attemptError = toAttemptError(provider.name, err);
        const verdict = this.classify(attemptError);
        attempts.push({
          provider: provider.name,
          ok: false,
          error: attemptError.message,
          status: attemptError.status,
          retryable: verdict === "retryable",
        });
        if (verdict === "fatal") {
          throw new ProviderRequestError(
            `model-failover: "${provider.name}" failed with a non-retryable error — stopping without trying the remaining providers: ${attemptError.message}`,
            { provider: provider.name, status: attemptError.status, cause: attemptError.cause ?? err },
          );
        }
        // retryable: fall through to the next provider in the chain.
      }
    }

    throw new AllProvidersFailedError(attempts);
  }

  /**
   * Run a streaming chat completion. Yields OpenAI-style
   * `chat.completion.chunk` objects (each with `.provider` set) from
   * whichever provider's connection actually succeeds.
   *
   * Failover only happens before the first chunk is yielded, i.e. while
   * establishing the connection (bad status / network error / timeout). A
   * provider that answers 200 and then dies mid-stream is not retried on a
   * different provider, since tokens already delivered to the caller can't
   * be un-sent — this matches how every OpenAI-compatible client behaves.
   */
  async *streamChatCompletion(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, void> {
    const attempts: AttemptSummary[] = [];

    for (const provider of this.providers) {
      let response: Response;
      try {
        const payload = { ...request, model: request.model ?? provider.model, stream: true };
        response = await rawRequest(provider, payload, this.ctx);
        if (!response.ok) {
          throw await errorFromResponse(provider, response);
        }
      } catch (err) {
        const attemptError = toAttemptError(provider.name, err);
        const verdict = this.classify(attemptError);
        attempts.push({
          provider: provider.name,
          ok: false,
          error: attemptError.message,
          status: attemptError.status,
          retryable: verdict === "retryable",
        });
        if (verdict === "fatal") {
          throw new ProviderRequestError(
            `model-failover: "${provider.name}" failed with a non-retryable error — stopping without trying the remaining providers: ${attemptError.message}`,
            { provider: provider.name, status: attemptError.status, cause: attemptError.cause ?? err },
          );
        }
        continue;
      }

      // Connection to this provider succeeded — commit to it and stream through.
      for await (const chunk of parseSseStream(provider, response)) {
        yield { ...chunk, provider: provider.name };
      }
      return;
    }

    throw new AllProvidersFailedError(attempts);
  }
}
