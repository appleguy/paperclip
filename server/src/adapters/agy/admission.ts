import fs from "node:fs/promises";
import path from "node:path";

export const AGY_HOST_ADMISSION = "/Volumes/NVM/AI_Agent_Runtime/agy-3p-admission";

type Owner = { runId: string; issueId: string; stateDir: string };

/** The seat lock must already be held, including during restart reattachment. */
export async function claimAgyHostAdmission(root: string, owner: Owner, reattach: boolean): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lease = path.join(root, "active");
  const record = path.join(lease, "owner.json");
  try {
    await fs.mkdir(lease, { mode: 0o700 });
    await fs.writeFile(record, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await fs.readFile(record, "utf8").then(raw => JSON.parse(raw) as Partial<Owner>).catch(() => null);
    if (!reattach || !current || current.runId !== owner.runId || current.issueId !== owner.issueId || current.stateDir !== owner.stateDir)
      throw new Error("agy Remote Control seat busy: another Claude/GPT host admission is unresolved");
  }
  return async () => {
    const current = await fs.readFile(record, "utf8").then(raw => JSON.parse(raw) as Partial<Owner>).catch(() => null);
    if (!current || current.runId !== owner.runId || current.issueId !== owner.issueId || current.stateDir !== owner.stateDir)
      throw new Error("agy host admission ownership changed; reconciliation required");
    await fs.rm(lease, { recursive: true });
  };
}

export function isAgyHostLimitedModel(model: string): boolean {
  return /^(claude|gpt)-/i.test(model);
}

export function isAgyAdmissionIdle(snapshot: unknown, conversationId: string | null, receiptMtime: number, now = Date.now()): boolean {
  if (!snapshot || typeof snapshot !== "object" || !conversationId) return false;
  const status = snapshot as Record<string, unknown>;
  const observed = typeof status.observedAt === "string" ? Date.parse(status.observedAt) : NaN;
  return status.agentState === "idle" && status.conversationId === conversationId && status.pendingInputCount === 0
    && status.toolConfirmationPending === false && Number.isFinite(observed) && observed >= receiptMtime
    && observed <= now && now - observed <= 10_000;
}
