import { Router, type Request } from "express";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import { createClaudeNativeLocalProbes, discoverClaudeNativePresence, type ClaudePresenceDependencies } from "../services/claude-native-presence.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

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
}
export function claudeNativePresenceRoutes(options: ClaudeNativePresenceRouteOptions) {
  const router = Router();
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
  return router;
}
