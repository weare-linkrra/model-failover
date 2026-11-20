/**
 * Shared types for model-failover.
 *
 * The library is deliberately provider-agnostic: a "provider" is nothing
 * more than an OpenAI-compatible chat completions endpoint plus a name used
 * for error reporting. Nothing here encodes any specific vendor.
 */

/** One entry in a failover chain. */
export interface ProviderConfig {
  /** Human-readable label used in error messages and attempt logs. */
  name: string;
  /** Base URL of the OpenAI-compatible API, e.g. "https://api.openai.com/v1". */
  baseURL: string;
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Model id sent in the request body, unless overridden per-call. */
  model: string;
  /** Extra headers merged into every request to this provider. */
  headers?: Record<string, string>;
  /** Per-provider request timeout in ms; falls back to the chain default. */
  timeoutMs?: number;
}

/** An OpenAI-style chat message. Extra fields are passed through untouched. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | null;
  [key: string]: unknown;
}

/**
 * Chat completion request body. Mirrors the OpenAI chat completions shape.
 * `model` is optional — when omitted, each provider's own `model` is used,
 * which is what makes the same request portable across a chain whose
 * providers serve different model names.
 */
export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/** The raw provider response (OpenAI chat.completion shape) plus which provider answered. */
export type ChatCompletionResult = Record<string, unknown> & { provider: string };

/** One chunk of a streamed response (OpenAI chat.completion.chunk shape) plus which provider answered. */
export type ChatCompletionChunk = Record<string, unknown> & { provider: string };

/** Failure classes a provider attempt can fall into, used by the classifier. */
export type AttemptFailureKind = "http" | "network" | "timeout" | "parse";

/**
 * Normalized description of one failed attempt against one provider, passed
 * into the (pluggable) classifier so it can decide retryable vs. fatal.
 */
export interface ProviderAttemptError {
  /** Name of the provider that failed. */
  provider: string;
  /** Which kind of failure this was. */
  kind: AttemptFailureKind;
  /** HTTP status code, when the provider actually answered (kind "http"). */
  status?: number | undefined;
  statusText?: string | undefined;
  /** Parsed JSON body if available, else raw text, else undefined. */
  body?: unknown;
  /** Human-readable message describing the failure. */
  message: string;
  /** The original thrown error/exception, if any. */
  cause?: unknown;
}

/** Verdict returned by a classifier for one failed attempt. */
export type ClassifyVerdict = "retryable" | "fatal";

/**
 * Decides whether a failed attempt should fall through to the next provider
 * ("retryable") or abort the whole chain immediately ("fatal"). Override
 * this to teach the chain about a provider's specific exhaustion signals.
 */
export type ErrorClassifier = (error: ProviderAttemptError) => ClassifyVerdict;

/** Summary of one attempt, successful or not, used for diagnostics and the aggregate error. */
export interface AttemptSummary {
  provider: string;
  ok: boolean;
  error?: string | undefined;
  status?: number | undefined;
  retryable?: boolean | undefined;
}

export interface ModelFailoverChainOptions {
  /** Override the retryable/fatal classifier. Defaults to {@link defaultClassifier}. */
  classify?: ErrorClassifier;
  /** Request timeout per attempt, in ms. Default 30000. */
  timeoutMs?: number;
  /** Override fetch (e.g. for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Chat completions path appended to baseURL. Default "/chat/completions". */
  path?: string;
}
