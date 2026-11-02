import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { NativeOwnerCommandJournal } from "./native-owner-command-journal.js";
import { ClaudeInteractiveReceiptFence, type ClaudeInteractiveReceipt } from "./native-interactive-receipts.js";

/** The adapter is a trusted host boundary, not a PID supplied in hook JSON.
 * It must obtain peer identity from the kernel, verify the peer's live ancestry
 * and both process births, and bind the launch namespace before returning. */
export interface ClaudeHookKernelPeerAdapter<Connection> {
  verify(connection: Connection, expected: Readonly<ClaudeHookLaunchIdentity>): Promise<boolean>;
}
export interface ClaudeHookLaunchIdentity {
  sessionId: string; cwd: string; pid: number; processGeneration: string; namespace: string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE=/^[0-9a-f]{64}$/;
const sha=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");

/** SessionStart ingress only. This boundary does not implement the native
 * socket adapter, issue a launch nonce, or create a verifier SDK-init receipt. */
export class ClaudeHookStartIngress<Connection> {
  private readonly identity: Readonly<ClaudeHookLaunchIdentity>;
  private readonly nonce: Buffer;
  private readonly journal: NativeOwnerCommandJournal;
  private readonly fence: ClaudeInteractiveReceiptFence;
  private readonly verify: ClaudeHookKernelPeerAdapter<Connection>["verify"];
  constructor(input:{identity:ClaudeHookLaunchIdentity; nonce:string; journalDirectory:string; peer:ClaudeHookKernelPeerAdapter<Connection>}) {
    const {identity}=input;
    if (!UUID.test(identity.sessionId) || !isAbsolute(identity.cwd) || !Number.isSafeInteger(identity.pid) || identity.pid<1 || !identity.processGeneration || identity.processGeneration.length>1024 || !identity.namespace || identity.namespace.length>1024 || !NONCE.test(input.nonce)) throw new Error("invalid Claude hook binding");
    this.identity=Object.freeze({...identity,cwd:resolve(identity.cwd)});
    this.nonce=Buffer.from(input.nonce,"hex");
    this.journal=new NativeOwnerCommandJournal({directory:input.journalDirectory,sessionId:identity.sessionId,processGeneration:identity.processGeneration});
    this.fence=new ClaudeInteractiveReceiptFence({sessionId:identity.sessionId,cwd:this.identity.cwd,processGeneration:identity.processGeneration});
    this.verify=input.peer.verify.bind(input.peer);
  }
  /** Unknown/crashed prior reservations fail closed; replay is never accepted.
   * A successful receipt does not prove Remote Control or turn completion. */
  async accept(input:{connection:Connection; nonce:string; body:string}):Promise<ClaudeInteractiveReceipt> {
    if (typeof input.body!=="string" || Buffer.byteLength(input.body,"utf8")>4096 || !NONCE.test(input.nonce)) throw new Error("invalid Claude hook input");
    const provided=Buffer.from(input.nonce,"hex");
    if (!timingSafeEqual(provided,this.nonce)) throw new Error("Claude hook nonce mismatch");
    if (!await this.verify(input.connection,this.identity)) throw new Error("Claude hook peer unverified");
    const receipt=this.fence.project(input.body,this.identity.processGeneration);
    if (receipt.event!=="SessionStart") throw new Error("Claude hook event is not SessionStart");
    const operationId=`hook-start:${sha(input.nonce)}`;
    const status=await this.journal.begin({operationId,sessionId:this.identity.sessionId,processGeneration:this.identity.processGeneration,inputSha256:sha(input.body)});
    if (status!=="reserved") throw new Error("Claude hook receipt already consumed or uncertain");
    // A failed write leaves the durable reservation in place and cannot be replayed.
    await this.journal.written(operationId);
    return receipt;
  }
}
