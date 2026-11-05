import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let api: ReturnType<typeof vi.fn>;
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
    api = vi.fn(async () => new Response("{}", { status: 200 }));
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
    expect(result.exitCode).toBe(0);
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain("Paperclip run");
    expect(submitted[0]).not.toMatch(/\/new|\/remote-control/);
    expect(api.mock.calls.map((args) => (args[1] as RequestInit).method)).toEqual(["GET", "PUT", "PATCH"]);
    expect(JSON.parse(String((api.mock.calls[2]![1] as RequestInit).body))).toEqual({ status: "done" });
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
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("settles a foreign receipt while busy, then dispatches the current wake", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({
      runId: OLD, issueId: "previous", receiptPath: receiptFilePath(dir, OLD), rcUrl: URL,
    }));
    await fs.writeFile(receiptFilePath(dir, OLD), JSON.stringify(receipt(OLD, "previous")));
    await fs.writeFile(receiptFilePath(dir, RUN), JSON.stringify(receipt()));
    expect((await execute(context(dir))).exitCode).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(6);
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
