import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { verifyOwned, jsonRequest, pauseOwned } from "./deploy-drain.mjs";

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

describe("deploy drain exact ownership and fail-closed rules", () => {
  it("selects only a run-owned active OpenCode session", () => {
    assert.deepEqual(plan(), [{
      runId: id, issueId: issue, agentId, taskId: issue, sessionId: sid, url, active: true, state: "planned",
    }]);
  });
  it("retains the same durable binding when OpenCode is already idle", () => {
    assert.equal(plan([run], [binding], { [sid]: { type: "idle" } })[0].active, false);
  });
  it("refuses an orphan active server session even when another run has a journal", () => {
    assert.throws(() => plan([run], [binding], {
      [sid]: { type: "busy" }, ses_unowned_live_45678: { type: "busy" },
    }), /unowned or pre-journal/);
  });
  it("refuses pre-journal and stale run mappings", () => {
    assert.throws(() => plan([run], []), /missing or conflicting/);
    assert.throws(() => plan([run], [{ ...binding, runId: "44444444-4444-4444-8444-444444444444" }]),
      /missing or conflicting/);
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
  it("refuses non-OpenCode runs instead of killing them", () => {
    const agents = new Map([[agentId, { ...agent, adapterType: "claude_local" }]]);
    assert.throws(() => verifyOwned([run], agents, [binding], new Map([[url, {}]])), /non-OpenCode/);
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
  it("orders admission, bounded wait, owned interrupt, restart, health and completion", async () => {
    const source = await fs.readFile(new URL("./pc-deploy.sh", import.meta.url), "utf8");
    const markers = [
      'node "$helper" verified "$sha"', 'node "$helper" pace',
      'node "$helper" begin "$manifest"', 'node "$helper" wait "$manifest" 600',
      'node "$helper" pause "$manifest"', 'node "$helper" verify "$manifest"',
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
    assert.match(source, /flock -x|-x -w 2700/);
    assert.match(source, /--connect-timeout 2 --max-time 5/);
    assert.match(source, /install --ref "\$sha"/);
    assert.match(source, /source_branch=fix\/git-installer-bundled-workspaces-20261030/);
    assert.match(source, /rollback_restart/);
    assert.match(source, /node "\$restore_helper" restore "\$original" "\$short"/);
    assert.doesNotMatch(source, /cli update --rollback|rm -rf "\$lock"|git add -A|git reset --hard|git clean -f/);
  });
});
