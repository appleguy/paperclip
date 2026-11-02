import { EventEmitter } from "node:events";
import type { Db } from "@paperclipai/db";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { readOpenCodeTerminalReceipt } from "./opencode-shared-recovery.js";

const events = new EventEmitter();
const key = (binding: OpenCodeSharedBinding) => `${binding.runId}:${binding.taskSessionId}:${binding.generation}:${binding.epoch}`;
export function notifyOpenCodeTerminal(binding: OpenCodeSharedBinding) { events.emit(key(binding)); }

/** Subscribe before the second read, so a committed receipt cannot be missed. */
export async function waitForOpenCodeTerminal(db: Db, binding: OpenCodeSharedBinding, signal: AbortSignal, read = () => readOpenCodeTerminalReceipt(db, binding)) {
  signal.throwIfAborted();
  const existing = await read();
  if (existing) return existing;
  type Receipt = NonNullable<Awaited<ReturnType<typeof readOpenCodeTerminalReceipt>>>;
  return new Promise<Receipt>((resolve, reject) => {
    let checking = false, pending = false, finished = false;
    const cleanup = () => { events.off(key(binding), wake); signal.removeEventListener("abort", abort); };
    const finish = (error: unknown, result?: Receipt) => {
      if (finished) return; finished = true; cleanup();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal.reason ?? new Error("opencode_terminal_wait_aborted"));
    const wake = () => {
      if (finished) return;
      if (checking) { pending = true; return; }
      checking = true;
      void read().then(result => {
        checking = false;
        if (result) finish(null, result);
        else if (pending) { pending = false; wake(); }
      }, error => finish(error));
    };
    events.on(key(binding), wake);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else wake();
  });
}
