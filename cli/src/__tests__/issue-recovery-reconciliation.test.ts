import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const issueId = "44444444-4444-4444-8444-444444444444";
const actionId = "66666666-6666-4666-8666-666666666666";
const reconciliation = {
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  providerStopped: true,
  actionOutcome: "mixed",
  outcomeEvidence: "Verified the recorded action receipts against their destination.",
};
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dir = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/issue-reconciliation-");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("command failed"); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function run(file?: string) {
  const program = new Command();
  program.exitOverride();
  registerIssueCommands(program);
  await program.parseAsync([
    "issue", "recovery:resolve", issueId, "--outcome", "restored", "--source-issue-status", "todo",
    "--action-id", actionId, ...(file === undefined ? [] : ["--execution-reconciliation-file", file]),
    "--api-base", "http://localhost:3100", "--api-key", "test-token",
  ], { from: "user" });
}

it("forwards the validated evidence exactly using a literal file path", async () => {
  const marker = `injection-${randomUUID()}`;
  const file = join(dir, `evidence;$(touch\${IFS}${marker}).json`);
  await writeFile(file, JSON.stringify(reconciliation));
  await run(file);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`http://localhost:3100/api/issues/${issueId}/recovery-actions/resolve`);
  expect(JSON.parse(String(init.body))).toEqual({ actionId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation: reconciliation });
  await expect(access(join(process.cwd(), marker))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves the existing request without the option", async () => {
  await run();
  const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({ actionId, outcome: "restored", sourceIssueStatus: "todo" });
});

it.each([
  ["malformed JSON", "{ confidential-evidence"],
  ["unknown field", JSON.stringify({ ...reconciliation, unknown: true })],
  ["omitted providerStopped", JSON.stringify({ ...reconciliation, providerStopped: undefined })],
  ["false providerStopped", JSON.stringify({ ...reconciliation, providerStopped: false })],
  ["invalid outcome", JSON.stringify({ ...reconciliation, actionOutcome: "unknown" })],
  ["invalid run ID", JSON.stringify({ ...reconciliation, runId: "not-a-uuid" })],
  ["short evidence", JSON.stringify({ ...reconciliation, outcomeEvidence: "unknown" })],
])("rejects %s before any API request", async (_name, contents) => {
  const file = join(dir, "invalid.json");
  await writeFile(file, contents);
  await expect(run(file)).rejects.toThrow("command failed");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("confidential-evidence");
});
