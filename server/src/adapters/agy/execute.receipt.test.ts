import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const transport = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: transport.exec,
}));
import { execute, receiptFilePath } from "./execute.js";

const ROOT = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const RUN = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const URL = "https://antigravity.google.com/r/probe-v2";
const conversation = "33333333-3333-4333-8333-333333333333";
const screen = (editor = ">") => [
  `${URL}?p=c%2F${conversation}`, "Working...", "────────────", editor,
  "────────────", "esc to cancel", "agy working",
].join("\n");
const receipt = (runId = RUN, issueId = "probe") => ({
  runId, issueId, status: "done", summary: "finished the busy wake",
  report: "Validated the busy wake and receipt-scoped completion. ".repeat(8),
});

describe("agy busy dispatch and receipt completion", () => {
  let dir: string;
  let submitted: string[];
  let capture: string;
  let api: Mock<(url: string, init: RequestInit) => Promise<Response>>;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(ROOT, "agy-receipt-test-"));
    submitted = [];
    capture = screen();
    transport.exec.mockImplementation((_command, args, _options, callback) => {
      void (async () => {
        if (args.includes("load-buffer")) submitted.push(await fs.readFile(args.at(-1), "utf8"));
        // Any native input is queued; after Enter the owner starts another draft.
        if (args.includes("send-keys")) capture = screen("> owner typing while the receipt arrives");
        const stdout = args.includes("capture-pane") ? capture : args.includes("display-message") ? "agy\n" : "";
        callback(null, { stdout, stderr: "" });
      })().catch(callback);
    });
    const reports = new Map<string, unknown>();
    const statuses = new Map<string, string>();
    api = vi.fn(async (url: string, init: RequestInit) => {
      const route = new globalThis.URL(url).pathname;
      if (route.endsWith("/documents/report")) {
        if (init.method === "PUT") reports.set(route, { ...JSON.parse(String(init.body)), latestRevisionId: "rev" });
        return reports.has(route) ? Response.json(reports.get(route)) : new Response(null, { status: 404 });
      }
      if (init.method === "PATCH") statuses.set(route, "done");
      return Response.json({ status: statuses.get(route) ?? "in_progress" });
    });
    vi.stubGlobal("fetch", api);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
    transport.exec.mockReset();
  });
  const context = (stateDir: string) => ({
    runId: RUN, authToken: "test-scoped-token", agent: { id: "probe", companyId: "probe", name: "probe" },
    config: { stateDir, cwd: ROOT, timeoutSec: 30, promptTemplate: "Complete the probe." },
    context: { issueId: "probe" }, onLog: vi.fn(), onDispatch: vi.fn(),
  }) as unknown as AdapterExecutionContext;

  it("delivers into a busy conversation without statusLine or /new and completes on its receipt", async () => {
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    const ctx = context(dir);
    const result = await execute(ctx);
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain("Paperclip run");
    expect(submitted[0]).not.toMatch(/\/new|\/remote-control/);
    expect(api.mock.calls.map((args) => (args[1] as RequestInit).method)).toEqual(["GET", "PUT", "GET", "PATCH"]);
    expect(JSON.parse(String((api.mock.calls[3]![1] as RequestInit).body))).toEqual({ status: "done" });
    expect(result.resultJson).toMatchObject({ issueClosed: true, issueStatus: "done", reviewPending: false });
    await expect(fs.stat(path.join(dir, "active.json"))).rejects.toThrow();
  });

  it("refuses an owner draft before dispatch without creating a checkpoint", async () => {
    capture = screen("> unfinished owner draft");
    const result = await execute(context(dir));
    expect(result.errorFamily).toBe("target_busy");
    expect(submitted).toEqual([]);
    expect(api).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, "active.json"))).rejects.toThrow();
  });

  it("reports review-wait and reuses the receipt without another PATCH or provider dispatch", async () => {
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    let status = "in_progress";
    const handler = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init: RequestInit) => {
      if (!new globalThis.URL(url).pathname.endsWith("/documents/report")) {
        if (init.method === "PATCH") status = "in_review";
        return Response.json({ status });
      }
      return handler(url, init);
    });
    const ctx = context(dir);
    const first = await execute(ctx);
    expect(first).toMatchObject({ exitCode: 0, resultJson: { issueClosed: false, issueStatus: "in_review", reviewPending: true } });
    expect(ctx.onLog).not.toHaveBeenCalledWith("stdout", expect.stringContaining("[agy] Done"));
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(RUN);
    const second = await execute(context(dir));
    expect(second.resultJson).toMatchObject({ issueClosed: false, reviewPending: true });
    expect(submitted).toHaveLength(1);
    expect(api.mock.calls.filter(args => args[1].method === "PATCH")).toHaveLength(1);
    expect(api.mock.calls.filter(args => args[1].method === "PUT")).toHaveLength(1);
    status = "done";
    expect((await execute(context(dir))).resultJson).toMatchObject({ issueClosed: true, reviewPending: false });
    await expect(fs.stat(path.join(dir, "active.json"))).rejects.toThrow();
    expect(submitted).toHaveLength(1);
  });

  it.each(["", "{", "null", "{}", '{"status":"in_progress"}'])("retains a checkpoint on an invalid success acknowledgement: %j", async body => {
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    const handler = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init: RequestInit) =>
      init.method === "PATCH" ? new Response(body) : handler(url, init));
    const result = await execute(context(dir));
    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.issueClosed).not.toBe(true);
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(RUN);
    expect((await execute(context(dir))).exitCode).toBe(1);
    expect(api.mock.calls.filter(args => args[1].method === "PATCH")).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it.each(["", "{", "null", "{}"])("does not close an issue after an invalid report acknowledgement: %j", async body => {
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    const handler = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init: RequestInit) =>
      init.method === "PUT" ? new Response(body) : handler(url, init));
    expect((await execute(context(dir))).exitCode).toBe(1);
    expect(api.mock.calls.some(args => args[1].method === "PATCH")).toBe(false);
    await fs.stat(path.join(dir, "active.json"));
  });

  it("refuses rotation without positive idle evidence and preserves the conversation", async () => {
    const ctx = context(dir);
    ctx.evaluateSessionPrompt = vi.fn(async () => ({ rotate: true, reason: "peak plus prompt", handoffMarkdown: "Unfinished" }));
    const result = await execute(ctx);
    expect(result.errorFamily).toBe("target_busy");
    expect(submitted).toEqual([]);
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, "active.json"))).rejects.toThrow();
  });

  it("rotates only an attested idle conversation and sends the fresh handoff", async () => {
    const ctx = context(dir);
    ctx.runtime = { sessionId: conversation, sessionParams: { sessionId: conversation }, sessionDisplayId: conversation, taskKey: "probe" };
    ctx.evaluateSessionPrompt = vi.fn(async () => ({ rotate: true, reason: "peak plus prompt", handoffMarkdown: "Unfinished rotation marker" }));
    await fs.writeFile(path.join(dir, "status-line.json"), JSON.stringify({
      agentState: "idle", observedAt: new Date().toISOString(), conversationId: conversation,
      pendingInputCount: 0, toolConfirmationPending: false,
    }));
    const next = "44444444-4444-4444-8444-444444444444";
    const original = transport.exec.getMockImplementation()!;
    transport.exec.mockImplementation((command, args, options, callback) => original(command, args, options,
      (error: unknown, output: unknown) => {
        if (args.includes("send-keys") && submitted.at(-1) === "/new") capture = screen().replaceAll(conversation, next);
        callback(error, output);
      }));
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 0, sessionId: next });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toBe("/new");
    expect(submitted[1]).toContain("Unfinished rotation marker");
  });

  it("adopts an old same-issue checkpoint without redispatch or an editor gate", async () => {
    const active = {
      runId: OLD, issueId: "probe", receiptPath: receiptFilePath(dir, OLD), rcUrl: URL,
      conversationId: conversation, startedAt: "2000-01-01T00:00:00Z",
    };
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(active));
    await fs.writeFile(active.receiptPath, JSON.stringify(receipt(OLD)));
    capture = screen("> owner draft");
    const result = await execute(context(dir));
    expect(result.exitCode).toBe(0);
    expect(submitted).toEqual([]);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("reattaches the exact run checkpoint without submitting another prompt", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({
      runId: RUN, issueId: "probe", receiptPath: receiptFilePath(dir, RUN), rcUrl: URL, conversationId: conversation,
    }));
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    const ctx = context(dir);
    ctx.context.paperclipRestartReattach = true;
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(submitted).toEqual([]);
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
  });

  it.each(["missing", "other run"])("does not submit on restart when the checkpoint is %s", async (kind) => {
    if (kind === "other run") await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({
      runId: OLD, issueId: "probe", receiptPath: receiptFilePath(dir, OLD), rcUrl: URL,
    }));
    const ctx = context(dir);
    ctx.context.paperclipRestartReattach = true;
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(/restart checkpoint/);
    expect(result.executionRecovery).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });

  it("settles a foreign receipt while busy, then dispatches the current wake", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({
      runId: OLD, issueId: "previous", receiptPath: receiptFilePath(dir, OLD), rcUrl: URL,
    }));
    await fs.writeFile(receiptFilePath(dir, OLD), JSON.stringify(receipt(OLD, "previous")));
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    expect((await execute(context(dir))).exitCode).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(8);
  });

  it("keeps an old receiptless checkpoint even with an empty editor", async () => {
    const active = {
      runId: OLD, issueId: "probe", receiptPath: receiptFilePath(dir, OLD), rcUrl: URL,
      startedAt: "2000-01-01T00:00:00Z",
    };
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(active));
    const ctx = context(dir);
    ctx.signal = AbortSignal.abort();
    const result = await execute(ctx);
    expect(result.errorMessage).toContain("cancelled");
    expect(submitted).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "active.json"), "utf8"))).toEqual(active);
  });
});
