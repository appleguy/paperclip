import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { agents, companies, connectionGrants, createDb, projects, startEmbeddedPostgresTestDatabase, toolConnections } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";
import { resolveCurrentCodexSharedRegistration } from "./codex-shared-registration.js";

vi.mock("./codex-shared-daemon.js", () => ({ inspectCodexSharedDaemon: vi.fn() }));

it("serializes concurrent resolver calls and retires an expired grant", async () => {
  const database = await startEmbeddedPostgresTestDatabase("codex-shared-resolver-");
  const db = createDb(database.connectionString);
  try {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: "CSR" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "paperclip_runner" });
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue({ socketPath: "/socket", codexHome: "/codex", cliVersion: "0.166.0", appServerVersion: "0.166.0", daemonGeneration: "one", peer: { pid: 1, startSeconds: 1, startMicroseconds: 1, executable: "/codex" } });
    const env = { PAPERCLIP_CODEX_SHARED_DEFAULT: "1", PAPERCLIP_CODEX_SHARED_HOST_ID: "host", PAPERCLIP_CODEX_SHARED_EXECUTABLE: "/codex", PAPERCLIP_CODEX_SHARED_CODEX_HOME: "/codex", PAPERCLIP_CODEX_SHARED_HOME: "/home", PAPERCLIP_CODEX_SHARED_ISSUER_USER_ID: "board" };
    const resolve = () => resolveCurrentCodexSharedRegistration(env, db, companyId, agentId, "/runner", async () => projectId, { model: "model", effort: "high" });
    const results = await Promise.all([resolve(), resolve(), resolve()]);
    expect(new Set(results.map(result => result?.grantId)).size).toBe(1);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, results[0]!.grantId));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, grant!.connectionId));
    await db.update(toolConnections).set({ config: { ...connection!.config, codexNativeDelegation: { ...(connection!.config.codexNativeDelegation as object), expiresAt: new Date(1).toISOString() } } }).where(eq(toolConnections.id, connection!.id));
    const renewed = await Promise.all([resolve(), resolve()]);
    expect(renewed[0]!.grantId).not.toBe(grant!.id);
    expect(renewed[0]!.grantId).toBe(renewed[1]!.grantId);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id)))[0]!.status).toBe("revoked");
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id)))[0]!.enabled).toBe(false);
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue({ socketPath: "/socket", codexHome: "/codex", cliVersion: "0.166.0", appServerVersion: "0.166.0", daemonGeneration: "two", peer: { pid: 2, startSeconds: 2, startMicroseconds: 1, executable: "/codex" } });
    const rotated = await Promise.all([resolve(), resolve()]);
    expect(rotated[0]!.grantId).toBe(rotated[1]!.grantId);
    expect(rotated[0]!.grantId).not.toBe(renewed[0]!.grantId);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, renewed[0]!.grantId)))[0]!.status).toBe("revoked");
  } finally {
    await db.$client.end();
    await database.cleanup();
  }
}, 60000);
