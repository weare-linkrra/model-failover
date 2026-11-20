import { ProviderHttpError } from "./errors.ts";
import type { ProviderConfig } from "./types.ts";

export interface RequestContext {
  timeoutMs: number;
  fetchImpl: typeof fetch;
  path: string;
}

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * POST `payload` to `provider`'s chat completions endpoint and return the
 * raw Response. Never throws on a non-2xx HTTP status (the caller decides
 * what to do with it) — only throws {@link ProviderHttpError} for timeouts
 * and network/connection failures, which the caller cannot recover without
 * retrying a different provider anyway.
 */
export async function rawRequest(
  provider: ProviderConfig,
  payload: unknown,
  ctx: RequestContext,
): Promise<Response> {
  const timeoutMs = provider.timeoutMs ?? ctx.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await ctx.fetchImpl(joinUrl(provider.baseURL, ctx.path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderHttpError(`request to "${provider.name}" timed out after ${timeoutMs}ms`, {
        kind: "timeout",
        cause: err,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderHttpError(`network error calling "${provider.name}": ${message}`, {
      kind: "network",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Turn a non-ok Response into a {@link ProviderHttpError} with the parsed
 * (or raw) body attached, so the classifier can inspect it.
 */
export async function errorFromResponse(provider: ProviderConfig, response: Response): Promise<ProviderHttpError> {
  const body = await readBody(response);
  const detail = typeof body === "string" ? body : JSON.stringify(body);
  return new ProviderHttpError(
    `"${provider.name}" responded HTTP ${response.status} ${response.statusText}: ${detail}`,
    { kind: "http", status: response.status, statusText: response.statusText, body },
  );
}

/** Parse a successful non-streaming JSON response body. */
export async function parseJsonResponse(provider: ProviderConfig, response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("response body was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ProviderHttpError(`"${provider.name}" returned a response that could not be parsed as JSON`, {
      kind: "parse",
      body: text,
      cause: err,
    });
  }
}
