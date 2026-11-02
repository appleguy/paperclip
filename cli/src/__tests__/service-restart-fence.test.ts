import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(), delete: vi.fn(), restart: vi.fn(),
}));
vi.mock("../commands/client/common.js", () => ({
  resolveCommandContext: () => ({ api: { post: mocks.post, get: mocks.get, delete: mocks.delete } }),
}));
vi.mock("../services/service-manager.js", () => ({
  detectServiceManager: async () => ({ supported: true, manager: {
    status: async () => ({ pid: 123, serviceName: "test" }), restart: mocks.restart,
  } }),
}));
import { registerServiceCommands, restartManagedService } from "../commands/service.js";

let previousHome: string | undefined;
let tempHome: string;
beforeEach(async () => {
  vi.resetAllMocks();
  previousHome = process.env.PAPERCLIP_HOME;
  tempHome = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/restart-fence-");
  process.env.PAPERCLIP_HOME = tempHome;
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const hold = { ownerId: "test-owner", startedAt: new Date().toISOString(), expiresAt };
  mocks.post.mockResolvedValue(hold);
  mocks.get.mockResolvedValue({ ...hold, serverPid: 123, draining: true, pendingWakes: 0,
    upgradeReadiness: { blockingRuns: 1, pendingWakes: 0, truncated: false, draining: true } });
  mocks.delete.mockResolvedValue({});
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

it("describes --wait as a refusal, not an automatic wait", () => {
  const program = new Command();
  registerServiceCommands(program);
  const restart = program.commands.find(command => command.name() === "service")!.commands.find(command => command.name() === "restart")!;
  expect(restart.helpInformation().replace(/\s+/g, " ")).toContain("Do not interrupt active runs; retry after they finish (does not wait)");
});

it("signals only after the owned fence and global readiness are verified", async () => {
  const state = await mocks.get();
  mocks.get.mockResolvedValue({ ...state, upgradeReadiness: { blockingRuns: 0, pendingWakes: 0, truncated: false, draining: true } });
  mocks.restart.mockRejectedValue(new Error("simulated supervisor failure"));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "ok", serverVersion: "test" }) })));
  await expect(restartManagedService()).rejects.toThrow("simulated supervisor failure");
  expect(mocks.get).toHaveBeenCalledWith("/api/instance/task-drain?upgradeReadiness=1");
  expect(mocks.restart).toHaveBeenCalledOnce();
  expect(mocks.delete).not.toHaveBeenCalled();
});

it.each([
  { serverPid: 456 },
  { expiresAt: new Date(Date.now() + 1_000).toISOString() },
  { pendingWakes: 1 },
  { upgradeReadiness: { blockingRuns: 0, pendingWakes: 0, truncated: true, draining: true } },
])("rejects incomplete or changed readiness %#", async override => {
  const state = await mocks.get();
  mocks.get.mockResolvedValue({ ...state, ...override });
  await expect(restartManagedService()).rejects.toThrow("Restart refused");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledWith("/api/instance/task-drain?ownerId=test-owner");
});

it.each([false, true])("refuses active nonrecoverable work and releases only its own fence (wait=%s)", async waitForDrain => {
  await expect(restartManagedService({ waitForDrain })).rejects.toThrow("Restart refused");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledWith("/api/instance/task-drain?ownerId=test-owner");
  await expect(fs.stat(path.join(tempHome, "instances/default/hot-restart-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a changed owner before signalling", async () => {
  const state = await mocks.get();
  mocks.get.mockResolvedValue({ ...state, ownerId: "foreign" });
  await expect(restartManagedService()).rejects.toThrow("Restart refused");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledWith("/api/instance/task-drain?ownerId=test-owner");
});

it("releases an owned fence when the acquisition response is incomplete", async () => {
  mocks.post.mockResolvedValue({ ownerId: "test-owner" });
  await expect(restartManagedService()).rejects.toThrow("Restart refused");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledWith("/api/instance/task-drain?ownerId=test-owner");
});

it("does not release a fence without an established owner", async () => {
  mocks.post.mockResolvedValue({ startedAt: new Date().toISOString() });
  await expect(restartManagedService()).rejects.toThrow("Restart refused");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).not.toHaveBeenCalled();
});

it("releases its own fence if the readiness read fails", async () => {
  mocks.get.mockRejectedValue(new Error("readiness unavailable"));
  await expect(restartManagedService()).rejects.toThrow("readiness unavailable");
  expect(mocks.restart).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledWith("/api/instance/task-drain?ownerId=test-owner");
});
