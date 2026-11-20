import type { AttemptFailureKind, AttemptSummary } from "./types.ts";

/**
 * Internal error shape thrown by the HTTP layer for every kind of failure
 * (bad status, network error, timeout, unparseable body). Carries enough
 * structure for the classifier to make a decision without re-parsing
 * anything.
 */
export class ProviderHttpError extends Error {
  readonly kind: AttemptFailureKind;
  readonly status?: number | undefined;
  readonly statusText?: string | undefined;
  readonly body?: unknown;

  constructor(
    message: string,
    init: {
      kind: AttemptFailureKind;
      status?: number | undefined;
      statusText?: string | undefined;
      body?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ProviderHttpError";
    this.kind = init.kind;
    this.status = init.status;
    this.statusText = init.statusText;
    this.body = init.body;
  }
}

/**
 * Thrown when a provider fails with a classifier verdict of "fatal" — the
 * request itself is the problem (bad request, non-quota auth failure,
 * etc.), so the chain stops immediately instead of masking it by trying
 * every remaining provider. The original error is preserved on `.cause`.
 */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status?: number | undefined;
  readonly retryable = false;

  constructor(message: string, init: { provider: string; status?: number | undefined; cause?: unknown }) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ProviderRequestError";
    this.provider = init.provider;
    this.status = init.status;
  }
}

/**
 * Thrown when every provider in the chain was attempted and every attempt
 * was classified "retryable" (so the chain fell through all of them without
 * ever being told "stop"), yet none succeeded. Lists exactly what was tried
 * and why each attempt failed — never a bare "all providers failed".
 */
export class AllProvidersFailedError extends Error {
  readonly attempts: AttemptSummary[];

  constructor(attempts: AttemptSummary[]) {
    super(AllProvidersFailedError.formatMessage(attempts));
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }

  private static formatMessage(attempts: AttemptSummary[]): string {
    if (attempts.length === 0) {
      return "model-failover: no providers were configured";
    }
    const lines = attempts.map((a, i) => {
      const status = a.status !== undefined ? ` (HTTP ${a.status})` : "";
      return `  ${i + 1}. ${a.provider}${status}: ${a.error ?? "unknown error"}`;
    });
    return `model-failover: all ${attempts.length} provider(s) failed:\n${lines.join("\n")}`;
  }
}
