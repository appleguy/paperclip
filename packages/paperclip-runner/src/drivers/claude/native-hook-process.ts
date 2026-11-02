import {spawn} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,unlink} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";
import {NativeOwnerCommandJournal} from "./native-owner-command-journal.js";
import type {ClaudeNativePty} from "./native-pty-factory.js";

type LaunchScope=ClaudeNativePty["launchScope"];
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Paths contain no nonce. Install them in the owned launch's SessionStart
 * hook command before starting it. This is not an SDK-init receipt. */
export class ClaudeNativeHookProcess {
  readonly socketPath:string; readonly nonceFile:string;
  private readonly nonce:string; private used=false;
  private constructor(private readonly directory:string, private readonly executable:string, nonce:string) {
    this.nonce=nonce; this.socketPath=join(directory,`hook-${nonce.slice(0,16)}.sock`);this.nonceFile=join(directory,`hook-${nonce.slice(0,16)}.nonce`);
  }
  /** Paths, never the nonce, are embedded in the hook configuration. */
  sessionStartCommand():string {
    const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
    return `CLAUDE_HOOK_SOCKET=${quote(this.socketPath)} CLAUDE_HOOK_NONCE_FILE=${quote(this.nonceFile)} ${quote(this.executable)} send`;
  }
  async dispose():Promise<void> { await unlink(this.nonceFile).catch(()=>{}); }
  static async prepare(input:{directory:string; executable:string}):Promise<ClaudeNativeHookProcess> {
    if (!isAbsolute(input.directory)||!isAbsolute(input.executable)) throw new Error("invalid hook process paths");
    const dir=resolve(input.directory), st=await lstat(dir);
    if (!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.()) throw new Error("hook directory must be private and owned");
    const helper=new ClaudeNativeHookProcess(dir,resolve(input.executable),randomBytes(32).toString("hex"));
    if(process.platform==="darwin" && Buffer.byteLength(helper.socketPath)>=104) throw new Error("Claude hook socket path exceeds Darwin limit");
    const f=await open(helper.nonceFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    try {await f.writeFile(helper.nonce);await f.sync();} finally {await f.close();}
    return helper;
  }
  /** Call once after spawning the exact PTY. Reservation is durable before
   * the helper opens the socket. Failed or crashed reservations cannot replay. */
  async bind(input:{sessionId:string;launchScope:LaunchScope}):Promise<{sessionId:string;event:"SessionStart";peer:"darwin-kernel-pid-uid-and-live-ancestry";namespace:"parent-attested-launch-scope"}> {
    if(this.used) throw new Error("hook process already used");this.used=true;
    const s=input.launchScope;
    if(!uuid.test(input.sessionId)||s.source!=="parent-attested-launch-scope"||!Number.isSafeInteger(s.pid)||s.pid<1||!s.generation||![s.executable,s.cwd,s.home,s.config].every(isAbsolute)) throw new Error("invalid hook launch scope");
    const operationId=`hook-start:${hash(this.nonce)}`;
    const journal=new NativeOwnerCommandJournal({directory:this.directory,sessionId:input.sessionId,processGeneration:s.generation});
    const digest=hash(JSON.stringify({sessionId:input.sessionId,...s}));
    try {
      if(await journal.begin({operationId,sessionId:input.sessionId,processGeneration:s.generation,inputSha256:digest})!=="reserved") throw new Error("hook reservation already consumed or uncertain");
      const result=await new Promise<Record<string,unknown>>((resolveResult,reject)=>{
        const child=spawn(this.executable,[],{stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin:/usr/sbin",LC_ALL:"C"}});
        let output="",done=false;const timer=setTimeout(()=>{child.kill();finish(new Error("hook process deadline"));},20000);
        const finish=(error?:Error,value?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolveResult(value!);};
        child.on("error",()=>finish(new Error("hook process unavailable")));
        child.stdout.on("data",(chunk:Buffer)=>{output+=chunk.toString("utf8");if(Buffer.byteLength(output)>8192){child.kill();finish(new Error("hook process output too large"));}});
        child.on("close",code=>{if(code!==0)return finish(new Error("hook process rejected"));try {const lines=output.trim().split("\n");if(lines.length!==2||JSON.parse(lines[0]!).status!=="ready")throw new Error();finish(undefined,JSON.parse(lines[1]!) as Record<string,unknown>);}catch{finish(new Error("invalid hook process output"));}});
        child.stdin.on("error",()=>finish(new Error("hook process input failed")));
        child.stdin.end(JSON.stringify({socket:this.socketPath,nonce:this.nonce,sessionID:input.sessionId,...s}));
      });
      if(result.status!=="accepted"||result.sessionId!==input.sessionId||result.pid!==s.pid||result.generation!==s.generation||result.cwd!==s.cwd||result.executable!==s.executable||result.home!==s.home||result.config!==s.config||result.event!=="SessionStart"||result.peer!=="darwin-kernel-pid-uid-and-live-ancestry"||result.namespace!=="parent-attested-launch-scope") throw new Error("hook process receipt mismatch");
      await journal.written(operationId);
      return {sessionId:input.sessionId,event:"SessionStart",peer:"darwin-kernel-pid-uid-and-live-ancestry",namespace:"parent-attested-launch-scope"};
    } finally {await unlink(this.nonceFile).catch(()=>{});}
  }
}
