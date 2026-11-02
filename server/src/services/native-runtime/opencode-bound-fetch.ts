import { execFile } from "node:child_process";
import { Agent, request } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Connect first, then ask the kernel which process owns the exact server-side
 * socket, before sending credentials on that same connection. Darwin only. */
export function createOpenCodeBoundFetch(input: { pid: number; port: number; isAlive: () => boolean; allowEmptySessionCreate?: boolean; allowExactSessionCreateBody?: string; allowPromptForSession?: string; allowExactMcpReplace?: { body: string; directory: string } }): typeof fetch {
  if (process.platform !== "darwin" || !Number.isSafeInteger(input.pid) || input.pid <= 0 || !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("opencode_socket_attestation_unsupported");
  return (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(resource instanceof Request ? resource.url : resource.toString());
    const method = init?.method ?? "GET";
    const allowedCreate = method === "POST" && url.pathname === "/api/session" && !url.search && typeof init?.body === "string" && ((input.allowEmptySessionCreate === true && init.body === "{}") || (input.allowExactSessionCreateBody !== undefined && init.body === input.allowExactSessionCreateBody && Buffer.byteLength(init.body) <= 4096));
    const allowedPrompt = Boolean(input.allowPromptForSession && method === "POST" && url.pathname === `/api/session/${encodeURIComponent(input.allowPromptForSession)}/prompt` && !url.search && typeof init?.body === "string" && Buffer.byteLength(init.body) <= 262_500);
    const allowedMcp = Boolean(input.allowExactMcpReplace && method === "PUT" && url.pathname === "/api/experimental/mcp/paperclip" && url.search === `?directory=${encodeURIComponent(input.allowExactMcpReplace.directory)}` && init?.body === input.allowExactMcpReplace.body && Buffer.byteLength(input.allowExactMcpReplace.body) <= 4096);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== input.port || url.username || url.password || (!allowedCreate && !allowedPrompt && !allowedMcp && (method !== "GET" || init?.body))) throw new Error("opencode_socket_target_invalid");
    if (!input.isAlive() || init?.signal?.aborted) throw new Error("opencode_daemon_unavailable");
    const socket = connect({ host: "127.0.0.1", port: input.port });
    // Bound connection, attestation and response headers; the durable stream
    // itself stays open until its caller cancels it.
    const headerTimer = setTimeout(() => socket.destroy(new Error("opencode_request_timeout")), 10_000);
    let responseStream: import("node:http").IncomingMessage | undefined;
    const abort = () => { const error = new Error("opencode_request_aborted"); responseStream?.destroy(error); socket.destroy(error); };
    init?.signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => { clearTimeout(headerTimer); init?.signal?.removeEventListener("abort", abort); });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      const localPort = socket.localPort;
      if (!localPort) throw new Error("opencode_socket_attestation_failed");
      const tuple = `n127.0.0.1:${input.port}->127.0.0.1:${localPort}`;
      let verified = false;
      // TCP connect can finish before the server accepts the socket. Recheck
      // the same connected socket briefly; send no bytes until the kernel
      // reports its exact peer tuple under the expected PID.
      for (let attempt = 0; attempt < 4; attempt++) {
        const { stdout } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(input.pid), `-iTCP:${input.port}`, "-Fpn"], { timeout: 3000, maxBuffer: 65536 });
        if (!input.isAlive() || socket.destroyed) throw new Error("opencode_socket_attestation_failed");
        const lines = stdout.split("\n");
        if (lines.includes(`p${input.pid}`) && lines.includes(tuple)) { verified = true; break; }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (!verified) throw new Error("opencode_socket_attestation_failed");
      return await new Promise<Response>((resolve, reject) => {
        const headers = new Headers(init?.headers);
        headers.set("connection", "close");
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => socket;
        socket.once("close", () => agent.destroy());
        const req = request({ method, host: "127.0.0.1", port: input.port, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(headers.entries()), agent }, response => {
          responseStream = response;
          clearTimeout(headerTimer);
          if (!response.headers["content-type"]?.toLowerCase().startsWith("text/event-stream")) socket.setTimeout(10_000, () => socket.destroy(new Error("opencode_response_timeout")));
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) { response.destroy(); reject(new Error("opencode_redirect_rejected")); return; }
          resolve(new Response(status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
        });
        req.once("error", reject);
        // Credentials must only travel over the connection whose peer tuple
        // was just attested. Node may otherwise choose a different socket.
        req.once("socket", actual => {
          if (actual !== socket) { req.destroy(new Error("opencode_socket_attestation_failed")); return; }
          req.end(allowedCreate || allowedPrompt || allowedMcp ? init!.body as string : undefined);
        });
      });
    } catch (error) { socket.destroy(); throw error; }
  }) as typeof fetch;
}
