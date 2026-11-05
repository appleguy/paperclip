import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { acquireSessionAdvisoryLock, closeRegisteredClients, createDb } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describeEmbeddedPostgres("acquireSessionAdvisoryLock", () => {
  async function setup() {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-session-lock-");
    cleanups.push(database.cleanup);
    cleanups.push(() => closeRegisteredClients(database.connectionString));
    return { url: database.connectionString, a: createDb(database.connectionString), b: createDb(database.connectionString) };
  }

  it("admits one holder at a time and hands over on release", async () => {
    const { a, b } = await setup();
    const first = await acquireSessionAdvisoryLock(a, "test:leader", { retryMs: 20 });

    const abort = new AbortController();
    const blocked = acquireSessionAdvisoryLock(b, "test:leader", { retryMs: 20, signal: abort.signal });
    const outcome = await Promise.race([blocked.then(() => "acquired", () => "rejected"), new Promise((r) => setTimeout(() => r("waiting"), 200))]);
    expect(outcome).toBe("waiting");

    await first.release();
    const second = await blocked;
    await second.release();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects a waiter when its signal aborts, leaving the holder intact", async () => {
    const { a, b } = await setup();
    const holder = await acquireSessionAdvisoryLock(a, "test:leader", { retryMs: 20 });
    const abort = new AbortController();
    const waiting = acquireSessionAdvisoryLock(b, "test:leader", { retryMs: 20, signal: abort.signal });
    setTimeout(() => abort.abort(new Error("stop")), 60);
    await expect(waiting).rejects.toThrow("stop");
    const again = acquireSessionAdvisoryLock(b, "test:leader", { retryMs: 20, signal: AbortSignal.timeout(100) });
    await expect(again).rejects.toBeDefined();
    await holder.release();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("reports loss when the holding connection is terminated", async () => {
    const { url, a, b } = await setup();
    const lost = new Promise<unknown>((resolve) => {
      void acquireSessionAdvisoryLock(a, "test:leader", { retryMs: 20, heldCheckMs: 30, onLost: resolve });
    });
    const admin = postgres(url, { max: 1 });
    try {
      await new Promise((r) => setTimeout(r, 150));
      await admin`SELECT pg_terminate_backend(l.pid) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> pg_backend_pid()`;
      expect(await lost).toBeDefined();
      const next = await acquireSessionAdvisoryLock(b, "test:leader", { retryMs: 20, signal: AbortSignal.timeout(2000) });
      await next.release();
    } finally {
      await admin.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
