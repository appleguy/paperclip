/**
 * Universal tests U7..U13 (NAR spec section 8.1): receipt fences, non-completion
 * by transport/stop/idle/phone, conversation identity, Paperclip restart,
 * owner steering, secrets hygiene and non-interference.
 */

import type { UniversalTest } from "./conformance.js";
import { assert, expectOk, openScene, type Scene } from "./harness.js";
import { GRADE_ORDER } from "./types.js";

export const LIFECYCLE_TESTS: UniversalTest[] = [
  {
    id: "U7",
    name: "receipt fences: foreign issue/run/conversation/epoch/generation, malformed or partial payload cannot complete",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u7", runId: "run-u7" });
      const op = scene.op(0);
      expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      const good = scene.receipt("finish", op);
      const refused = [
        scene.receipt("finish", op, { issueId: "issue-other" }),
        scene.receipt("finish", op, { runId: "run-other" }),
        scene.receipt("finish", op, { conversationId: "ses_other" }),
        scene.receipt("finish", op, { hostEpoch: 99 }),
        scene.receipt("finish", op, { leaseGeneration: 99 }),
        scene.receipt("finish", op, { controllerId: "controller-other" }),
        { ...good, receiptId: "" },
        { ...good, payloadSha256: "not-a-digest" },
        { ...good, result: undefined },
        { ...good, kind: "block", result: undefined, reason: "" },
        { ...good, hostEpoch: 0 },
        { ...good, leaseGeneration: 0 },
      ];
      for (const [index, receipt] of refused.entries()) {
        const result = scene.core.applyReceipt(receipt as typeof good, scene.caller);
        assert(!result.ok, `fenced receipt ${index} must be refused`);
      }
      assert(scene.core.readTerminal(scene.runId) === undefined, "no fenced receipt may become a terminal");
      assert(scene.core.readOp(op.opId)?.state !== "terminal", "op must not be terminal");
    },
  },
  {
    id: "U8",
    name: "transport success, stop, idle or phone reply never completes a run; grades stay within the declared ack grade",
    async run({ driver, capabilities }) {
      const scene = await openScene(driver, { issueId: "u8", runId: "run-u8" });
      const op = scene.op(0);
      const outcome = expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      const grade = outcome.grade ?? "outcome_unknown";
      if (grade !== "outcome_unknown") {
        assert(
          GRADE_ORDER[grade] <= GRADE_ORDER[capabilities.ackGrade],
          `submit grade ${grade} is stronger than ackGrade ${capabilities.ackGrade}`,
        );
      }
      const observed = await scene.core.observe(scene.conversationId);
      assert(Array.isArray(observed.events), "observe returns events");
      for (const event of observed.events) {
        assert(
          !/^(stop|idle|phone_text|owner_text)$/.test(event.kind) || event.opId === undefined,
          `activity ${event.kind} must not be attributed to an op`,
        );
      }
      expectOk(
        scene.core.ingestEvents([{ cursor: "phone-1", kind: "phone_text", raw: { textLength: 12 } }]),
        "phone activity is recorded",
      );
      const read = await scene.core.readOutcome(scene.conversationId, op.opId);
      assert(read !== "receipted", "transport success and events are not a receipt");
      assert(scene.core.readOp(op.opId)?.state !== "terminal", "run must not complete without a receipt");
      expectOk(scene.core.applyReceipt(scene.receipt("finish", op), scene.caller), "only a receipt completes");
      assert(scene.core.readOp(op.opId)?.state === "terminal", "validated receipt completes the run");
    },
  },
  {
    id: "U9",
    name: "conversation identity: new issue gets a new id, same-issue resume adopts it, foreign scope is refused",
    async run({ driver }) {
      const first = await openScene(driver, { issueId: "u9-a", runId: "run-u9-a" });
      const second = await openScene(driver, { issueId: "u9-b", runId: "run-u9-b" });
      assert(first.conversationId !== second.conversationId, "a new issue must get a different conversation id");
      const callsBefore = submitCalls(first) + submitCalls(second);

      const resumed = expectOk(
        await first.core.bindConversation(first.host, first.scope, "resume", first.fence, first.caller),
        "resume same issue",
      );
      assert(
        resumed.conversationId === first.conversationId,
        `same-issue resume must adopt ${first.conversationId}, got ${resumed.conversationId}`,
      );
      assert(submitCalls(first) + submitCalls(second) === callsBefore, "resume must not push a prompt");

      await expectThrow(
        first.core.bindConversation(
          first.host,
          { ...first.scope, cwd: "/tmp/foreign-cwd" },
          "resume",
          first.fence,
          first.caller,
        ),
        "foreign cwd",
      );
      await expectThrow(
        first.core.bindConversation(
          first.host,
          { ...first.scope, model: "foreign-model" },
          "resume",
          first.fence,
          first.caller,
        ),
        "foreign model",
      );
      await expectThrow(
        first.core.bindConversation(
          first.host,
          { ...first.scope, agentId: "agent-other" },
          "resume",
          first.fence,
          first.caller,
        ),
        "foreign agent",
      );
    },
  },
  {
    id: "U10",
    name: "Paperclip restart re-attaches the live host, settles the original op from the ledger and never replays",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u10", runId: "run-u10" });
      const op = scene.op(0);
      expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      assert(submitCalls(scene) === 1, "first submit reaches the transport once");

      const restarted = scene.core.restart();
      assert(restarted.snapshot().restarts === 1, "snapshot records one restart");
      assert(restarted.readOp(op.opId)?.state === "emitted_local", "ledger survives restart");

      const host = expectOk(await restarted.attestHost(scene.scope.agentId), "reattest");
      const resumed = expectOk(
        await restarted.bindConversation(host, scene.scope, "resume", scene.fence, scene.caller),
        "resume after restart",
      );
      assert(
        resumed.conversationId === scene.conversationId,
        `restart must adopt ${scene.conversationId}, got ${resumed.conversationId}`,
      );
      assert(submitCalls(scene) === 1, "reattach must not replay the prompt");

      const settled = expectOk(await restarted.submit(op, scene.fence, scene.meta(), scene.caller), "settle");
      assert(settled.reused === true, "original op settles from the ledger");
      assert(submitCalls(scene) === 1, "settling the original op never resends it");

      const receipt = scene.receipt("finish", op);
      expectOk(restarted.applyReceipt(receipt, scene.caller), "late receipt after restart");
      const duplicate = expectOk(restarted.applyReceipt(receipt, scene.caller), "duplicate late receipt");
      assert(duplicate.receipt.receiptId === receipt.receiptId, "late receipt is applied exactly once");
    },
  },
  {
    id: "U11",
    name: "owner steering is competing activity, never attributed to an op and never causes replay",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u11", runId: "run-u11" });
      const op = scene.op(0);
      expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      const before = submitCalls(scene);
      const stateBefore = scene.core.readOp(op.opId)?.state;

      expectOk(
        scene.core.ingestEvents([
          { cursor: "owner-1", kind: "owner_text", raw: { textLength: 20 } },
          { cursor: "owner-2", kind: "phone_text", raw: { textLength: 5 } },
        ]),
        "owner activity is accepted as competing activity",
      );
      const attributed = scene.core.ingestEvents([
        { cursor: "owner-3", kind: "owner_text", opId: op.opId, raw: { textLength: 3 } },
      ]);
      assert(!attributed.ok && attributed.code === "invalid_event", "owner text must not carry an op id");

      const observed = await scene.core.observe(scene.conversationId);
      for (const event of [...observed.events]) {
        assert(
          !/^(owner_text|owner_input|phone_text|phone_input)$/.test(event.kind) || event.opId === undefined,
          "observed owner activity must never carry an op id",
        );
      }
      assert(submitCalls(scene) === before, "owner steering never triggers a replay");
      assert(scene.core.readOp(op.opId)?.state === stateBefore, "owner steering does not advance the op");
      assert(scene.core.recover(op.opId)?.action === "hold_unknown", "op remains held");
    },
  },
  {
    id: "U12",
    name: "secrets hygiene: no token, password or key in capabilities, events, evidence or receipts",
    async run({ driver, capabilities }) {
      const scene = await openScene(driver, { issueId: "u12", runId: "run-u12" });
      const op = scene.op(0);
      const outcome = expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      const observed = await scene.core.observe(scene.conversationId);
      const host = expectOk(await scene.core.attestHost(scene.scope.agentId), "attest");
      const strings = [
        ...collectStrings(capabilities),
        ...collectStrings(observed.events),
        ...collectStrings(host.detail),
        ...collectStrings(outcome),
        ...collectStrings(scene.receipt("finish", op)),
      ];
      for (const value of strings) {
        assert(!looksLikeSecret(value), `possible secret in driver surface: ${value.slice(0, 80)}`);
      }
    },
  },
  {
    id: "U13",
    name: "non-interference: work on one conversation leaves unrelated conversations, events and listeners untouched",
    async run({ driver }) {
      const active = await openScene(driver, { issueId: "u13-active", runId: "run-u13-active" });
      const idle = await openScene(driver, { issueId: "u13-idle", runId: "run-u13-idle" });
      const idleBefore = await idle.core.observe(idle.conversationId);
      expectOk(await active.core.submit(active.op(0), active.fence, active.meta(), active.caller), "active submit");
      assert(submitCalls(active) === 1, "active conversation receives the send");
      const idleAfter = await idle.core.observe(idle.conversationId);
      assert(
        idleAfter.events.length === idleBefore.events.length,
        "an unrelated conversation must receive no events",
      );
      const calls = (driver as { submitCalls?: { conversationId: string }[] }).submitCalls ?? [];
      assert(
        calls.every((call) => call.conversationId !== idle.conversationId),
        "no send is addressed to the unrelated conversation",
      );
      const resumedIdle = expectOk(
        await idle.core.bindConversation(idle.host, idle.scope, "resume", idle.fence, idle.caller),
        "idle resume",
      );
      assert(resumedIdle.conversationId === idle.conversationId, "idle conversation identity is unchanged");
      assert(idle.core.readOp(`${idle.runId}-op-0`) === undefined, "no op is recorded on the idle run");
    },
  },
];

function submitCalls(scene: Scene): number {
  const calls = (scene.driver as { submitCalls?: { conversationId?: string }[] }).submitCalls;
  if (!Array.isArray(calls)) return 0;
  return calls.filter((call) => call.conversationId === scene.conversationId).length;
}

async function expectThrow(promise: Promise<unknown>, where: string): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  assert(threw, `${where} must be refused`);
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => collectStrings(entry, depth + 1));
  }
  return [];
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{10,}/,
  /ghp_[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{12,}/,
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/,
  /(?:api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;}]{6,}/i,
];

function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}
