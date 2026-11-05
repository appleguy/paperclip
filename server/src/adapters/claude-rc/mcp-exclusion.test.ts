import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envBoundPaperclipServers, excludeEnvBoundMcp, withExclusion } from "./mcp-exclusion.js";

const CWD = "/Volumes/NVM/Paperclip/workspaces/claude-rc";
const base = () => ({
  numStartups: 7,
  oauthAccount: { a: 1 },
  mcpServers: {
    paperclip: { type: "stdio", command: "npx", args: ["-y", "@paperclipai/mcp-server"], env: { PAPERCLIP_API_KEY: "${PAPERCLIP_API_KEY}", PAPERCLIP_RUN_ID: "${PAPERCLIP_RUN_ID}" } },
    "gog-gmail": { type: "stdio", command: "/opt/homebrew/bin/gog", env: {} },
  },
  projects: { "/other": { allowedTools: [], disabledMcpServers: ["x"] }, [CWD]: { hasTrustDialogAccepted: true, disabledMcpjsonServers: ["keep"] } },
});

let dir: string;
let file: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "sco1033-")); file = path.join(dir, "claude.json"); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const write = (o: unknown) => fs.writeFile(file, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
const read = async () => JSON.parse(await fs.readFile(file, "utf8"));

describe("envBoundPaperclipServers (SCO-1033)", () => {
  it("selects only servers with ${PAPERCLIP_*} env refs", () => {
    expect(envBoundPaperclipServers(base())).toEqual(["paperclip"]);
    expect(envBoundPaperclipServers({})).toEqual([]);
  });
});

describe("withExclusion", () => {
  it("adds only the env-bound server to this cwd and preserves everything else", () => {
    const out = JSON.parse(withExclusion(JSON.stringify(base()), CWD)!);
    const expected = base() as any;
    expected.projects[CWD].disabledMcpServers = ["paperclip"];
    expect(out).toEqual(expected);
  });
  it("creates the project entry for a future cwd", () => {
    const out = JSON.parse(withExclusion(JSON.stringify(base()), "/new/seat")!);
    expect(out.projects["/new/seat"]).toEqual({ disabledMcpServers: ["paperclip"] });
  });
  it("keeps existing disabled entries and does not duplicate", () => {
    const b = base() as any;
    b.projects[CWD].disabledMcpServers = ["x", "paperclip"];
    expect(withExclusion(JSON.stringify(b), CWD)).toBeNull();
    b.projects[CWD].disabledMcpServers = ["x"];
    expect(JSON.parse(withExclusion(JSON.stringify(b), CWD)!).projects[CWD].disabledMcpServers).toEqual(["x", "paperclip"]);
  });
  it("is a no-op when no server is env-bound", () => {
    const b = base() as any;
    delete b.mcpServers.paperclip;
    expect(withExclusion(JSON.stringify(b), CWD)).toBeNull();
  });
});

describe("excludeEnvBoundMcp", () => {
  it("writes once, is idempotent, keeps file mode", async () => {
    await write(base());
    expect((await excludeEnvBoundMcp(CWD, file)).changed).toBe(true);
    const first = await fs.readFile(file, "utf8");
    expect((await read()).projects[CWD].disabledMcpServers).toEqual(["paperclip"]);
    expect((await excludeEnvBoundMcp(CWD, file)).changed).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(first);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dir)).sort()).toEqual(["claude.json"]);
  });
  it("does not throw on a missing or corrupt file", async () => {
    expect((await excludeEnvBoundMcp(CWD, file)).changed).toBe(false);
    await fs.writeFile(file, "{not json");
    expect((await excludeEnvBoundMcp(CWD, file)).changed).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("{not json");
  });
  it("two cwds applied in sequence both stick", async () => {
    await write(base());
    await excludeEnvBoundMcp(CWD, file);
    await excludeEnvBoundMcp("/seat/two", file);
    const c = await read();
    expect(c.projects[CWD].disabledMcpServers).toEqual(["paperclip"]);
    expect(c.projects["/seat/two"].disabledMcpServers).toEqual(["paperclip"]);
    expect(c.numStartups).toBe(7);
  });
});
