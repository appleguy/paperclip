import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeSessionAuthorityStore, type AuthorityActor, type AuthoritySnapshot, type WriterGrant } from "./native-session-authority.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const scratchRoot = process.env.PAPERCLIP_TMPDIR ?? process.env.TMPDIR;
if (!scratchRoot) throw new Error("Set TMPDIR to the authorized test scratch directory");

function grant(row: AuthoritySnapshot): WriterGrant {
  return { authorityId: row.id, generation: row.generation, hostEpoch: row.hostEpoch,
    controllerId: row.controllerId!, gatewayIncarnation: row.gatewayIncarnation! };
}
const hostId = randomUUID();
const identity = (id = randomUUID()) => ({ provider: "codex", hostId, hostEpoch: "epoch-a", provisionalId: id });
const claim = (row: AuthoritySnapshot, controllerId = "controller-a") => ({
  authorityId: row.id, hostEpoch: row.hostEpoch, generation: row.generation,
  controllerId, gatewayIncarnation: "gateway-a",
});

for (const backend of ["postgres", "pglite"] as const) {
  (backend === "postgres" && !support.supported ? describe.skip : describe)(`native session authority: ${backend}`, () => {
    let clients: [Sql, Sql];
    let connect: () => [Sql, Sql];
    let cleanup: () => Promise<void>;
    let restart: (() => Promise<void>) | undefined;
    const stores = () => clients.map((client) => createNativeSessionAuthorityStore(client));

    beforeAll(async () => {
      if (backend === "postgres") {
        const db = await startEmbeddedPostgresTestDatabase("n9-authority-");
        connect = () => [postgres(db.connectionString, { max: 1 }), postgres(db.connectionString, { max: 1 })];
        cleanup = db.cleanup;
      } else {
        // Independent TCP clients of one persistent PGlite instance. Two separate
        // in-memory databases or two handles to one JS transaction are not a race.
        await mkdir(scratchRoot, { recursive: true });
        const root = await mkdtemp(path.join(scratchRoot, "n9-pglite-"));
        let pg = await PGlite.create(path.join(root, "db"));
        let socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 4 });
        await socket.start();
        connect = () => [0, 1].map(() => postgres(`postgres://postgres:postgres@${socket.getServerConn()}/postgres`, {
          max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0,
        })) as [Sql, Sql];
        clients = connect();
        // Only the three FK parents are stubbed. The exact generated authority
        // migration and real store/transactions are exercised on both engines.
        await clients[0].unsafe(`CREATE TABLE companies (id uuid PRIMARY KEY, name text, issue_prefix text);
          CREATE TABLE agents (id uuid PRIMARY KEY, company_id uuid, name text, role text, adapter_type text);
          CREATE TABLE heartbeat_runs (id uuid PRIMARY KEY, company_id uuid, agent_id uuid, status text);`);
        const migration = await readFile(new URL("./migrations/0404_material_sue_storm.sql", import.meta.url), "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await clients[0].unsafe(statement);
        }
        restart = async () => {
          await socket.stop();
          await pg.close();
          pg = await PGlite.create(path.join(root, "db"));
          socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 4 });
          await socket.start();
        };
        cleanup = async () => { await socket.stop(); await pg.close(); };
        // Scratch is retained for failure diagnosis under the owner's scratch
        // quarantine policy; no text or live database is deleted by this suite.
      }
      clients ??= connect();
      await Promise.all(clients.map((client) => client`SELECT 1`));
    }, 90_000);

    afterAll(async () => {
      if (clients) await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
      await cleanup?.();
    });

    async function actors(): Promise<[AuthorityActor, AuthorityActor, AuthorityActor]> {
      const companyId = randomUUID();
      const otherCompany = randomUUID();
      await clients[0]`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${companyId}, 'N9 test', ${`N${companyId.slice(0, 6)}`}),
        (${otherCompany}, 'N9 isolation', ${`N${otherCompany.slice(0, 6)}`})`;
      const result: AuthorityActor[] = [];
      for (const company of [companyId, companyId, otherCompany]) {
        const agentId = randomUUID(), runId = randomUUID();
        await clients[0]`INSERT INTO agents (id, company_id, name, role, adapter_type)
          VALUES (${agentId}, ${company}, 'N9 agent', 'engineer', 'paperclip_runner')`;
        await clients[0]`INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
          VALUES (${runId}, ${company}, ${agentId}, 'running')`;
        result.push({ companyId: company, agentId, runId });
      }
      return result as [AuthorityActor, AuthorityActor, AuthorityActor];
    }

    it("arbitrates independent racing clients, reserves before ACK, and rejects late old ACKs", async () => {
      const [a, b] = await actors();
      const [s1, s2] = stores();
      if (backend === "postgres") {
        const pids = await Promise.all(clients.map((c) => c`SELECT pg_backend_pid() AS pid`));
        expect(pids[0][0].pid).not.toBe(pids[1][0].pid);
      }
      const same = identity();
      const provisions = await Promise.all([s1.provision(a, same), s2.provision(b, same)]);
      expect(provisions[0].id).toBe(provisions[1].id);
      expect((await s2.provision(b, { ...same, provider: "codex_app_server", hostId: hostId.toUpperCase() })).id).toBe(provisions[0].id);
      await expect(s1.provision(a, { ...same, provider: "acpx" })).rejects.toMatchObject({ code: "identity" });
      await expect(s1.provision(a, { ...same, hostId: "localhost" })).rejects.toMatchObject({ code: "identity" });
      const race = await Promise.allSettled([
        s1.reserve(a, claim(provisions[0], "a")), s2.reserve(b, claim(provisions[1], "b")),
      ]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: "grant" });
      const winner = race.findIndex((r) => r.status === "fulfilled");
      const actor = [a, b][winner], other = [b, a][winner];
      const row = (race[winner] as PromiseFulfilledResult<AuthoritySnapshot>).value;
      expect(row).toMatchObject({ generation: "1", state: "installing" });
      const first = grant(row);
      await s1.acknowledge(actor, first, "fence-installed-1");
      await s2.acknowledge(actor, first, "fence-installed-1"); // lost ACK retry
      const second = await s2.reserve(other, claim(await s1.read(actor, row.id), "successor"));
      expect(second).toMatchObject({ generation: "2", state: "installing" });
      await expect(s1.acknowledge(actor, first, "late-old-ack")).rejects.toMatchObject({ code: "grant" });
      await expect(s1.release(actor, first, "late-old-release")).rejects.toMatchObject({ code: "grant" });
      await s2.acknowledge(other, grant(second), "fence-installed-2");
      expect(await s1.read(actor, row.id)).toMatchObject({ generation: "2", state: "active" });
    }, 30_000);

    it("binds canonical provider identity atomically and rejects aliases without merging grants", async () => {
      const [a, b, foreign] = await actors();
      const [s1, s2] = stores();
      const shared = identity();
      const rows = await Promise.all([s1.provision(a, shared), s2.provision(b, identity())]);
      const reserved = await Promise.all([s1.reserve(a, claim(rows[0], "a")), s2.reserve(b, claim(rows[1], "b"))]);
      const providerId = randomUUID();
      const bound = await Promise.allSettled([
        s1.bindProvider(a, grant(reserved[0]), providerId, "bind-a"),
        s2.bindProvider(b, grant(reserved[1]), providerId, "bind-b"),
      ]);
      expect(bound.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((bound.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "identity" });
      const canonical = await s1.findProvider(a, shared.provider, shared.hostId, providerId);
      expect(canonical?.providerSessionId).toBe(providerId);
      await expect(s1.provision(a, { ...shared, hostEpoch: "invented-epoch" })).rejects.toMatchObject({ code: "identity" });
      await expect(s1.read(foreign, rows[0].id)).rejects.toMatchObject({ code: "not_found" });
      await expect(s1.reserve({ ...a, runId: b.runId }, claim(rows[0]))).rejects.toMatchObject({ code: "actor" });
      const otherScope = await s1.provision(foreign, shared);
      await s1.bindProvider(foreign, grant(await s1.reserve(foreign, claim(otherScope))), providerId, "separate-company");
      expect((await s1.findProvider(foreign, shared.provider, shared.hostId, providerId))?.id).not.toBe(canonical?.id);
    }, 30_000);

    it("retains unknown and installing across restart; recovery requires exact settled receipt and never reuses a generation", async () => {
      const [a, b] = await actors();
      let [s1, s2] = stores();
      const row = await s1.reserve(a, claim(await s1.provision(a, identity())));
      const pending = await s2.reserve(b, claim(await s2.provision(b, identity()), "pending"));
      await s1.markUnknown(a, grant(row), "unresolved-effect");
      await Promise.all(clients.map((c) => c.end({ timeout: 2 })));
      await restart?.(); // PGlite closes/reopens its persistent engine, not just store handles.
      clients = connect();
      [s1, s2] = stores();
      expect(await s2.read(b, row.id)).toMatchObject({ state: "unknown", generation: "1" });
      expect(await s1.read(a, pending.id)).toMatchObject({ state: "installing", generation: "1" });
      await expect(s2.reserve(b, claim(await s2.read(b, row.id)))).rejects.toMatchObject({ code: "grant" });
      await expect(s1.acknowledge(a, grant(row), "unproven-restart-ack")).rejects.toMatchObject({ code: "grant" });
      await expect(s2.reconcileSettled(b, { ...grant(row), gatewayIncarnation: "wrong-gateway" }, "bad-proof")).rejects.toMatchObject({ code: "grant" });
      const settled = await s2.reconcileSettled(b, grant(row), "exclusive-gateway-settled");
      const next = await s2.reserve(b, { ...claim(settled, "recovered"), gatewayIncarnation: "gateway-b" });
      expect(next).toMatchObject({ generation: "2", state: "installing" });
      await expect(s1.reconcileSettled(a, grant(row), "late-proof")).rejects.toMatchObject({ code: "grant" });
    }, 30_000);

    it("rolls back a grant when durable audit fails and handles generations beyond JS integer precision", async () => {
      const [a] = await actors();
      const [s1] = stores();
      const row = await s1.provision(a, identity());
      await clients[0]`ALTER TABLE native_session_authority_events ADD CONSTRAINT n9_audit_fault CHECK (action <> 'reserve') NOT VALID`;
      try {
        await expect(s1.reserve(a, claim(row))).rejects.toMatchObject({ code: "23514" });
        expect(await s1.read(a, row.id)).toMatchObject({ generation: "0", state: "free" });
      } finally {
        await clients[0]`ALTER TABLE native_session_authority_events DROP CONSTRAINT n9_audit_fault`;
      }
      await clients[0]`UPDATE native_session_authorities SET generation = 9007199254740992 WHERE id = ${row.id}`;
      const next = await s1.reserve(a, { ...claim(row), generation: "9007199254740992" });
      expect(next.generation).toBe("9007199254740993");
      const history = await clients[1]`SELECT action FROM native_session_authority_events WHERE authority_id = ${row.id} ORDER BY created_at, id`;
      expect(history.map((r) => r.action)).toEqual(["provision", "reserve"]);
    }, 30_000);
  });
}
