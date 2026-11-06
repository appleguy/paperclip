import { parseObject } from "../adapters/utils.js";

export function pendingInteractionSummary(payload: unknown): string {
  const questions = parseObject(payload).questions;
  if (!Array.isArray(questions)) return "Question details are available on the card.";
  const prompts = questions.flatMap(question => {
    const prompt = parseObject(question).prompt;
    return typeof prompt === "string" && prompt.trim() ? [prompt.trim().replace(/\s+/g, " ")] : [];
  });
  return prompts.length ? prompts.join("; ").slice(0, 500) : "Question details are available on the card.";
}
