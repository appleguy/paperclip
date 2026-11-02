import { timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { scopedOpenCodeEvents } from "./opencode-scoped-events.js";

/** An exact-session ingress. Authentication and all callbacks are host-owned;
 * neither the native credential nor the upstream origin is exposed to clients. */
export function createOpenCodeScopedProxy(input: {
  sessionId: string;
  readerToken: string;
  ownerToken: string;
  allowOwnerPrompt?: boolean;
  workspaceDirectory?: string;
  attestEvent?: () => Promise<void>;
  read: (path: string, signal: AbortSignal) => Promise<Response>;
  dispatch: (operation: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }) => Promise<unknown>;
}) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(input.sessionId) || input.readerToken.length < 32 || input.ownerToken.length < 32 || input.readerToken === input.ownerToken) throw new Error("invalid_opencode_proxy_binding");
  if (input.workspaceDirectory !== undefined && (!isAbsolute(input.workspaceDirectory) || resolve(input.workspaceDirectory) !== input.workspaceDirectory)) throw new Error("invalid_opencode_proxy_workspace");
  const equal = (actual: string, expected: string) => {
    const a = Buffer.from(actual), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const sessionPath = `/api/session/${encodeURIComponent(input.sessionId)}`;
  const logPath = `/api/experimental/session/${encodeURIComponent(input.sessionId)}/log`;
  return async (request: Request): Promise<Response> => {
    const auth = request.headers.get("authorization") ?? "";
    // Accept the native server's Basic convention as well as bearer tokens.
    // The password is a scoped capability, never the backend password.
    const reader = equal(auth, `Bearer ${input.readerToken}`) || equal(auth, `Basic ${Buffer.from(`opencode:${input.readerToken}`).toString("base64")}`);
    const owner = equal(auth, `Bearer ${input.ownerToken}`) || equal(auth, `Basic ${Buffer.from(`opencode:${input.ownerToken}`).toString("base64")}`);
    if (!reader && !owner) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/session" && input.workspaceDirectory) {
      if ([...url.searchParams.keys()].some(key => !["limit", "order", "parentID"].includes(key)) || ["limit", "order", "parentID"].some(key => url.searchParams.getAll(key).length > 1) || (url.searchParams.has("parentID") && !["null", input.sessionId].includes(url.searchParams.get("parentID")!)) || (url.searchParams.has("order") && !["asc", "desc"].includes(url.searchParams.get("order")!)) || (url.searchParams.has("limit") && (!/^[1-9][0-9]{0,2}$/.test(url.searchParams.get("limit")!) || Number(url.searchParams.get("limit")) > 500))) return new Response(null, { status: 403 });
      const upstream = await input.read(sessionPath, request.signal);
      if (!upstream.ok || !upstream.body) return new Response(null, { status: 503 });
      const reader = upstream.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await reader.cancel(); return new Response(null, { status: 503 }); } chunks.push(part.value); } } finally { reader.releaseLock(); }
      let value: any; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return new Response(null, { status: 503 }); }
      if (value?.data?.id !== input.sessionId || value?.data?.location?.directory !== input.workspaceDirectory) return new Response(null, { status: 503 });
      const parent = url.searchParams.get("parentID");
      const data = parent === input.sessionId || (parent === "null" && value.data.parentID != null) ? [] : [value.data];
      return Response.json({ data, cursor: { previous: null, next: null } });
    }
    if (request.method === "GET" && url.pathname === "/api/event" && !url.search && input.workspaceDirectory && input.attestEvent) {
      const upstream = await input.read("/api/event", request.signal);
      if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) return new Response(null, { status: 503 });
      return new Response(scopedOpenCodeEvents(upstream.body, input.sessionId, input.workspaceDirectory, input.attestEvent), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    if (request.method === "GET" && input.workspaceDirectory && (url.pathname === "/api/location" || url.pathname === "/api/fs/list" || url.pathname === "/api/plugin" || url.pathname === "/api/experimental/migration/v1")) {
      const directory = input.workspaceDirectory;
      if (url.pathname === "/api/experimental/migration/v1" ? !!url.search : ([...url.searchParams.keys()].some(key => key !== "location[directory]") || url.searchParams.getAll("location[directory]").length > 1 || (url.searchParams.has("location[directory]") && url.searchParams.get("location[directory]") !== directory))) return new Response(null, { status: 403 });
      const upstream = await input.read(`${url.pathname}${url.search}`, request.signal);
      if (!upstream.ok || !upstream.body) return new Response(null, { status: 503 });
      const stream = upstream.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try { while (true) { const part = await stream.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await stream.cancel(); return new Response(null, { status: 503 }); } chunks.push(part.value); } } finally { stream.releaseLock(); }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return new Response(null, { status: 503 }); }
      if (url.pathname === "/api/experimental/migration/v1") return body?.status === "completed" ? Response.json({ status: "completed" }) : new Response(null, { status: 503 });
      if (url.pathname === "/api/location") {
        if (body?.directory !== directory || body?.project?.directory !== directory || body?.project?.canonical !== directory || typeof body?.project?.id !== "string") return new Response(null, { status: 503 });
        return Response.json({ directory, project: { directory, canonical: directory, id: body.project.id } });
      }
      if (body?.location?.directory !== directory || !Array.isArray(body?.data)) return new Response(null, { status: 503 });
      // Native plugin descriptors can carry RPC capabilities and settings. Only
      // the verified empty catalog is safe until those descriptors are scoped.
      if (url.pathname === "/api/plugin") return body.data.length === 0 ? Response.json({ location: { directory }, data: [] }) : new Response(null, { status: 503 });
      const data = body.data.filter((entry: any) => entry && typeof entry.path === "string" && entry.path !== "." && entry.path !== ".." && !entry.path.includes("/") && !entry.path.includes("\\") && (entry.type === "file" || entry.type === "directory")).map((entry: any) => ({ path: entry.path, type: entry.type }));
      return Response.json({ location: { directory }, data });
    }
    const sessionRead = ["inbox", "message", "permission", "form"].some(suffix => url.pathname === `${sessionPath}/${suffix}`);
    const scopedQuery = [...url.searchParams.keys()].every(key => key === "location[directory]" || (url.pathname === `${sessionPath}/message` && (key === "limit" || key === "order"))) && ["location[directory]", "limit", "order"].every(key => url.searchParams.getAll(key).length <= 1) && (!url.searchParams.has("location[directory]") || url.searchParams.get("location[directory]") === input.workspaceDirectory) && (!url.searchParams.has("limit") || (/^[1-9][0-9]{0,2}$/.test(url.searchParams.get("limit")!) && Number(url.searchParams.get("limit")) <= 500)) && (!url.searchParams.has("order") || ["asc", "desc"].includes(url.searchParams.get("order")!));
    if (request.method === "GET" && (((url.pathname === sessionPath || url.pathname === "/api/info") && !url.search) || (sessionRead && scopedQuery && !!input.workspaceDirectory) || (url.pathname === logPath && [...url.searchParams.keys()].every(k => k === "follow" || k === "after") && url.searchParams.getAll("follow").length <= 1 && url.searchParams.getAll("after").length <= 1))) {
      const upstream = await input.read(`${url.pathname}${url.search}`, request.signal);
      if (upstream.status >= 300 && upstream.status < 400) throw new Error("opencode_proxy_redirect_rejected");
      const headers = new Headers();
      const type = upstream.headers.get("content-type");
      if (type) headers.set("content-type", type);
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (input.allowOwnerPrompt === true && owner && request.method === "POST" && url.pathname === `${sessionPath}/prompt` && !url.search) {
      if (!request.body) return new Response(null, { status: 400 });
      const stream = request.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await stream.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262500) { await stream.cancel(); return new Response(null, { status: 413 }); }
          chunks.push(part.value);
        }
      } finally { stream.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
      if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(k => !["id", "text", "delivery", "resume"].includes(k)) || typeof body.id !== "string" || !/^msg_[A-Za-z0-9_-]+$/.test(body.id) || typeof body.text !== "string" || (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue") || (body.resume !== undefined && typeof body.resume !== "boolean")) return new Response(null, { status: 400 });
      await input.dispatch(body as { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean });
      return Response.json({ data: { id: body.id, sessionID: input.sessionId, type: "user" } });
    }
    return new Response(null, { status: 403 });
  };
}
