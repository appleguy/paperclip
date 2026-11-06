import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const companyId = "22222222-2222-4222-8222-222222222222";
function program() {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerIssueCommands(p);
  return p;
}
async function run(extra: string[] = []) {
  await program().parseAsync([
    "issue", "list", "--company-id", companyId, "--json",
    "--api-base", "http://localhost:3100", "--api-key", "synthetic-test-key",
    ...extra,
  ], { from: "user" });
}
describe("issue list pagination", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("reaches issues beyond both the default and maximum page size without offset deletion gaps", async () => {
    const rows = Array.from({ length: 1501 }, (_, n) => ({
      id: "00000000-0000-4000-8000-" + String(n + 1).padStart(12, "0"),
      identifier: "SCO-" + (n + 1), title: n === 1500 ? "Owner ask beyond cap" : "Fixture",
      status: "done", description: "",
    }));
    let live = [...rows];
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      const limit = Math.min(Number(q.get("limit") ?? 500), 1000);
      const after = q.get("afterId");
      const selected = live.filter(r => !after || r.id > after).slice(Number(q.get("offset") ?? 0));
      return new Response(JSON.stringify(selected.slice(0, limit)), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await run();
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await run(["--limit", "1000", "--sort-field", "id", "--sort-dir", "asc"]);
    const first = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(first).toHaveLength(1000);
    live = live.slice(1); // A deletion in a previous page must not skip the next issue.
    await run(["--limit", "1000", "--sort-field", "id", "--sort-dir", "asc", "--after-id", first.at(-1).id]);
    const second = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(second).toHaveLength(501);
    expect(second[0].identifier).toBe("SCO-1001");
    expect(second.at(-1).title).toBe("Owner ask beyond cap");
    expect(new Set([...first, ...second].map(r => r.id)).size).toBe(1501);
  });

  it("preserves existing filters and applies local matching only to the requested page", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify([
      { id: "late", identifier: "SCO-1501", title: "Owner ask beyond cap", description: "", status: "blocked" },
      { id: "other", identifier: "SCO-1502", title: "Different", description: "", status: "blocked" },
    ]), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await run(["--status", "blocked", "--project-id", "project", "--assignee-agent-id", "agent",
      "--limit", "1000", "--offset", "1000", "--sort-field", "created", "--sort-dir", "asc", "--match", "beyond cap"]);
    const q = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(Object.fromEntries(q)).toEqual({ status: "blocked", assigneeAgentId: "agent", projectId: "project", limit: "1000", offset: "1000", sortField: "created", sortDir: "asc" });
    const output = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(output.map((r: { identifier: string }) => r.identifier)).toEqual(["SCO-1501"]);
  });
});
