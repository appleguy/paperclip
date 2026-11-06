import { stat } from "node:fs/promises";
import path from "node:path";
import { claudeLocalReasoningEffortsForModel, resolveClaudeModel } from "@paperclipai/adapter-claude-local";
import { codexLocalReasoningEffortsForModel, DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { HttpError, unprocessable } from "../../errors.js";
import type { ServerAdapterModule } from "../types.js";
import { validateConfig as validateAgyConfig } from "../agy/config-validation.js";
import { validateConfig as validateClaudeRcConfig } from "../claude-rc/config-validation.js";

const EFFORT_KEYS = ["effort", "reasoningEffort", "modelReasoningEffort"] as const;
const GENERIC_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
// Node timers overflow above this value, silently becoming a 1ms timeout.
const MAX_TIMER_MS = 2 ** 31 - 1;

function fail(type: string, field: string, reason: string): never {
  throw unprocessable(`Invalid ${type} adapterConfig.${field}: ${reason}`);
}

export async function validateConfig(type: string, config: Record<string, unknown>, context?: { localCwd?: boolean }): Promise<void> {
  if (config.model !== undefined && (typeof config.model !== "string"
    || config.model.trim().startsWith("-") || /[\x00-\x1f\x7f]/.test(config.model))) {
    fail(type, "model", "expected a model id string without control characters or a leading '-'");
  }
  if (type === "agy_local") validateAgyConfig(config);
  if (type === "claude_rc_local") validateClaudeRcConfig(config);

  const model = typeof config.model === "string" ? config.model : "";
  let efforts: readonly string[] = GENERIC_EFFORTS;
  if (type === "claude_local") efforts = claudeLocalReasoningEffortsForModel(resolveClaudeModel(config.model,
    typeof config.env === "object" && config.env !== null ? config.env as Record<string, unknown> : {}));
  if (type === "codex_local") efforts = codexLocalReasoningEffortsForModel(model || DEFAULT_CODEX_LOCAL_MODEL);
  if (type === "grok_local") efforts = grokLocalReasoningEffortsForModel(model);
  if (type === "kimi_local") efforts = ["low", "medium", "high", "max"];
  if (type === "claude_rc_local") efforts = ["low", "medium", "high", "xhigh", "max"];
  if (["process", "http", "agy_local", "cursor", "cursor_cloud", "gemini_local", "openclaw_gateway", "hermes_gateway", "hermes_local"].includes(type)) efforts = [];
  for (const key of EFFORT_KEYS) {
    if (config[key] !== undefined && config[key] !== ""
      && (typeof config[key] !== "string" || !efforts.includes(config[key] as string))) {
      fail(type, key, efforts.length ? `expected one of ${efforts.join(", ")}` : "this adapter does not support a separate effort setting");
    }
  }

  const rc = type === "agy_local" || type === "claude_rc_local";
  for (const [key, min, max] of [
    ["timeoutSec", rc ? 30 : 0, rc ? 3600 : MAX_TIMER_MS / 1000],
    ["timeoutMs", 0, MAX_TIMER_MS],
  ] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) {
      fail(type, key, `expected a finite number between ${min} and ${max}`);
    }
  }
  if (config.cwd !== undefined) {
    if (typeof config.cwd !== "string" || !(path.isAbsolute(config.cwd)
      || (context?.localCwd === false && path.win32.isAbsolute(config.cwd)))) fail(type, "cwd", "expected an absolute directory path");
    // A remote/sandbox cwd belongs to that environment, not the API host.
    if (context?.localCwd !== false) {
      const info = await stat(config.cwd).catch(() => null);
      if (!info?.isDirectory()) fail(type, "cwd", `directory does not exist or is not accessible: ${config.cwd}`);
    }
  }
}

/** Keep existing module identity (discovery uses it), and preserve plugin checks. */
const validatedAdapters = new WeakSet<ServerAdapterModule>();
export function withConfigValidation(adapter: ServerAdapterModule): ServerAdapterModule {
  if (validatedAdapters.has(adapter)) return adapter;
  const providerValidation = adapter.validateConfig;
  adapter.validateConfig = async (config, context) => {
    await validateConfig(adapter.type, config, context);
    try { await providerValidation?.call(adapter, config, context); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw unprocessable(`Invalid ${adapter.type} adapterConfig: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  validatedAdapters.add(adapter);
  return adapter;
}
