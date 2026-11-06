import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { projectToolRoutes } from "../routes/project-tools.js";
import { forbidden } from "../errors.js";

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../services/project-tool-context.js", () => ({ projectToolContext: context }));

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", companyId: "company", agentId: "agent", runId: "run" };
    next();
  });
  server.use("/api", projectToolRoutes({} as Db));
  server.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return server;
}

beforeEach(() => {
  context.mockReset().mockResolvedValue({ run: { companyId: "company" }, issue: { workMode: "standard" } });
});

describe("Codex project-tools MCP startup", () => {
  it("completes initialize, the optional GET stream probe, initialized, and tools/list", async () => {
    const server = app();
    const rpc = (body: object) => request(server).post("/api/mcp/project-tools")
      .set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", ...body });
    const initialized = await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: "paperclip-project-tools" } });

    // RMCP closes the transport on a 404 here. A POST-only server must use 405.
    const stream = await request(server).get("/api/mcp/project-tools").set("Accept", "text/event-stream");
    expect(stream.status).toBe(405);
    expect(stream.headers.allow).toBe("POST");
    expect((await rpc({ method: "notifications/initialized" })).status).toBe(202);

    // Use the real definitions/converter: a mocked catalog would hide the
    // deployed shared/server Zod mismatch that previously broke discovery.
    const listed = await rpc({ id: 2, method: "tools/list" });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const tools = listed.body.result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["create_task", "create_project", "list_projects"]));
    const schema = tools.find((tool: { name: string }) => tool.name === "create_project").inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.required.toSorted()).toEqual(["idempotencyKey", "name"]);
    expect(context).toHaveBeenCalledTimes(4);
  });

  it("keeps the GET stream probe behind run authentication", async () => {
    context.mockRejectedValue(forbidden("Project tools require an authenticated agent run"));
    const response = await request(app()).get("/api/mcp/project-tools");
    expect(response.status).toBe(403);
    expect(response.headers.allow).toBeUndefined();
  });
});
