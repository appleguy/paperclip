import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const idPattern = /^[a-zA-Z0-9_-]{1,55}$/;
const remotePattern = /https:\/\/antigravity\.google\.com\/r\/[a-zA-Z0-9-]+/;
type Tmux = (args: string[]) => Promise<string>;
function validateLaunch(input: { socket: string; session: string; stateDir: string; cwd: string; tmpDir: string; executable: string; model: string; conversationId?: string }): void {
  if (!idPattern.test(input.socket) || !idPattern.test(input.session) ||
    ![input.stateDir, input.cwd, input.tmpDir, input.executable].every(path.isAbsolute) ||
    input.cwd === "/" || input.cwd.startsWith("/private/var/folders/") || input.cwd.startsWith("/var/folders/") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,199}$/.test(input.model) ||
    (input.conversationId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(input.conversationId))) throw new Error("Invalid Antigravity seat launch");
}

export function emptyAgyEditor(screen: string): boolean {
  const lines = screen.replace(/\r/g, "").trimEnd().split("\n").slice(-35);
  const borders = lines.flatMap((line, i) => /^\s*[─━═]{6,}\s*$/.test(line) ? [i] : []);
  for (let i = borders.length - 1; i > 0; i--) {
    const bottom = borders[i]!;
    if (lines.length - bottom > 10) return false;
    const editor = lines.slice(borders[i - 1]! + 1, bottom).filter(line => line.trim() !== "");
    if (!/^\s*>/.test(editor[0] ?? "")) continue;
    return editor.length === 1 && /^\s*>\s*$/.test(editor[0]!);
  }
  return false;
}

export function isAgySeatIdle(snapshot: unknown, conversationId: unknown, after: number, now: number): boolean {
  if (!snapshot || typeof snapshot !== "object" || typeof conversationId !== "string" || !conversationId) return false;
  const status = snapshot as Record<string, unknown>;
  const observed = typeof status.observedAt === "string" ? Date.parse(status.observedAt) : NaN;
  return status.agentState === "idle" && status.conversationId === conversationId && status.pendingInputCount === 0 &&
    status.toolConfirmationPending === false && Number.isFinite(observed) && observed >= after && observed <= now && now - observed <= 10_000;
}

/** An existing seat is usable only while its exact pane and process remain present.
 * The caller holds the seat lock and reconciles any prior dispatched turn. */
export class AntigravityInteractiveControl {
  private restartEligibleRun?: string;
  private constructor(private readonly input: {
    socket: string; session: string; stateDir: string; paneId: string; panePid: string;
    tmux: Tmux; authorize: (operationId: string) => boolean;
  }, readonly remoteControlUrl: string) {}

  private async assertRunOwner(runId: string): Promise<void> {
    const active = JSON.parse(await fs.readFile(path.join(this.input.stateDir, "active.json"), "utf8")) as { runId?: unknown };
    if (!runId || active.runId !== runId) throw new Error("Antigravity stop checkpoint ownership changed");
    const identity = (await this.input.tmux(["display-message", "-p", "-t", `=${this.input.session}:`, "#{pane_id} #{pane_pid} #{pane_current_command}"])).trim();
    if (identity !== `${this.input.paneId} ${this.input.panePid} agy`) throw new Error("Antigravity seat identity changed");
  }

  static async open(input: {
    socket: string; session: string; stateDir: string; cwd: string; tmpDir: string; executable: string; model: string;
    rejoinOnly: boolean; requireNew?: boolean; expectedRemoteControlUrl?: string; conversationId?: string; authorize: (operationId: string) => boolean; tmux?: Tmux;
    wait?: (ms: number) => Promise<void>; startupTimeoutMs?: number;
  }): Promise<AntigravityInteractiveControl> {
    validateLaunch(input);
    const tmux = input.tmux ?? (async (args: string[]) =>
      (await exec("/opt/homebrew/bin/tmux", ["-L", input.socket, ...args], { timeout: 10_000, maxBuffer: 2_000_000 })).stdout);
    let exists = true;
    try { await tmux(["has-session", "-t", `=${input.session}:`]); } catch { exists = false; }
    if (exists && input.requireNew) throw new Error("Antigravity seat unexpectedly exists after stop");
    if (!exists) {
      if (input.rejoinOnly) throw new Error("Antigravity active seat unavailable; reconcile without replay");
      await fs.mkdir(input.cwd, { recursive: true });
      await fs.mkdir(input.tmpDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(input.stateDir, { recursive: true, mode: 0o700 });
      await tmux(["new-session", "-d", "-s", input.session, "-c", input.cwd, "-e", `TMPDIR=${input.tmpDir}`,
        input.executable, "--remote-control", "--dangerously-skip-permissions", "--model", input.model,
        ...(input.conversationId ? ["--conversation", input.conversationId] : [])]);
    }
    const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + (input.startupTimeoutMs ?? 45_000);
    for (;;) {
      try { return await AntigravityInteractiveControl.attach({ ...input, tmux }); }
      catch (error) {
        if (exists || Date.now() >= deadline || !(error instanceof Error) || !/identity unavailable/.test(error.message)) throw error;
        await wait(1000);
      }
    }
  }

  /** The caller holds the seat lock for the whole operation. */
  async interruptRun(runId: string, options: {
    readStatus?: () => Promise<unknown>; wait?: (ms: number) => Promise<void>;
    now?: () => number; timeoutMs?: number;
  }): Promise<"idle" | "restart_required"> {
    this.restartEligibleRun = undefined;
    const now = options.now ?? Date.now;
    const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const started = now();
    const deadline = started + (options.timeoutMs ?? 60_000);
    const readStatus = options.readStatus ?? (async () => {
      try { return JSON.parse(await fs.readFile(path.join(this.input.stateDir, "status-line.json"), "utf8")); } catch { return null; }
    });
    const check = () => this.assertRunOwner(runId);
    await check();
    await this.input.tmux(["send-keys", "-t", this.input.paneId, "Escape"]);
    let sentControlC = false;
    while (now() < deadline) {
      await check();
      const checkpoint = JSON.parse(await fs.readFile(path.join(this.input.stateDir, "active.json"), "utf8")) as { conversationId?: unknown };
      const status = await readStatus();
      const screen = await this.input.tmux(["capture-pane", "-t", this.input.paneId, "-p", "-J", "-S", "-150"]);
      if (isAgySeatIdle(status, checkpoint.conversationId, started, now()) && emptyAgyEditor(screen)) {
        await check(); return "idle";
      }
      if (!sentControlC && now() - started >= 5000) {
        await check();
        await this.input.tmux(["send-keys", "-t", this.input.paneId, "C-c"]);
        sentControlC = true;
      }
      await wait(Math.min(500, Math.max(0, deadline - now())));
    }
    await check();
    this.restartEligibleRun = runId;
    return "restart_required";
  }

  /** The caller holds the seat lock and records the outcome on the run. */
  async restartRunSeat(runId: string, input: {
    cwd: string; tmpDir: string; executable: string; model: string; conversationId?: string;
    wait?: (ms: number) => Promise<void>; startupTimeoutMs?: number;
  }): Promise<AntigravityInteractiveControl> {
    validateLaunch({ ...input, socket: this.input.socket, session: this.input.session, stateDir: this.input.stateDir });
    await this.assertRunOwner(runId);
    if (this.restartEligibleRun !== runId) throw new Error("Antigravity seat restart requires an interrupt timeout");
    const checkpoint = JSON.parse(await fs.readFile(path.join(this.input.stateDir, "active.json"), "utf8")) as { conversationId?: unknown };
    if ((input.conversationId ?? null) !== (checkpoint.conversationId ?? null))
      throw new Error("Antigravity restart conversation does not match checkpoint");
    this.restartEligibleRun = undefined;
    await this.input.tmux(["kill-session", "-t", `=${this.input.session}:`]);
    const active = JSON.parse(await fs.readFile(path.join(this.input.stateDir, "active.json"), "utf8")) as { runId?: unknown };
    if (active.runId !== runId) throw new Error("Antigravity stop checkpoint ownership changed");
    return AntigravityInteractiveControl.open({ ...input, socket: this.input.socket, session: this.input.session,
      stateDir: this.input.stateDir, authorize: this.input.authorize, tmux: this.input.tmux, rejoinOnly: false, requireNew: true });
  }

  static async attach(input: {
    socket: string; session: string; stateDir: string; expectedRemoteControlUrl?: string;
    authorize: (operationId: string) => boolean; tmux?: Tmux;
  }): Promise<AntigravityInteractiveControl> {
    if (!idPattern.test(input.socket) || !idPattern.test(input.session) || !path.isAbsolute(input.stateDir))
      throw new Error("Invalid Antigravity seat");
    const tmux = input.tmux ?? (async (args: string[]) =>
      (await exec("/opt/homebrew/bin/tmux", ["-L", input.socket, ...args], { timeout: 10_000, maxBuffer: 2_000_000 })).stdout);
    const target = ["-t", `=${input.session}:`];
    const identity = (await tmux(["display-message", "-p", ...target, "#{pane_id} #{pane_pid} #{pane_current_command}"])).trim();
    const match = /^(%\d+) (\d+) agy$/.exec(identity);
    if (!match) throw new Error("Antigravity seat identity unavailable");
    const screen = await tmux(["capture-pane", ...target, "-p", "-J", "-S", "-150"]);
    const remoteControlUrl = screen.match(remotePattern)?.[0];
    if (!remoteControlUrl || (input.expectedRemoteControlUrl && input.expectedRemoteControlUrl !== remoteControlUrl))
      throw new Error("Antigravity Remote Control identity unavailable or changed");
    const state = await fs.lstat(input.stateDir);
    if (!state.isDirectory() || state.isSymbolicLink() || (process.platform !== "win32" && ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.())))
      throw new Error("Antigravity seat state must be private and owned");
    return new AntigravityInteractiveControl({ ...input, tmux, paneId: match[1]!, panePid: match[2]! }, remoteControlUrl);
  }

  async submit(operationId: string, message: string, runId: string): Promise<{ disposition: "written_consumption_unknown" }> {
    if (!operationId || !message || /[\r\n]/.test(message) || message.startsWith("/") || !this.input.authorize(operationId))
      throw new Error("Antigravity interactive submission denied");
    await this.assertRunOwner(runId);
    const sessionTarget = ["-t", `=${this.input.session}:`];
    const target = ["-t", this.input.paneId];
    const identity = (await this.input.tmux(["display-message", "-p", ...sessionTarget, "#{pane_id} #{pane_pid} #{pane_current_command}"])).trim();
    if (identity !== `${this.input.paneId} ${this.input.panePid} agy`) throw new Error("Antigravity seat identity changed");
    const screen = await this.input.tmux(["capture-pane", ...target, "-p", "-J", "-S", "-150"]);
    const currentUrl = screen.match(remotePattern)?.[0];
    if (currentUrl && currentUrl !== this.remoteControlUrl) throw new Error("Antigravity Remote Control identity changed");
    if (!emptyAgyEditor(screen)) throw new Error("Antigravity input guard refused");
    const id = createHash("sha256").update(operationId).digest("hex");
    const reservation = path.join(this.input.stateDir, `dispatch-${id}.reservation`);
    const fd = await fs.open(reservation, "wx", 0o600);
    try {
      await fd.writeFile(JSON.stringify({ operationId, paneId: this.input.paneId, panePid: this.input.panePid,
        inputSha256: createHash("sha256").update(message).digest("hex") }));
      await fd.sync();
    } finally { await fd.close(); }
    const directory = await fs.open(this.input.stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    const file = path.join(this.input.stateDir, `input-${randomUUID()}`);
    const buffer = `paperclip-agy-${randomUUID()}`;
    try {
      if (!this.input.authorize(operationId)) throw new Error("Antigravity interactive admission revoked");
      await this.assertRunOwner(runId);
      await fs.writeFile(file, message, { flag: "wx", mode: 0o600 });
      await this.input.tmux(["load-buffer", "-b", buffer, file]);
      await this.input.tmux(["paste-buffer", "-p", "-r", "-d", "-b", buffer, ...target]);
      await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(350, 500 + Math.ceil(message.length / 1500) * 300))));
      await this.input.tmux(["send-keys", ...target, "Enter"]);
    } finally {
      await this.input.tmux(["delete-buffer", "-b", buffer]).catch(() => {});
      await fs.rm(file, { force: true });
    }
    return { disposition: "written_consumption_unknown" };
  }
}
