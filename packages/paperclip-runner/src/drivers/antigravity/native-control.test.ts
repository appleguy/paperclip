import { describe, expect, it } from "vitest";
import { AntigravityHeadlessStream, encodeAntigravityUserMessage } from "./native-control.js";

const init = { event: "init", conversation_id: "conversation-1", init: { cwd: "/project", permission_mode: "request-review" } };
const step = { event: "step_update", step_update: { conversation_id: "conversation-1", step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command" } };
const result = { event: "result", result: { conversation_id: "conversation-1", status: "SUCCESS", response: "ok", num_turns: 1 } };
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

describe("agy documented headless stream", () => {
  it("binds the exact conversation and reads multiple results across fragmented bytes", () => {
    const parser = new AntigravityHeadlessStream("1.4.12", "conversation-1");
    const bytes = Buffer.concat([line(init), line(step), line(result), line({ ...result, result: { ...result.result, num_turns: 2 } })]);
    const events = [...parser.push(bytes.subarray(0, 23)), ...parser.push(bytes.subarray(23))];
    expect(events.map(e => e.kind)).toEqual(["init", "step", "result", "result"]);
    expect(events[1]).toMatchObject({ toolName: "run_command", index: 1 });
    expect(events[3]).toMatchObject({ numTurns: 2 });
    parser.finish();
  });
  it("rejects mismatched conversation, version, malformed and oversized data", () => {
    expect(() => new AntigravityHeadlessStream("1.4.13")).toThrow();
    expect(() => new AntigravityHeadlessStream("1.4.12", "other").push(line(init))).toThrow();
    const parser = new AntigravityHeadlessStream("1.4.12");
    parser.push(line(init));
    expect(() => parser.push(line({ ...result, result: { ...result.result, conversation_id: "other" } }))).toThrow();
    expect(() => parser.push(line(result))).toThrow();
    expect(() => new AntigravityHeadlessStream("1.4.12", undefined, 5).push(Buffer.from("123456"))).toThrow();
    expect(() => new AntigravityHeadlessStream("1.4.12").push(Buffer.from("{bad}\n"))).toThrow();
  });
  it("does not turn truncation or unsupported control messages into completion", () => {
    const parser = new AntigravityHeadlessStream("1.4.12");
    parser.push(line(init));
    parser.push(Buffer.from('{"event"'));
    expect(() => parser.finish()).toThrow();
    const other = new AntigravityHeadlessStream("1.4.12");
    other.push(line(init));
    expect(() => other.push(line({ event: "control_request" }))).toThrow();
  });
  it("encodes only documented user input and rejects slash commands", () => {
    expect(JSON.parse(encodeAntigravityUserMessage("hello"))).toEqual({ event: "user", message: { content: "hello" } });
    expect(() => encodeAntigravityUserMessage("/model")).toThrow();
  });
});
