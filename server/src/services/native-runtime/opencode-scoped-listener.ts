import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createOpenCodeScopedProxy } from "./opencode-scoped-proxy.js";

/** Private loopback ingress, owned and closed by its host controller. */
export async function startOpenCodeScopedListener(input: {
  sessionId: string;
  workspaceDirectory?: string;
  attestEvent?: () => Promise<void>;
  read: (path: string, signal: AbortSignal) => Promise<Response>;
  dispatch: (operation: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }) => Promise<unknown>;
}) {
  const readerToken = randomBytes(32).toString("hex"), ownerToken = randomBytes(32).toString("hex");
  const handle = createOpenCodeScopedProxy({ ...input, readerToken, ownerToken });
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.once("close", () => abort.abort());
    try {
      if (incoming.socket.remoteAddress !== "127.0.0.1" || !incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { outgoing.writeHead(403).end(); return; }
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers: incoming.headers as HeadersInit, signal: abort.signal,
        ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" } as RequestInit),
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { outgoing.end(); return; }
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("error", () => outgoing.destroy()).pipe(outgoing);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("opencode_proxy_listen_failed"); }
  let closing: Promise<void> | undefined;
  return Object.freeze({ origin: `http://127.0.0.1:${address.port}`, readerToken, ownerToken,
    close() { return closing ??= (async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); })(); },
  });
}
