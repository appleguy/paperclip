import { assertWorkableCwd, isValidSeatSettings, rcSlotCount } from "./execute.js";
import { validateRemoteControlNames } from "../config-validation/remote-control-names.js";
import path from "node:path";
import { unprocessable } from "../../errors.js";

export function validateConfig(config: Record<string, unknown>): void {
  validateRemoteControlNames("claude_rc_local", config, rcSlotCount(config.slots));
  const model = config.model ?? "claude-sonnet-5-5";
  const effort = config.effort ?? "medium";
  if (typeof model !== "string" || !isValidSeatSettings(model, "medium")) {
    throw unprocessable("Invalid claude_rc_local adapterConfig.model: permits only claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5");
  }
  if (typeof effort !== "string" || !isValidSeatSettings(model, effort)) {
    throw unprocessable("Invalid claude_rc_local adapterConfig.effort: expected low, medium, high, xhigh or max");
  }
  if (typeof config.cwd === "string") {
    try { assertWorkableCwd(path.resolve(config.cwd)); }
    catch (error) { throw unprocessable(error instanceof Error ? error.message : String(error)); }
  }
}
