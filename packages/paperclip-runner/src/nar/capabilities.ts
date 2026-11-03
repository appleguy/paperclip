// Capability matrix (spec section 3.3) as data. A cell moves to PROVEN-LIVE only
// when its conformance test ran against the live provider (spec section 8).
import type { Capabilities, Provider } from "./driver.js";

export const CAPABILITIES: Record<Provider, Capabilities> = {
  claude: {
    provider: "claude",
    inputKind: "mcp_channel",
    ackGrade: "emitted_local",
    receiptKinds: ["mcp_tool"],
    ownerPhone: { path: "Remote Control URL, same session", proof: "PROVEN-LIVE" },
    permission: { route: "channel_relay", proof: "PROVEN-LIVE" },
    resume: { byId: true, proof: "PROVEN-LIVE" },
    interrupt: { scoped: false, proof: "OPEN" },
    needsPane: true,
    observeCoverage: "incomplete",
  },
  agy: {
    provider: "agy",
    inputKind: "pane_text",
    ackGrade: "emitted_local",
    receiptKinds: ["file"],
    ownerPhone: { path: "agy Remote Control URL (legacy pane input)", proof: "PROVEN-LIVE" },
    permission: { route: "none", proof: "UNSUPPORTED" },
    resume: { byId: true, proof: "OPEN" },
    interrupt: { scoped: false, proof: "OPEN" },
    needsPane: true,
    observeCoverage: "incomplete",
  },
  opencode: {
    provider: "opencode",
    inputKind: "http_api",
    ackGrade: "accepted_provider",
    receiptKinds: ["mcp_tool", "provider_event"],
    ownerPhone: { path: "Herdr/Moshi pane (generic)", proof: "OPEN" },
    permission: { route: "provider_policy", proof: "OPEN" },
    resume: { byId: true, proof: "SHIPPED-UNPROVEN" },
    interrupt: { scoped: true, proof: "SHIPPED-UNPROVEN" },
    needsPane: false,
    observeCoverage: "complete",
  },
  codex: {
    provider: "codex",
    inputKind: "rpc",
    ackGrade: "accepted_provider",
    receiptKinds: ["mcp_tool", "provider_event"],
    ownerPhone: { path: "Codex app thread visibility (unverified)", proof: "OPEN" },
    permission: { route: "provider_policy", proof: "SHIPPED-UNPROVEN" },
    resume: { byId: true, proof: "SHIPPED-UNPROVEN" },
    interrupt: { scoped: true, proof: "SHIPPED-UNPROVEN" },
    needsPane: false,
    observeCoverage: "complete",
  },
};

/** A driver whose strongest honest grade is queued_local is degraded (spec 3.2). */
export function isDispatchEligible(c: Capabilities): boolean {
  return c.ackGrade !== "queued_local";
}
