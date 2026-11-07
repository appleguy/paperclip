// @ts-expect-error standalone JS helper is shared with the Claude launcher
import { assembleGuidance } from "../../scripts/nar-guidance.mjs";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver-impl.js";
import { sharedDaemonTransportFactory, type SharedDaemonCodexAppServerTransport } from "../drivers/codex/shared-daemon-transport.js";
import type { HarnessSession } from "../contracts/harness-driver.js";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Readable thread title: compact model@effort tag (T@H = Terra@High) leads, mirroring server model-effort-name.ts.
export function modelEffortTag(model: string, effort: string): string {
  const family = ([[/\bsol\b/i, "S"], [/\bterra\b/i, "T"], [/\bluna\b/i, "L"], [/\bastra\b/i, "A"]] as [RegExp, string][])
    .find(([pattern]) => (pattern as RegExp).test(model))?.[1] ?? "";
  const level = ({ low: "L", medium: "M", high: "H", xhigh: "X", max: "Mx" } as Record<string, string>)[effort.toLowerCase()] ?? "";
  return family && level ? `${family}@${level}` : family || level;
}

export async function standaloneCodexMain(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    "codex-home": { type: "string" }, cwd: { type: "string" }, model: { type: "string" },
    effort: { type: "string" }, prompt: { type: "string" }, sandbox: { type: "string" },
    "receipt-dir": { type: "string" }, "timeout-ms": { type: "string" }, inspect: { type: "boolean" }, name: { type: "string" }, thread: { type: "string" }, "web-search": { type: "string" }, class: { type: "string" }, project: { type: "string" }, "compact-limit": { type: "string" }, "compact-prompt-file": { type: "string" },
  } });
  const codexHome = resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const workspace = await realpath(resolve(values.cwd ?? process.cwd()));
  const socketPath = await realpath(join(codexHome, "app-server-control", "app-server-control.sock"));
  const socket = await stat(socketPath);
  if (!socket.isSocket()) throw new Error("Codex control path is not a socket");
  const generation = `${socket.dev}:${socket.ino}:${socket.birthtimeMs}`;
  const model = values.model ?? "inspection-only";
  const effort = values.effort ?? "medium";
  const sandbox = values.sandbox ?? "read-only";
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error("invalid native sandbox");
  const webSearch = values["web-search"] ?? "disabled";
  if (webSearch !== "disabled" && webSearch !== "live") throw new Error("invalid web search mode");
  const timeoutMs = Number(values["timeout-ms"] ?? "300000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000) throw new Error("invalid turn deadline");
  if (!values.inspect && (!values.model?.trim() || !values.prompt?.trim() || !values["receipt-dir"]))
    throw new Error("--model, --prompt and --receipt-dir are required");

  const compactLimit = values["compact-limit"] === undefined ? undefined : Number(values["compact-limit"]);
  if (compactLimit !== undefined && (!Number.isSafeInteger(compactLimit) || compactLimit <= 0)) throw new Error("invalid compaction limit");
  if (values.thread && (values.class || values.project || compactLimit !== undefined || values["compact-prompt-file"])) throw new Error("guidance and compaction options apply only to new threads");
  const guidance = !values.inspect && !values.thread ? assembleGuidance(values.class, values.project) as string : undefined;
  const runId = `nar-${randomUUID()}`;
  const receiptDir = values["receipt-dir"] ? resolve(values["receipt-dir"]) : null;
  if (receiptDir && !isAbsolute(receiptDir)) throw new Error("receipt directory must be absolute");
  let journal: number | undefined;
  if (receiptDir && !values.inspect) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    journal = openSync(join(receiptDir, "receipt.jsonl"), "wx", 0o600);
  }
  const receipt = (value: Record<string, unknown>) => {
    if (journal !== undefined) {
      appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
      fsyncSync(journal);
    }
  };
  const save = (name: string, value: unknown) => {
    if (!receiptDir) return;
    const file = openSync(join(receiptDir, name), "wx", 0o600);
    try { writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); fsyncSync(file); }
    finally { closeSync(file); }
  };
  let transport: SharedDaemonCodexAppServerTransport | undefined;
  let session: HarnessSession | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const remoteControlStates: string[] = [];
  const factory = sharedDaemonTransportFactory({
    identity: { codexHome, socketPath, cliVersion: "not-invoked", appServerVersion: "see-initialize-receipt",
      processGeneration: generation, threadId: values.thread ?? "", workspace, model, effort },
    // --thread continues one lane thread (provider prompt cache, one RC entry) instead of starting a new one.
    newThread: !values.thread,
    webSearch,
    admit: async () => {
      const current = await stat(socketPath);
      return current.isSocket() && `${current.dev}:${current.ino}:${current.birthtimeMs}` === generation;
    },
    onRequest: ({ method, params }) => receipt({ phase: "send-attempt", method, params }),
    onTransport: current => {
      transport = current;
      const request = current.request.bind(current);
      current.request = async (method, params) => {
        const result = await request(method, params);
        // Never log config/read contents, credentials, URLs, or configured environment values.
        if (method === "remoteControl/status/read") {
          remoteControlStates.push(String(result.status));
          receipt({ phase: "response", method, status: result.status });
        } else if (method === "initialize") {
          receipt({ phase: "response", method, userAgent: result.userAgent });
        } else if (method === "thread/start") {
          receipt({ phase: "response", method, threadId: object(result.thread).id, cwd: object(result.thread).cwd,
            model: result.model, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy });
        }
        return result;
      };
    },
  });
  try {
    if (values.inspect) {
      const client = factory();
      await client.request("initialize", { clientInfo: { name: "nar-standalone-inspect", version: "1" },
        capabilities: { experimentalApi: true } });
      client.notify("initialized");
      const response = await client.request("config/read", { includeLayers: false, cwd: workspace });
      const config = object(response.config);
      const rc = await client.request("remoteControl/status/read", {});
      const models = await client.request("model/list", { limit: 100 });
      const defaultModel = Array.isArray(models.data) ? models.data.map(object).find(value => value.isDefault === true) : undefined;
      console.log(JSON.stringify({ model: config.model ?? defaultModel?.model ?? defaultModel?.id,
        effort: config.model_reasoning_effort ?? defaultModel?.defaultReasoningEffort,
        mcpServerNames: Object.keys(object(config.mcp_servers)), remoteControl: rc.status }));
      return;
    }
    receipt({ phase: "manifest", runId, codexHome, socketPath, socketGeneration: generation, workspace,
      model, effort, sandbox, webSearch, paperclipServer: false, injectedContext: values.thread ? "resumed" : "guidance",
      providerBoundCapture: "unverified", prompt: values.prompt });
    const driver = new CodexAppServerDriver({
      taskEnvelope: createCodexTaskEnvelope({ objective: "", criteria: [], constraints: [] }),
      conversationMode: "direct", baseInstructions: "", includeSkillInstructions: false,
      includeCollaborationModeInstructions: false, dynamicTools: [], model, reasoningEffort: effort,
      sharedDaemonSandbox: sandbox as "read-only" | "workspace-write" | "danger-full-access",
      sharedDaemonWebSearch: webSearch,
      sharedDaemonDeveloperInstructions: guidance,
      sharedDaemonCompaction: { autoCompactTokenLimit: compactLimit, compactPromptFile: values["compact-prompt-file"] ? resolve(values["compact-prompt-file"]) : undefined },
      approvalPolicy: "never", transportFactory: factory,
      environment: { HOME: homedir(), CODEX_HOME: codexHome, PATH: process.env.PATH, LANG: process.env.LANG },
      capabilities: { goals: false, dynamicTools: false },
    });
    if (values.thread) {
      const recovered = await driver.recoverSession({ driverKind: "codex-app-server", driverSessionId: values.thread,
        runId, normalizedSessionId: runId, workingDirectory: workspace });
      if (!recovered.recovered) throw new Error(`thread resume refused: ${recovered.reason}`);
      session = recovered.session;
      receipt({ phase: "response", method: "thread/resume", threadId: values.thread });
    } else session = await driver.openSession({ runId, normalizedSessionId: runId, workingDirectory: workspace });
    if (!session) throw new Error("session recovery returned no session");
    const threadName = [modelEffortTag(model, effort), (values.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "NAR"]
      .filter(Boolean).join(" ");
    try {
      await transport!.request("thread/name/set", { threadId: session.ids().driverSessionId, name: threadName });
      receipt({ phase: "response", method: "thread/name/set", name: threadName });
    } catch (error) {
      receipt({ phase: "warning", method: "thread/name/set", message: error instanceof Error ? error.message : "name failed" });
    }
    save("identity.json", { runId, codexHome, socketPath, socketGeneration: generation, workspace,
      model, effort, ...session.ids(), snapshot: await session.snapshot() });
    let terminalType = "";
    const completed = (async () => {
      for await (const event of session!.events()) {
        receipt({ phase: "event", event });
        if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
          terminalType = event.eventType;
          return;
        }
      }
      throw new Error("native event stream ended without a terminal event; outcome unknown");
    })();
    const timed = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("standalone deadline exceeded; daemon turn preserved, outcome unknown")), timeoutMs);
    });
    // Attach both rejection handlers before awaiting either bootstrap or event completion.
    const execution = Promise.all([
      session.startTurn({ message: { role: "user", text: values.prompt! } }).then(turn => {
        receipt({ phase: "turn-accepted", threadId: session!.ids().driverSessionId, turnId: turn.turnId });
        return turn;
      }),
      completed,
    ]);
    const [turn] = await Promise.race([execution, timed]);
    if (deadline) clearTimeout(deadline);
    save("transcript.json", await transport!.request("thread/read", {
      threadId: session.ids().driverSessionId, includeTurns: true,
    }));
    const listing = await transport!.request("thread/list", { limit: 100 });
    const threadId = session.ids().driverSessionId;
    const listed = Array.isArray(listing.data) && listing.data.some(value => object(value).id === threadId);
    const summary = { runId, threadId, turnId: turn.turnId, terminal: terminalType,
      remoteControlStates, threadListContainsThread: listed, receiptDir, providerBoundCapture: "unverified" };
    save("result.json", summary);
    receipt({ phase: "completed", ...summary });
    console.log(JSON.stringify(summary));
    if (terminalType !== "turn.completed" || !listed) throw new Error("standalone proof incomplete; inspect receipt");
  } catch (error) {
    receipt({ phase: "error", message: error instanceof Error ? error.message : "standalone failure",
      threadId: session?.ids().driverSessionId ?? null, replayed: false });
    throw error;
  } finally {
    if (deadline) clearTimeout(deadline);
    // Only detach our socket. Never terminate the daemon, interrupt, or replay a turn.
    if (session) await session.close({ reason: "standalone observer detached" });
    else await transport?.close();
    if (journal !== undefined) closeSync(journal);
  }
}
