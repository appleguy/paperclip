// @ts-expect-error JS shared helper
import { assembleGuidance } from "../../scripts/nar-guidance.mjs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { WORKSPACE } from "../drivers/codex/codex-app-server-driver.test-support.js";
import { modelEffortTag, standaloneCodexMain } from "./codex-standalone.js";

// Keep the Unix socket path under the macOS sun_path limit (104 bytes).
const TMP = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const THREAD = "thread-d32";
const TURN = "turn-d32";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  dir: string;
  codexHome: string;
  socketPath: string;
  messages: Array<{ method: string; params: Record<string, unknown> }>;
}

async function fixture(options: { socket?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(TMP, "d32-"));
  const codexHome = join(dir, "h");
  const control = join(codexHome, "app-server-control");
  await mkdir(control, { recursive: true });
  const socketPath = join(control, "app-server-control.sock");
  const messages: Fixture["messages"] = [];
  if (options.socket === false) {
    await writeFile(socketPath, "");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return { dir, codexHome, socketPath, messages };
  }
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", socket => {
    socket.on("message", data => {
      const msg = JSON.parse(data.toString()) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id === undefined || typeof msg.method !== "string") return;
      messages.push({ method: msg.method, params: msg.params ?? {} });
      const respond = (result: unknown) =>
        socket.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === "initialize") return respond({ userAgent: "codex-cli/test" });
      if (msg.method === "config/read")
        return respond({
          config: {
            mcp_servers: { example: {} },
            model: "gpt-5-terra",
            api_key: "config-secret-value",
          },
        });
      if (msg.method === "remoteControl/status/read") return respond({ status: "connected" });
      if (msg.method === "model/list")
        return respond({
          data: [
            {
              id: "gpt-5-terra",
              model: "gpt-5-terra",
              isDefault: true,
              defaultReasoningEffort: "high",
            },
          ],
        });
      if (msg.method === "thread/start")
        return respond({
          thread: { id: THREAD, cwd: WORKSPACE },
          model: "gpt-5-terra",
          sandbox: { type: "readOnly" },
          approvalPolicy: "never",
        });
      if (msg.method === "thread/name/set") return respond({});
      if (msg.method === "turn/start") {
        respond({ turn: { id: TURN, status: "inProgress", items: [] } });
        socket.send(JSON.stringify({
          method: "turn/started",
          params: { threadId: THREAD, turn: { id: TURN, status: "inProgress" } },
        }));
        socket.send(JSON.stringify({
          method: "turn/completed",
          params: { threadId: THREAD, turn: { id: TURN, status: "completed", items: [] } },
        }));
        return;
      }
      if (msg.method === "thread/read")
        return respond({
          thread: {
            id: THREAD,
            cwd: WORKSPACE,
            turns: [{ id: TURN, status: "completed", items: [] }],
          },
        });
      if (msg.method === "thread/list") return respond({ data: [{ id: THREAD }] });
      return respond({});
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, codexHome, socketPath, messages };
}

function baseArgs(f: Fixture, receiptDir: string): string[] {
  return [
    "--codex-home", f.codexHome,
    "--cwd", WORKSPACE,
    "--model", "gpt-5-terra",
    "--effort", "high",
    "--prompt", "Only this text.",
    "--receipt-dir", receiptDir,
  ];
}

function journalLines(text: string): Array<Record<string, unknown>> {
  return text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("standalone NAR Codex entrypoint", () => {
  it("builds the compact M@E thread tag", () => {
    expect(modelEffortTag("gpt-5.1-terra", "high")).toBe("T@H");
    expect(modelEffortTag("gpt-5.1-sol", "xhigh")).toBe("S@X");
    expect(modelEffortTag("gpt-5.1-luna", "low")).toBe("L@L");
    expect(modelEffortTag("gpt-5.1-astra", "max")).toBe("A@Mx");
    expect(modelEffortTag("gpt-5.1", "medium")).toBe("M");
    expect(modelEffortTag("gpt-5.1-terra", "unexpected")).toBe("T");
    expect(modelEffortTag("gpt-5.1", "unexpected")).toBe("");
  });

  it("admits one clean standalone turn, names the thread, and records receipts", async () => {
    const f = await fixture();
    const receiptDir = join(f.dir, "receipts");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = {
      apiKey: process.env.PAPERCLIP_API_KEY,
      workspace: process.env.PAPERCLIP_WORKSPACE_CWD,
    };
    process.env.PAPERCLIP_API_KEY = "must-not-pass";
    process.env.PAPERCLIP_WORKSPACE_CWD = "/paperclip/owned";
    try {
      await standaloneCodexMain([
        ...baseArgs(f, receiptDir),
        "--sandbox", "read-only",
        "--timeout-ms", "30000",
        "--name", "  lane   d32  ",
        "--class", "research", "--compact-limit", "12345", "--compact-prompt-file", "/tmp/compact.txt",
      ]);
    } finally {
      if (previous.apiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous.apiKey;
      if (previous.workspace === undefined) delete process.env.PAPERCLIP_WORKSPACE_CWD;
      else process.env.PAPERCLIP_WORKSPACE_CWD = previous.workspace;
      log.mockRestore();
    }

    const result = JSON.parse(
      await readFile(join(receiptDir, "result.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      threadId: THREAD,
      turnId: TURN,
      terminal: "turn.completed",
      threadListContainsThread: true,
      providerBoundCapture: "unverified",
    });
    const states = result.remoteControlStates as string[];
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.every(state => state === "connected")).toBe(true);

    expect(f.messages.find(message => message.method === "thread/name/set")?.params)
      .toMatchObject({ threadId: THREAD, name: "T@H lane d32" });

    const start = f.messages.find(message => message.method === "thread/start")!.params;
    expect(start.developerInstructions).toBe(assembleGuidance("research"));
    expect(start.baseInstructions).toBe("");
    expect(start.config).toMatchObject({ model_auto_compact_token_limit: 12345, experimental_compact_prompt_file: "/tmp/compact.txt", project_doc_max_bytes: 0 });
    const identity = JSON.parse(
      await readFile(join(receiptDir, "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(identity).toMatchObject({
      driverSessionId: THREAD,
      model: "gpt-5-terra",
      effort: "high",
    });

    const journal = await readFile(join(receiptDir, "receipt.jsonl"), "utf8");
    const manifest = journalLines(journal).find(line => line.phase === "manifest");
    expect(manifest).toMatchObject({
      paperclipServer: false,
      injectedContext: "guidance",
      providerBoundCapture: "unverified",
      prompt: "Only this text.",
      model: "gpt-5-terra",
      effort: "high",
      sandbox: "read-only",
    });
    // The standalone path must not inherit Paperclip-owned environment values,
    // and config/read contents must never reach the receipt journal.
    expect(journal).not.toContain("must-not-pass");
    expect(journal).not.toContain("/paperclip/owned");
    expect(journal).not.toContain("config-secret-value");
  });

  it("inspects the daemon without starting a thread", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let output: unknown;
    try {
      await standaloneCodexMain(["--codex-home", f.codexHome, "--cwd", WORKSPACE, "--inspect"]);
      output = log.mock.calls.at(-1)?.[0];
    } finally {
      log.mockRestore();
    }
    expect(f.messages.some(message => message.method === "thread/start")).toBe(false);
    expect(JSON.parse(String(output))).toMatchObject({
      model: "gpt-5-terra",
      effort: "high",
      mcpServerNames: ["example"],
      remoteControl: "connected",
    });
  });

  it("refuses unsafe arguments before opening a standalone turn", async () => {
    const f = await fixture();
    const receiptDir = join(f.dir, "receipts");
    await expect(standaloneCodexMain([...baseArgs(f, receiptDir), "--sandbox", "host"]))
      .rejects.toThrow("invalid native sandbox");
    await expect(standaloneCodexMain([...baseArgs(f, receiptDir), "--timeout-ms", "1"]))
      .rejects.toThrow("invalid turn deadline");
    await expect(standaloneCodexMain(["--codex-home", f.codexHome, "--cwd", WORKSPACE]))
      .rejects.toThrow("--model, --prompt and --receipt-dir are required");
    expect(f.messages).toEqual([]);
  });

  it("refuses a control path that is not a socket", async () => {
    const f = await fixture({ socket: false });
    await expect(standaloneCodexMain([
      "--codex-home", f.codexHome,
      "--cwd", WORKSPACE,
      "--inspect",
    ])).rejects.toThrow("Codex control path is not a socket");
  });
});
