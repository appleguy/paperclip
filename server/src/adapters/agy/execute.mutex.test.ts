import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tryAcquire } from "./execute.js";

const ROOT = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe("seat mutex ownership (SCO-1038)", () => {
  let dir: string;
  const children: ChildProcess[] = [];
  const unlocks: (() => Promise<void>)[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(ROOT, "seat-mutex-")); });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    for (const unlock of unlocks.splice(0)) await unlock();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function claim() {
    const unlock = await tryAcquire(dir);
    if (unlock) unlocks.push(unlock);
    return unlock;
  }
  async function staleLock(pid = String(spawnSync("/usr/bin/true").pid)) {
    await fs.mkdir(path.join(dir, "dispatch.lock"));
    await fs.writeFile(path.join(dir, "dispatch.lock", "pid"), pid);
    return pid;
  }
  async function childOwner(stage: "before-pid" | "acquired") {
    const child = spawn(process.execPath, ["--expose-gc", "--import", require.resolve("tsx"), "--input-type=module", "-e", `
      import fs from "node:fs/promises";
      import path from "node:path";
      const { tryAcquire } = await import(process.argv[1]);
      if (process.argv[3] === "before-pid") {
        const write = fs.writeFile.bind(fs);
        fs.writeFile = async (file, ...args) => {
          if (path.basename(String(file)) === "pid") {
            // Root the paused async frame through a real event source. An
            // unreachable never-resolved promise can be collected with its DB.
            const resume = new Promise(resolve => process.once("message", resolve));
            setImmediate(() => { global.gc(); process.send("before-pid"); });
            await resume;
          }
          return write(file, ...args);
        };
      }
      const unlock = await tryAcquire(process.argv[2]);
      if (!unlock) throw new Error("child could not acquire seat");
      process.on("message", async message => {
        if (message === "release") { await unlock(); process.disconnect(); }
      });
      setImmediate(() => { global.gc(); process.send("acquired"); });
    `, new URL("./execute.ts", import.meta.url).href, dir, stage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`child exited before ${stage}: ${stderr}`)));
      child.once("message", message => {
        if (message === stage) resolve();
        else reject(new Error(`expected ${stage}, got ${String(message)}`));
      });
    });
    return child;
  }
  async function killOwner(child: ChildProcess) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }

  it("excludes a second holder and preserves checkpoints through stale recovery", async () => {
    await fs.writeFile(path.join(dir, "active.json"), "original checkpoint");
    await staleLock();
    const unlock = await claim();
    expect(unlock).toBeTypeOf("function");
    expect(await claim()).toBeNull();
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toBe("original checkpoint");
    await unlock!();
    expect(await claim()).toBeTypeOf("function");
  });

  it("cannot reclaim a successor after two contenders observe a stale lock", async () => {
    const dead = await staleLock();
    const firstRead = deferred(), secondRead = deferred();
    const resumeFirst = deferred(), resumeSecond = deferred();
    const read = fs.readFile.bind(fs);
    let staleReads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const value = await read(...args);
      if (args[0] === path.join(dir, "dispatch.lock", "pid") && String(value) === dead) {
        if (++staleReads === 1) {
          firstRead.resolve();
          await resumeFirst.promise;
        } else {
          secondRead.resolve();
          await resumeSecond.promise;
        }
      }
      return value;
    });
    const first = claim();
    await firstRead.promise;
    const second = claim();
    // The old protocol lets both read stale metadata. A process-owned lock
    // instead refuses the second contender before it can read that metadata.
    await Promise.race([secondRead.promise, second]);
    resumeFirst.resolve();
    expect(await first).toBeTypeOf("function");
    resumeSecond.resolve();
    expect(await second).toBeNull();
    expect(await claim()).toBeNull();
  });

  it("a repeated or concurrent unlock cannot remove the next owner's lock", async () => {
    const first = await claim();
    await Promise.all([first!(), first!()]);
    expect(await claim()).toBeTypeOf("function");
    await first!();
    expect(await claim()).toBeNull();
  });

  it("retains process ownership until directory removal finishes", async () => {
    const unlock = await claim();
    const removing = deferred(), resume = deferred();
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === path.join(dir, "dispatch.lock")) {
        removing.resolve();
        await resume.promise;
      }
      return rm(...args);
    });
    const release = unlock!();
    await removing.promise;
    try { expect(await claim()).toBeNull(); }
    finally { resume.resolve(); await release; }
    expect(await claim()).toBeTypeOf("function");
  });

  it("preserves a live legacy holder and refuses unknown legacy ownership", async () => {
    await staleLock(String(process.pid));
    expect(await claim()).toBeNull();
    await fs.unlink(path.join(dir, "dispatch.lock", "pid"));
    expect(await claim()).toBeNull();
  });

  it("releases process ownership on death before PID publication", async () => {
    const child = await childOwner("before-pid");
    expect(await claim()).toBeNull();
    await killOwner(child);
    expect(await claim()).toBeTypeOf("function");
  });

  it("excludes a separate process and recovers after the owner dies", async () => {
    const child = await childOwner("acquired");
    expect(await claim()).toBeNull();
    await killOwner(child);
    expect(await claim()).toBeTypeOf("function");
    expect(await claim()).toBeNull();
  });

  it("releases ownership if PID publication fails", async () => {
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (path.basename(String(args[0])) === "pid") throw new Error("publication failed");
      return write(...args);
    });
    await expect(claim()).rejects.toThrow("publication failed");
    vi.restoreAllMocks();
    expect(await claim()).toBeTypeOf("function");
  });
});
