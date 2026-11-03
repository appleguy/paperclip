/**
 * Universal tests U1..U6 (NAR spec section 8.1): lease/fence authority, op_id
 * dedupe, duplicate intent, crash windows, no-inference-of-loss and receipt
 * idempotency. Everything runs against the driver under test plus the
 * conformance-only ReferenceCore.
 */

import type { UniversalTest } from "./conformance.js";
import { assert, digest, expectOk, openScene } from "./harness.js";
import { LIFECYCLE_TESTS } from "./universal-tests-lifecycle.js";

const LEDGER_TESTS: UniversalTest[] = [
  {
    id: "U1",
    name: "lease/fence: expired lease, stale epoch, foreign controller and dead-run result are refused",
    async run({ driver }) {
      const expired = await openScene(driver, { issueId: "u1-expired", runId: "run-u1-expired" });
      const expiredOp = expired.op(0);
      expired.core.expireLease(expired.runId);
      const expiredResult = await expired.core.submit(expiredOp, expired.fence, expired.meta(), expired.caller);
      assert(!expiredResult.ok, "expired lease must refuse submit");
      assert(expiredResult.code === "authority_lost", `expired lease code: ${expiredResult.code}`);
      assert(submitCallCount(expired) === 0, "expired lease must not reach the transport");

      const stale = await openScene(driver, { issueId: "u1-stale", runId: "run-u1-stale" });
      const staleResult = await stale.core.submit(
        stale.op(0),
        { ...stale.fence, leaseGeneration: stale.fence.leaseGeneration - 1 },
        stale.meta(),
        stale.caller,
      );
      assert(!staleResult.ok && staleResult.code === "authority_lost", "lower lease generation must be refused");

      const foreign = await openScene(driver, { issueId: "u1-foreign", runId: "run-u1-foreign" });
      const foreignResult = await foreign.core.submit(
        foreign.op(0),
        foreign.fence,
        foreign.meta(),
        { controllerId: "controller-other" },
      );
      assert(!foreignResult.ok && foreignResult.code === "authority_lost", "foreign controller must be refused");

      const dead = await openScene(driver, { issueId: "u1-dead", runId: "run-u1-dead" });
      const deadOp = dead.op(0);
      expectOk(await dead.core.submit(deadOp, dead.fence, dead.meta(), dead.caller), "dead-run submit");
      dead.core.revokeLease(dead.runId);
      const late = dead.core.applyReceipt(dead.receipt("finish", deadOp), dead.caller);
      assert(!late.ok && late.code === "authority_lost", "late result from a dead run must be rejected");
    },
  },
  {
    id: "U2",
    name: "duplicate op_id: same digest returns stored state without transport; different digest is identity_conflict",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u2", runId: "run-u2" });
      const op = scene.op(0);
      const first = expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "first submit");
      assert(first.reused === false, "first submit must not be marked reused");
      assert(first.state === "emitted_local", `first state: ${first.state}`);
      assert(submitCallCount(scene) === 1, "first submit must reach the transport once");

      const replay = expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "duplicate submit");
      assert(replay.reused === true, "duplicate op_id must return the stored state");
      assert(replay.state === first.state, "duplicate op_id must preserve the stored state");
      assert(submitCallCount(scene) === 1, "duplicate op_id must not invoke the transport");

      const conflict = await scene.core.submit(
        { ...op, payloadSha256: digest(5) },
        scene.fence,
        scene.meta(),
        scene.caller,
      );
      assert(!conflict.ok, "same op_id with a different digest must be refused");
      assert(conflict.code === "identity_conflict", `conflict code: ${conflict.code}`);
      assert(submitCallCount(scene) === 1, "identity conflict must not invoke the transport");
    },
  },
  {
    id: "U3",
    name: "duplicate intent: a new op_id for the same run/client_intent is refused",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u3", runId: "run-u3" });
      expectOk(await scene.core.submit(scene.op(0), scene.fence, scene.meta(), scene.caller), "first intent");
      const duplicate = await scene.core.submit(scene.op(1), scene.fence, scene.meta(), scene.caller);
      assert(!duplicate.ok, "second op for the same client intent must be refused");
      assert(duplicate.code === "duplicate_intent", `duplicate intent code: ${duplicate.code}`);
      assert(submitCallCount(scene) === 1, "duplicate intent must not invoke the transport");
    },
  },
  {
    id: "U4",
    name: "crash windows hold without replay; only a provably-unsent reservation may become a new op",
    async run({ driver }) {
      const reserved = await openScene(driver, { issueId: "u4-reserved", runId: "run-u4-reserved" });
      expectOk(reserved.core.reserve(reserved.op(0), reserved.fence, reserved.meta(), reserved.caller), "reserve");
      const reservedRecovery = reserved.core.recover(`${reserved.runId}-op-0`);
      assert(reservedRecovery?.action === "reject_and_allow_new_op", "reserved-only crash must allow a new op");
      expectOk(reserved.core.rejectReserved(`${reserved.runId}-op-0`), "reject reserved");
      expectOk(
        await reserved.core.submit(reserved.op(1), reserved.fence, reserved.meta(), reserved.caller),
        "new op after reserved-only crash",
      );
      assert(submitCallCount(reserved) === 1, "only the replacement op may reach the transport");

      const pushed = await openScene(driver, { issueId: "u4-pushed", runId: "run-u4-pushed" });
      const pushedOp = pushed.op(0);
      expectOk(pushed.core.reserve(pushedOp, pushed.fence, pushed.meta(), pushed.caller), "reserve pushed");
      expectOk(pushed.core.markPushStarted(pushedOp.opId, pushed.fence, pushed.caller), "mark push_started");
      assert(pushed.core.recover(pushedOp.opId)?.action === "hold_unknown", "push_started crash must hold as unknown");
      const pushedReplay = expectOk(
        await pushed.core.submit(pushedOp, pushed.fence, pushed.meta(), pushed.caller),
        "duplicate after push crash",
      );
      assert(pushedReplay.reused === true && submitCallCount(pushed) === 0, "push crash must not replay");
      const pushedIntent = await pushed.core.submit(pushed.op(1), pushed.fence, pushed.meta(), pushed.caller);
      assert(!pushedIntent.ok && pushedIntent.code === "duplicate_intent", "push crash must not allow a new intent");

      const emitted = await openScene(driver, { issueId: "u4-emitted", runId: "run-u4-emitted" });
      const emittedOp = emitted.op(0);
      expectOk(await emitted.core.submit(emittedOp, emitted.fence, emitted.meta(), emitted.caller), "emitted submit");
      assert(emitted.core.recover(emittedOp.opId)?.action === "hold_unknown", "emitted crash must hold as unknown");
      expectOk(await emitted.core.submit(emittedOp, emitted.fence, emitted.meta(), emitted.caller), "emitted duplicate");
      assert(submitCallCount(emitted) === 1, "emitted crash must not replay");

      const hooked = await openScene(driver, { issueId: "u4-hook", runId: "run-u4-hook" });
      const hookedOp = hooked.op(0);
      expectOk(await hooked.core.submit(hookedOp, hooked.fence, hooked.meta(), hooked.caller), "hook submit");
      expectOk(hooked.core.recordHook(hookedOp.opId, "fake hook"), "record hook");
      assert(hooked.core.recover(hookedOp.opId)?.action === "await_late_receipt", "hook crash waits for a receipt");
      expectOk(await hooked.core.submit(hookedOp, hooked.fence, hooked.meta(), hooked.caller), "hook duplicate");
      assert(submitCallCount(hooked) === 1, "hook crash must not replay");

      const tool = await openScene(driver, { issueId: "u4-tool", runId: "run-u4-tool" });
      const toolOp = tool.op(0);
      expectOk(await tool.core.submit(toolOp, tool.fence, tool.meta(), tool.caller), "tool submit");
      const toolReceipt = tool.receipt("finish", toolOp);
      expectOk(tool.core.stageReceipt(toolReceipt, tool.caller), "stage receipt");
      assert(tool.core.recover(toolOp.opId)?.action === "settle_staged_receipt", "staged receipt is settled on recovery");
      expectOk(tool.core.commitStagedReceipt(toolReceipt.receiptId, tool.caller), "commit staged receipt");
      const secondCommit = tool.core.commitStagedReceipt(toolReceipt.receiptId, tool.caller);
      assert(!secondCommit.ok, "a second commit has no staged receipt left");
      const duplicateApply = expectOk(tool.core.applyReceipt(toolReceipt, tool.caller), "duplicate apply");
      assert(duplicateApply.receipt.receiptId === toolReceipt.receiptId, "duplicate apply returns stored receipt");
      assert(tool.core.readTerminal(tool.runId) !== undefined, "exactly one terminal exists");

      const restart = await openScene(driver, { issueId: "u4-restart", runId: "run-u4-restart" });
      const restartOp = restart.op(0);
      expectOk(await restart.core.submit(restartOp, restart.fence, restart.meta(), restart.caller), "restart submit");
      const restartReceipt = restart.receipt("finish", restartOp);
      expectOk(restart.core.stageReceipt(restartReceipt, restart.caller), "stage before restart");
      const restartedCore = restart.core.restart();
      assert(
        restartedCore.recover(restartOp.opId)?.action === "settle_staged_receipt",
        "durable staged receipt survives restart",
      );
      expectOk(restartedCore.commitStagedReceipt(restartReceipt.receiptId, restart.caller), "commit after restart");
      assert(restartedCore.readTerminal(restart.runId) !== undefined, "restart yields one terminal");
    },
  },
  {
    id: "U5",
    name: "no inference of loss: absent hook/transcript keeps the op unknown and held, never rejected",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u5", runId: "run-u5" });
      const op = scene.op(0);
      expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const observed = await scene.core.observe(scene.conversationId);
        assert(Array.isArray(observed.events), "observe returns events");
        const current = scene.core.readOp(op.opId);
        assert(current !== undefined, "op record survives");
        assert(current.state !== "rejected", "absence must never become rejected");
        assert(current.state !== "terminal", "absence must never become terminal");
        const outcome = await scene.core.readOutcome(scene.conversationId, op.opId);
        assert(outcome !== "receipted", "no receipt means not receipted");
      }
      assert(scene.core.recover(op.opId)?.action === "hold_unknown", "op stays held as unknown");
      const duplicate = expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "duplicate");
      assert(duplicate.reused === true, "held op returns stored state");
      assert(submitCallCount(scene) === 1, "held op is never resent");
    },
  },
  {
    id: "U6",
    name: "receipt idempotency: duplicate finish is stored; finish-then-block or block-then-finish yields one terminal",
    async run({ driver }) {
      const scene = await openScene(driver, { issueId: "u6-finish", runId: "run-u6-finish" });
      const op = scene.op(0);
      expectOk(await scene.core.submit(op, scene.fence, scene.meta(), scene.caller), "submit");
      const finish = scene.receipt("finish", op);
      const applied = expectOk(scene.core.applyReceipt(finish, scene.caller), "apply finish");
      const duplicate = expectOk(scene.core.applyReceipt(finish, scene.caller), "duplicate finish");
      assert(duplicate.receipt.receiptId === applied.receipt.receiptId, "duplicate finish returns the stored receipt");
      const blockAfterFinish = scene.core.applyReceipt(scene.receipt("block", op), scene.caller);
      assert(!blockAfterFinish.ok, "block after finish must be refused");
      assert(blockAfterFinish.code === "already_terminal", `block-after-finish code: ${blockAfterFinish.code}`);
      assert(scene.core.readTerminal(scene.runId) !== undefined, "one terminal remains");

      const reverse = await openScene(driver, { issueId: "u6-block", runId: "run-u6-block" });
      const reverseOp = reverse.op(0);
      expectOk(await reverse.core.submit(reverseOp, reverse.fence, reverse.meta(), reverse.caller), "reverse submit");
      expectOk(reverse.core.applyReceipt(reverse.receipt("block", reverseOp), reverse.caller), "apply block");
      const finishAfterBlock = reverse.core.applyReceipt(reverse.receipt("finish", reverseOp), reverse.caller);
      assert(!finishAfterBlock.ok, "finish after block must be refused");
      assert(finishAfterBlock.code === "already_terminal", `finish-after-block code: ${finishAfterBlock.code}`);
    },
  },
];

export const UNIVERSAL_TESTS: UniversalTest[] = [...LEDGER_TESTS, ...LIFECYCLE_TESTS];

function submitCallCount(scene: { driver: unknown; conversationId: string }): number {
  const calls = (scene.driver as { submitCalls?: { conversationId?: string }[] }).submitCalls;
  if (!Array.isArray(calls)) return 0;
  // The driver instance is shared across scenes in one test, so count only this
  // conversation's pushes; otherwise earlier scenes inflate the total.
  return calls.filter((call) => call.conversationId === scene.conversationId).length;
}
