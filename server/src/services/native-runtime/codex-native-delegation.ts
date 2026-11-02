import { createHash, randomUUID } from "node:crypto";
import { agents, projects, toolApplications, toolConnections, connectionGrants, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";

const object=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
export type NativeDaemonDelegation = Readonly<{schema:"paperclip.codex-native-delegation.v1";revision:string;hostId:string;processGeneration:string;projectId:string;agentId:string;model:string;effort:string;issuer:string;expiresAt:string}>;
type Tx=Parameters<Parameters<Db["transaction"]>[0]>[0];
export const codexDaemonGeneration=(d:Awaited<ReturnType<typeof inspectCodexSharedDaemon>>)=>createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries({daemonGeneration:d.daemonGeneration,peer:d.peer}).sort(([a],[b])=>a.localeCompare(b))),(_k,item:unknown)=>item && typeof item==="object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item)).digest("hex");
export type NativeDaemonHost = {hostId:string; inspect():ReturnType<typeof inspectCodexSharedDaemon>};
export function localNativeDaemonHost(input:{hostId:string;codexExecutable:string;codexHome:string;runnerExecutable:string;home:string}):NativeDaemonHost {
  if (!input.hostId.trim()) throw new Error("codex_delegation_host_missing");
  return {hostId:input.hostId,inspect:()=>inspectCodexSharedDaemon(input)};
}
export async function registerCodexNativeDelegation(db:Db,host:NativeDaemonHost,input:{companyId:string;projectId:string;agentId:string;model:string;effort:string;issuer:string;expiresAt:Date}) {
  if (![input.companyId,input.projectId,input.agentId,input.model,input.effort,input.issuer,host.hostId].every(v=>typeof v==="string" && v.trim().length>0 && v.length<=240) || !(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime()<=Date.now()) throw new Error("codex_delegation_invalid");
  const daemon=await host.inspect(); const processGeneration=codexDaemonGeneration(daemon);
  return db.transaction(async tx=>{
    return insertDelegation(tx,host,input,processGeneration);
  });
}
async function insertDelegation(tx:Tx,host:NativeDaemonHost,input:{companyId:string;projectId:string;agentId:string;model:string;effort:string;issuer:string;expiresAt:Date},processGeneration:string) {
    const [project]=await tx.select({id:projects.id}).from(projects).where(and(eq(projects.id,input.projectId),eq(projects.companyId,input.companyId))).limit(1);
    const [agent]=await tx.select({id:agents.id}).from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId))).limit(1);
    if (!project || !agent) throw new Error("codex_delegation_scope_invalid");
    const [app]=await tx.insert(toolApplications).values({companyId:input.companyId,applicationKey:"native-codex-daemon",name:"Native Codex daemon delegation",type:"mcp_http",metadata:{kind:"codex-native-delegation-v1"},ownerUserId:input.issuer}).onConflictDoNothing().returning({id:toolApplications.id,type:toolApplications.type,status:toolApplications.status,metadata:toolApplications.metadata});
    const [existing]=app ? [app] : await tx.select({id:toolApplications.id,type:toolApplications.type,status:toolApplications.status,metadata:toolApplications.metadata}).from(toolApplications).where(and(eq(toolApplications.companyId,input.companyId),eq(toolApplications.applicationKey,"native-codex-daemon"))).limit(1);
    if (!existing || existing.type!=="mcp_http" || existing.status!=="active" || existing.metadata.kind!=="codex-native-delegation-v1") throw new Error("codex_delegation_application_unavailable");
    const revision=randomUUID(), id=randomUUID();
    const config:NativeDaemonDelegation={schema:"paperclip.codex-native-delegation.v1",revision,hostId:host.hostId,processGeneration,projectId:input.projectId,agentId:input.agentId,model:input.model,effort:input.effort,issuer:input.issuer,expiresAt:input.expiresAt.toISOString()};
    await tx.insert(toolConnections).values({id,companyId:input.companyId,applicationId:existing.id,uid:`native-codex-${id}`,name:"Native Codex daemon delegation",connectionPurpose:"ai",transport:"runtime_auth",authKind:"none",status:"active",enabled:true,healthStatus:"ok",config:{codexNativeDelegation:config},createdByUserId:input.issuer});
    const [grant]=await tx.insert(connectionGrants).values({companyId:input.companyId,connectionId:id,kind:"agent",subjectAgentId:input.agentId,status:"active",createdByUserId:input.issuer}).returning({id:connectionGrants.id});
    if (codexDaemonGeneration(await host.inspect())!==processGeneration || Date.now()>=input.expiresAt.getTime()) throw new Error("codex_delegation_daemon_changed");
    return {connectionId:id,grantId:grant!.id,revision,processGeneration};
}

/** Renew only active administrator-issued intents, including expired attestations. */
export async function renewCodexSharedDelegations(db:Db,host:NativeDaemonHost,agentIds:string[],options:{days:number}) {
  if (!Number.isFinite(options.days) || options.days<=0 || options.days>3650 || new Set(agentIds).size!==agentIds.length) throw new Error("codex_delegation_renewal_invalid");
  const rows=await db.select({id:toolConnections.id,companyId:toolConnections.companyId,config:toolConnections.config,agentId:connectionGrants.subjectAgentId}).from(toolConnections).innerJoin(connectionGrants,and(eq(connectionGrants.connectionId,toolConnections.id),eq(connectionGrants.companyId,toolConnections.companyId))).where(and(eq(toolConnections.enabled,true),eq(toolConnections.status,"active"),eq(connectionGrants.kind,"agent"),eq(connectionGrants.status,"active")));
  const candidates=rows.filter(row=>{const d=object(row.config.codexNativeDelegation);return d.schema==="paperclip.codex-native-delegation.v1" && d.hostId===host.hostId && typeof row.agentId==="string" && (!agentIds.length || agentIds.includes(row.agentId));});
  const results=[];
  for (const row of candidates) {
    const processGeneration=codexDaemonGeneration(await host.inspect());
    const result=await db.transaction(async tx=>{
      const [locked]=await tx.select().from(toolConnections).where(and(eq(toolConnections.id,row.id),eq(toolConnections.companyId,row.companyId),eq(toolConnections.enabled,true),eq(toolConnections.status,"active"))).for("update").limit(1);
      if (!locked) throw new Error("codex_delegation_renewal_conflict");
      const [grant]=await tx.select().from(connectionGrants).where(and(eq(connectionGrants.connectionId,row.id),eq(connectionGrants.companyId,row.companyId),eq(connectionGrants.kind,"agent"),eq(connectionGrants.subjectAgentId,row.agentId!),eq(connectionGrants.status,"active"))).for("update").limit(1);
      const d=object(locked.config.codexNativeDelegation);
      if (!grant || d.schema!=="paperclip.codex-native-delegation.v1" || d.hostId!==host.hostId || d.agentId!==row.agentId || ![d.projectId,d.agentId,d.model,d.effort,d.issuer].every(v=>typeof v==="string" && v.trim())) throw new Error("codex_delegation_renewal_conflict");
      const replacement=await insertDelegation(tx,host,{companyId:row.companyId,projectId:d.projectId as string,agentId:d.agentId as string,model:d.model as string,effort:d.effort as string,issuer:d.issuer as string,expiresAt:new Date(Date.now()+options.days*86400_000)},processGeneration);
      await tx.update(connectionGrants).set({status:"revoked",revokedByUserId:d.issuer as string,revokedAt:new Date()}).where(and(eq(connectionGrants.companyId,row.companyId),eq(connectionGrants.connectionId,row.id)));
      await tx.update(toolConnections).set({enabled:false,updatedAt:new Date()}).where(eq(toolConnections.id,row.id));
      return {agentId:row.agentId,companyId:row.companyId,previousConnectionId:row.id,...replacement};
    });
    results.push(result);
  }
  return results;
}
export async function revokeCodexNativeDelegation(db:Db,input:{companyId:string;connectionId:string;issuer:string}) {
  await db.transaction(async tx=>{
    const [connection]=await tx.select().from(toolConnections).where(and(eq(toolConnections.id,input.connectionId),eq(toolConnections.companyId,input.companyId))).for("update").limit(1);
    if (object(connection?.config.codexNativeDelegation).schema!=="paperclip.codex-native-delegation.v1") throw new Error("codex_delegation_not_found");
    await tx.update(connectionGrants).set({status:"revoked",revokedByUserId:input.issuer,revokedAt:new Date()}).where(and(eq(connectionGrants.companyId,input.companyId),eq(connectionGrants.connectionId,input.connectionId)));
    await tx.update(toolConnections).set({enabled:false,updatedAt:new Date()}).where(eq(toolConnections.id,input.connectionId));
  });
}
export async function assertCodexNativeDelegation(tx:Tx,input:{companyId:string;projectId:string;agentId:string;model:string;effort:string;processGeneration:string;hostId?:string;delegationGrantId?:string;delegationRevision?:string}) {
  if (!input.hostId || !input.delegationGrantId || !input.delegationRevision) throw new Error("codex_delegation_missing");
  const [grant]=await tx.select().from(connectionGrants).where(and(eq(connectionGrants.id,input.delegationGrantId),eq(connectionGrants.companyId,input.companyId),eq(connectionGrants.kind,"agent"),eq(connectionGrants.subjectAgentId,input.agentId),eq(connectionGrants.status,"active"))).limit(1);
  if (!grant) throw new Error("codex_delegation_unavailable");
  const [connection]=await tx.select().from(toolConnections).where(and(eq(toolConnections.id,grant.connectionId),eq(toolConnections.companyId,input.companyId),eq(toolConnections.enabled,true),eq(toolConnections.status,"active"))).for("update").limit(1);
  const [lockedGrant]=await tx.select({id:connectionGrants.id}).from(connectionGrants).where(and(eq(connectionGrants.id,grant.id),eq(connectionGrants.companyId,input.companyId),eq(connectionGrants.connectionId,grant.connectionId),eq(connectionGrants.kind,"agent"),eq(connectionGrants.subjectAgentId,input.agentId),eq(connectionGrants.status,"active"))).for("update").limit(1);
  if (!lockedGrant) throw new Error("codex_delegation_unavailable");
  const d=object(connection?.config.codexNativeDelegation);
  if (d.schema==="paperclip.codex-native-delegation.v1" && (d.processGeneration!==input.processGeneration || typeof d.expiresAt!=="string" || !Number.isFinite(Date.parse(d.expiresAt)) || Date.parse(d.expiresAt)<=Date.now())) throw new Error("codex_shared_grant_stale: run renew-shared-grants");
  if (d.schema!=="paperclip.codex-native-delegation.v1" || d.revision!==input.delegationRevision || d.hostId!==input.hostId || d.processGeneration!==input.processGeneration || d.projectId!==input.projectId || d.agentId!==input.agentId || d.model!==input.model || d.effort!==input.effort || typeof d.expiresAt!=="string" || !Number.isFinite(Date.parse(d.expiresAt)) || Date.parse(d.expiresAt)<=Date.now()) throw new Error("codex_delegation_scope_invalid");
}
