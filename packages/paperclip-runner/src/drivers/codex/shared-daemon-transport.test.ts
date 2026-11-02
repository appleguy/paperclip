import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createConnection } from "node:net";
import { SharedDaemonCodexAppServerTransport, sharedDaemonTransportFactory, type SharedDaemonIdentity, type SharedDaemonTransportOptions } from "./shared-daemon-transport.js";
import { FakeCodexTransport, makeDriver, WORKSPACE } from "./codex-app-server-driver.test-support.js";

const identity: SharedDaemonIdentity = {
  codexHome: "/tmp/test-codex-home", socketPath: "/tmp/socket-placeholder",
  cliVersion: "0.166.0", appServerVersion: "0.166.0", processGeneration: "test-generation",
  threadId: "thread-a", workspace: WORKSPACE, model: "test-model", effort: "medium",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(onRequest: (msg: Record<string, unknown>, socket: WebSocket) => void = (msg, socket) => socket.send(JSON.stringify({id:msg.id,result:{ok:true,thread:{id:"thread-a",cwd:WORKSPACE}}})), options: Partial<SharedDaemonTransportOptions> = {}) {
  const dir = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/ws-test-");
  const path = join(dir,"s");
  const server: Server = createServer();
  const wss = new WebSocketServer({server});
  const messages: Record<string, unknown>[] = [];
  let client: WebSocket | undefined;
  wss.on("connection", socket => { client = socket; socket.on("message", data => { const msg = JSON.parse(data.toString()) as Record<string, unknown>; messages.push(msg); if (msg.id !== undefined && msg.method) onRequest(msg,socket); }); });
  await new Promise<void>(resolve => server.listen(path,resolve));
  cleanups.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir,{recursive:true,force:true}); });
  const admit = vi.fn(async (_identity: Readonly<SharedDaemonIdentity>, _operation: {method:string; params:Readonly<Record<string, unknown>>}) => true);
  const transport = new SharedDaemonCodexAppServerTransport({identity:{...identity,socketPath:path},admit,timeoutMs:300,...options});
  cleanups.push(() => transport.close());
  return {transport,admit,messages,client:() => client!,path};
}

describe("shared daemon Codex transport", () => {
  it("uses the opt-in driver factory only for its exact persisted thread", () => {
    const factory = sharedDaemonTransportFactory({identity,admit:async () => true});
    expect(() => factory()).toThrow("matching persisted session");
    expect(() => factory({persistedSession:{driverSessionId:"foreign"}} as never)).toThrow("matching persisted session");
    expect(factory({persistedSession:{driverSessionId:"thread-a"}} as never)).toBeInstanceOf(SharedDaemonCodexAppServerTransport);
  });
  it("refuses new threads, mismatched thread/model/effort, and denied admission before connecting", async () => {
    const f = await fixture();
    await expect(f.transport.request("thread/start",{})).rejects.toThrow("exact thread");
    await expect(f.transport.request("thread/read",{threadId:"other"})).rejects.toThrow("thread mismatch");
    await expect(f.transport.request("turn/start",{threadId:"thread-a",model:"other"})).rejects.toThrow("model or effort");
    await expect(f.transport.request("turn/start",{threadId:"thread-a",cwd:"/other"})).rejects.toThrow("workspace mismatch");
    await expect(f.transport.request("thread/resume",{threadId:"thread-a",config:{"shell_environment_policy.set":{"TOKEN":"secret"}}})).rejects.toThrow("config not admitted");
    await expect(f.transport.request("thread/resume",{threadId:"thread-a",env:{TOKEN:"secret"}})).rejects.toThrow("parameter not admitted");
    f.admit.mockResolvedValue(false);
    await expect(f.transport.request("thread/read",{threadId:"thread-a"})).rejects.toThrow("admission denied");
    expect(f.messages).toEqual([]);
  });
  it("resumes the exact thread through the socket with fresh admission on connect and send", async () => {
    const f = await fixture();
    await expect(f.transport.request("thread/resume",{threadId:"thread-a",model:"test-model"})).resolves.toMatchObject({ok:true,thread:{id:"thread-a"}});
    expect(f.messages[0]).toMatchObject({method:"thread/resume",params:{threadId:"thread-a"}});
    expect(f.admit.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(f.admit.mock.calls[0]?.[0]).toMatchObject({threadId:"thread-a",processGeneration:"test-generation"});
  });
  it("recovers an existing driver session through the opt-in socket factory", async () => {
    const original = await makeDriver([new FakeCodexTransport("thread-a")]).openSession({
      runId:"test-run", normalizedSessionId:"test-session", workingDirectory:WORKSPACE,
    });
    const snapshot = await original.snapshot();
    await original.close({reason:"test checkpoint"});
    const provider = new FakeCodexTransport("thread-a");
    const f = await fixture((msg,socket) => {
      void provider.request(msg.method as string, msg.params as Record<string, unknown>)
        .then(result => socket.send(JSON.stringify({id:msg.id,result})));
    });
    const factory = sharedDaemonTransportFactory({identity:{...identity,socketPath:f.path},admit:async () => true});
    const recovered = await makeDriver([], {transportFactory:factory}).recoverSession(snapshot);
    expect(recovered.recovered).toBe(true);
    expect(f.messages.some(m => m.method === "thread/resume")).toBe(true);
    expect(f.messages.some(m => m.method === "thread/start")).toBe(false);
    await recovered.session!.close({reason:"test complete"});
  });
  it("rejects a provider response for a different thread", async () => {
    const f = await fixture((msg,socket) => socket.send(JSON.stringify({id:msg.id,result:{thread:{id:"other"}}})));
    await expect(f.transport.request("thread/resume",{threadId:"thread-a"})).rejects.toThrow("different thread");
  });
  it("rejects a provider response with a missing or foreign workspace", async () => {
    const f = await fixture((msg,socket) => socket.send(JSON.stringify({id:msg.id,result:{thread:{id:"thread-a",cwd:"/other"}}})));
    await expect(f.transport.request("thread/read",{threadId:"thread-a"})).rejects.toThrow("different workspace");
  });
  it("rejects an in-flight RPC when the socket closes and does not retry", async () => {
    const f = await fixture((_msg,socket) => socket.terminate());
    await expect(f.transport.request("thread/read",{threadId:"thread-a"})).rejects.toThrow("outcome may be unknown");
    expect(f.messages).toHaveLength(1);
    await expect(f.transport.request("thread/read",{threadId:"thread-a"})).rejects.toThrow();
  });
  it("closes only its own connection and leaves another client connected", async () => {
    const f = await fixture();
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const other = new WebSocket("ws://localhost", {createConnection:() => createConnection(f.path)});
    await new Promise<void>((resolve,reject) => { other.once("open",resolve); other.once("error",reject); });
    await f.transport.close();
    expect(other.readyState).toBe(WebSocket.OPEN);
    other.terminate();
  });
  it("fails closed after an RPC timeout", async () => {
    const f = await fixture(() => {});
    await expect(f.transport.request("thread/goal/set",{threadId:"thread-a",status:"paused"})).rejects.toThrow("timeout; outcome may be unknown");
    expect(f.messages).toHaveLength(1);
  });
  it("does not send a turn when admission refuses it", async () => {
    const f = await fixture();
    f.admit.mockImplementation(async (_identity, operation) => operation.method !== "turn/start");
    await expect(f.transport.request("turn/start",{threadId:"thread-a",effort:"medium"})).rejects.toThrow("admission denied");
    expect(f.messages).toEqual([]);
  });
  it("routes only exact-thread notifications and independently admits server requests", async () => {
    const f = await fixture();
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const handler = vi.fn(async () => ({decision:"accept"})); f.transport.setServerRequestHandler(handler);
    const next = f.transport.notifications()[Symbol.asyncIterator]().next();
    f.client().send(JSON.stringify({method:"item/updated",params:{threadId:"other"}}));
    f.client().send(JSON.stringify({method:"item/updated",params:{threadId:"thread-a",value:1}}));
    await expect(next).resolves.toMatchObject({value:{params:{threadId:"thread-a",value:1}}});
    f.client().send(JSON.stringify({id:"foreign-approval",method:"item/approval",params:{threadId:"other"}}));
    f.client().send(JSON.stringify({id:"unscoped-approval",method:"item/approval",params:{}}));
    f.client().send(JSON.stringify({id:"approval",method:"item/approval",params:{threadId:"thread-a"}}));
    await vi.waitFor(() => expect(f.messages.some(m => m.id === "approval")).toBe(true));
    expect(handler).toHaveBeenCalledOnce();
    expect(f.messages.some(m => m.id === "foreign-approval" || m.id === "unscoped-approval")).toBe(false);
    expect(f.messages.find(m => m.id === "approval")).toMatchObject({result:{decision:"accept"}});
  });
  it("keeps owner steering visible while holding managed writes until reconciliation", async () => {
    const reports = vi.fn();
    const f = await fixture(undefined, {classifyIntervention:async () => "owner", onControlGap:reports});
    f.admit.mockImplementation(async (_identity, operation) => operation.method !== "event:turn/started" && (operation.method !== "reconcile:managed-writes" || operation.params.receipt === "durable"));
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const next = f.transport.notifications()[Symbol.asyncIterator]().next();
    f.client().send(JSON.stringify({method:"turn/started",params:{threadId:"thread-a",turn:{id:"owner-turn"}}}));
    await expect(next).resolves.toMatchObject({value:{method:"turn/started",params:{turn:{id:"owner-turn"}}}});
    await vi.waitFor(() => expect(f.transport.controlGap()?.disposition).toBe("owner"));
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({disposition:"owner"}));
    expect(f.client().readyState).toBe(WebSocket.OPEN);
    await expect(f.transport.request("thread/read",{threadId:"thread-a"})).resolves.toBeDefined();
    await expect(f.transport.request("turn/start",{threadId:"thread-a"})).rejects.toThrow("managed writes held");
    await expect(f.transport.reconcileManagedWrites({receipt:"missing"})).rejects.toThrow("admission denied");
    await f.transport.reconcileManagedWrites({receipt:"durable"});
    expect(f.transport.controlGap()).toBeNull();
    await expect(f.transport.request("turn/start",{threadId:"thread-a"})).resolves.toBeDefined();
    expect(f.messages.some(m => m.method === "turn/interrupt" || m.method === "thread/goal/set")).toBe(false);
  });
  it("continues delivering events while origin classification is stalled", async () => {
    const f = await fixture();
    f.admit.mockImplementation(async (_identity, operation) => operation.method === "event:turn/started" ? new Promise<boolean>(() => {}) : true);
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const iterator = f.transport.notifications()[Symbol.asyncIterator]();
    f.client().send(JSON.stringify({method:"turn/started",params:{threadId:"thread-a"}}));
    f.client().send(JSON.stringify({method:"item/updated",params:{threadId:"thread-a",i:1}}));
    await expect(iterator.next()).resolves.toMatchObject({value:{method:"turn/started"}});
    await expect(iterator.next()).resolves.toMatchObject({value:{method:"item/updated"}});
    await expect(f.transport.request("turn/start",{threadId:"thread-a"})).rejects.toThrow("managed writes held");
  });
  it("does not restore writes when a newer intervention arrives during reconciliation", async () => {
    const f = await fixture();
    let finish!: (value:boolean) => void;
    f.admit.mockImplementation(async (_identity, operation) => {
      if (operation.method.startsWith("event:")) return false;
      if (operation.method === "reconcile:managed-writes") return new Promise<boolean>(resolve => {finish = resolve;});
      return true;
    });
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const iterator = f.transport.notifications()[Symbol.asyncIterator]();
    f.client().send(JSON.stringify({method:"turn/started",params:{threadId:"thread-a"}}));
    await iterator.next();
    const reconcile = f.transport.reconcileManagedWrites({receipt:"first"});
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.client().send(JSON.stringify({method:"thread/goal/cleared",params:{threadId:"thread-a"}}));
    await iterator.next();
    finish(true);
    await expect(reconcile).rejects.toThrow("gap changed");
    await expect(f.transport.request("turn/start",{threadId:"thread-a"})).rejects.toThrow("managed writes held");
  });
  it("rejects oversized frames rather than buffering an unbounded message", async () => {
    const f = await fixture();
    await f.transport.request("thread/read",{threadId:"thread-a"});
    const next = f.transport.notifications()[Symbol.asyncIterator]().next();
    f.client().send("x".repeat(1024 * 1024 + 1));
    await expect(next).rejects.toThrow("socket error");
  });
});
