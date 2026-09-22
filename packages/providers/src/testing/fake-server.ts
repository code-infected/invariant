/**
 * A local HTTP server standing in for a provider in tests. It records every request
 * (method, path, headers, parsed JSON body) and answers from a handler, so a test can
 * assert the exact wire format an adapter sent and feed it a realistic provider response,
 * including errors with retry-after. Test-only: nothing outside *.test.ts imports it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Serialised as JSON unless it is already a string. */
  body: unknown;
}

export interface FakeServer {
  url: string;
  host: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeServer(handler: (req: RecordedRequest, n: number) => FakeReply | Promise<FakeReply>): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        // keep raw text
      }
      const recorded: RecordedRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      requests.push(recorded);
      try {
        const reply = await handler(recorded, requests.length);
        const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
        res.end(text);
      } catch (err) {
        res.writeHead(599, { "content-type": "text/plain" });
        res.end(`fake server handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A queue of replies, one per request, in order; a request past the end fails the test loudly. */
export function queue(...replies: FakeReply[]): (req: RecordedRequest, n: number) => FakeReply {
  return (_req, n) => {
    const r = replies[n - 1];
    if (!r) throw new Error(`fake server got request #${n} but only ${replies.length} replies were queued`);
    return r;
  };
}
