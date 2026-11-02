import { Router, type Request } from "express";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import { createClaudeNativeLocalProbes, discoverClaudeNativePresence, type ClaudePresenceDependencies } from "../services/claude-native-presence.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { ClaudeManagedSessions, type ClaudeManagedOptions } from "../services/claude-native-presence.js";
import { projectWorkspaces, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { logActivity, type LogActivityInput } from "../services/activity-log.js";

function assertAuthenticatedAdmin(req: Request, companyId: string) {
  assertBoard(req); assertInstanceAdmin(req); assertCompanyAccess(req,companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin !== true || typeof req.actor.userId !== "string" || !req.actor.userId.trim()) throw forbidden("Authenticated Board instance administrator required");
}

/** Keep the slot occupied until underlying work settles, even after a deadline. */
export function singleFlightWithDeadline<T>(work: (shouldContinue: () => boolean) => Promise<T>, timeoutMs: number): () => Promise<T> {
  let flight: Promise<T> | undefined;
  return () => {
    if (flight) return flight;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const underlying = Promise.resolve().then(() => work(() => active));
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { active = false; reject(new Error("Claude discovery deadline exceeded")); }, timeoutMs);
    });
    const result = Promise.race([underlying, deadline]);
    flight = result;
    void underlying.then(() => { active = false; clearTimeout(timer); flight = undefined; }, () => { active = false; clearTimeout(timer); flight = undefined; });
    return result;
  };
}

export interface ClaudeNativePresenceRouteOptions {
  /** Trusted, server-owned provider configuration; never derived from request data. */
  resolveHostSettings(): Promise<{claudeExecutable:string;home:string;claudeConfigDir?:string}>;
  /** Test seam; production uses the declared official Agent SDK and native probes. */
  dependencies?: (settings:{claudeExecutable:string;home:string;claudeConfigDir?:string}) => Pick<ClaudePresenceDependencies,"inventory"|"process"|"sdk">;
  db?: Db;
  /** Server wiring that resolves a run's admitted authority (see createClaudeNativeAuthority). */
  admitRun?: ClaudeManagedOptions["admitRun"];
  /** Executor-launched live sessions the managed service adopts (no second launch). */
  liveSessions?: ClaudeManagedOptions["liveSessions"];
  managedSessions?: ClaudeManagedSessions;
  /** Internal audit seam; production persists through the existing activity log. */
  recordActivity?: (event: LogActivityInput) => Promise<unknown>;
}
export function claudeNativePresenceRoutes(options: ClaudeNativePresenceRouteOptions) {
  const router = Router();
  const managed=options.managedSessions ?? (options.db ? new ClaudeManagedSessions({
    admitRun:options.admitRun,
    liveSessions:options.liveSessions,
    resolveHostSettings:options.resolveHostSettings,
    stateDirectory:process.env.PAPERCLIP_CLAUDE_INTERACTIVE_STATE_DIR ?? "",
    hookHelperExecutable:process.env.PAPERCLIP_CLAUDE_HOOK_HELPER ?? "",
    model:process.env.PAPERCLIP_CLAUDE_INTERACTIVE_MODEL ?? "",
    effort:process.env.PAPERCLIP_CLAUDE_INTERACTIVE_EFFORT ?? "",
    async resolveWorkspace(companyId,workspaceId) {
      const [workspace]=await options.db!.select({cwd:projectWorkspaces.cwd}).from(projectWorkspaces).where(and(eq(projectWorkspaces.id,workspaceId),eq(projectWorkspaces.companyId,companyId))).limit(1);
      return workspace?.cwd ?? null;
    },
  }) : undefined);
  const discover = singleFlightWithDeadline(async shouldContinue => {
    const settings = await options.resolveHostSettings();
    if (!shouldContinue()) throw new Error("Claude discovery deadline exceeded");
    const sdkConfig = resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || `${homedir()}/.claude`);
    const targetConfig = resolve(settings.claudeConfigDir || `${settings.home}/.claude`);
    if (!options.dependencies && sdkConfig !== targetConfig) throw new Error("Claude SDK and host configuration differ");
    const deps = options.dependencies?.(settings) ?? {...createClaudeNativeLocalProbes(settings),sdk:{getSessionInfo}};
    return discoverClaudeNativePresence({...deps,authorize:async () => true,shouldContinue});
  }, 15_000);
  router.get("/companies/:companyId/native-sessions/claude", async (req,res) => {
    const companyId = z.uuid().parse(req.params.companyId);
    assertAuthenticatedAdmin(req,companyId);
    if (Object.keys(req.query).length !== 0) throw badRequest("Discovery does not accept client host or session selectors");
    const result = await discover();
    assertAuthenticatedAdmin(req,companyId);
    res.set("Cache-Control","no-store").json(result);
  });
  const base="/companies/:companyId/native-sessions/claude/managed";
  function context(req:Request) {
    const companyId=z.uuid().parse(req.params.companyId);assertAuthenticatedAdmin(req,companyId);
    if (!managed) throw badRequest("Managed Claude control unavailable");
    return {companyId,actorId:req.actor.userId!,managed};
  }
  async function mutate<T>(c:ReturnType<typeof context>, action:string, id:string, details:Record<string,unknown>, work:()=>Promise<T>):Promise<T> {
    const record=options.recordActivity ?? (options.db ? (event:LogActivityInput)=>logActivity(options.db!,event) : undefined);
    // Launch/input text, terminal output and provider credentials never enter audit details.
    const event={companyId:c.companyId,actorType:"user" as const,actorId:c.actorId,entityType:"native_session",entityId:id,details};
    await record?.({...event,action:`native_session.claude_${action}_requested`});
    let result:T;
    try { result=await work(); }
    catch(error) {
      // A failed response is not evidence that a terminal write or launch did not happen.
      await record?.({...event,action:`native_session.claude_${action}_uncertain`});
      throw error;
    }
    await record?.({...event,action:`native_session.claude_${action}_returned`});
    return result;
  }
  router.post(base,async(req,res)=>{
    const c=context(req), body=z.object({requestId:z.uuid(),workspaceId:z.uuid(),runId:z.uuid().optional()}).strict().parse(req.body);
    const result=await mutate(c,"launch",body.requestId,{workspaceId:body.workspaceId,...(body.runId?{runId:body.runId}:{})},()=>c.managed.start({...body,companyId:c.companyId,actorId:c.actorId}));assertAuthenticatedAdmin(req,c.companyId);
    res.set("Cache-Control","no-store").status(201).json(result);
  });
  router.get(`${base}/:controlId`,async(req,res)=>{
    const c=context(req), id=z.uuid().parse(req.params.controlId);if(Object.keys(req.query).length)throw badRequest("Managed session does not accept selectors");
    const result=await c.managed.read(c.companyId,c.actorId,id);assertAuthenticatedAdmin(req,c.companyId);res.set("Cache-Control","no-store").json(result);
  });
  router.post(`${base}/:controlId/input`,async(req,res)=>{
    const c=context(req), id=z.uuid().parse(req.params.controlId), body=z.object({operationId:z.uuid(),text:z.string().min(1).max(65536)}).strict().parse(req.body);
    const result=await mutate(c,"input",id,{operationId:body.operationId},()=>c.managed.input(c.companyId,c.actorId,id,body.operationId,body.text));assertAuthenticatedAdmin(req,c.companyId);res.set("Cache-Control","no-store").json(result);
  });
  router.post(`${base}/:controlId/interrupt`,async(req,res)=>{
    const c=context(req), id=z.uuid().parse(req.params.controlId), body=z.object({operationId:z.uuid()}).strict().parse(req.body);
    const result=await mutate(c,"interrupt",id,{operationId:body.operationId},()=>c.managed.interrupt(c.companyId,c.actorId,id,body.operationId));assertAuthenticatedAdmin(req,c.companyId);res.set("Cache-Control","no-store").json(result);
  });
  router.post(`${base}/:controlId/detach`,async(req,res)=>{
    const c=context(req), id=z.uuid().parse(req.params.controlId);z.object({}).strict().parse(req.body);
    const result=await mutate(c,"detach",id,{},()=>c.managed.detach(c.companyId,c.actorId,id));assertAuthenticatedAdmin(req,c.companyId);res.set("Cache-Control","no-store").json(result);
  });
  return router;
}
