import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ClaudeInteractiveOwnerJournal } from "./native-interactive-controller.js";

interface OwnerCommand { operationId:string; sessionId:string; processGeneration:string; inputSha256:string; }
const digest=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
const sha=/^[0-9a-f]{64}$/;
/** Append-only per-operation reservation. The directory must already be a
 * private, durable Runner-owned directory; no separate database or scheduler. */
export class NativeOwnerCommandJournal implements ClaudeInteractiveOwnerJournal {
  private readonly directory:string;
  private readonly sessionId:string;
  private readonly generation:string;
  private readonly owned=new Set<string>();
  constructor(input:{directory:string;sessionId:string;processGeneration:string}) {
    if (!isAbsolute(input.directory) || !input.sessionId || !input.processGeneration) throw new Error("invalid native owner journal binding");
    this.directory=resolve(input.directory);this.sessionId=input.sessionId;this.generation=input.processGeneration;
  }
  private async assertDirectory():Promise<void> {
    const stat=await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform!=="win32" && ((stat.mode & 0o077)!==0 || stat.uid!==process.getuid?.()))) throw new Error("native owner journal directory must be private and owned");
  }
  private path(operationId:string,suffix:string):string { return join(this.directory,`${digest(operationId)}.${suffix}`); }
  private async syncDirectory():Promise<void> {const d=await open(this.directory,"r");try{await d.sync();}finally{await d.close();}}
  async begin(input:OwnerCommand):Promise<"reserved"|"existing"|"uncertain"> {
    if (!input.operationId.trim() || input.operationId.length>128 || input.sessionId!==this.sessionId || input.processGeneration!==this.generation || !sha.test(input.inputSha256)) throw new Error("native owner command binding invalid");
    await this.assertDirectory();
    const path=this.path(input.operationId,"reservation");
    const record=JSON.stringify({schema:"paperclip.claude.owner-command.v1",...input});
    let file;
    try { file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600); }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      try {
        const stat=await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size>4096 || (process.platform!=="win32" && (stat.mode&0o077)!==0)) return "uncertain";
        const prior=await readFile(path,"utf8");
        if (prior!==record) throw new Error("native owner operation id conflict");
        return "existing";
      } catch(error) {if(error instanceof Error && error.message==="native owner operation id conflict")throw error;return "uncertain";}
    }
    try { await file.writeFile(record,"utf8");await file.sync(); } finally { await file.close(); }
    await this.syncDirectory();
    this.owned.add(input.operationId);
    return "reserved";
  }
  async written(operationId:string):Promise<void> {
    if (!this.owned.delete(operationId)) throw new Error("native owner command reservation not held");
    await this.assertDirectory();
    const file=await open(this.path(operationId,"written"),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    try { await file.writeFile('{"write":"attempted","delivery":"unknown"}',"utf8");await file.sync(); } finally { await file.close(); }
    await this.syncDirectory();
  }
}
