#!/usr/bin/env node
// SCO-337 L3: one-shot, read-only evidence inspection. Never creates issues, wakes agents or restarts services.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ROUTES = ["mac-glm", "wrx-deepseek", "wrx-glm", "tensor64-lead"];
const ACTIVE = new Set(["queued", "running", "scheduled_retry"]);
const MIN_REPORT_BYTES = 250;

export function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.cases) || manifest.cases.length !== 6) {
    throw new Error("Exactly six distinct acceptance issue cases are required");
  }
  const ids = new Set();
  const seenRoutes = new Set();
  for (const c of manifest.cases) {
    if (!/^SCO-[0-9]+$/.test(c.identifier ?? "") ||
        !/^[a-f0-9-]{36}$/i.test(c.assigneeAgentId ?? "") ||
        !ROUTES.includes(c.route)) {
      throw new Error("Each case needs a valid identifier, assigneeAgentId and known route");
    }
    if (ids.has(c.identifier)) throw new Error("Duplicate acceptance issue " + c.identifier);
    ids.add(c.identifier);
    seenRoutes.add(c.route);
  }
  if (ROUTES.some((route) => !seenRoutes.has(route))) {
    throw new Error("All four local-agent routes must be represented");
  }
  return manifest.cases;
}

function time(value) {
  const millis = Date.parse(value ?? "");
  return Number.isNaN(millis) ? 0 : millis;
}

export function evaluateCase(spec, { issue, runs, documents }) {
  const problems = [];
  if (!issue || issue.identifier !== spec.identifier) problems.push("issue_not_found");
  if (issue?.assigneeAgentId !== spec.assigneeAgentId) problems.push("unexpected_assignee");
  if (issue?.status !== "done") problems.push("not_done");
  if (issue?.activeRecoveryAction) problems.push("active_recovery_action");

  const ownedRuns = Array.isArray(runs)
    ? runs.filter((run) => run.agentId === spec.assigneeAgentId)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))
    : [];
  const latest = ownedRuns[0] ?? null;
  if (!latest || latest.status !== "succeeded" || latest.livenessState !== "completed") {
    problems.push("latest_run_not_completed");
  }
  if (ownedRuns.some((run) => ACTIVE.has(run.status))) problems.push("active_or_queued_run");
  const successfulRuns = ownedRuns.filter((run) => run.status === "succeeded");
  if (successfulRuns.length > 1) problems.push("multiple_successful_runs_require_effect_review");

  const report = Array.isArray(documents) ? documents.find((doc) => doc.key === "report") : null;
  const reportBytes = Buffer.byteLength(report?.body ?? "", "utf8");
  if (reportBytes < MIN_REPORT_BYTES) problems.push("missing_or_short_report");
  if (latest && report && time(report.updatedAt) < time(latest.startedAt)) {
    problems.push("report_predates_latest_run");
  }
  const manualWake = ownedRuns.some((run) => ["on_demand", "manual"].includes(run.invocationSource));
  if (manualWake) problems.push("manual_run_not_unattended");
  const firstAssignment = ownedRuns.some((run) =>
    run.invocationSource === "assignment" &&
    (run.contextSnapshot?.wakeReason === "issue_assigned" || !run.contextSnapshot));
  if (!firstAssignment) problems.push("no_assignment_origin_verified");

  return {
    identifier: spec.identifier,
    route: spec.route,
    issueStatus: issue?.status ?? "missing",
    latestRun: latest?.runId ?? null,
    latestRunStatus: latest?.status ?? null,
    reportBytes,
    completedUnattendedCandidate: problems.length === 0,
    problems,
    // These need a genuine second-client control receipt and a same-identity pre/post restart
    // receipt. A report marker or a healthy endpoint alone cannot prove either.
    steerProof: "unverified",
    restartSurvivalProof: "unverified",
    completedToolReplayProof: "unverified",
  };
}

export function evaluateBatch(manifest, snapshots) {
  const cases = validateManifest(manifest).map((spec) =>
    evaluateCase(spec, snapshots[spec.identifier] ?? {}));
  const candidates = cases.filter((c) => c.completedUnattendedCandidate).length;
  return {
    accepted: false, // Lead must independently verify restart, steering and no completed-tool replay.
    unattendedCandidates: candidates,
    required: 6,
    missingEndToEndProof: ["live_steer", "restart_survival", "no_completed_tool_replay"],
    cases,
  };
}

function fetchJson(pc, args) {
  const out = execFileSync(pc, [...args, "--json"], {
    encoding: "utf8", timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function main(args) {
  if (args.length !== 1 || args[0] === "--help") {
    console.error("usage: node scripts/sco337-six-issue-snapshot.mjs MANIFEST.json");
    process.exitCode = args[0] === "--help" ? 0 : 64;
    return;
  }
  const manifest = JSON.parse(readFileSync(args[0], "utf8"));
  const cases = validateManifest(manifest);
  const pc = process.env.PAPERCLIP_CLI_PATH || "/Volumes/NVM/Paperclip/bin/pc";
  const snapshots = {};
  for (const c of cases) {
    snapshots[c.identifier] = {
      issue: fetchJson(pc, ["issue", "get", c.identifier]),
      runs: fetchJson(pc, ["issue", "runs", c.identifier]),
      documents: fetchJson(pc, ["issue", "documents", c.identifier]),
    };
  }
  const result = evaluateBatch(manifest, snapshots);
  console.log(JSON.stringify(result, null, 2));
  if (result.unattendedCandidates !== 6) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error("SCO-337 acceptance snapshot failed:", error.message);
    process.exitCode = 1;
  }
}
