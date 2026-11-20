import type { ClassifyVerdict, ProviderAttemptError } from "./types.ts";

/** HTTP statuses that are always worth retrying against the next provider. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Statuses that are normally fatal (the request itself is the problem) but
 * get re-checked against {@link QUOTA_SIGNAL} because some OpenAI-compatible
 * providers signal "you're out of quota/credits" through a 400 or 403
 * instead of a clean 429.
 */
const RECHECK_STATUS = new Set([400, 402, 403]);

/**
 * Loose match for the vocabulary providers actually use to say "you have no
 * quota/credits/budget left", gathered from real OpenAI-compatible error
 * bodies. This is intentionally permissive — a false "retryable" just costs
 * one extra hop to the next provider, while a false "fatal" stops the chain
 * on a problem that was really just this one provider running dry.
 */
const QUOTA_SIGNAL =
  /insufficient[_ ]quota|insufficient[_ ]balance|billing[_ ]hard[_ ]limit|exceeded.*quota|quota.*exceeded|out of credits|no credits|payment required|account.*(suspended|deactivated).*(billing|payment)/i;

function bodyText(error: ProviderAttemptError): string {
  if (typeof error.body === "string") return error.body;
  if (error.body !== undefined && error.body !== null) {
    try {
      return JSON.stringify(error.body);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Default retryable/fatal classifier.
 *
 * Retryable (fall through to the next provider):
 *  - network/connection errors (DNS, refused, reset)
 *  - timeouts (including a primary that hangs and never answers at all)
 *  - HTTP 429 and 5xx
 *  - a malformed/unparseable response body (the provider answered, but not sanely)
 *  - a 400/402/403 whose body matches a known quota/billing-exhaustion phrase
 *
 * Fatal (stop the chain immediately, surface the real error):
 *  - any other 4xx (bad request, real auth failure, not-found, etc.)
 *
 * Override via `ModelFailoverChainOptions.classify` for providers with
 * different signals (e.g. one that always answers 400 for both bad requests
 * *and* quota exhaustion, distinguishable only by an error `code` field).
 */
export function defaultClassifier(error: ProviderAttemptError): ClassifyVerdict {
  if (error.kind === "network" || error.kind === "timeout" || error.kind === "parse") {
    return "retryable";
  }

  // error.kind === "http" from here on.
  const status = error.status;
  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return "retryable";
  }
  if (status !== undefined && RECHECK_STATUS.has(status)) {
    const text = `${bodyText(error)} ${error.message}`;
    if (QUOTA_SIGNAL.test(text)) {
      return "retryable";
    }
  }
  return "fatal";
}
