import { expect, it } from "vitest";
import { createOpenCodeBridgeReceiptLink, verifyOpenCodeBridgeReceiptLink, verifyOpenCodeBridgeReceiptSet } from "./opencode-bridge-receipt-link.js";
import { nativeSha256 } from "./canonical.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";

it("binds only a unique completed bridge receipt to the original operation and result", () => {
  const binding = { runId: "run", providerSessionId: "ses_test", epoch: "epoch" } as OpenCodeSharedBinding;
  const call = { callId: "call", tool: "workspace_write", arguments: { path: "a", text: "b", expectedSha256: null } };
  const authorityReceipt = createOpenCodeBridgeReceiptLink(binding, call)!;
  const result = { outcome: "ok" };
  const entry = { operationId: authorityReceipt.operationId, digest: authorityReceipt.semanticDigest, tool: call.tool, state: "returned", resultDigest: nativeSha256(result), authorityReceipt };
  const saved = { bridgeToolReceipts: { [authorityReceipt.key]: { tool: call.tool, digest: authorityReceipt.inputDigest, state: "completed", result } } };
  expect(verifyOpenCodeBridgeReceiptSet(binding, [entry], saved, entry.operationId)).toBe(true);
  expect(verifyOpenCodeBridgeReceiptSet(binding, [entry, entry], saved, entry.operationId)).toBe(false);
  expect(verifyOpenCodeBridgeReceiptSet(binding, [entry, { ...entry, operationId: "f".repeat(64) }], saved, entry.operationId)).toBe(false);
  for (const altered of [{ ...entry, state: "reserved" }, { ...entry, digest: "0".repeat(64) }, { ...entry, resultDigest: "0".repeat(64) }, { ...entry, authorityReceipt: undefined }, { ...entry, authorityReceipt: { ...authorityReceipt, key: "0".repeat(64) } }]) expect(verifyOpenCodeBridgeReceiptLink(binding, altered, saved)).toBe(false);
  for (const other of [{ ...binding, runId: "other" }, { ...binding, providerSessionId: "ses_other" }, { ...binding, epoch: "other" }]) expect(verifyOpenCodeBridgeReceiptLink(other, entry, saved)).toBe(false);
  expect(verifyOpenCodeBridgeReceiptLink(binding, entry, {})).toBe(false);
  expect(verifyOpenCodeBridgeReceiptLink(binding, entry, { bridgeToolReceipts: { [authorityReceipt.key]: { ...saved.bridgeToolReceipts[authorityReceipt.key], state: "pending" } } })).toBe(false);
  expect(verifyOpenCodeBridgeReceiptLink(binding, entry, { bridgeToolReceipts: { [authorityReceipt.key]: { ...saved.bridgeToolReceipts[authorityReceipt.key], result: { changed: true } } } })).toBe(false);
  expect(createOpenCodeBridgeReceiptLink(binding, { ...call, tool: "get_task_context" })).toBeUndefined();
});
