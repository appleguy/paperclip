import { unprocessable } from "../../errors.js";

// Match the identifiers accepted by the RC dispatchers, including trimmed
// strings and blank values selecting the adapter's default socket/session.
const TMUX_NAME = /^[a-zA-Z0-9_-]{1,55}$/;

export function validateRemoteControlNames(type: string, config: Record<string, unknown>, slots = 1): void {
  for (const field of ["tmuxSocket", "tmuxSession"] as const) {
    const value = config[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (typeof value !== "string" || !TMUX_NAME.test(value.trim())) {
      throw unprocessable(`Invalid ${type} adapterConfig.${field}: expected 1–55 letters, digits, underscores or hyphens`);
    }
    if (field === "tmuxSession" && slots > 1 && !TMUX_NAME.test(`${value.trim()}-s${slots - 1}`)) {
      throw unprocessable(`Invalid ${type} adapterConfig.tmuxSession: leave room within 55 characters for the seat suffix -s${slots - 1}`);
    }
  }
}
