import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, type Db, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("./execute.js", async importOriginal => ({
  ...await importOriginal<typeof import("./execute.js")>(),
  applySeatSettings: (...args: unknown[]) => fake.apply(...args),
}));

import { reconcileSeatSettings } from "./execute.js";
import { attemptPending, clearDispatchApplied, pendingMarkers, recordSettingsChange, retryPending, settingsReconciler } from "./pending-settings.js";
import { createAgentLifecycle } from "../../services/agent-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping Claude RC settings database tests: ${support.reason}`);

describeDb("Claude RC pending settings", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let dir: string;
  let id: string;
  let cfg: Record<string, unknown>;
  let screen: string;
  let commands: string[];
  let reconciler: ReturnType<typeof settingsReconciler>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-rc-settings-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1010-pending-");
    const [company] = await db.insert(companies).values({ name: "RC fixture", issuePrefix: `R${randomUUID().slice(0, 7)}` }).returning();
    cfg = { stateDir: dir, tmuxSession: "fixture", model: "claude-sonnet-5-5", effort: "high" };
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "RC fixture", adapterType: "claude_rc_local", adapterConfig: cfg }).returning();
    id = agent!.id;
    screen = "❯ \n  bypass permissions on";
    commands = [];
    fake.apply.mockReset();
    fake.apply.mockImplementation(async (_socket: string, _session: string, stateDir: string, model: string, effort: string) =>
      reconcileSeatSettings({ stateDir, identity: "same-process", launchModel: "claude-sonnet-5-5", launchEffort: "high", model, effort,
        screen: async () => screen, submit: async command => { commands.push(command); return true; } }));
    reconciler = settingsReconciler(db);
  });
  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function change(model = "claude-opus-5-5", effort = "xhigh", throughService = false) {
    cfg = { ...cfg, model, effort };
    if (throughService) await createAgentLifecycle(db).updateConfiguration(id, { adapterConfig: cfg });
    else await db.transaction(async tx => {
      const [before] = await tx.select().from(agents).where(eq(agents.id, id)).for("no key update");
      const [after] = await tx.update(agents).set({ adapterConfig: cfg }).where(eq(agents.id, id)).returning();
      await recordSettingsChange(before!, after!);
    });
  }

  it("records a busy update, then applies it once after completion and an idle prompt", async () => {
    await fs.writeFile(path.join(dir, "active.json"), "{}");
    screen = "✻ Synthesizing… (esc to …)\n❯ \n  bypass permissions on";
    await change("claude-opus-5-5", "xhigh", true);
    expect(await pendingMarkers(dir)).toHaveLength(1);
    expect(await reconciler.attemptAgent(id)).toBe(false);
    expect(commands).toEqual([]);
    await fs.rm(path.join(dir, "active.json"));
    expect(await reconciler.attemptAgent(id)).toBe(false);
    expect(commands).toEqual([]);
    await retryPending(() => attemptPending(dir, () => reconciler.inspect(id, dir)), async () => { screen = "❯ \n  bypass permissions on"; });
    expect(commands).toEqual(["/model claude-opus-5-5", "/effort xhigh"]);
    expect(await pendingMarkers(dir)).toHaveLength(0);
    await reconciler.attemptAgent(id);
    expect(commands).toHaveLength(2);
  });

  it("rescans a durable pending change at boot", async () => {
    await fs.writeFile(path.join(dir, "active.json"), "{}");
    await change("claude-sonnet-5-5", "xhigh");
    await fs.rm(path.join(dir, "active.json"));
    await settingsReconciler(db).boot();
    expect(commands).toEqual(["/effort xhigh"]);
    expect(await pendingMarkers(dir)).toHaveLength(0);
  });

  it("clears a dispatch-applied intent only when the current config matches", async () => {
    await fs.writeFile(path.join(dir, "active.json"), "{}");
    await change("claude-sonnet-5-5", "xhigh");
    await clearDispatchApplied(() => reconciler.inspect(id, dir), { model: "claude-sonnet-5-5", effort: "high" });
    expect(await pendingMarkers(dir)).toHaveLength(1);
    await fake.apply("pc-claude-rc", "fixture", dir, "claude-sonnet-5-5", "xhigh");
    await clearDispatchApplied(() => reconciler.inspect(id, dir), { model: "claude-sonnet-5-5", effort: "xhigh" });
    await fs.rm(path.join(dir, "active.json"));
    await reconciler.attemptAgent(id);
    expect(await pendingMarkers(dir)).toHaveLength(0);
    expect(commands).toEqual(["/effort xhigh"]);
  });

  it("does not clear an intent created by a concurrent config transaction", async () => {
    await fs.writeFile(path.join(dir, "active.json"), "{}");
    await change("claude-sonnet-5-5", "xhigh");
    const snapshot = await reconciler.inspect(id, dir);
    await change("claude-opus-5-5", "max");
    await clearDispatchApplied(async () => snapshot, { model: "claude-sonnet-5-5", effort: "xhigh" });
    expect(await pendingMarkers(dir)).toHaveLength(1);
    expect((await db.select().from(agents).where(eq(agents.id, id)))[0]?.adapterConfig).toMatchObject({ effort: "max" });
  });

  it("waits for a config transaction before snapshotting its pending intent", async () => {
    let release!: () => void;
    let written!: () => void;
    const ready = new Promise<void>(resolve => { written = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const update = db.transaction(async tx => {
      const [before] = await tx.select().from(agents).where(eq(agents.id, id)).for("no key update");
      const [after] = await tx.update(agents).set({ adapterConfig: { ...cfg, effort: "xhigh" } }).where(eq(agents.id, id)).returning();
      await recordSettingsChange(before!, after!);
      written();
      await gate;
    });
    await ready;
    let finished = false;
    const snapshot = reconciler.inspect(id, dir).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    release();
    await update;
    const result = await snapshot;
    expect(result.agent?.adapterConfig).toMatchObject({ effort: "xhigh" });
    expect(result.pending).toHaveLength(1);
  });
});
