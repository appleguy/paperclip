import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "./types.js";
import { readableRuntimePath } from "./readable-runtime-paths.js";

let temporary: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});
const context = () => ({ agent: { name: "Codex Burst S4 (Sol High, Paperclip)" },
  context: { paperclipIssue: { identifier: "SCO-907" } } } as unknown as AdapterExecutionContext);

describe("readable runtime paths", () => {
  it("preserves relative instruction reads and writes without exposing storage identities", async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-paths-"));
    vi.stubEnv("PAPERCLIP_HOME", temporary);
    const source = path.join(temporary, "companies", "55cef09f-ec08-4e71-8e7f-2afb4a912ce8", "9267b919".repeat(8));
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "AGENTS.md"), "Read sibling.txt");
    await fs.writeFile(path.join(source, "sibling.txt"), "original");
    const ctx = context();
    const alias = await readableRuntimePath(ctx, "instructions", source);
    expect(alias).toContain("SCO-907-");
    expect(alias).toContain("Codex-Burst-S4-");
    expect(alias).not.toContain("55cef09f");
    expect(alias).not.toContain("9267b919");
    expect(await fs.readFile(path.join(alias, "AGENTS.md"), "utf8")).toBe("Read sibling.txt");
    // Atomic replacement through the directory alias reaches the original root.
    await fs.writeFile(path.join(alias, "new.txt"), "changed");
    await fs.rename(path.join(alias, "new.txt"), path.join(alias, "sibling.txt"));
    expect(await fs.readFile(path.join(source, "sibling.txt"), "utf8")).toBe("changed");
    expect(await readableRuntimePath(ctx, "instructions", source)).toBe(alias);
    const skills = await readableRuntimePath(ctx, "skills", source);
    expect(path.dirname(skills)).toBe(path.dirname(alias));
    await expect(readableRuntimePath(ctx, "instructions", temporary)).rejects.toThrow();
  });

  it("isolates concurrent runs of the same seat and confines alias names", async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-paths-"));
    vi.stubEnv("PAPERCLIP_HOME", temporary);
    const [first, second] = await Promise.all([
      readableRuntimePath(context(), "skills", temporary),
      readableRuntimePath(context(), "skills", temporary),
    ]);
    expect(first).not.toBe(second);
    await expect(readableRuntimePath(context(), "../escape", temporary)).rejects.toThrow("Invalid runtime path alias");
  });
});
