import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AntigravityHeadlessController } from "./headless-controller.js";
function setup() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, exitCode: null, signalCode: null });
  const spawnProcess = vi.fn((_file: string, _args: string[], _options: unknown) => child);
  const events = vi.fn(), uncertain = vi.fn(), authorize = vi.fn(() => true);
  const controller = AntigravityHeadlessController.launch({ executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", conversationId: "exact-id", env: {}, authorize, onEvent: events, onUncertain: uncertain, spawnProcess: spawnProcess as never, readProcessBirth: () => "fixture-birth", readVersion: () => "1.4.12" });
  const send = (v: unknown) => child.stdout.write(JSON.stringify(v) + "\n");
  const init = (id = "exact-id") => send({ event: "init", conversation_id: id, init: { cwd: "/tmp", permission_mode: "request-review" } });
  const result = () => send({ event: "result", result: { conversation_id: "exact-id", status: "SUCCESS" } });
  return { child, spawnProcess, controller, events, uncertain, authorize, init, result };
}
describe("Antigravity persistent headless controller", () => {
  it("resumes exact identity and serializes each acknowledged turn", () => {
    const t = setup();
    expect(t.spawnProcess.mock.calls[0][1]).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "exact-id"]);
    expect(() => t.controller.submit("one", "hello")).toThrow(); t.init();
    expect(t.controller.submit("one", "hello").disposition).toBe("written_consumption_unknown");
    expect(JSON.parse(t.child.stdin.read().toString()).message.content).toBe("hello");
    expect(() => t.controller.submit("two", "hello")).toThrow(); t.result();
    expect(() => t.controller.submit("one", "hello")).toThrow();
    t.controller.submit("two", "again"); t.result();
    expect(t.events.mock.calls.length).toBe(3); t.controller.closeInput();
  });
  it("holds writes after identity mismatch and reports uncertain on disconnect", () => {
    const wrong = setup(); wrong.init("foreign");
    expect(() => wrong.controller.submit("x", "hello")).toThrow();
    const t = setup(); t.init(); t.controller.submit("x", "hello");
    t.child.emit("exit", 1); t.child.emit("error", new Error("lost"));
    expect(t.uncertain).toHaveBeenCalledOnce(); expect(t.uncertain).toHaveBeenCalledWith("x");
    expect(() => t.controller.submit("x", "hello")).toThrow();
  });
  it("requires admission and rejects unsupported input", () => {
    const t = setup(); t.init(); t.authorize.mockReturnValue(false);
    expect(() => t.controller.submit("x", "hello")).toThrow(); t.authorize.mockReturnValue(true);
    expect(() => t.controller.submit("x", "/model")).toThrow(); expect(t.child.stdin.read()).toBeNull();
  });
  it("refuses input when the owned PID's birth changes", () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, exitCode: null, signalCode: null });
    const readProcessBirth = vi.fn().mockReturnValueOnce("first").mockReturnValue("replacement");
    const controller = AntigravityHeadlessController.launch({ executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", conversationId: "exact-id", env: {}, authorize: () => true, onEvent: () => {}, onUncertain: () => {}, spawnProcess: (() => child) as never, readProcessBirth, readVersion: () => "1.4.12" });
    child.stdout.write(JSON.stringify({ event: "init", conversation_id: "exact-id", init: { cwd: "/tmp", permission_mode: "request-review" } }) + "\n");
    expect(() => controller.submit("x", "hello")).toThrow(/unavailable/);
    expect(child.stdin.read()).toBeNull();
  });
  it("filters run credentials from the native process environment", () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, exitCode: null, signalCode: null });
    const spawnProcess = vi.fn((_file: string, _args: string[], _options: unknown) => child);
    AntigravityHeadlessController.launch({ executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", conversationId: "exact-id", env: { HOME: "/tmp", PAPERCLIP_API_KEY: "secret", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret" }, authorize: () => true, onEvent: () => {}, onUncertain: () => {}, spawnProcess: spawnProcess as never, readProcessBirth: () => "birth", readVersion: () => "1.4.12" });
    const options = spawnProcess.mock.calls[0]![2] as unknown as { env: Record<string, string> };
    expect(options.env).toEqual({ HOME: "/tmp" });
  });
  it("rejects the wrong CLI version before spawning a session", () => {
    const spawnProcess = vi.fn();
    expect(() => AntigravityHeadlessController.launch({ executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", conversationId: "exact-id", env: {}, authorize: () => true, onEvent: () => {}, onUncertain: () => {}, spawnProcess: spawnProcess as never, readVersion: () => "1.4.13" })).toThrow(/version mismatch/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
