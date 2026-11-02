export function resolveCodexSharedRegistration(env: NodeJS.ProcessEnv, agentId: string): {
  grantId: string;
  hostId: string;
  codexExecutable: string;
  codexHome: string;
  home: string;
} | null {
  let grantId: string | undefined;
  if (env.PAPERCLIP_CODEX_SHARED_GRANTS?.trim()) {
    let grants: unknown;
    try {
      grants = JSON.parse(env.PAPERCLIP_CODEX_SHARED_GRANTS);
    } catch {
      throw new Error("codex_shared_registration_unavailable");
    }
    if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
      throw new Error("codex_shared_registration_unavailable");
    }
    const value = Object.prototype.hasOwnProperty.call(grants, agentId)
      ? (grants as Record<string, unknown>)[agentId] : undefined;
    if (value === false || value === null) return null;
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error("codex_shared_registration_unavailable");
    }
    grantId = typeof value === "string" ? value.trim() : undefined;
  }
  if (!grantId && env.PAPERCLIP_CODEX_SHARED_AGENT_ID?.trim() === agentId) {
    grantId = env.PAPERCLIP_CODEX_SHARED_GRANT_ID?.trim();
    if (!grantId) throw new Error("codex_shared_registration_unavailable");
  }
  if (!grantId && env.PAPERCLIP_CODEX_SHARED_DEFAULT !== "1") return null;
  const hostId = env.PAPERCLIP_CODEX_SHARED_HOST_ID?.trim();
  const codexExecutable = env.PAPERCLIP_CODEX_SHARED_EXECUTABLE?.trim();
  const codexHome = env.PAPERCLIP_CODEX_SHARED_CODEX_HOME?.trim();
  const home = env.PAPERCLIP_CODEX_SHARED_HOME?.trim();
  if (!hostId || !codexExecutable || !codexHome || !home) {
    throw new Error("codex_shared_registration_unavailable");
  }
  return { grantId: grantId ?? "", hostId, codexExecutable, codexHome, home };
}
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { codexDaemonGeneration, localNativeDaemonHost, registerCodexNativeDelegation } from "./codex-native-delegation.js";


/** Resolve the current attestation for an explicitly opted-in agent. */
export async function resolveCurrentCodexSharedRegistration(env:NodeJS.ProcessEnv,db:Db,companyId:string,agentId:string,runnerExecutable:string|(()=>string),issueProjectId?:()=>Promise<string|null|undefined>, scope?:{model:string;effort:string}) {
  const registration=resolveCodexSharedRegistration(env,agentId);
  if (!registration) return null;
  // Grants are bound per project: pick the grant for the issue's project, and keep a projectless issue on the ordinary route.
  const projectId=issueProjectId ? await issueProjectId() : undefined;
  if (issueProjectId && !projectId) return null;
  const host=localNativeDaemonHost({...registration,runnerExecutable:typeof runnerExecutable==="function"?runnerExecutable():runnerExecutable});
  const processGeneration=codexDaemonGeneration(await host.inspect());
  const rows=await db.select({id:connectionGrants.id,config:toolConnections.config}).from(connectionGrants).innerJoin(toolConnections,and(eq(toolConnections.id,connectionGrants.connectionId),eq(toolConnections.companyId,connectionGrants.companyId))).where(and(eq(connectionGrants.companyId,companyId),eq(connectionGrants.kind,"agent"),eq(connectionGrants.subjectAgentId,agentId),eq(connectionGrants.status,"active"),eq(toolConnections.enabled,true),eq(toolConnections.status,"active"))).orderBy(desc(connectionGrants.createdAt),desc(connectionGrants.id));
  const selected=rows.find(row=>{
    const d=row.config.codexNativeDelegation;
    if (!d || typeof d!=="object" || Array.isArray(d)) return false;
    const value=d as Record<string,unknown>;
    return value.schema==="paperclip.codex-native-delegation.v1" && value.agentId===agentId && (projectId===undefined || value.projectId===projectId) && (!scope || (value.model===scope.model && value.effort===scope.effort)) && value.hostId===registration.hostId && value.processGeneration===processGeneration && typeof value.expiresAt==="string" && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt)>Date.now();
  });
  if (!selected && scope && projectId) {
    const issuer=env.PAPERCLIP_CODEX_SHARED_ISSUER_USER_ID?.trim();
    if (!issuer) throw new Error("codex_shared_issuer_unset: configure PAPERCLIP_CODEX_SHARED_ISSUER_USER_ID");
    const created=await registerCodexNativeDelegation(db,host,{companyId,projectId,agentId,model:scope.model,effort:scope.effort,issuer,expiresAt:new Date(Date.now()+30*86400_000)});
    return {...registration,grantId:created.grantId};
  }
  if (!selected) throw new Error("codex_shared_grant_stale: run renew-shared-grants");
  return {...registration,grantId:selected.id};
}
