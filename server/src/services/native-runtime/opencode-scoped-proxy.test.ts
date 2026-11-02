import { expect, it, vi } from "vitest";
import { createOpenCodeScopedProxy } from "./opencode-scoped-proxy.js";
import { startOpenCodeScopedListener } from "./opencode-scoped-listener.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

it("limits clients to an exact session and routes owner prompts through admission", async () => {
  const read = vi.fn(async () => Response.json({ data: { id: "ses_one" } }));
  const dispatch = vi.fn(async () => undefined);
  const readerToken = "r".repeat(32), ownerToken = "o".repeat(32);
  const proxy = createOpenCodeScopedProxy({ sessionId: "ses_one", readerToken, ownerToken, allowOwnerPrompt: true, read, dispatch });
  const request = (path: string, token: string, method = "GET", body?: unknown) => new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await proxy(request("/api/session/ses_one", readerToken))).status).toBe(200);
  expect((await proxy(new Request("http://127.0.0.1/api/session/ses_one", { headers: { authorization: `Basic ${Buffer.from(`opencode:${readerToken}`).toString("base64")}` } }))).status).toBe(200);
  expect((await proxy(request("/api/session/ses_other", ownerToken))).status).toBe(403);
  expect((await proxy(request("/api/session/ses_one", "wrong"))).status).toBe(401);
  const prompt = { id: "msg_one", text: "steer", delivery: "steer" };
  expect((await proxy(request("/api/session/ses_one/prompt", readerToken, "POST", prompt))).status).toBe(403);
  expect((await proxy(request("/api/session/ses_one/prompt", ownerToken, "POST", { ...prompt, model: "foreign" }))).status).toBe(400);
  expect((await proxy(request("/api/session/ses_one/prompt", ownerToken, "POST", prompt))).status).toBe(200);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(prompt);
  expect(read).toHaveBeenCalledTimes(2);
});

it("exposes its scoped read surface to the installed native API client", async () => {
  const listener = await startOpenCodeScopedListener({ sessionId: "ses_one", read: async path => Response.json(path === "/api/info" ? { pid: process.pid, version: "2.2.5" } : { data: { id: "ses_one" } }), dispatch: async () => undefined });
  try {
    const run = promisify(execFile);
    const version = await run("/opt/homebrew/bin/opencode", ["--version"], { timeout: 5000 });
    if (version.stdout.trim() !== "opencode v2.2.5") return;
    const result = await run("/opt/homebrew/bin/opencode", ["--server", listener.origin, "api", "GET", "/api/session/ses_one"], { timeout: 5000, env: { ...process.env, OPENCODE_PASSWORD: listener.readerToken } });
    expect(result.stdout).toContain("ses_one");
  } finally { await listener.close(); }
});

it("limits native workspace bootstrap to the attested directory and bounded direct entries", async () => {
  const token = "r".repeat(32), directory = "/workspace";
  let body: unknown = { location: { directory }, data: [{ path: "ok", type: "file", secret: "discard" }, { path: "../outside", type: "file" }, { path: "nested/outside", type: "file" }, { path: "link", type: "symlink" }] };
  const read = vi.fn(async () => Response.json(body));
  const proxy = createOpenCodeScopedProxy({ sessionId: "ses_one", readerToken: token, ownerToken: "o".repeat(32), workspaceDirectory: directory, read, dispatch: async () => undefined });
  const request = (path: string) => new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(await (await proxy(request("/api/fs/list"))).json()).toEqual({ location: { directory }, data: [{ path: "ok", type: "file" }] });
  expect((await proxy(request("/api/fs/list?location%5Bdirectory%5D=%2Fother"))).status).toBe(403);
  expect((await proxy(request("/api/fs/list?location%5Bdirectory%5D=%2Fworkspace&location%5Bdirectory%5D=%2Fworkspace"))).status).toBe(403);
  expect((await proxy(request("/api/event"))).status).toBe(403);
  body = { data: { id: "ses_one", location: { directory }, title: "owned" } };
  expect(await (await proxy(request("/api/session?limit=20&order=desc&parentID=null"))).json()).toEqual({ data: [{ id: "ses_one", location: { directory }, title: "owned" }], cursor: { previous: null, next: null } });
  expect(await (await proxy(request("/api/session?limit=200&order=desc&parentID=ses_one"))).json()).toEqual({ data: [], cursor: { previous: null, next: null } });
  expect((await proxy(request("/api/session?parentID=ses_foreign"))).status).toBe(403);
  body = { data: { id: "ses_foreign", location: { directory } } };
  expect((await proxy(request("/api/session"))).status).toBe(503);
  expect((await proxy(request("/api/session/ses_one/message?location%5Bdirectory%5D=%2Fworkspace"))).status).toBe(200);
  expect((await proxy(request("/api/session/ses_other/message"))).status).toBe(403);
  expect((await proxy(request("/api/session/ses_one/message?location%5Bdirectory%5D=%2Fother"))).status).toBe(403);
  expect((await proxy(request("/api/session/ses_one/message?limit=50&order=desc"))).status).toBe(200);
  expect((await proxy(request("/api/session/ses_one/message?limit=999999&order=desc"))).status).toBe(403);
  expect((await proxy(request("/api/session/ses_one/message?limit=5&limit=5"))).status).toBe(403);
  expect((await proxy(request("/api/plugin/rpc"))).status).toBe(403);
  expect((await proxy(new Request("http://localhost/api/plugin/rpc", { method: "POST", headers: { authorization: `Bearer ${"o".repeat(32)}` }, body: "{}" }))).status).toBe(403);
  expect((await proxy(new Request("http://localhost/api/session/ses_one/prompt", { method: "POST", headers: { authorization: `Bearer ${"o".repeat(32)}` }, body: JSON.stringify({ id: "msg_one", text: "denied" }) }))).status).toBe(403);
  for (const [method, path] of [["POST", "/api/session"], ["POST", "/api/rpc/opencode.goal/get"], ["POST", "/api/session/ses_one/form"], ["PUT", "/api/session/ses_one/environment"], ["POST", "/api/session/ses_other/prompt"]]) {
    expect((await proxy(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${"o".repeat(32)}` }, body: "{}" }))).status).toBe(403);
  }
  body = { location: { directory }, data: [] };
  expect(await (await proxy(request("/api/plugin?location%5Bdirectory%5D=%2Fworkspace"))).json()).toEqual(body);
  body = { location: { directory }, data: [{ id: "foreign-plugin", token: "private" }] };
  expect((await proxy(request("/api/plugin"))).status).toBe(503);
  body = { status: "completed", secret: "discard" };
  expect(await (await proxy(request("/api/experimental/migration/v1"))).json()).toEqual({ status: "completed" });
  body = { status: "running" };
  expect((await proxy(request("/api/experimental/migration/v1"))).status).toBe(503);
  body = { location: { directory: "/other" }, data: [] };
  expect((await proxy(request("/api/fs/list"))).status).toBe(503);
  body = { directory, project: { directory, canonical: "/other", id: "project" } };
  expect((await proxy(request("/api/location"))).status).toBe(503);
  body = { directory, project: { directory, canonical: directory, id: "project", secret: "discard" } };
  expect(await (await proxy(request("/api/location"))).json()).toEqual({ directory, project: { directory, canonical: directory, id: "project" } });
});
