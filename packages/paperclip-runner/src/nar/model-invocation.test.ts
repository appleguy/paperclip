import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { invokeIsolatedModel, type IsolatedModelProvider } from "./model-invocation.js";

const request = { family: "luna", role: "author", authorFamily: "luna", prompt: "private prompt",
  workingDirectory: "/work", schemaPath: "/work/schema.json", responsePath: "/work/result.json",
  freshContext: true, toolsDisabled: true };
const root = "/Volumes/NVM/AI_Agent_Runtime/tmp";

it("reserves durably before sending and never replays after an uncertain failure", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const invoke = vi.fn(async () => { throw new Error("connection lost"); });
  const provider: IsolatedModelProvider = { family: "luna", invokeFreshToolsOff: invoke };
  const input = { request, operationId: "attempt-1", journalDirectory: dir, provider,
    signal: new AbortController().signal, validateResponse: () => {} };
  try {
    await expect(invokeIsolatedModel(input)).rejects.toThrow("connection lost");
    await expect(invokeIsolatedModel(input)).rejects.toThrow("reconcile");
    expect(invoke).toHaveBeenCalledTimes(1);
    const stored = await readFile(join(dir, (await readdir(dir))[0]!), "utf8");
    expect(stored).not.toContain(request.prompt);
    await expect(invokeIsolatedModel({ ...input, request: { ...request, prompt: "changed" } })).rejects.toThrow("conflict");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("does not dispatch a pre-cancelled, self-critic or mismatched request", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const invoke = vi.fn(async () => ({ response: "{}" }));
  const provider: IsolatedModelProvider = { family: "luna", invokeFreshToolsOff: invoke };
  const controller = new AbortController(); controller.abort();
  const input = { request, operationId: "attempt-2", journalDirectory: dir, provider,
    signal: controller.signal, validateResponse: () => {} };
  try {
    await expect(invokeIsolatedModel(input)).rejects.toThrow();
    await expect(invokeIsolatedModel({ ...input, signal: new AbortController().signal, request: { ...request, role: "critic" } })).rejects.toThrow("self-family");
    await expect(invokeIsolatedModel({ ...input, signal: new AbortController().signal, provider: { ...provider, family: "sonnet" } })).rejects.toThrow("family mismatch");
    expect(invoke).not.toHaveBeenCalled();
    expect(await readdir(dir)).toHaveLength(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("returns validated structured text and explicitly unknown usage", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const provider: IsolatedModelProvider = { family: "luna", invokeFreshToolsOff: async () => ({ response: '{"ok":true}' }) };
  try {
    const result = await invokeIsolatedModel({ request, operationId: "attempt-3", journalDirectory: dir, provider,
      signal: new AbortController().signal, validateResponse: (text) => { if (JSON.parse(text).ok !== true) throw new Error("bad response"); } });
    expect(result).toMatchObject({ response: '{"ok":true}', usage: { known: false } });
    expect(result.wall_nanos).toBeGreaterThan(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("bounds a caller after cancellation even if a provider does not settle, and never replays", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const started = Promise.withResolvers<void>();
  const invoke = vi.fn(() => { started.resolve(); return new Promise<never>(() => {}); });
  const controller = new AbortController();
  const input = { request, operationId: "attempt-4", journalDirectory: dir,
    provider: { family: "luna" as const, invokeFreshToolsOff: invoke }, signal: controller.signal, validateResponse: () => {} };
  try {
    const pending = invokeIsolatedModel(input);
    await started.promise;
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    await expect(invokeIsolatedModel({ ...input, signal: new AbortController().signal })).rejects.toThrow("reconcile");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("allows at most one concurrent dispatch for the same operation", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const invoke = vi.fn(async () => ({ response: '{}' }));
  const input = { request, operationId: "concurrent", journalDirectory: dir,
    provider: { family: "luna" as const, invokeFreshToolsOff: invoke },
    signal: new AbortController().signal, validateResponse: () => {} };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => invokeIsolatedModel(input)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("never replays an invocation whose response fails validation", async () => {
  const dir = await mkdtemp(join(root, "nar-model-journal-"));
  const invoke = vi.fn(async () => ({ response: 'not-json' }));
  const input = { request, operationId: "invalid-result", journalDirectory: dir,
    provider: { family: "luna" as const, invokeFreshToolsOff: invoke },
    signal: new AbortController().signal, validateResponse: (response: string) => { JSON.parse(response); } };
  try {
    await expect(invokeIsolatedModel(input)).rejects.toThrow();
    await expect(invokeIsolatedModel(input)).rejects.toThrow("reconcile");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
