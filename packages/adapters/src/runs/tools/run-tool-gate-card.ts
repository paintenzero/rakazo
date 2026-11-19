import { displayName } from "@rakazo/core";
import type { ApprovalCardOptions } from "../../approvals/approval-ask.js";
import { approvalActionName, buildApprovalAskBlock } from "../../approvals/approval-ask.js";
import { scheduleApprovalExpiry } from "../../approvals/approval-expiry.js";
import { reportBotMessageWait } from "../../messaging/bot-messages.js";
import { scheduleRunSecretsExpiry } from "../../secrets/run-secrets-expiry.js";
import type { RunContext } from "../assembly/run-context.js";
import { pauseForApproval, persistTurnCheckpoint } from "../assembly/run-context.js";
import { enqueueSteeringContinuation, renewRunLease } from "../lifecycle/run-lifecycle.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import type { ToolCall } from "./run-tool-gate.js";

/** Ask the owner through an approval card. Parallel calls share the first call's pause. */
export function requestApproval(ctx: RunContext, call: ToolCall, card: ApprovalCardOptions) {
  const { approval } = ctx.state;
  // Parallel calls can need approval at once. Only the first saves the turn and shows
  // its card; the others wait for that pause. Otherwise a later call's save could make
  // the turn resume a call other than the one the user approved.
  if (approval.request) return approval.request.then(() => pauseForApproval(ctx));
  approval.request = showApprovalCard(ctx, call, card);
  return approval.request;
}

async function showApprovalCard(ctx: RunContext, call: ToolCall, card: ApprovalCardOptions) {
  const { deps, run, runId, bot, thread } = ctx;
  const { name, args, executionId, applied } = call;
  if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
    // Another worker owns the run now; exit without leaving a local pause card.
    return pauseForApproval(ctx);
  }
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: ctx.workerId,
    leaseFence: ctx.fence,
    onPaused: async (tx) => {
      await scheduleRunSecretsExpiry(deps.jobs, runId)(tx);
      await scheduleApprovalExpiry(deps.jobs, tx, {
        trigger: run.trigger,
        runId,
        effectId: applied!.effect.id,
      });
    },
    blocks: [
      buildApprovalAskBlock(
        applied!.effect.id,
        name,
        name === "update_bot" && "previousInstructions" in args ? { ...args, botId: bot.id } : args,
        ctx.secrets,
        card,
      ),
    ],
  });
  // pauseRunForInput returning false after a successful renew means the run row no
  // longer matches this worker. Exiting via pauseForApproval() would leave the run
  // stuck in "running" with no ask card — fail instead so the user can retry.
  if (!paused) {
    throw new Error("Could not pause this run for approval; try sending again.");
  }
  await enqueueSteeringContinuation(deps, paused.continuationRunId);
  await reportBotMessageWait(deps, run, bot, `approve ${name}`, ctx.attempt.id);
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs approval`,
    // Only the action, with no verb: the card's title can name a recipient or subject, and a call
    // can decline rather than allow, so both stay on the card.
    body: approvalActionName(name, args, card.batch, ctx.secrets),
    botId: bot.id,
    threadId: thread.id,
  });
  return pauseForApproval(ctx);
}
