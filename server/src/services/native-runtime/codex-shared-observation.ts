import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activateCodexSharedObservation, beginCodexSharedObservation, type CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";

/**
 * The attestation must inspect the configured daemon and exact thread; attach
 * must use Runner's authenticated shared socket. No provider payload is
 * accepted as authority. This helper does not start or stop the daemon.
 */
export async function attachCodexSharedObservation<T extends { detach():Promise<void>; isConnected():boolean; onDisconnect(listener:()=>void):void }>(input:{
  db:Db; binding:CodexSharedGoalBinding; sourceGoalDigest:string|null;
  attest():Promise<void>; attach():Promise<T>;
}):Promise<T> {
  await input.attest();
  const epochId=randomUUID();
  if (await beginCodexSharedObservation(input.db,input.binding,{epochId,sourceGoalDigest:input.sourceGoalDigest})!=="fresh") throw new Error("codex_shared_observation_reconciliation_required");
  let session:T|undefined;
  let disconnected=false;
  const markUncertain=()=>{
    disconnected=true;
    void beginCodexSharedObservation(input.db,input.binding,{epochId,sourceGoalDigest:input.sourceGoalDigest}).catch(()=>{});
  };
  try {
    session=await input.attach();
    session.onDisconnect(markUncertain);
    await input.attest();
    if (disconnected || !session.isConnected()) throw new Error("codex_shared_observation_disconnected");
    await activateCodexSharedObservation(input.db,input.binding,epochId);
    if (disconnected || !session.isConnected()) throw new Error("codex_shared_observation_disconnected");
    return session;
  } catch (error) {
    // An attach can succeed even if its acknowledgement or activation fails.
    // A second begin atomically records the possible gap; never reattach here.
    try { await beginCodexSharedObservation(input.db,input.binding,{epochId,sourceGoalDigest:input.sourceGoalDigest}); } catch { /* the expired lease already blocks writes */ }
    if (session) { try { await session.detach(); } catch { /* preserve original failure */ } }
    throw error;
  }
}
