import { createHash } from "node:crypto";
import { nativeSha256 } from "./canonical.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";

// Matches the existing PaperclipRunnerToolAuthority bridge receipt key and
// canonical input digest; version it rather than infer old journal links.
function bridgeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(bridgeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") { const obj = value as Record<string, unknown>; return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${bridgeCanonical(obj[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function createOpenCodeBridgeReceiptLink(binding: OpenCodeSharedBinding, call: { callId: string; tool: string; arguments: unknown }) {
  if (call.tool !== "workspace_write" && call.tool !== "workspace_run") return undefined;
  return { schema: "opencode.bridge-receipt-link.v1", runId: binding.runId, sessionId: binding.providerSessionId, epoch: binding.epoch, operationId: nativeSha256({ epoch: binding.epoch, sessionId: binding.providerSessionId, callId: call.callId }), semanticDigest: nativeSha256({ tool: call.tool, arguments: call.arguments }), key: sha(call.callId), tool: call.tool, inputDigest: sha(bridgeCanonical({ tool: call.tool, arguments: call.arguments })) } as const;
}

/** Evidence only; never invokes an authority, resends work, or admits recovery. */
export function verifyOpenCodeBridgeReceiptLink(binding: Pick<OpenCodeSharedBinding, "runId" | "providerSessionId" | "epoch">, entry: unknown, resultJson: unknown): boolean {
  const row = object(entry), link = object(row?.authorityReceipt), receipts = object(object(resultJson)?.bridgeToolReceipts);
  if (!row || !link || link.schema !== "opencode.bridge-receipt-link.v1" || link.runId !== binding.runId || link.sessionId !== binding.providerSessionId || link.epoch !== binding.epoch || link.operationId !== row.operationId || link.semanticDigest !== row.digest || typeof link.key !== "string" || !/^[a-f0-9]{64}$/.test(link.key) || typeof link.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(link.inputDigest) || link.tool !== row.tool || (link.tool !== "workspace_write" && link.tool !== "workspace_run") || row.state !== "returned" || typeof row.resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.resultDigest)) return false;
  const receipt = object(receipts?.[link.key]);
  return !!receipt && receipt.state === "completed" && receipt.tool === link.tool && receipt.digest === link.inputDigest && Object.hasOwn(receipt, "result") && nativeSha256(receipt.result) === row.resultDigest;
}

export function verifyOpenCodeBridgeReceiptSet(binding: Pick<OpenCodeSharedBinding, "runId" | "providerSessionId" | "epoch">, entries: unknown, resultJson: unknown, operationId: string): boolean {
  if (!Array.isArray(entries) || !/^[a-f0-9]{64}$/.test(operationId)) return false;
  const matches = entries.filter(entry => object(entry)?.operationId === operationId);
  if (matches.length !== 1) return false;
  const key = object(object(matches[0])?.authorityReceipt)?.key;
  if (typeof key !== "string" || entries.filter(entry => object(object(entry)?.authorityReceipt)?.key === key).length !== 1) return false;
  return verifyOpenCodeBridgeReceiptLink(binding, matches[0], resultJson);
}
