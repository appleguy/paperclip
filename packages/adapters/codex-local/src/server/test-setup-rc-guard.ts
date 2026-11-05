import { vi } from "vitest";

// SCO-912: legacy engine tests exercise execute() internals; neutralize the RC guard for them.
// rc-guard.test.ts imports the real module through vi.importActual.
vi.mock("./rc-guard.js", async (importActual) => ({
  ...(await importActual<typeof import("./rc-guard.js")>()),
  codexRemoteControlViolation: () => null,
  codexRcDaemonDownReason: () => null,
}));
