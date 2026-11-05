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

/** The requested fallback estimate; bytes/3 is not a proven token upper bound. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function assertPromptTokenShare(input: {
  seat: string;
  model: string;
  prompt: string;
  share?: number;
}): void {
  const limit = tokenPreflightModelLimit(input.model);
  if (limit === null) return;
  const share = input.share ?? 1;
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`Invalid token preflight share for ${input.seat} (${input.model}); model limit ${limit} tokens`);
  }
  const estimate = estimatePromptTokens(input.prompt);
  const allowance = Math.floor(limit * share);
  if (estimate > allowance) {
    throw new Error(`Token preflight refused ${input.seat} (${input.model}): estimated ${estimate} tokens exceeds configured allowance ${allowance}; model limit ${limit} tokens`);
  }
}
