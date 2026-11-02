import { createDb } from "@paperclipai/db";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity } from "./native-restart-recovery.js";

// Isolated test child: inputs travel over IPC and are never written to output.
process.once("message", async (message: { connectionString: string; runId: string }) => {
  const db = createDb(message.connectionString);
  try {
    const controller = await currentNativeControllerIdentity();
    const dispositions = await claimNativeRestartRecoveries({ db, runIds: [message.runId], restartKind: "hard" });
    process.send?.({ controller, dispositions });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : "child_failed" });
  } finally {
    await db.$client.end({ timeout: 1 });
    process.disconnect?.();
  }
});
