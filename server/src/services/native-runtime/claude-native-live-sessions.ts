/**
 * Process-local registry of the genuine Claude interactive sessions that the native-session executor launched under an
 * admitted run. The managed service (owner input / interrupt / Remote Control surface) adopts the SAME session from here;
 * it must never launch a second `--session-id`. Entries are removed by the executor when the run closes.
 */
export interface ClaudeLiveSessionControl {
  identity(): Promise<unknown>;
  ownerInput(input: { operationId: string; text: string }): Promise<unknown>;
  interrupt(input: { operationId: string }): Promise<unknown>;
  settlement(): unknown;
  capabilities(): unknown;
}
export interface ClaudeLiveSession {
  companyId: string; runId: string; nativeSessionId: string;
  control: ClaudeLiveSessionControl;
}

export class ClaudeLiveSessionRegistry {
  private readonly entries = new Map<string, ClaudeLiveSession>();
  private key(companyId: string, runId: string) { return `${companyId}:${runId}`; }
  register(entry: ClaudeLiveSession): () => void {
    const key = this.key(entry.companyId, entry.runId);
    if (this.entries.has(key)) throw new Error("claude_live_session_already_registered");
    this.entries.set(key, entry);
    return () => { if (this.entries.get(key) === entry) this.entries.delete(key); };
  }
  get(companyId: string, runId: string): ClaudeLiveSession | undefined { return this.entries.get(this.key(companyId, runId)); }
  has(companyId: string, runId: string): boolean { return this.entries.has(this.key(companyId, runId)); }
}

export const claudeLiveSessions = new ClaudeLiveSessionRegistry();
