import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { verifyOwned, jsonRequest, pauseOwned, selectStaleUnowned, reclaimOrphan,
  interruptStaleUnowned, waitForRestartReady, retryHealthyIdentity, stableDeployOwner } from "./deploy-drain.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const issue = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const url = "http://127.0.0.1:19403";
const cwd = "/Volumes/NVM/Paperclip/workspaces/test";
const sid = "ses_verified_live_12345";
const run = { id, issueId: issue, agentId, status: "running" };
const agent = { adapterType: "opencode_local", url, cwd };
const binding = { version: 1, agentId, taskId: issue, runId: id, sessionId: sid, url, cwd };
const plan = (runs = [run], bindings = [binding], active = { [sid]: { type: "busy" } }) =>
  verifyOwned(runs, new Map([[agentId, agent]]), bindings, new Map([[url, active]]));

describe("orphan deploy fence recovery", () => {
  it("waits past the birth-time resolution and rejects a changed parent or birth", async () => {
    let pid = 123;
    let birth = "original";
    let waited = 0;
    const parent = () => pid;
    const identity = processId => ({ pid: processId, birth });
    const wait = async ms => { waited = ms; };
    assert.deepEqual(await stableDeployOwner(parent, identity, wait), { pid: 123, birth: "original" });
    assert.ok(waited > 1000);
    await assert.rejects(stableDeployOwner(parent, identity, async () => { pid = 1; }), /shell changed/);
    pid = 123;
    await assert.rejects(stableDeployOwner(parent, identity, async () => { birth = "replacement"; }), /shell changed/);
  });
  it("reclaims only a matching dead owner, retaining live, unrelated, and replaced fences", async () => {
    const dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1020-test-");
    const original = { draining: true, startedAt: "2020-01-01T00:00:00.000Z", serverPid: 123 };
    await fs.writeFile(dir + "/pc-deploy-drain-456.json", JSON.stringify({ schema: 1,
      startedAt: original.startedAt, serverPid: original.serverPid }));
    const calls = [];
    let state = original;
    let reads = 0;
    const client = { api: async method => {
      calls.push(method);
      if (method === "DELETE") return {};
      reads++;
      return state;
    } };
    assert.equal(await reclaimOrphan(client, dir, () => true), false);
    assert.deepEqual(calls, ["GET"]);
    calls.length = 0;
    state = { ...original, ownerId: "other" };
    assert.equal(await reclaimOrphan(client, dir, () => false), false);
    assert.deepEqual(calls, ["GET"]);
    calls.length = 0;
    reads = 0;
    state = original;
    const changed = { api: async method => {
      calls.push(method);
      return ++reads === 1 ? original : { ...original, startedAt: "different" };
    } };
    assert.equal(await reclaimOrphan(changed, dir, () => false), false);
    assert.deepEqual(calls, ["GET", "GET"]);
    calls.length = 0;
    assert.equal(await reclaimOrphan(client, dir, () => false), true);
    assert.deepEqual(calls, ["GET", "GET", "DELETE"]);
  });
});

describe("live deploy session isolation", () => {
  it("continues after its launcher's process group is killed", async () => {
    const dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1020-session-");
    const source = await fs.readFile("/Volumes/NVM/Paperclip/bin/pc-deploy", "utf8");
    const prefix = source.split("# Self-copy:")[0];
    assert.match(prefix, /POSIX::setsid/);
    const fixture = dir + "/deploy.sh";
    await fs.writeFile(fixture, prefix + '\nprintf ready > "$1/ready"\nsleep 2\nprintf survived > "$1/result"\n');
    const child = spawn("/bin/sh", [fixture, dir], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await fs.stat(dir + "/ready").then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await fs.stat(dir + "/ready");
    process.kill(-child.pid, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 2400));
    assert.equal(await fs.readFile(dir + "/result", "utf8"), "survived");
  });
});

describe("deploy drain exact ownership and fail-closed rules", () => {
  it("selects only a run-owned active OpenCode session", () => {
    assert.deepEqual(plan(), [{
      runId: id, issueId: issue, agentId, taskId: issue, sessionId: sid, url, active: true, state: "planned",
    }]);
  });
  it("retains the same durable binding when OpenCode is already idle", () => {
    assert.equal(plan([run], [binding], { [sid]: { type: "idle" } })[0].active, false);
  });
  it("ignores an unowned active server session: a Paperclip restart does not touch it", () => {
    assert.deepEqual(plan([run], [binding], {
      [sid]: { type: "busy" }, ses_unowned_live_45678: { type: "busy" },
    }).map(item => item.sessionId), [sid]);
  });
  const lost = { runId: id, issueId: issue, agentId, taskId: null, sessionId: null, url: null,
    active: false, state: "restart-lost" };
  it("marks pre-journal and stale run mappings restart-lost instead of waiting", () => {
    assert.deepEqual(plan([run], []), [lost]);
    assert.deepEqual(plan([run], [{ ...binding, runId: "44444444-4444-4444-8444-444444444444" }]), [lost]);
  });
  it("refuses a binding belonging to another issue or server", () => {
    assert.throws(() => plan([run], [{ ...binding, taskId: id }]), /journal task\/session identity/);
    assert.throws(() => plan([run], [{ ...binding, url: "http://127.0.0.1:19404" }]),
      /server\/workspace identity/);
  });
  it("refuses contradictory duplicated session claims", () => {
    const run2 = { ...run, id: "55555555-5555-4555-8555-555555555555" };
    const binding2 = { ...binding, runId: run2.id };
    assert.throws(() => plan([run, run2], [binding, binding2]), /two runs claim one session/);
  });
  it("never interrupts non-OpenCode runs; they are restart-lost and recovered server-side", () => {
    const agents = new Map([[agentId, { adapterType: "claude_local", url: null, cwd: null }]]);
    assert.deepEqual(verifyOwned([run], agents, [binding], new Map()), [lost]);
  });
  it("never selects a session with an invalid ID or mismatched workspace", () => {
    assert.throws(() => plan([run], [{ ...binding, sessionId: "invalid" }]), /journal task\/session identity/);
    assert.throws(() => plan([run], [{ ...binding, cwd: "/different" }]), /server\/workspace identity/);
  });
  it("fails closed for malformed provider inventory", () => {
    assert.throws(() => verifyOwned([run], new Map([[agentId, agent]]), [binding], new Map([[url, null]])),
      /unverifiable provider/);
  });
});

describe("pre-L2 stale orphan reconciliation", () => {
  const orphan = "ses_orphan_pre_l2_45678";
  const at = 1_800_000;
  const active = new Map([[url, { [orphan]: { type: "busy" } }]]);
  const details = new Map([[url + "/" + orphan, { time: { updated: at - 180_001 } }]]);
  const candidate = (runs = [], agents = new Map(), bindings = [], journals = new Set(), data = details) =>
    selectStaleUnowned(active, data, runs, agents, bindings, journals, at);

  it("selects only a running unowned and unjournaled session older than 3 minutes", () => {
    assert.deepEqual(candidate(), [{ url, sessionId: orphan, updatedAt: at - 180_001, state: "planned" }]);
    assert.equal(candidate([], new Map(), [], new Set([url + "/" + orphan])).length, 0);
    assert.equal(candidate([run], new Map([[agentId, agent]]), []).length, 0);
    assert.equal(candidate([run], new Map([[agentId, agent]]), [binding]).length, 1);
    assert.equal(candidate([], new Map(), [], new Set(), new Map([
      [url + "/" + orphan, { time: { updated: at - 179_999 } }],
    ])).length, 0);
    assert.equal(candidate([], new Map(), [], new Set(), new Map([
      [url + "/" + orphan, { time: { updated: "stale" } }],
    ])).length, 0);
  });
  it("selects a fresh zombie whose only journal owner run is no longer running", () => {
    const fresh = new Map([[url + "/" + orphan, { time: { updated: at - 1_000 } }]]);
    const zombieBinding = { ...binding, sessionId: orphan, runId: "44444444-4444-4444-8444-444444444444" };
    assert.deepEqual(candidate([], new Map(), [zombieBinding], new Set([url + "/" + orphan]), fresh),
      [{ url, sessionId: orphan, updatedAt: at - 1_000, state: "planned", zombie: true }]);
    assert.equal(candidate([run], new Map([[agentId, agent]]), [{ ...zombieBinding, runId: id }],
      new Set([url + "/" + orphan]), fresh).length, 0);
  });
  it("rejects malformed active status and does not treat retry as interruptible", () => {
    assert.throws(() => selectStaleUnowned(new Map([[url, null]]), details, [], new Map(), [], new Set(), at),
      /unverifiable/);
    assert.equal(selectStaleUnowned(new Map([[url, { [orphan]: { type: "retry" } }]]),
      details, [], new Map(), [], new Set(), at).length, 0);
  });
  it("persists intent before exact interrupt, acknowledges and observes idle", async () => {
    const items = candidate();
    const steps = [];
    const p = new Map([[url, { request: async (method, uri) => {
      steps.push(method + " " + uri);
      return method === "POST" ? { interrupted: true } : {};
    } }]]);
    await interruptStaleUnowned(items, p, async item => {
      steps.push("persist:" + item.state);
    }, async item => {
      assert.equal(item.sessionId, orphan); steps.push("revalidated");
    });
    assert.deepEqual(steps, [
      "revalidated", "persist:planned", "POST /session/" + orphan + "/interrupt",
      "persist:interrupt-acknowledged", "GET /session/active", "persist:interrupted-and-idle",
    ]);
  });
});

describe("concurrent kickstart during preflight pacing", () => {
  it("retries starting health and transient GET failure without skipping identity", async () => {
    let attempts = 0, tick = 0;
    const identity = await retryHealthyIdentity(async () => {
      attempts++;
      if (attempts === 1) throw new Error("local GET transport unavailable");
      if (attempts === 2) throw new Error("Paperclip process is not healthy or has no verified identity");
      return { state: { serverPid: 6789 }, health: { status: "ok" } };
    }, { timeoutMs: 240_000 }, { now: () => tick, sleep: async ms => { tick += ms; } });
    assert.equal(identity.state.serverPid, 6789);
    assert.equal(attempts, 3);
    assert.equal(tick, 6_000);
  });
  it("bounds the retry and does not swallow unauthorized HTTP errors", async () => {
    let tick = 0;
    await assert.rejects(retryHealthyIdentity(async () => {
      throw new Error("local GET transport unavailable");
    }, { timeoutMs: 9_000 }, { now: () => tick, sleep: async ms => { tick += ms; } }),
    /after 240 seconds/);
    assert.equal(tick, 9_000);
    await assert.rejects(retryHealthyIdentity(async () => {
      throw new Error("local GET failed: status 403");
    }), /status 403/);
  });
});

describe("kickstart startup readiness race", () => {
  const sha = "a".repeat(40);
  const healthy = { health: { status: "ok", commit: sha },
    state: { serverPid: 300, draining: false }, payload: sha.slice(0, 12) };
  it("polls starting health and old PID, requiring two stable new-PID observations", async () => {
    let tick = 0, calls = 0;
    const ready = await waitForRestartReady(async () => {
      calls++;
      if (calls <= 2) return { ...healthy, health: { status: "starting" } };
      if (calls === 3) return { ...healthy, state: { serverPid: 200, draining: false } };
      return healthy;
    }, { previousPid: 200, sha, timeoutMs: 240_000 },
    { now: () => tick, sleep: async ms => { tick += ms; } });
    assert.equal(ready.state.serverPid, 300);
    assert.ok(calls >= 6);
    assert.ok(tick >= 20_000);
  });
  it("fails after the bound if the PID stays old or the installed SHA is wrong", async () => {
    let tick = 0;
    await assert.rejects(waitForRestartReady(async () =>
      ({ ...healthy, payload: "b".repeat(12) }),
    { previousPid: 200, sha, timeoutMs: 12_000 },
    { now: () => tick, sleep: async ms => { tick += ms; } }), /within 240 seconds/);
    assert.equal(tick, 12_000);
  });
});

describe("HTTP safety", () => {
  it("pins a credential-bearing request to loopback and refuses redirect", async () => {
    const seen = [];
    const fetcher = async (target, opts) => {
      seen.push({ target, opts });
      return { ok: true, status: 200, json: async () => ({ data: { interrupted: true } }) };
    };
    const v = await jsonRequest(url, { authorization: "test-redacted" }, "POST",
      "/api/session/" + sid + "/interrupt", {}, fetcher);
    assert.deepEqual(v, { interrupted: true });
    assert.equal(seen[0].opts.redirect, "error");
    assert.equal(seen[0].opts.headers.authorization, "test-redacted");
    assert.equal(seen[0].target, url + "/api/session/" + sid + "/interrupt");
    await assert.rejects(jsonRequest("http://not-loopback:123", {}, "GET", "/api/health", undefined, fetcher),
      /not loopback/);
  });
  it("does not expose server response body on transport or status failure", async () => {
    await assert.rejects(jsonRequest(url, {}, "POST", "/api/session/id/interrupt", {}, async () => ({
      ok: false, status: 503, json: async () => ({ password: "never-log" }),
    })), /HTTP 503/);
    await assert.rejects(jsonRequest(url, {}, "POST", "/api/session/id/interrupt", {}, async () => {
      throw Error("secret-in-exception");
    }), err => !String(err).includes("secret-in-exception"));
  });
});

describe("owned session pause lifecycle", () => {
  it("interrupts exactly once, persists the ACK and waits for idle", async () => {
    const records = plan();
    let persistence = 0;
    const requests = [];
    const providers = new Map([[url, { request: async (method, uri, body) => {
      requests.push({ method, uri, body });
      return method === "POST" ? { interrupted: true } : { [sid]: { type: "idle" } };
    } }]]);
    await pauseOwned(records, providers, async () => { persistence++; });
    assert.deepEqual(requests.map(r => [r.method, r.uri]), [
      ["POST", "/session/" + sid + "/interrupt"], ["GET", "/session/active"],
    ]);
    assert.equal(records[0].state, "paused");
    assert.equal(persistence, 2);
  });
  it("does not interrupt a provider-idle session", async () => {
    const records = plan([run], [binding], { [sid]: { type: "idle" } });
    const providers = new Map([[url, { request: async () => { throw Error("unexpected POST"); } }]]);
    await pauseOwned(records, providers);
    assert.equal(records[0].state, "idle");
  });
  it("refuses false interrupt ACKs rather than treating them as safely paused", async () => {
    const records = plan();
    const providers = new Map([[url, { request: async () => ({ interrupted: false }) }]]);
    await assert.rejects(pauseOwned(records, providers), /failed to acknowledge/);
    assert.equal(records[0].state, "planned");
  });
});

describe("installed deploy shell contract", () => {
  it("coalesces under the lock before choosing hot, rolling or legacy replacement", async () => {
    const source = await fs.readFile(new URL("./pc-deploy.sh", import.meta.url), "utf8");
    const markers = [
      'node "$helper" verified "$sha"',
      'node "$hot_helper" plan "$sha" || hot_rc=$?',
      'node "$helper" begin "$manifest"',
      'if "$handoff" handoff "$sha" "$original"',
      'launchctl kickstart -k', 'node "$helper" finish "$manifest" "$sha"',
    ];
    let previous = -1;
    for (const marker of markers) {
      const found = marker === "launchctl kickstart -k" ? source.lastIndexOf(marker) : source.indexOf(marker);
      assert.ok(found > previous, "ordering or missing: " + marker);
      previous = found;
    }
    assert.match(source, /node "\$helper" release "\$manifest"/);
    assert.match(source, /if \[ "\$rc" -eq 10 \]|\[ "\$rc" -eq 10 \]/);
    assert.match(source, /-x -w 600 -E 76/);
    // Owner 2026-11-03: a deploy never holds on a stuck process or refuses on unprovable work.
    assert.match(source, /killing stuck holder/);
    assert.match(source, /PAPERCLIP_DEPLOY_API_BASE=\$\("\$handoff" endpoint\)/);
    assert.doesNotMatch(source, /node "\$helper" (pause|wait|verify) "\$manifest"/);
    assert.doesNotMatch(source, /refusing restart|-w 2700|verify "\$manifest" \|\| exit/);
    assert.doesNotMatch(source, /poll_health|curl -fsS|helper" pace|wait "\$manifest" [1-9]/);
    assert.match(source, /helper" finish "\$manifest" "\$sha"/);
    assert.match(source, /install --ref "\$sha"/);
    assert.match(source, /source_branch=fix\/git-installer-bundled-workspaces-20261030/);
    assert.match(source, /rollback_restart/);
    assert.match(source, /node "\$restore_helper" restore "\$original" "\$short"/);
    assert.doesNotMatch(source, /cli update --rollback|rm -rf "\$lock"|git add -A|git reset --hard|git clean -f/);
  });
});
