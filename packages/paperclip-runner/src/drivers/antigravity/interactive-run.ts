import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AntigravityInteractiveControl } from "./interactive-control.js";

export type AntigravityInteractiveCheckpoint = {
  runId: string; issueId: string; receiptPath: string; rcUrl: string;
  tmuxSocket: string; tmuxSession: string; conversationId: string | null;
  startedAt: string; paneId?: string; panePid?: string;
};

type Binding = { stateDir: string; runId: string; issueId: string };
type Control = Pick<AntigravityInteractiveControl, "submit" | "interruptRun">;

async function privateDirectory(stateDir: string): Promise<void> {
  if (!path.isAbsolute(stateDir)) throw new Error("Antigravity checkpoint requires an absolute directory");
  const stat = await fs.lstat(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32"
      && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
    throw new Error("Antigravity checkpoint directory must be private and owned");
}

async function readOwned(binding: Binding): Promise<string | null> {
  await privateDirectory(binding.stateDir);
  let raw: string;
  const file = path.join(binding.stateDir, "active.json");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024
        || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
      throw new Error("Antigravity checkpoint must be a private owned file");
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const checkpoint = JSON.parse(raw) as { runId?: unknown; issueId?: unknown } | null;
  if (!checkpoint || checkpoint.runId !== binding.runId || checkpoint.issueId !== binding.issueId)
    throw new Error("Antigravity checkpoint ownership changed");
  return raw;
}

async function syncDirectory(stateDir: string): Promise<void> {
  const directory = await fs.open(stateDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Runner owns the existing per-seat checkpoint. The adapter holds its seat
 * mutex through dispatch, receipt delivery and stop. Reopening never resends. */
export class AntigravityInteractiveRun {
  private attempted: boolean;
  private constructor(private readonly binding: Binding, private readonly control: Control, adopted: boolean) {
    this.attempted = adopted;
  }

  static async open(input: Binding & { control: Control }): Promise<AntigravityInteractiveRun> {
    if (!input.runId || !input.issueId) throw new Error("Antigravity checkpoint identity missing");
    const binding = { stateDir: input.stateDir, runId: input.runId, issueId: input.issueId };
    return new AntigravityInteractiveRun(binding, input.control, await readOwned(binding) !== null);
  }

  async dispatch(checkpoint: AntigravityInteractiveCheckpoint, prompt: string): Promise<void> {
    const b = this.binding;
    const record = { ...checkpoint };
    if (this.attempted || record.runId !== b.runId || record.issueId !== b.issueId)
      throw new Error("Antigravity checkpoint dispatch cannot replay or change ownership");
    const raw = JSON.stringify(record);
    this.attempted = true;
    await privateDirectory(b.stateDir);
    const file = await fs.open(path.join(b.stateDir, "active.json"), "wx", 0o600);
    try { await file.writeFile(raw); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(b.stateDir);
    await this.control.submit(b.runId, prompt, b.runId);
  }

  async complete(): Promise<void> {
    if (await readOwned(this.binding) === null) throw new Error("Antigravity checkpoint missing before completion");
    await fs.unlink(path.join(this.binding.stateDir, "active.json"));
    await syncDirectory(this.binding.stateDir);
  }

  /** Only receipt delivery or verified Stop authorizes retirement. Preserves the
   * original record for reconciliation rather than discarding uncertain work. */
  static async archiveSettled(binding: Binding): Promise<void> {
    if (await readOwned(binding) === null) throw new Error("Antigravity checkpoint missing before retirement");
    await fs.rename(path.join(binding.stateDir, "active.json"),
      path.join(binding.stateDir, `active.settled-${randomUUID().slice(0, 12)}.json`));
    await syncDirectory(binding.stateDir);
  }

  async stop(): Promise<"idle" | "restart_required"> {
    if (await readOwned(this.binding) === null) {
      if (this.attempted) throw new Error("Antigravity dispatched checkpoint missing before Stop");
      return "idle";
    }
    const outcome = await this.control.interruptRun(this.binding.runId, {});
    if (outcome === "idle") await AntigravityInteractiveRun.archiveSettled(this.binding);
    return outcome;
  }
}
