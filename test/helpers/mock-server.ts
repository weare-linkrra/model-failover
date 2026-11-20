import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockServer {
  baseURL: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

/**
 * Spin up a real local HTTP server driven by `handler`, for exercising
 * ModelFailoverChain against genuine network round-trips rather than a
 * mocked fetch. Tracks how many requests it received, so tests can assert
 * a provider was never even contacted.
 */
export function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<MockServer> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        requestCount: () => count,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

/** Read the full request body as JSON (used by handlers that need to echo the request). */
export function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Send a non-streaming JSON response. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Send an OpenAI-style SSE chat completion stream and end it with `data: [DONE]`. */
export function sendSse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
