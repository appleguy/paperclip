import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaperclipMcpServer } from "./index.js";
import { readRunEnv } from "./config.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function seat() {
  const dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1021-mcp-");
  dirs.push(dir);
  return path.join(dir, "run-env.sh");
}

function runFile(url: string, token: string, run: string, company: string) {
  return `export PAPERCLIP_API_URL='${url}'\nexport PAPERCLIP_API_KEY='${token}'\nexport PAPERCLIP_RUN_ID='${run}'\nexport PAPERCLIP_COMPANY_ID='${company}'\nexport PAPERCLIP_AGENT_ID='agent'\n`;
}

describe("persistent seat MCP configuration", () => {
  it("reads each run afresh for a single long-lived server and clears after removal", async () => {
    const file = await seat();
    for (const key of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_AGENT_ID"]) vi.stubEnv(key, "");
    vi.stubEnv("PAPERCLIP_RC_RUN_ENV", file);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { server } = createPaperclipMcpServer();
    const client = new Client({ name: "seat-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await fs.writeFile(file, runFile("http://first:3100", "first-token", "run-one", "company-one"));
    await client.callTool({ name: "paperclipUpdateIssue", arguments: { issueId: "SCO-1", status: "done" } });
    await fs.writeFile(file, runFile("http://second:3100", "second-token", "run-two", "company-two"));
    await client.callTool({ name: "paperclipUpdateIssue", arguments: { issueId: "SCO-2", status: "done" } });
    await client.callTool({ name: "paperclipListSkills", arguments: {} });
    await client.callTool({ name: "paperclipCheckoutIssue", arguments: { issueId: "SCO-2" } });
    const calls = fetchMock.mock.calls as unknown as [URL, RequestInit][];
    expect(calls.slice(0, 2).map(([url]) => String(url))).toEqual(["http://first:3100/api/issues/SCO-1", "http://second:3100/api/issues/SCO-2"]);
    expect(calls.slice(0, 2).map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual(["Bearer first-token", "Bearer second-token"]);
    expect(calls.slice(0, 2).map(([, init]) => (init.headers as Record<string, string>)["X-Paperclip-Run-Id"])).toEqual(["run-one", "run-two"]);
    expect(String(calls[2]![0])).toBe("http://second:3100/api/companies/company-two/skills");
    expect(JSON.parse(String(calls[3]![1].body)).agentId).toBe("agent");
    await fs.rm(file);
    expect(JSON.stringify(await client.callTool({ name: "paperclipUpdateIssue", arguments: { issueId: "SCO-3", status: "done" } }))).toContain("no active Paperclip run for this seat");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await client.close();
  });

  it("isolates slots, respects explicit values, and parses quotes without executing shell", async () => {
    const first = await seat();
    const second = await seat();
    await fs.writeFile(first, "export PAPERCLIP_API_KEY='foo'\\''bar'\nexport PAPERCLIP_API_URL='http://first'\nexport PAPERCLIP_RUN_ID=$(touch /should-not-exist)\n");
    await fs.writeFile(second, runFile("http://second", "second-token", "run-two", "company-two"));
    const a = await readRunEnv({ PAPERCLIP_RC_RUN_ENV: first, PAPERCLIP_API_URL: "http://override", PAPERCLIP_API_KEY: "${PAPERCLIP_API_KEY}" });
    const b = await readRunEnv({ PAPERCLIP_RC_RUN_ENV: second });
    expect(a.PAPERCLIP_API_KEY).toBe("foo'bar");
    expect(a.PAPERCLIP_API_URL).toBe("http://override");
    expect(a.PAPERCLIP_RUN_ID).toBeUndefined();
    expect(b.PAPERCLIP_API_KEY).toBe("second-token");
    expect(b.PAPERCLIP_RUN_ID).toBe("run-two");
  });
});
