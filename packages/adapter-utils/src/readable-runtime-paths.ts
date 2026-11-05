import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "./types.js";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";

const roots = new WeakMap<AdapterExecutionContext, Promise<string>>();

function readableName(value: string | undefined): string {
  return (value ?? "agent").normalize("NFKD").replace(/\([^)]*\)/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}

/** Presentation aliases only: never move storage or retarget another run's link.
 * Kept with run history so paths in saved prompts continue to resolve. Each ctx
 * gets an exclusive directory, including concurrent runs of the same seat.
 */
async function runRoot(ctx: AdapterExecutionContext): Promise<string> {
  let pending = roots.get(ctx);
  if (!pending) {
    pending = (async () => {
      const parent = path.join(resolvePaperclipInstanceRootForAdapter(), "runs");
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const task = ctx.context.paperclipIssue as { identifier?: string } | undefined;
      const identifier = ctx.context.issueIdentifier ?? task?.identifier;
      const issue = typeof identifier === "string" ? `${readableName(identifier)}-` : "";
      const day = new Date().toISOString().slice(5, 10).replace("-", "");
      return fs.mkdtemp(path.join(parent, `${issue}${day}-${readableName(ctx.agent.name)}-`));
    })();
    roots.set(ctx, pending);
  }
  return pending;
}

export async function readableRuntimePath(
  ctx: AdapterExecutionContext, name: string, target: string, type: "dir" | "file" = "dir",
): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..") throw new Error("Invalid runtime path alias");
  const alias = path.join(await runRoot(ctx), name);
  const resolved = path.resolve(target);
  try { await fs.symlink(resolved, alias, type); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await fs.readlink(alias) !== resolved) throw error;
  }
  return alias;
}
