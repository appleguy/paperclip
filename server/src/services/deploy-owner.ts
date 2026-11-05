import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type DeployOwner = { pid: number; birth: string };
export type OwnerLiveness = "alive" | "dead" | "unknown";

// Linux exposes an immutable start tick in the process stat record. macOS ps
// exposes kernel birth time at one-second resolution: a same-second PID reuse
// is deliberately treated as alive, never as evidence for a release.
export async function localProcessBirth(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid process PID");
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(") ");
    const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
    if (!stat.startsWith(`${pid} (`) || !/^\d+$/.test(fields[19] ?? "")) throw new Error("invalid process stat");
    return `linux:${fields[19]}`;
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    });
    const birth = stdout.trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(birth)) throw new Error("invalid process birth");
    return `darwin:${birth}`;
  }
  throw new Error("unsupported process identity platform");
}

export async function deployOwnerLiveness(owner: DeployOwner): Promise<OwnerLiveness> {
  try {
    const birth = await localProcessBirth(owner.pid);
    return birth === owner.birth ? "alive" : "dead";
  } catch {
    try { process.kill(owner.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    }
    return "unknown";
  }
}
