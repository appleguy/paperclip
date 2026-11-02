import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createOpenCodeScopedProxy } from "./opencode-scoped-proxy.js";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

it.runIf(process.platform === "darwin")("records the pinned native TUI bootstrap against the scoped endpoint without a model turn", async () => {
  const workspace = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-tui-probe-");
  const token = "r".repeat(40), paths: string[] = [];
  const proxy = createOpenCodeScopedProxy({ sessionId: "ses_fixture", workspaceDirectory: workspace, readerToken: token, ownerToken: "o".repeat(40), read: async path => Response.json(path === "/api/info" ? { pid: process.pid, version: "2.2.5" } : path === "/api/location" ? { directory: workspace, project: { directory: workspace, canonical: workspace, id: "project_fixture" } } : path.startsWith("/api/fs/list") ? { location: { directory: workspace }, data: [{ path: "fixture.txt", type: "file" }, { path: "../outside", type: "file" }] } : path.startsWith("/api/plugin") ? { location: { directory: workspace }, data: [] } : { data: { id: "ses_fixture" } }), dispatch: async () => { throw new Error("unexpected_dispatch"); } });
  let notify!: () => void;
  const gotRequest = new Promise<void>(resolveRequest => { notify = resolveRequest; });
  const server = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      paths.push(`${req.method} ${parsed.pathname}${parsed.search ? `?${[...parsed.searchParams.keys()].sort().join(",")}` : ""}`); notify();
      const response = await proxy(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as HeadersInit }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  const requireRunner = createRequire(resolve(import.meta.dirname, "../../../../packages/paperclip-runner/package.json"));
  const pty = requireRunner("node-pty") as typeof import("node-pty");
  const terminals = [0, 1].map(() => pty.spawn("/opt/homebrew/bin/opencode", ["--server", `http://127.0.0.1:${port}`, "--session", "ses_fixture"], { cwd: workspace, cols: 100, rows: 30, env: { PATH: "/usr/bin:/bin", HOME: workspace, TERM: "xterm-256color", OPENCODE_PASSWORD: token } }));
  const exited = terminals.map(terminal => new Promise<void>(resolveExit => terminal.onExit(() => resolveExit())));
  try {
    await Promise.race([gotRequest, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_tui_no_request")), 8000))]);
    await new Promise(resolveWait => setTimeout(resolveWait, 1500));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some(path => path.startsWith("POST "))).toBe(false);
    expect(paths.filter(path => path === "GET /api/event").length).toBeGreaterThanOrEqual(2);
    const headers = { authorization: `Bearer ${token}` };
    const listing = await proxy(new Request("http://localhost/api/fs/list", { headers }));
    expect(await listing.json()).toEqual({ location: { directory: workspace }, data: [{ path: "fixture.txt", type: "file" }] });
    expect((await proxy(new Request("http://localhost/api/fs/list?location%5Bdirectory%5D=%2F", { headers }))).status).toBe(403);
    process.stdout.write(`native-tui-routes ${JSON.stringify([...new Set(paths)])}\n`);
  } finally {
    terminals.forEach(terminal => terminal.kill());
    await Promise.race([Promise.all(exited), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_tui_exit_unconfirmed")), 5000))]);
    server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}, 20_000);

it.runIf(process.platform === "darwin")("inspects pinned native TUI bootstrap read shapes without a model", async () => {
  const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-tui-schema-");
  for (const name of ["home", "config", "data", "cache", "state", "work"]) await mkdir(resolve(root, name));
  const password = "fixture-password", cwd = resolve(root, "work");
  await writeFile(resolve(cwd, "fixture.txt"), "fixture");
  const child = spawn("/opt/homebrew/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: resolve(root, "home"), XDG_CONFIG_HOME: resolve(root, "config"), XDG_DATA_HOME: resolve(root, "data"), XDG_CACHE_HOME: resolve(root, "cache"), XDG_STATE_HOME: resolve(root, "state"), OPENCODE_PASSWORD: password } });
  child.stderr.resume(); const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  try {
    const port = await new Promise<number>((resolvePort, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error("native_start_timeout")), 10_000); child.once("error", reject); child.once("exit", () => reject(new Error("native_start_failed"))); child.stdout.on("data", chunk => { buffer += String(chunk); const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); buffer = ""; resolvePort(Number(match[1])); child.stdout.resume(); } }); });
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    const output: Record<string, unknown> = {};
    for (const path of ["/api/location", "/api/fs/list", `/api/fs/list?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, "/api/config", `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, "/api/experimental/migration/v1"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(5000) });
      let body: any; try { body = await response.json(); } catch { body = null; }
      const data = body && typeof body === "object" ? body.data : undefined;
      output[path.split("?")[0] + (path.includes("?") ? "?directory" : "")] = { status: response.status, rootKeys: body && typeof body === "object" ? Object.keys(body).sort() : [], rootTypes: body && typeof body === "object" && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value])) : {}, projectKeys: body?.project && typeof body.project === "object" ? Object.keys(body.project).sort() : [], locationKeys: body?.location && typeof body.location === "object" ? Object.keys(body.location).sort() : [], dataArray: Array.isArray(data), firstEntryKeys: Array.isArray(data) && data[0] && typeof data[0] === "object" ? Object.keys(data[0]).sort() : [], dataKeys: data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).sort() : [] };
      Object.assign(output[path.split("?")[0] + (path.includes("?") ? "?directory" : "")] as object, { directoryExact: body?.directory === cwd || body?.location?.directory === cwd, projectDirectoryExact: body?.project?.directory === cwd, projectCanonicalType: typeof body?.project?.canonical, projectCanonicalExact: body?.project?.canonical === cwd, projectIdType: typeof body?.project?.id, fixtureType: Array.isArray(data) ? data.find((entry: any) => entry.path === "fixture.txt")?.type : undefined });
      if (path === "/api/experimental/migration/v1") Object.assign(output[path] as object, { statusValue: body?.status });
    }
    process.stdout.write(`native-tui-schema ${JSON.stringify(output)}\n`);
    expect(output["/api/location"]).toMatchObject({ status: 200 });
    const controller = new AbortController();
    const responses = await Promise.all([0, 1].map(() => fetch(`http://127.0.0.1:${port}/api/event`, { headers, signal: controller.signal })));
    const readers = responses.map(response => response.body!.getReader());
    const observed: any[][] = [[], []];
    const tasks = readers.map(async (reader, index) => { const decoder = new TextDecoder(); let buffer = ""; try { while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) if (line.startsWith("data:")) { try { observed[index]!.push(JSON.parse(line.slice(5))); } catch {} } } } catch {} });
    try {
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      expect(observed.every(events => events.some(event => event.type === "server.connected"))).toBe(true);
      const create = async () => { const response = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) }); expect(response.status).toBe(200); return (await response.json() as any).data.id as string; };
      const owned = await create(), foreign = await create();
      const accessed: string[] = [];
      const scopedToken = "t".repeat(40), rejected: string[] = [];
      const handler = createOpenCodeScopedProxy({ sessionId: owned, workspaceDirectory: cwd, readerToken: scopedToken, ownerToken: "o".repeat(40), attestEvent: async () => {}, read: async (path, signal) => { accessed.push(path.split("?")[0]!); const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal }); if (path.startsWith("/api/plugin")) { const body = await response.clone().json() as any; process.stdout.write(`native-plugin-observed ${JSON.stringify({ count: Array.isArray(body.data) ? body.data.length : null, entryKeys: body.data?.[0] ? Object.keys(body.data[0]).sort() : [], sample: body.data?.slice(0, 2), directoryExact: body.location?.directory === cwd })}\n`); } return response; }, dispatch: async () => { throw new Error("unexpected_dispatch"); } });
      const listener = createServer(async (req, res) => { try { const response = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as HeadersInit })); if (response.status >= 400) { const url = new URL(req.url!, "http://localhost"); if (url.pathname === "/api/session") process.stdout.write(`native-session-list-query ${JSON.stringify({ limit: url.searchParams.get("limit"), order: url.searchParams.get("order"), parent: url.searchParams.get("parentID") === owned ? "owned" : url.searchParams.get("parentID") })}\n`); rejected.push(`${req.method} ${url.pathname} ${response.status} ${[...url.searchParams.keys()].sort().join(",")}`); } res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res); else res.end(); } catch { res.writeHead(503).end(); } });
      await new Promise<void>(resolveListen => listener.listen(0, "127.0.0.1", resolveListen));
      const listenerOrigin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
      const requireRunner = createRequire(resolve(import.meta.dirname, "../../../../packages/paperclip-runner/package.json"));
      const pty = requireRunner("node-pty") as typeof import("node-pty");
      const terminals = [0, 1].map(() => pty.spawn("/opt/homebrew/bin/opencode", ["--server", listenerOrigin, "--session", owned], { cwd, cols: 120, rows: 40, env: { PATH: "/usr/bin:/bin", HOME: resolve(root, "home"), XDG_CONFIG_HOME: resolve(root, "config"), XDG_DATA_HOME: resolve(root, "data"), XDG_CACHE_HOME: resolve(root, "cache"), XDG_STATE_HOME: resolve(root, "state"), TERM: "xterm-256color", OPENCODE_PASSWORD: scopedToken } }));
      const outputText = ["", ""];
      const terminalExits = terminals.map((terminal, index) => { terminal.onData(data => { outputText[index] = (outputText[index] + data).slice(-500_000); }); return new Promise<void>(resolveExit => terminal.onExit(() => resolveExit())); });
      try {
        await new Promise(resolveWait => setTimeout(resolveWait, 3000));
        const rename = await fetch(`http://127.0.0.1:${port}/api/session/${owned}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "OWNED-TUI-RENAME-TEST" }), signal: AbortSignal.timeout(5000) });
        expect(rename.status).toBe(204);
        const foreignRename = await fetch(`http://127.0.0.1:${port}/api/session/${foreign}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "FOREIGN-TUI-SECRET" }), signal: AbortSignal.timeout(5000) });
        expect(foreignRename.status).toBe(204);
        await new Promise(resolveWait => setTimeout(resolveWait, 3000));
        expect(accessed.filter(path => path === `/api/session/${owned}`).length).toBeGreaterThanOrEqual(2);
        expect(accessed.filter(path => path === "/api/event").length).toBeGreaterThanOrEqual(2);
        expect(rejected.some(path => path.startsWith("GET /api/plugin 503"))).toBe(true);
        expect(outputText.map(value => value.includes("OWNED-TUI-RENAME-TEST"))).toEqual([true, true]);
        expect(outputText.map(value => value.includes("FOREIGN-TUI-SECRET"))).toEqual([false, false]);
        process.stdout.write(`native-tui-render ${JSON.stringify({ bothExactSessionReads: accessed.filter(path => path === `/api/session/${owned}`).length >= 2, bothEventSubscriptions: accessed.filter(path => path === "/api/event").length >= 2, rendered: outputText.map(value => value.includes("OWNED-TUI-RENAME-TEST")), upstreamPaths: [...new Set(accessed)], rejected: [...new Set(rejected)] })}\n`);
        process.stdout.write(`native-tui-screen ${JSON.stringify(outputText.map(value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").slice(-1800)))}\n`);
      } finally { terminals.forEach(terminal => terminal.kill()); await Promise.race([Promise.all(terminalExits), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_tui_exit_unconfirmed")), 5000))]); listener.closeAllConnections(); await new Promise<void>(resolveClose => listener.close(() => resolveClose())); }
      const scoped = createOpenCodeScopedProxy({ sessionId: owned, workspaceDirectory: cwd, readerToken: "r".repeat(40), ownerToken: "o".repeat(40), attestEvent: async () => {}, read: (path, signal) => fetch(`http://127.0.0.1:${port}${path}`, { headers, signal }), dispatch: async () => { throw new Error("unexpected_dispatch"); } });
      const scopedResponses = await Promise.all([0, 1].map(() => scoped(new Request("http://localhost/api/event", { headers: { authorization: `Bearer ${"r".repeat(40)}` } }))));
      const scopedReaders = scopedResponses.map(response => response.body!.getReader());
      const readRename = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { for (let count = 0; count < 4; count++) { const item = await reader.read(); const value = new TextDecoder().decode(item.value); if (value.includes('"session.renamed"')) return value; } throw new Error("rename_event_missing"); };
      const updates = await Promise.all([owned, foreign].map(id => fetch(`http://127.0.0.1:${port}/api/session/${id}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: id === owned ? "owned fixture" : "foreign fixture" }), signal: AbortSignal.timeout(5000) })));
      const projected = await Promise.all(scopedReaders.map(readRename));
      for (const data of projected) { expect(data).toContain("owned fixture"); expect(data).not.toContain("foreign fixture"); }
      await Promise.all(scopedReaders.map(reader => reader.cancel()));
      await fetch(`http://127.0.0.1:${port}/api/session/${owned}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "missed while disconnected" }), signal: AbortSignal.timeout(5000) });
      const reconnected = await scoped(new Request("http://localhost/api/event", { headers: { authorization: `Bearer ${"r".repeat(40)}` } }));
      const reconnectReader = reconnected.body!.getReader();
      await fetch(`http://127.0.0.1:${port}/api/session/${owned}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "after reconnect" }), signal: AbortSignal.timeout(5000) });
      const afterReconnect = await readRename(reconnectReader);
      expect(afterReconnect).toContain("after reconnect");
      expect(afterReconnect).not.toContain("missed while disconnected");
      await reconnectReader.cancel();
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
      const shapes = observed.map(events => events.map(event => ({ type: event.type, keys: Object.keys(event).sort(), dataKeys: event.data && typeof event.data === "object" ? Object.keys(event.data).sort() : [], infoKeys: event.data?.info && typeof event.data.info === "object" ? Object.keys(event.data.info).sort() : [], scope: JSON.stringify(event).includes(owned) ? "owned" : JSON.stringify(event).includes(foreign) ? "foreign" : "unscoped" })));
      process.stdout.write(`native-observer-shapes ${JSON.stringify({ updates: updates.map(update => update.status), shapes })}\n`);
      const sample = observed[0]!.find(event => event.type === "session.created" && event.data?.sessionID === owned);
      const renamed = observed[0]!.find(event => event.type === "session.renamed" && event.data?.sessionID === owned);
      process.stdout.write(`native-event-types ${JSON.stringify({ created: Object.fromEntries(Object.entries(sample ?? {}).map(([k, v]) => [k, typeof v])), data: Object.fromEntries(Object.entries(sample?.data ?? {}).map(([k, v]) => [k, typeof v])), location: sample?.location, dataLocation: sample?.data?.location, renamed: Object.fromEntries(Object.entries(renamed ?? {}).map(([k, v]) => [k, typeof v])) })}\n`);
    } finally { controller.abort(); await Promise.all(tasks); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_exit_unconfirmed")), 5000))]); }
}, 30_000);
