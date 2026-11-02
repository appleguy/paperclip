import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
const run=promisify(execFile);
const record=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
export type CodexDaemonPeer = Readonly<{pid:number;startSeconds:number;startMicroseconds:number;executable:string}>;
/** Read-only discovery of the configured daemon and its kernel-authenticated peer.
 * It neither authorizes a run nor asserts that a thread belongs to the task. */
export async function inspectCodexSharedDaemon(input:{codexExecutable:string;codexHome:string;runnerExecutable:string;home:string}) {
  if (![input.codexExecutable,input.codexHome,input.runnerExecutable,input.home].every(isAbsolute)) throw new Error("codex_shared_paths_invalid");
  const home=await lstat(input.codexHome);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid!==process.getuid?.() || (home.mode&0o022)!==0) throw new Error("codex_shared_home_invalid");
  const executable=await realpath(input.codexExecutable);
  let metadata:Record<string,unknown>;
  try {
    const {stdout}=await run(executable,["app-server","daemon","version"],{env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:input.home,CODEX_HOME:input.codexHome,LANG:"C"},timeout:8000,maxBuffer:128*1024});
    metadata=record(JSON.parse(stdout));
  } catch { throw new Error("codex_shared_daemon_metadata_unavailable"); }
  if (metadata.status!=="running" || metadata.cliVersion!=="0.166.0" || metadata.appServerVersion!=="0.166.0" || metadata.managedCodexVersion!=="0.166.0" || typeof metadata.managedCodexPath!=="string" || !isAbsolute(metadata.managedCodexPath) || typeof metadata.socketPath!=="string" || !isAbsolute(metadata.socketPath)) throw new Error("codex_shared_daemon_version_or_socket_invalid");
  const managedExecutable=await realpath(metadata.managedCodexPath), managedRelative=relative(await realpath(input.codexHome),managedExecutable);
  if (!managedRelative || managedRelative===".." || managedRelative.startsWith(`..${sep}`) || isAbsolute(managedRelative)) throw new Error("codex_shared_daemon_executable_invalid");
  const socketPath=await realpath(metadata.socketPath);
  async function inspect() {
    try {
      const {stdout}=await run(input.runnerExecutable,["--inspect-codex-peer",socketPath],{env:{PATH:"/usr/bin:/bin",LANG:"C"},timeout:8000,maxBuffer:8192});
      const output=record(JSON.parse(stdout)),peer=record(output.peer);
      if (typeof output.daemonGeneration!=="string" || !output.daemonGeneration || !Number.isSafeInteger(peer.pid) || Number(peer.pid)<=0 || !Number.isSafeInteger(peer.startSeconds) || !Number.isSafeInteger(peer.startMicroseconds) || Number(peer.startMicroseconds)<0 || Number(peer.startMicroseconds)>=1_000_000 || typeof peer.executable!=="string" || !isAbsolute(peer.executable) || await realpath(peer.executable)!==managedExecutable) throw new Error();
      return {daemonGeneration:output.daemonGeneration,peer:peer as unknown as CodexDaemonPeer};
    } catch { throw new Error("codex_shared_daemon_peer_invalid"); }
  }
  const first=await inspect(),second=await inspect();
  if (JSON.stringify(first)!==JSON.stringify(second)) throw new Error("codex_shared_daemon_identity_changed");
  return Object.freeze({socketPath,codexHome:input.codexHome,cliVersion:"0.166.0" as const,appServerVersion:"0.166.0" as const,...first});
}
