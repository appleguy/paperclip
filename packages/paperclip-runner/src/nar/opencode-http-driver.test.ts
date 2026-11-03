// NAR OpenCode HTTP driver conformance against an in-memory fake of the v2.2.5 session API.
// No network, no model calls. Live proof is separate (owned runs on the GLM/DeepSeek lanes).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OpenCodeHttpDriver, OpenCodeHttpError, messageIdFor, parseModelRef, parseSse, sessionIdFor, sessionTitleFor } from "../../../adapters/opencode-local/src/server/nar/opencode-http-driver.js";

const URL0 = "http://127.0.0.1:19403";
const PW = `pw-${randomBytes(9).toString("hex")}`;
const pwFile = join(mkdtempSync(join(tmpdir(), "nar-oc-")), "password");
writeFileSync(pwFile, PW + "\n");
const FENCE = { runId: "r1", leaseGeneration: 1, hostEpoch: 4242 };
const H = { provider: "opencode" as const, hostEpoch: 4242, attested: true, detail: {} };

type Ev = { type: string; data?: any };
class FakeServer {
  version = "2.2.5";
  pid = 4242;
  urls = [URL0 + "/"];
  sessions = new Map<string, { info: any; log: { id: string; type: string; data: any; seq: number }[]; inbox: Set<string>; msgs: Map<string, number>; active: boolean }>();
  publicLog = true; // false = 2.2.5 behaviour: only the log.synced watermark is served
  clock = 1_000;
  deliver(c: string) { const s = this.sessions.get(c)!; s.inbox.clear(); s.active = true; s.info.time.busy = this.clock++; }
  finish(c: string, outcome = "succeeded") { const s = this.sessions.get(c)!; s.active = false; s.info.time.idle = this.clock++; s.info.outcome = outcome; }
  calls: { method: string; path: string; body?: any }[] = [];
  seq = 0;
  hidden = 0; // non-public durable events that bump seq but are not served
  fail?: (method: string, path: string) => "transport" | number | undefined;
  promptStatus?: number;
  fetch = async (input: any, init: any): Promise<Response> => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: u.pathname + u.search, body });
    if (init?.headers?.authorization !== "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")) return new Response("", { status: 401 });
    const f = this.fail?.(method, u.pathname);
    if (f === "transport") throw new TypeError("fetch failed: socket hang up");
    if (typeof f === "number") return new Response("{}", { status: f });
    const j = (s: number, d: unknown) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
    const p = u.pathname;
    if (p === "/api/info") return j(200, { version: this.version, pid: this.pid, hostname: "h", urls: this.urls });
    if (p === "/api/session" && method === "POST") {
      if (!String(body.id).startsWith("ses")) return j(400, {});
      if (this.sessions.has(body.id)) return j(409, {});
      this.sessions.set(body.id, { info: { id: body.id, title: body.title, location: body.location, model: body.model, time: { created: this.clock++ } }, log: [], inbox: new Set(), msgs: new Map(), active: false });
      return j(200, { data: this.sessions.get(body.id)!.info });
    }
    if (p === "/api/session/active") {
      return j(200, { data: Object.fromEntries([...this.sessions].filter(([, s]) => s.active).map(([id]) => [id, { type: "running" }])) });
    }
    let m = p.match(/^\/api\/session\/([^/]+)$/);
    if (m && method === "PATCH") {
      const s = this.sessions.get(decodeURIComponent(m[1]));
      if (!s) return j(404, {});
      if (typeof body.title === "string") s.info.title = body.title;
      return new Response(null, { status: 204 });
    }
    if (m) { const s = this.sessions.get(decodeURIComponent(m[1])); return s ? j(200, { data: s.info }) : j(404, {}); }
    m = p.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (m) {
      const s = this.sessions.get(decodeURIComponent(m[1]));
      if (!s) return j(404, {});
      if (this.promptStatus) return j(this.promptStatus, {});
      if (!s.msgs.has(body.id)) { s.inbox.add(body.id); s.msgs.set(body.id, this.clock++); this.emit(m[1], { type: "session.inbox.enqueued", data: { inboxID: body.id } }); }
      return j(200, { data: { id: body.id, type: "user", text: body.text } }); // idempotent by msg id
    }
    m = p.match(/^\/api\/session\/([^/]+)\/inbox$/);
    if (m) { const s = this.sessions.get(decodeURIComponent(m[1])); return j(200, { data: [...(s?.inbox ?? [])].map((id) => ({ id })) }); }
    m = p.match(/^\/api\/session\/([^/]+)\/message\/([^/]+)$/);
    if (m) {
      const created = this.sessions.get(decodeURIComponent(m[1]))?.msgs.get(decodeURIComponent(m[2]));
      return created === undefined ? j(404, { _tag: "MessageNotFoundError" }) : j(200, { data: { id: decodeURIComponent(m[2]), type: "user", time: { created } } });
    }
    m = p.match(/^\/api\/session\/([^/]+)\/interrupt$/);
    if (m) return j(200, { interrupted: true });
    m = p.match(/^\/api\/experimental\/session\/([^/]+)\/log$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const s = this.sessions.get(id);
      if (!s) return j(404, {});
      const after = Number(u.searchParams.get("after") ?? -1);
      const frames = s.log.filter((e) => this.publicLog && e.seq > after).map((e) => ({ id: e.id, type: e.type, created: 0, data: e.data, durable: { aggregateID: id, seq: e.seq, version: 1 } }));
      frames.push({ type: "log.synced", aggregateID: id, seq: this.seq } as any);
      return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return j(404, {});
  };
  emit(sessionId: string, e: Ev, hidden = 0) {
    const s = this.sessions.get(decodeURIComponent(sessionId))!;
    this.seq += hidden; // non-public events in between
    this.seq += 1;
    s.log.push({ id: `evt_${this.seq}`, type: e.type, data: e.data ?? {}, seq: this.seq });
  }
}

const mk = (srv: FakeServer, extra: Record<string, unknown> = {}) =>
  new OpenCodeHttpDriver({ url: URL0, passwordFile: pwFile, fetchImpl: srv.fetch as any, now: () => "T", ...extra });
const scope = { agentId: "agent-a", issueId: "SCO-1", cwd: "/w/sco-1", model: "maya-metal/glm-5.3#medium" };
const op = (n: number) => ({ opId: `op-${n}`, kind: "prompt" as const, payloadSha256: "x", text: `do ${n}` });
async function codeOf(p: Promise<unknown>) { try { await p; return "ok"; } catch (e) { return e instanceof OpenCodeHttpError ? e.code : "other"; } }

describe("OpenCode v2.2.5 driver: host attestation", () => {
  it("attests the authenticated /api/info identity; epoch is the server pid", async () => {
    const h = await mk(new FakeServer()).attestHost("a");
    expect(h).toMatchObject({ provider: "opencode", hostEpoch: 4242, attested: true, detail: { version: "2.2.5", pid: 4242 } });
  });
  it("refuses unqualified versions, wrong pid, foreign url, bad auth and create", async () => {
    const s = new FakeServer(); s.version = "1.18.34";
    expect(await codeOf(mk(s).attestHost("a"))).toBe("unqualified");
    expect(await codeOf(mk(new FakeServer(), { expectedPid: 7 }).attestHost("a"))).toBe("mismatch");
    const f = new FakeServer(); f.urls = ["http://127.0.0.1:19402/"];
    expect(await codeOf(mk(f).attestHost("a"))).toBe("mismatch");
    const bad = join(mkdtempSync(join(tmpdir(), "nar-oc-")), "pw"); writeFileSync(bad, "nope");
    expect(await codeOf(mk(new FakeServer(), { passwordFile: bad }).attestHost("a"))).toBe("auth");
    expect(await codeOf(mk(new FakeServer()).attestHost("a", { create: true }))).toBe("unqualified");
  });
  it("is loopback-only", () => {
    expect(() => new OpenCodeHttpDriver({ url: "http://10.0.0.5:19403", passwordFile: pwFile })).toThrow(OpenCodeHttpError);
    expect(() => new OpenCodeHttpDriver({ url: "https://127.0.0.1:19403", passwordFile: pwFile })).toThrow(OpenCodeHttpError);
  });
});

describe("OpenCode v2.2.5 driver: conversation binding", () => {
  it("creates one deterministic session per agent+issue and re-binds it after a lost reply", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const a = await d.bindConversation(H, scope, "new", FENCE);
    expect(a.conversationId).toBe(sessionIdFor(scope));
    expect(a).toMatchObject({ cwd: "/w/sco-1", model: "maya-metal/glm-5.3#medium" });
    const b = await d.bindConversation(H, scope, "new", FENCE); // 409 -> read-back
    expect(b.conversationId).toBe(a.conversationId);
    expect(s.sessions.size).toBe(1);
    expect(sessionIdFor({ agentId: "agent-a", issueId: "SCO-2" })).not.toBe(a.conversationId);
  });
  it("titles a new session with the issue and retitles an older placeholder on resume", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const id = sessionIdFor(scope);
    await d.bindConversation(H, scope, "new", FENCE); // no wake context: placeholder
    expect(s.sessions.get(id)!.info.title).toBe(`Paperclip ${scope.issueId}`);
    const titled = { ...scope, title: "SCO-12 Fix the thing" };
    await d.bindConversation(H, titled, "new", FENCE); // 409 -> read-back -> PATCH
    expect(s.sessions.get(id)!.info.title).toBe("SCO-12 Fix the thing");
    const patches = () => s.calls.filter((c) => c.method === "PATCH").length;
    expect(patches()).toBe(1);
    await d.bindConversation(H, titled, "new", FENCE); // already right: no PATCH
    expect(patches()).toBe(1);
    await d.bindConversation(H, { ...scope, title: "SCO-12 Renamed issue" }, "new", FENCE); // own earlier title tracks the issue
    expect(s.sessions.get(id)!.info.title).toBe("SCO-12 Renamed issue");
    await d.bindConversation(H, scope, "new", FENCE); // no title given: untouched
    expect(s.sessions.get(id)!.info.title).toBe("SCO-12 Renamed issue");
    s.sessions.get(id)!.info.title = "my own name";
    await d.bindConversation(H, titled, "new", FENCE); // owner-set title is never overwritten
    expect(s.sessions.get(id)!.info.title).toBe("my own name");
  });
  it("creates a session straight with the issue title and survives a failed retitle", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const t = { ...scope, issueId: "SCO-9", title: sessionTitleFor("SCO-9", "  Long\n title ") };
    await d.bindConversation(H, t, "new", FENCE);
    expect(s.sessions.get(sessionIdFor(t))!.info.title).toBe("SCO-9 Long title");
    s.sessions.get(sessionIdFor(t))!.info.title = "Paperclip SCO-9";
    s.fail = (method) => (method === "PATCH" ? 500 : undefined);
    expect((await d.bindConversation(H, t, "new", FENCE)).conversationId).toBe(sessionIdFor(t)); // PATCH 500 is advisory
    expect(sessionTitleFor("", "x")).toBeUndefined();
    expect(sessionTitleFor("SCO-1", "y".repeat(300))!.length).toBe(120);
  });
  it("rejects a session whose cwd or model differs", async () => {
    const s = new FakeServer();
    await mk(s).bindConversation(H, scope, "new", FENCE);
    expect(await codeOf(mk(s).bindConversation(H, { ...scope, cwd: "/elsewhere" }, "resume", FENCE))).toBe("mismatch");
    expect(await codeOf(mk(s).bindConversation(H, { ...scope, model: "x/y" }, "resume", FENCE))).toBe("mismatch");
    expect(await codeOf(mk(s).bindConversation(H, scope, "resume", FENCE, "ses_missing"))).toBe("http");
  });
  it("parses provider/model#variant with slashes in the model id", () => {
    expect(parseModelRef("native-fleet/wrx80/deepseek-v4.1#medium")).toEqual({ providerID: "native-fleet", id: "wrx80/deepseek-v4.1", variant: "medium" });
    expect(() => parseModelRef("nomodel")).toThrow(OpenCodeHttpError);
  });
});

describe("OpenCode v2.2.5 driver: submit (one send, idempotent by message id)", () => {
  it("grades durable admission accepted_provider and a resubmit admits nothing new", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    expect((await d.submit(H, c, op(1), FENCE)).grade).toBe("accepted_provider");
    expect((await d.submit(H, c, op(1), FENCE)).grade).toBe("accepted_provider");
    expect([...s.sessions.get(c)!.inbox]).toEqual([messageIdFor("op-1")]);
    expect(s.sessions.get(c)!.log.filter((e) => e.type === "session.inbox.enqueued")).toHaveLength(1);
  });
  it("never retries: a transport failure is outcome_unknown after exactly one POST", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    s.fail = (m, p) => (m === "POST" && p.endsWith("/prompt") ? "transport" : undefined);
    const r = await d.submit(H, c, op(2), FENCE);
    expect(r.grade).toBe("outcome_unknown");
    expect(s.calls.filter((x) => x.method === "POST" && x.path.endsWith("/prompt"))).toHaveLength(1);
  });
  it("5xx is outcome_unknown; 4xx and auth are rejections; non-prompt ops are refused", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    s.promptStatus = 503;
    expect((await d.submit(H, c, op(3), FENCE)).grade).toBe("outcome_unknown");
    s.promptStatus = 400;
    expect(await codeOf(d.submit(H, c, op(4), FENCE))).toBe("http");
    s.promptStatus = undefined;
    s.fail = (m, p) => (p.endsWith("/prompt") ? 401 : undefined);
    expect(await codeOf(d.submit(H, c, op(5), FENCE))).toBe("auth");
    expect(await codeOf(d.submit(H, c, { ...op(6), kind: "interrupt" as any }, FENCE))).toBe("unqualified");
  });
  it("never leaks the password into evidence or errors", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    s.fail = () => "transport";
    const r = await d.submit(H, c, op(7), FENCE);
    expect(JSON.stringify(r)).not.toContain(PW);
    const e = await mk(s).attestHost("a").catch((x) => x);
    expect(String(e?.message)).not.toContain(PW);
  });
});

describe("OpenCode v2.2.5 driver: observe and outcome", () => {
  it("replays the durable log, maps ops, and advances the cursor to the watermark", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    await d.submit(H, c, op(1), FENCE);
    s.emit(c, { type: "session.execution.started" }, 3);
    const o = await d.observe(c);
    expect(o.coverage).toBe("complete");
    expect(o.events.map((e) => e.kind)).toEqual(["session.inbox.enqueued", "session.execution.started"]);
    expect(o.events[0].opId).toBe("op-1");
    expect(o.next).toBe(String(s.seq));
    s.seq += 5; // only hidden events since
    const o2 = await d.observe(c, o.next);
    expect(o2.events).toHaveLength(0);
    expect(o2.next).toBe(String(s.seq));
  });
  it("rejects foreign or regressing log items and reports incomplete without a watermark", async () => {
    const mkResp = (frames: any[]) => async () => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { status: 200 });
    const d = (frames: any[]) => new OpenCodeHttpDriver({ url: URL0, passwordFile: pwFile, fetchImpl: mkResp(frames) as any });
    const ev = (seq: number, agg = "ses_a") => ({ id: `evt_${seq}`, type: "x", data: {}, durable: { aggregateID: agg, seq, version: 1 } });
    expect(await codeOf(d([ev(1, "ses_b")]).observe("ses_a"))).toBe("mismatch");
    expect(await codeOf(d([ev(2), ev(2)]).observe("ses_a"))).toBe("mismatch");
    expect(await codeOf(d([{ type: "log.synced", aggregateID: "ses_b", seq: 1 }]).observe("ses_a"))).toBe("mismatch");
    expect((await d([ev(1)]).observe("ses_a")).coverage).toBe("incomplete");
    expect(() => parseSse("data: {nope\n\n")).toThrow(OpenCodeHttpError);
  });
  it("readOutcome: unknown -> working -> hook_observed, never receipted", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    expect(await d.readOutcome(c, "op-9")).toBe("unknown");
    await d.submit(H, c, op(9), FENCE);
    expect(await d.readOutcome(c, "op-9")).toBe("working");
    s.emit(c, { type: "session.execution.started" });
    expect(await d.readOutcome(c, "op-9")).toBe("working");
    s.emit(c, { type: "session.execution.succeeded" });
    expect(await d.readOutcome(c, "op-9")).toBe("hook_observed");
    expect(await mk(s).interrupt(c, op(9), FENCE)).toBe("requested");
  });
  it("2.2.5 hidden log: settles from projected state (inbox drained, inactive, idle after the message)", async () => {
    const s = new FakeServer();
    s.publicLog = false;
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    expect(await d.readOutcome(c, "op-1")).toBe("unknown");
    await d.submit(H, c, op(1), FENCE);
    expect((await d.observe(c)).events).toHaveLength(0);
    expect(await d.readOutcome(c, "op-1")).toBe("working"); // pending in inbox
    s.deliver(c);
    expect(await d.readOutcome(c, "op-1")).toBe("working"); // running
    s.finish(c);
    expect(await d.readOutcome(c, "op-1")).toBe("hook_observed");
    // A later op is not settled by the earlier idle.
    await d.submit(H, c, op(2), FENCE);
    s.deliver(c);
    expect(await d.readOutcome(c, "op-2")).toBe("working");
    s.finish(c, "interrupted");
    expect(await d.readOutcome(c, "op-2")).toBe("hook_observed");
    expect(await d.readOutcome(c, "op-1")).toBe("hook_observed");
  });
  it("2.2.5 hidden log: an unreadable state source never settles", async () => {
    const s = new FakeServer();
    s.publicLog = false;
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    await d.submit(H, c, op(1), FENCE);
    s.deliver(c);
    s.finish(c);
    s.fail = (_m, p) => (p === "/api/session/active" ? 500 : undefined);
    expect(await d.readOutcome(c, "op-1")).toBe("working");
    s.fail = (_m, p) => (p.endsWith("/inbox") ? "transport" : undefined);
    expect(await d.readOutcome(c, "op-1")).toBe("unknown");
  });
  it("a terminal event before the op was admitted does not settle it", async () => {
    const s = new FakeServer();
    const d = mk(s);
    const { conversationId: c } = await d.bindConversation(H, scope, "new", FENCE);
    s.emit(c, { type: "session.execution.succeeded" });
    await d.submit(H, c, op(10), FENCE);
    expect(await d.readOutcome(c, "op-10")).toBe("working");
  });
});
