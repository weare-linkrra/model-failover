import { ProviderHttpError } from "./errors.ts";
import type { ProviderConfig } from "./types.ts";

/** Split a Response body stream into text lines (handles \n and \r\n, and partial reads across chunks). */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/, "");
  }
}

/**
 * Parse an OpenAI-compatible Server-Sent-Events chat completion stream
 * (lines of `data: {...}` terminated by `data: [DONE]`) into JSON chunk
 * objects, in order.
 */
export async function* parseSseStream(provider: ProviderConfig, response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw new ProviderHttpError(`"${provider.name}" returned a streaming response with no body`, { kind: "parse" });
  }
  for await (const line of readLines(response.body)) {
    if (line.length === 0) continue;
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === "object") {
        yield parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new ProviderHttpError(`"${provider.name}" sent an unparseable stream chunk: ${data.slice(0, 200)}`, {
        kind: "parse",
        body: data,
        cause: err,
      });
    }
  }
}
