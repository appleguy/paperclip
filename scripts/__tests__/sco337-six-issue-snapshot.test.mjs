import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCase, evaluateBatch, validateManifest } from "../sco337-six-issue-snapshot.mjs";

const agents = {
  "mac-glm": "23ed1b59-1ba8-4445-8b54-ded4afdf4780",
  "wrx-deepseek": "6afb0f4c-9524-4b02-b6b1-68d7fc696b8c",
  "wrx-glm": "4c18805f-6a9f-4732-88fc-62bedce141f6",
  "tensor64-lead": "bddd515a-8353-4133-bd35-017c22b334f3",
};
const names = ["mac-glm", "wrx-deepseek", "wrx-glm", "tensor64-lead", "mac-glm", "wrx-deepseek"];
const manifest = { cases: names.map((route, i) => ({
  identifier: "SCO-" + (500 + i), route, assigneeAgentId: agents[route],
})) };
const spec = manifest.cases[0];
const result = (id, status = "succeeded") => ({
  runId: id, agentId: spec.assigneeAgentId, createdAt: "2026-11-02T18:01:00Z",
  startedAt: "2026-11-02T18:01:00Z",
  status, livenessState: status === "succeeded" ? "completed" : "failed",
  invocationSource: "assignment",
});
function snapshot() {
  return {
    issue: { identifier: spec.identifier, status: "done", assigneeAgentId: spec.assigneeAgentId,
      activeRecoveryAction: null },
    runs: [result("r1")],
    documents: [{ key: "report", body: "verified " + "x".repeat(300),
      updatedAt: "2026-11-02T18:03:00Z" }],
  };
}

test("exactly six unique issues and all four routes are required", () => {
  assert.equal(validateManifest(manifest).length, 6);
  assert.throws(() => validateManifest({cases:manifest.cases.slice(0,5)}), /Exactly six/);
  assert.throws(() => validateManifest({cases:[...manifest.cases.slice(0,5),manifest.cases[0]]}), /Duplicate/);
  assert.throws(() => validateManifest({cases:manifest.cases.map((c) =>
    ({...c,route:"mac-glm"}))}), /four local-agent routes/);
});
test("completed issue, fresh substantive report, assignment run is an unattended candidate", () => {
  const evidence = evaluateCase(spec, snapshot());
  assert.equal(evidence.completedUnattendedCandidate, true);
  assert.equal(evidence.reportBytes, 309);
  assert.equal(evidence.steerProof, "unverified");
  assert.equal(evidence.restartSurvivalProof, "unverified");
});
test("comment-only completion is not a report, including document 404", () => {
  const state = snapshot(); state.documents = [];
  const evidence = evaluateCase(spec,state);
  assert.equal(evidence.completedUnattendedCandidate, false);
  assert.ok(evidence.problems.includes("missing_or_short_report"));
});
test("old report from a prior run is not fresh acceptance", () => {
  const state = snapshot(); state.documents[0].updatedAt = "2026-11-02T17:00:00Z";
  assert.ok(evaluateCase(spec,state).problems.includes("report_predates_latest_run"));
});
test("later failed retry, pending action and manual wake cannot silently count as done", () => {
  const state = snapshot();
  state.runs.unshift({...result("r2","failed"), createdAt:"2026-11-02T18:04:00Z",
    invocationSource:"on_demand"});
  state.issue.activeRecoveryAction={status:"active"};
  const p = evaluateCase(spec,state).problems;
  assert.ok(p.includes("latest_run_not_completed"));
  assert.ok(p.includes("active_recovery_action"));
  assert.ok(p.includes("manual_run_not_unattended"));
});
test("several successful runs require effect review, not blind exactly-once claims", () => {
  const state=snapshot();
  state.runs.unshift({...result("r2"),createdAt:"2026-11-02T18:04:00Z"});
  assert.ok(evaluateCase(spec,state).problems.includes("multiple_successful_runs_require_effect_review"));
});
test("even six complete candidates do not prove steer, restart or tool replay", () => {
  const snapshots=Object.fromEntries(manifest.cases.map((c,i) => {
    const s=snapshot();
    s.issue.identifier=c.identifier;s.issue.assigneeAgentId=c.assigneeAgentId;
    s.runs[0].agentId=c.assigneeAgentId;
    return [c.identifier,s];
  }));
  const result=evaluateBatch(manifest,snapshots);
  assert.equal(result.unattendedCandidates,6);
  assert.equal(result.accepted,false);
  assert.equal(result.missingEndToEndProof.length,3);
});
