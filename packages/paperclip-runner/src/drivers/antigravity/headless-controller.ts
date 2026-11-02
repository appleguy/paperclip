import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AntigravityHeadlessStream, encodeAntigravityUserMessage, type NativeEvent } from "./native-control.js";
const allowedEnvironment = new Set(["PATH", "HOME", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]);

/** Persistent print-mode process, not an interactive Remote Control attachment.
 * See https://antigravity.google/docs/cli/headless/ . Caller must verify executable
 * and version, authorize each write, and durably journal operations before calling.
 */
export class AntigravityHeadlessController {
  /** Bound to the owned child PID, OS start time and a launch nonce. */
  readonly generation: string;
  private readonly parser: AntigravityHeadlessStream;
  private ready = false;
  private failed = false;
  private active?: string;
  private readonly seen = new Set<string>();
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly conversation: string | undefined, private readonly cwd: string, private readonly birth: string, private readonly readBirth: (pid: number) => string | null,
    private readonly authorize: (operationId: string) => boolean, private readonly onEvent: (event: NativeEvent) => void,
    private readonly onUncertain: (operationId: string) => void) {
    this.generation = `${child.pid}:${birth}:${randomUUID()}`;
    this.parser = new AntigravityHeadlessStream("1.4.12", conversation);
    child.stdout.on("data", (data: Buffer) => {
      if (this.failed) return;
      try {
        for (const event of this.parser.push(data)) {
          let completed: string | undefined;
          if (event.kind === "init") {
            if (event.cwd !== this.cwd) throw new Error("Working directory mismatch");
            this.ready = true;
          }
          if (event.kind === "result") {
            if (!this.active) throw new Error("Unsolicited result");
            completed = this.active;
            this.active = undefined;
          }
          try { this.onEvent(event); } catch (error) { if (completed) this.onUncertain(completed); throw error; }
        }
      } catch { this.fail(); }
    });
    child.stdout.on("end", () => { try { this.parser.finish(); } catch { this.fail(); } });
    child.on("error", () => this.fail());
    child.on("exit", () => this.fail());
    child.stdin.on("error", () => this.fail());
    // Drain diagnostics without retaining secrets or risking blocked pipes.
    child.stderr.resume();
  }
  static launch(options: { executable: string; verifiedVersion: string; cwd: string; conversationId?: string;
    env: NodeJS.ProcessEnv; authorize: (operationId: string) => boolean; onEvent: (event: NativeEvent) => void;
    onUncertain: (operationId: string) => void;
    spawnProcess?: typeof spawn; readProcessBirth?: (pid: number) => string | null; readVersion?: (executable: string) => string }): AntigravityHeadlessController {
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd) || options.verifiedVersion !== "1.4.12" ||
      (options.conversationId !== undefined && (!options.conversationId || options.conversationId.startsWith("-") || /[\x00-\x1f]/.test(options.conversationId)))) throw new Error("Invalid launch binding");
    const env = Object.fromEntries(Object.entries(options.env).filter(([key, value]) => value !== undefined && (allowedEnvironment.has(key) || /^LC_[A-Z_]+$/.test(key))));
    const readVersion = options.readVersion ?? ((executable: string) => execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env }).trim());
    if (readVersion(options.executable) !== options.verifiedVersion) throw new Error("Antigravity CLI version mismatch");
    const child = (options.spawnProcess ?? spawn)(options.executable,
      ["--input-format", "stream-json", "--output-format", "stream-json", ...(options.conversationId ? ["--conversation", options.conversationId] : [])],
      { cwd: options.cwd, env, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    const readBirth = options.readProcessBirth ?? ((pid: number) => {
      try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000, env: { LC_ALL: "C" } }).trim() || null; }
      catch { return null; }
    });
    const birth = child.pid ? readBirth(child.pid) : null;
    if (!birth) { child.on("error", () => {}); child.kill(); throw new Error("Owned Antigravity process birth unavailable"); }
    return new AntigravityHeadlessController(child, options.conversationId, options.cwd, birth, readBirth, options.authorize, options.onEvent, options.onUncertain);
  }
  /** Verifies this initialized child still has the OS birth recorded at launch. */
  assertOwnedLive(): void {
    if (this.failed || !this.ready || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid || this.readBirth(this.child.pid) !== this.birth) throw new Error("Antigravity owned child unavailable");
  }
  /** Accepted to local stdin only; provider consumption remains unknown until result. */
  submit(operationId: string, content: string): { operationId: string; disposition: "written_consumption_unknown" } {
    if (this.failed || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid || this.readBirth(this.child.pid) !== this.birth || !this.ready || this.active || !operationId || this.seen.has(operationId)) throw new Error("Write unavailable");
    const message = encodeAntigravityUserMessage(content);
    if (Buffer.byteLength(message) > 1024 * 1024 || !this.authorize(operationId)) throw new Error("Write denied");
    this.seen.add(operationId);
    this.active = operationId;
    try { this.child.stdin.write(message); } catch (error) { this.fail(); throw error; }
    return { operationId, disposition: "written_consumption_unknown" };
  }
  /** EOF drains the current turn; this is not an interrupt. */
  closeInput(): void { this.child.stdin.end(); }
  /** Only this exact child is signalled; EOF alone cannot guarantee shutdown. */
  async closeOwned(timeoutMs = 2000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); }, timeoutMs);
      const hard = setTimeout(() => { this.child.kill("SIGKILL"); reject(new Error("Owned child did not close")); }, timeoutMs * 2);
      this.child.once("close", () => { clearTimeout(timer); clearTimeout(hard); resolve(); });
      this.child.stdin.end();
    });
  }
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    if (this.active) { const id = this.active; this.active = undefined; this.onUncertain(id); }
  }
}
