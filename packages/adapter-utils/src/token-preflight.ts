import type { AdapterExecutionContext } from "./types.js";
import { LocalTokenizer } from "@google/genai/tokenizer";

const geminiTokenizers = new Map<string, LocalTokenizer | null>();

/** Use only the provider's explicit model mapping; never substitute a nearby model. */
export async function promptTokenBound(model: string, prompt: string): Promise<number> {
  if (!model.toLowerCase().includes("gemini")) return estimatePromptTokens(prompt);
  const name = model.split("/").at(-1)!;
  let tokenizer = geminiTokenizers.get(name);
  if (tokenizer === undefined) {
    try { tokenizer = new LocalTokenizer(name); }
    catch { tokenizer = null; }
    geminiTokenizers.set(name, tokenizer);
  }
  if (tokenizer) {
    try {
      const count = (await tokenizer.countTokens(prompt)).totalTokens;
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count;
    } catch { /* Missing/corrupt provider assets retain the stricter byte bound. */ }
  }
  return estimatePromptTokens(prompt);
}

export async function assertAssembledPrompt(input: Parameters<typeof assertPromptTokenShare>[0]): Promise<number> {
  const bound = await promptTokenBound(input.model, input.prompt);
  assertPromptTokenShare({ ...input, tokenBound: bound });
  return bound;
}

/** Limits for the fleet models covered by the Paperclip token preflight. */
export function tokenPreflightModelLimit(model: string): number | null {
  const name = model.toLowerCase();
  if (/\b(?:gpt-6(?:\.1)?[-_.])?(?:sol|terra)\b/.test(name)) return 272_000;
  if (name.includes("gemini") && name.includes("pro")) return 200_000;
  if (name.includes("haiku")) return 100_000;
  if (name.includes("qwen")) return 102_400;
  if (name.includes("glm") || name.includes("deepseek")) return 131_072;
  return null;
}

/** Check the visible payload first; rotation never authorizes an oversized fresh prompt. */
export async function preflightSessionPrompt(ctx: AdapterExecutionContext, model: string, prompt: string, sessionId: string | null) {
  const promptTokens = await assertAssembledPrompt({ seat: ctx.agent.name, model, prompt,
    share: ctx.config.tokenPreflightShare === undefined ? undefined : Number(ctx.config.tokenPreflightShare) });
  return await ctx.evaluateSessionPrompt?.({ model, promptTokens, sessionId })
    ?? { rotate: false, reason: null, handoffMarkdown: null };
}

export function applyPromptRotation(ctx: AdapterExecutionContext, decision: { reason: string | null; handoffMarkdown: string | null }) {
  ctx.context.paperclipSessionRotationReason = decision.reason;
  ctx.context.paperclipSessionHandoffMarkdown = decision.handoffMarkdown;
  ctx.runtime.sessionId = null;
  ctx.runtime.sessionParams = null;
  ctx.runtime.sessionDisplayId = null;
}

/** One token per UTF-8 byte: conservative for byte-based text tokenizers. */
export function estimatePromptTokens(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function assertPromptTokenShare(input: {
  seat: string;
  model: string;
  prompt: string;
  share?: number;
  tokenBound?: number;
}): void {
  const limit = tokenPreflightModelLimit(input.model);
  if (limit === null) return;
  const share = input.share ?? 1;
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`Invalid token preflight share for ${input.seat} (${input.model}); model limit ${limit} tokens`);
  }
  const estimate = input.tokenBound ?? estimatePromptTokens(input.prompt);
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error(`Invalid token bound for ${input.seat} (${input.model}); model limit ${limit} tokens`);
  const allowance = Math.floor(limit * share);
  if (estimate > allowance) {
    throw new Error(`Token preflight refused ${input.seat} (${input.model}): prompt bound ${estimate} tokens exceeds configured allowance ${allowance}; model limit ${limit} tokens`);
  }
}
