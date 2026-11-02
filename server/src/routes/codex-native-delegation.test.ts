import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, expect, it, vi } from "vitest";
vi.unmock("http");vi.unmock("node:http");
const mocks=vi.hoisted(()=>({register:vi.fn(),revoke:vi.fn()}));
vi.mock("../services/native-runtime/codex-native-delegation.js",()=>({registerCodexNativeDelegation:mocks.register,revokeCodexNativeDelegation:mocks.revoke}));
import { codexNativeDelegationRoutes } from "./codex-native-delegation.js";
import { errorHandler } from "../middleware/error-handler.js";
const companyId="2e5550a0-0f43-4a1c-a011-000000000001",projectId="2e5550a0-0f43-4a1c-a011-000000000002",agentId="2e5550a0-0f43-4a1c-a011-000000000003";
const board:Express.Request["actor"]={type:"board",source:"board_key",isInstanceAdmin:true,userId:"board",companyIds:[companyId]};
const input={projectId,agentId,model:"model",effort:"high",expiresAt:"2030-01-01T00:00:00.000Z"};
function app(actor:Express.Request["actor"]){const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor;next();});app.use("/api",codexNativeDelegationRoutes({} as Db,{} as never));app.use(errorHandler);return app;}
beforeEach(()=>{mocks.register.mockReset().mockResolvedValue({connectionId:"connection"});mocks.revoke.mockReset().mockResolvedValue(undefined);});
it("requires authenticated company Board administrator before registration",async()=>{
 for(const actor of [{type:"agent",source:"agent_key",companyId},{...board,isInstanceAdmin:false},{...board,source:"local_implicit"},{...board,companyIds:[]}] as Express.Request["actor"][]) await request(app(actor)).post(`/api/companies/${companyId}/codex-native-delegations`).send(input).expect(403);
 expect(mocks.register).not.toHaveBeenCalled();
});
it("passes the exact scope and authenticated issuer; rejects caller-supplied daemon identity",async()=>{
 await request(app(board)).post(`/api/companies/${companyId}/codex-native-delegations`).send(input).expect(201);
 expect(mocks.register).toHaveBeenCalledOnce();expect(mocks.register.mock.calls[0]![2]).toMatchObject({companyId,projectId,agentId,issuer:"board"});
 mocks.register.mockClear();await request(app(board)).post(`/api/companies/${companyId}/codex-native-delegations`).send({...input,pid:1}).expect(400);expect(mocks.register).not.toHaveBeenCalled();
});
