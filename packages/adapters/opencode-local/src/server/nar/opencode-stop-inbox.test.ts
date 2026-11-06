import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpDriver } from "./opencode-http-driver.js";

describe("OpenCode stop inbox cancellation", () => {
  let dir: string;
  let pending: string[];
  let active: string | null;
  let deliveredDuringCancel: boolean;
  let cancellationFails: boolean;
  let targetRecorded: boolean;
  let idleAt: number | undefined;
  let calls: string[];
  let driver: OpenCodeHttpDriver;
  const op = { opId: "stop", kind: "interrupt" as const, payloadSha256: "" };
  const fence = { runId: "run", leaseGeneration: 1, hostEpoch: 1 };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "opencode-stop-"));
    const passwordFile = path.join(dir, "password");
    await writeFile(passwordFile, "fixture");
    pending = [];
    active = null;
    deliveredDuringCancel = false;
    cancellationFails = false;
    targetRecorded = true;
    idleAt = 2;
    calls = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(`${init?.method} ${pathname}`);
      if (pathname.endsWith("/inbox") && init?.method === "GET") return Response.json({ data: pending.map((id) => ({ id })) });
      if (pathname.includes("/inbox/") && init?.method === "DELETE") {
        if (cancellationFails) return new Response(null, { status: 500 });
        const id = decodeURIComponent(pathname.split("/").pop()!);
        pending = pending.filter((item) => item !== id);
        if (deliveredDuringCancel) active = id;
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/session/active") return Response.json({ data: active ? { ses_fixture: { type: "running" } } : {} });
      if (pathname.endsWith("/message")) return Response.json({ data: active ? [{ id: active, type: "user", time: { created: 1 } }] : [] });
      if (pathname.endsWith("/message/msg_target")) return targetRecorded
        ? Response.json({ data: { id: "msg_target", type: "user", time: { created: 1 } } }) : new Response(null, { status: 404 });
      if (pathname === "/api/session/ses_fixture") return Response.json({ data: { time: { idle: idleAt }, outcome: "interrupted" } });
      if (pathname.endsWith("/interrupt")) return Response.json({ interrupted: true });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    driver = new OpenCodeHttpDriver({ url: "http://127.0.0.1:4096", passwordFile, fetchImpl });
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("cancels only the target queued item without interrupting another turn", async () => {
    pending = ["msg_other", "msg_target"];
    active = "msg_active";
    expect(await driver.interruptExpectedMessage("ses_fixture", "msg_target", op, fence)).toBe("idle");
    expect(pending).toEqual(["msg_other"]);
    expect(calls).toContain("DELETE /api/session/ses_fixture/inbox/msg_target");
    expect(calls.some((call) => call.endsWith("/interrupt"))).toBe(false);
  });

  it("holds if the target was delivered during cancellation", async () => {
    pending = ["msg_target"];
    deliveredDuringCancel = true;
    expect(await driver.interruptExpectedMessage("ses_fixture", "msg_target", op, fence)).toBe("uncertain");
    expect(calls.some((call) => call.endsWith("/interrupt"))).toBe(false);
  });

  it("does not interrupt an unrelated active turn when queued cancellation fails", async () => {
    pending = ["msg_target"];
    active = "msg_other";
    cancellationFails = true;
    expect(await driver.interruptExpectedMessage("ses_fixture", "msg_target", op, fence)).toBe("uncertain");
    expect(pending).toEqual(["msg_target"]);
    expect(calls.some((call) => call.endsWith("/interrupt"))).toBe(false);
  });

  it("holds a matching active turn when conditional interrupt is unavailable", async () => {
    active = "msg_target";
    expect(await driver.interruptExpectedMessage("ses_fixture", "msg_target", op, fence)).toBe("uncertain");
    expect(calls.some((call) => call.startsWith("DELETE "))).toBe(false);
    expect(calls.some((call) => call.endsWith("/interrupt"))).toBe(false);
  });

  it("does not interrupt a different active turn", async () => {
    active = "msg_successor";
    expect(await driver.interruptExpectedMessage("ses_fixture", "msg_target", op, fence)).toBe("idle");
    expect(calls.some((call) => call.endsWith("/interrupt"))).toBe(false);
  });

  it("requires an idle session and an observed target outcome to verify an uncertain stop", async () => {
    expect(await driver.verifyStoppedMessage("ses_fixture", "msg_target")).toBe(true);
    active = "msg_successor";
    expect(await driver.verifyStoppedMessage("ses_fixture", "msg_target")).toBe(false);
    active = null;
    pending = ["msg_target"];
    expect(await driver.verifyStoppedMessage("ses_fixture", "msg_target")).toBe(false);
    pending = [];
    idleAt = undefined;
    expect(await driver.verifyStoppedMessage("ses_fixture", "msg_target")).toBe(false);
    idleAt = 2;
    targetRecorded = false;
    expect(await driver.verifyStoppedMessage("ses_fixture", "msg_target")).toBe(false);
  });
});
