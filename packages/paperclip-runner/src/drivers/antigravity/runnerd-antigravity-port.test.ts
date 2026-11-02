import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AntigravityHeadlessController } from "./headless-controller.js";
import type { DurablePrpControlPlane } from "../../control-plane/durable-prp-control-plane.js";
import { launchRunnerdAntigravity, RunnerdAntigravityPort } from "./runnerd-antigravity-port.js";
import type { NativeEvent } from "./native-control.js";
const binding = { bindingId: "binding", bindingGeneration: 1, runId: "run", environmentLeaseId: "lease", normalizedSessionId: "session", turnId: "turn" };
describe("Runner Antigravity committed dispatch", () => {
  it("rejects altered input before writing to the provider", () => {
    const dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-journal-");
    try {
      const submit = vi.fn();
      const port = new RunnerdAntigravityPort({ controller: { submit } as unknown as AntigravityHeadlessController, journalDirectory: dir, conversationId: "native", processGeneration: "generation", ...binding, admit: () => true, queueResult: vi.fn() });
      expect(() => port.dispatch({ schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event", payload: { binding, text: "altered", inputDigest: `sha256:${createHash("sha256").update("original").digest("hex")}` } })).toThrow();
      expect(submit).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])("reserves before write and never repeats, failure=%s", failed => {
    const dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-journal-");
    try {
      const submit = vi.fn(() => { if (failed) throw new Error("disconnect"); return { operationId: "event", disposition: "written_consumption_unknown" as const }; });
      const options = { controller: { submit } as unknown as AntigravityHeadlessController, journalDirectory: dir, conversationId: "native", processGeneration: "generation", ...binding, admit: () => true, queueResult: vi.fn() };
      const event = { schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event", payload: { binding, text: "test", inputDigest: `sha256:${createHash("sha256").update("test").digest("hex")}` } };
      expect(() => new RunnerdAntigravityPort(options).dispatch({ ...event, schema: "paperclip.prp.event.v1", schemaVersion: 1 })).toThrow(/denied/);
      if (failed) expect(() => new RunnerdAntigravityPort(options).dispatch(event)).toThrow(/disconnect/);
      else expect(new RunnerdAntigravityPort(options).dispatch(event).disposition).toBe("written_consumption_unknown");
      expect(() => new RunnerdAntigravityPort(options).dispatch(event)).toThrow(/uncertain/); expect(submit).toHaveBeenCalledOnce();
      expect(() => new RunnerdAntigravityPort(options).dispatch({ schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "other", payload: { binding: { ...binding, runId: "foreign" }, text: "test" } })).toThrow(/denied/); expect(submit).toHaveBeenCalledOnce();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("queues exact native result as observation, never completion", () => {
    const dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-journal-");
    try {
      const queueResult = vi.fn();
      const port = new RunnerdAntigravityPort({ controller: { submit: () => ({ operationId: "event", disposition: "written_consumption_unknown" }) } as unknown as AntigravityHeadlessController, journalDirectory: dir, conversationId: "native", processGeneration: "generation", ...binding, admit: () => true, queueResult });
      port.dispatch({ schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event", payload: { binding, text: "task", inputDigest: `sha256:${createHash("sha256").update("task").digest("hex")}` } });
      expect(() => port.observe({ kind: "result", conversationId: "foreign", status: "SUCCESS" })).toThrow(/mismatch/);
      port.observe({ kind: "result", conversationId: "native", status: "SUCCESS", response: "answer" });
      expect(queueResult).toHaveBeenCalledOnce();
      expect(queueResult.mock.calls[0]![1]).toMatchObject({ action: "antigravity.native_result", result: { status: "SUCCESS", response: "answer" } });
      const first = queueResult.mock.calls[0];
      port.recoverResult("event");
      expect(queueResult.mock.calls[1]).toEqual(first);
      expect(() => port.observe({ kind: "result", conversationId: "native", status: "SUCCESS" })).toThrow(/no admitted/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("wires controller result to the same durable PRP command lane", () => {
    const dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-journal-");
    const queueCommand = vi.fn();
    let receive!: (event: NativeEvent) => void;
    const spy = vi.spyOn(AntigravityHeadlessController, "launch").mockImplementation(options => {
      receive = options.onEvent;
      return { generation: "generation", submit: () => ({ operationId: "event", disposition: "written_consumption_unknown" }) } as unknown as AntigravityHeadlessController;
    });
    try {
      const { port } = launchRunnerdAntigravity({ core: { queueCommand } as unknown as DurablePrpControlPlane, executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", env: {}, journalDirectory: dir, conversationId: "native", ...binding, admit: () => true, onUncertain: () => {} });
      port.dispatch({ schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event", payload: { binding, text: "task", inputDigest: `sha256:${createHash("sha256").update("task").digest("hex")}` } });
      receive({ kind: "result", conversationId: "native", status: "SUCCESS" });
      expect(queueCommand).toHaveBeenCalledOnce();
      expect(queueCommand.mock.calls[0]![0]).toBe("native_controller.observation");
      expect(queueCommand.mock.calls[0]![1]).toMatchObject({ action: "antigravity.native_result" });
    } finally { spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("drives an owned fake CLI process through the durable result lane", async () => {
    const dir = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-process-");
    const script = join(dir, "fake-agy");
    writeFileSync(script, `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');\nlet s='';process.stdin.on('data',d=>{s+=d; if(s.includes('\\n')) { process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:'native',status:'SUCCESS',response:'fake'}})+'\\n'); s=''; }});`, { mode: 0o700 });
    const queueCommand = vi.fn();
    let controller: AntigravityHeadlessController | undefined;
    try {
      let initialized!: () => void;
      const ready = new Promise<void>(resolve => { initialized = resolve; });
      const launched = launchRunnerdAntigravity({ core: { queueCommand } as unknown as DurablePrpControlPlane, executable: script, verifiedVersion: "1.4.12", cwd: dir, env: { PATH: process.env.PATH }, journalDirectory: dir, conversationId: "native", ...binding, admit: () => true, onUncertain: () => {}, onEvent: event => { if (event.kind === "init") initialized(); } });
      controller = launched.controller;
      await ready;
      launched.port.dispatch({ schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event", payload: { binding, text: "test", inputDigest: `sha256:${createHash("sha256").update("test").digest("hex")}` } });
      await vi.waitFor(() => expect(queueCommand).toHaveBeenCalledOnce(), { timeout: 3000 });
      expect(queueCommand.mock.calls[0]![1]).toMatchObject({ processGeneration: controller.generation, result: { status: "SUCCESS", response: "fake" } });
      await launched.port.closeOwned();
      expect(queueCommand.mock.calls[1]![1]).toMatchObject({ action: "antigravity.provider_exit", processGeneration: controller.generation, exitObserved: true });
    } finally { if (controller) await controller.closeOwned(); rmSync(dir, { recursive: true, force: true }); }
  });
});
