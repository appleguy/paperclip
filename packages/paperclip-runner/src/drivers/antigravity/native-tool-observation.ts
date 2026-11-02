import { createHash } from "node:crypto";
import type { NativeEvent } from "./native-control.js";

/** Native stream observation, not a tool invocation, result, or server receipt. */
export interface AntigravityToolObservation {
  schema: "paperclip.antigravity.tool-observation.v1";
  observationId: string;
  runId: string;
  environmentLeaseId: string;
  normalizedSessionId: string;
  turnId: string;
  bindingId: string;
  bindingGeneration: number;
  conversationId: string;
  processGeneration: string;
  stepIndex: number;
  state: string;
  toolNameDigest: string;
  authority: "provider_observation_only";
}
export type AntigravityToolBinding = Pick<AntigravityToolObservation, "runId" | "environmentLeaseId" | "normalizedSessionId" | "turnId" | "bindingId" | "bindingGeneration" | "conversationId" | "processGeneration">;

/** The version-pinned stream exposes step index and name, not a durable tool-call ID.
 * Identical step/state observations dedupe within one process generation only. */
export function normalizeAntigravityToolObservation(binding: AntigravityToolBinding, event: NativeEvent): AntigravityToolObservation | null {
  if (event.conversationId !== binding.conversationId) throw new Error("Antigravity tool observation conversation mismatch");
  if (event.kind !== "step" || event.toolName === undefined) return null;
  const values = [binding.runId,binding.environmentLeaseId,binding.normalizedSessionId,binding.turnId,binding.bindingId,binding.conversationId,binding.processGeneration,event.state,event.stepType,event.toolName];
  if (values.some(value => typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 256 || /[\x00-\x1f\x7f]/.test(value)) || !Number.isSafeInteger(binding.bindingGeneration) || binding.bindingGeneration < 1 || !Number.isSafeInteger(event.index) || event.index < 0) throw new Error("Invalid Antigravity tool observation");
  const data = { runId:binding.runId,environmentLeaseId:binding.environmentLeaseId,normalizedSessionId:binding.normalizedSessionId,turnId:binding.turnId,bindingId:binding.bindingId,bindingGeneration:binding.bindingGeneration,conversationId:binding.conversationId,processGeneration:binding.processGeneration,stepIndex:event.index,state:["running","completed","failed"].includes(event.state)?event.state:"other",toolNameDigest:`sha256:${createHash("sha256").update(event.toolName).digest("hex")}` };
  const observationId = `sha256:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`;
  return {schema:"paperclip.antigravity.tool-observation.v1",observationId,...data,authority:"provider_observation_only"};
}
