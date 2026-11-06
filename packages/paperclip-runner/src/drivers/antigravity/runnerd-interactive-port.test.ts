import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityInteractiveControl } from "./interactive-control.js";
import { RunnerdAntigravityInteractivePort } from "./runnerd-interactive-port.js";

describe("Antigravity interactive Runner port", () => {
  it("dispatches only an admitted, checkpointed Runner event and never replays it", async () => {
    const stateDir = await mkdtemp(path.join("/Volumes/NVM/AI_Agent_Runtime/tmp", "agy-port-"));
    const calls: string[][] = [];
    let admitted = true;
    const tmux = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "display-message") return "%42 123 agy";
      if (args[0] === "capture-pane") return "https://antigravity.google.com/r/seat-1\n────────────\n>\n────────────";
      return "";
    };
    const binding = { bindingId: "binding", bindingGeneration: 1, runId: "run-1", environmentLeaseId: "lease",
      normalizedSessionId: "session", turnId: "turn" };
    const event = { schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: "native_controller.dispatch_requested", sourceEventId: "event-1",
      payload: { binding, text: "do work", inputDigest: `sha256:${createHash("sha256").update("do work").digest("hex")}` } };
    try {
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-1" }));
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, tmux, authorize: () => admitted });
      const port = new RunnerdAntigravityInteractivePort({ ...binding, stateDir, control, admit: () => admitted });
      await expect(port.dispatch({ ...event, payload: { ...event.payload, binding: { ...binding, runId: "other" } } })).rejects.toThrow(/denied/);
      await expect(port.dispatch({ ...event, payload: { ...event.payload, text: "changed" } })).rejects.toThrow(/denied/);
      admitted = false;
      await expect(port.dispatch(event)).rejects.toThrow(/denied/);
      admitted = true;
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "other" }));
      await expect(port.dispatch(event)).rejects.toThrow(/checkpoint/);
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-1" }));
      const otherDir = path.join(stateDir, "other-seat");
      await mkdir(otherDir, { mode: 0o700 });
      await writeFile(path.join(otherDir, "active.json"), JSON.stringify({ runId: "other" }));
      const otherControl = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir: otherDir, tmux, authorize: () => admitted });
      const wrongSeat = new RunnerdAntigravityInteractivePort({ ...binding, stateDir, control: otherControl, admit: () => admitted });
      await expect(wrongSeat.dispatch(event)).rejects.toThrow(/ownership/);
      expect(await port.dispatch(event)).toEqual({ disposition: "written_consumption_unknown" });
      await expect(port.dispatch(event)).rejects.toThrow();
      expect(calls.filter(args => args[0] === "send-keys")).toHaveLength(1);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
