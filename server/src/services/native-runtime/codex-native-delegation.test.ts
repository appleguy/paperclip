import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, companies, projects, createDb, toolConnections, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertCodexNativeDelegation, registerCodexNativeDelegation, revokeCodexNativeDelegation, type NativeDaemonHost } from "./codex-native-delegation.js";
it("registers an exact daemon delegation and rejects foreign, rotated, expired and revoked scope",async()=>{
 const database=await startEmbeddedPostgresTestDatabase("codex-delegation-");const db=createDb(database.connectionString);
 try {
  const companyId=randomUUID(),projectId=randomUUID(),agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Fixture",issuePrefix:"CDE"});await db.insert(projects).values({id:projectId,companyId,name:"Fixture"});await db.insert(agents).values({id:agentId,companyId,name:"Fixture",role:"engineer",adapterType:"paperclip_runner"});
  const daemon={socketPath:"/fixture/socket",codexHome:"/fixture/home",cliVersion:"0.166.0" as const,appServerVersion:"0.166.0" as const,daemonGeneration:"inode",peer:{pid:123,startSeconds:12,startMicroseconds:1,executable:"/fixture/codex"}};
  const host:NativeDaemonHost={hostId:"host",inspect:async()=>daemon};
  let inspections=0;
  const rotating:NativeDaemonHost={hostId:"host",inspect:async()=>({...daemon,daemonGeneration:++inspections===1?"first":"second"})};
  await expect(registerCodexNativeDelegation(db,rotating,{companyId,projectId,agentId,model:"model",effort:"high",issuer:"board",expiresAt:new Date(Date.now()+60000)})).rejects.toThrow("daemon_changed");
  const result=await registerCodexNativeDelegation(db,host,{companyId,projectId,agentId,model:"model",effort:"high",issuer:"board",expiresAt:new Date(Date.now()+60000)});
  const scope={companyId,projectId,agentId,model:"model",effort:"high",hostId:"host",processGeneration:result.processGeneration,delegationGrantId:result.grantId,delegationRevision:result.revision};
  const check=(input:typeof scope)=>db.transaction(tx=>assertCodexNativeDelegation(tx,input));
  await expect(check(scope)).resolves.toBeUndefined();
  for (const change of [{companyId:randomUUID()},{projectId:randomUUID()},{agentId:randomUUID()},{model:"foreign"},{effort:"low"},{hostId:"foreign"},{processGeneration:"foreign"},{delegationRevision:randomUUID()}]) await expect(check({...scope,...change})).rejects.toThrow();
  const [row]=await db.select().from(toolConnections).where(eq(toolConnections.id,result.connectionId));const config=row!.config;
  const delegation=config.codexNativeDelegation as Record<string,unknown>;
  await db.update(toolConnections).set({config:{...config,codexNativeDelegation:{...delegation,expiresAt:new Date(1).toISOString()}}}).where(eq(toolConnections.id,result.connectionId));
  await expect(check(scope)).rejects.toThrow("scope_invalid");
  await db.update(toolConnections).set({config}).where(eq(toolConnections.id,result.connectionId));
  await revokeCodexNativeDelegation(db,{companyId,connectionId:result.connectionId,issuer:"board"});
  await expect(check(scope)).rejects.toThrow("unavailable");
 } finally {await db.$client.end();await database.cleanup();}
},60000);
