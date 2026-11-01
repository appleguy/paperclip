import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { ClaudeInteractivePty, ClaudeInteractivePtyFactory } from "./native-interactive-controller.js";

const execFileAsync=promisify(execFile);
interface PtyProcess {
  pid:number;
  onData(handler:(data:string)=>void):{dispose():void};
  onExit(handler:()=>void):{dispose():void};
  write(data:string):void;
  kill(signal?:string):void;
}
interface PtyModule { spawn(file:string,args:string[],options:{name:string;cols:number;rows:number;cwd:string;env:Record<string,string>}):PtyProcess; }
const require=createRequire(import.meta.url);

/** macOS `ps` birth time has second precision; this is a process reuse fence,
 * not a cryptographic identity or proof of Claude Remote Control connection. */
export async function claudePtyProcessGeneration(pid:number):Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid<1 || process.platform!=="darwin") return null;
  try {
    const {stdout}=await execFileAsync("/bin/ps",["-p",String(pid),"-o","lstart="],{encoding:"utf8",timeout:2000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}});
    const birth=stdout.trim();
    return birth ? `${pid}:${birth}` : null;
  } catch { return null; }
}
export async function verifyClaudePtyGeneration(pid:number,generation:string):Promise<boolean> {
  return await claudePtyProcessGeneration(pid)===generation;
}
export interface ClaudeNativePty extends ClaudeInteractivePty {
  /** Explicit local terminal input only; this is not a durable delivery receipt. */
  writeInput(text:string):void;
}
export interface ClaudeNativePtyOptions {
  /** Explicit consumer for sensitive terminal data; default drains and discards it. */
  onOutput?:(data:string)=>void;
  /** Test seam; production resolves the declared node-pty dependency. */
  loadPty?:()=>PtyModule;
}
const permittedEnv=new Set(["PATH","HOME","CLAUDE_CONFIG_DIR","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CACHE_HOME","LANG","LANGUAGE","TERM","COLORTERM","TMPDIR","SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS"]);
/** Never pass provider API keys, Paperclip grants, or arbitrary caller environment. */
export function nativeSubscriptionEnvironment(base:NodeJS.ProcessEnv, explicit?:NodeJS.ProcessEnv):Record<string,string> {
  const result:Record<string,string>={};
  for (const source of [base,explicit]) {
    if (!source) continue;
    for (const [key,value] of Object.entries(source)) {
      if ((permittedEnv.has(key) || /^LC_[A-Z_]+$/.test(key)) && typeof value==="string" && !value.includes("\0")) result[key]=value;
    }
  }
  return result;
}
export class ClaudeNativePtyFactory implements ClaudeInteractivePtyFactory {
  constructor(private readonly options:ClaudeNativePtyOptions={}) {}
  async start(input:{executable:string;cwd:string;args:readonly string[];environment?:NodeJS.ProcessEnv}):Promise<ClaudeNativePty> {
    if (process.platform!=="darwin") throw new Error("Claude native PTY currently supports macOS only");
    let module:PtyModule;
    try { module=this.options.loadPty?.() ?? require("node-pty") as PtyModule; } catch { throw new Error("node-pty is unavailable; install the pinned native dependency"); }
    const env=nativeSubscriptionEnvironment(process.env,input.environment);
    const pty=module.spawn(input.executable,[...input.args],{name:"xterm-256color",cols:100,rows:32,cwd:input.cwd,env});
    let exited=false, detached=false, stopped=false;
    pty.onExit(()=>{exited=true;});
    pty.onData(data=>{if (!detached) { try { this.options.onOutput?.(data); } catch { /* output consumers cannot terminate the owner session */ } }});
    const generation=await claudePtyProcessGeneration(pty.pid);
    if (!generation || exited) throw new Error("Claude PTY process identity unavailable; reconcile launch");
    return {
      pid:pty.pid,generation,
      writeInput(text) {
        if (detached || stopped || exited) throw new Error("Claude PTY unavailable");
        if (typeof text!=="string" || Buffer.byteLength(text,"utf8")>65536) throw new Error("Claude PTY input too large");
        pty.write(text);
      },
      async detach(){ if(detached || stopped) throw new Error("Claude PTY unavailable"); detached=true; },
      async stop(){
        if(detached || stopped || exited) throw new Error("Claude PTY unavailable");
        if (!await verifyClaudePtyGeneration(pty.pid,generation)) throw new Error("Claude PTY process identity changed");
        stopped=true;
        pty.kill("SIGTERM");
      },
    };
  }
}
