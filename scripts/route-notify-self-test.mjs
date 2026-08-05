#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyLoopMessage,
  goalLoopTransition,
  goalStrategyFingerprint,
  normalizeGoalDecision,
  notifyHumanInputRequests,
  notifyTerminalTasks,
  queueSubdirFor,
  readJson,
  routeLoopMessage,
  resolveHumanInput,
  runQueueOnce,
  runQueueDrain,
  taskRuntimeDirFor,
  writeJson
} from '../lib/core.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-route-notify-'));
const queue = 'route-smoke';

assert.equal(normalizeGoalDecision({ verdict: 'revise' }).decision, 'change_strategy');
assert.deepEqual(goalLoopTransition({ decision: 'change_strategy' }, { round: 1, maxRounds: 3 }), {
  status: 'replan_pending',
  continue: true,
  terminal: false
});
assert.equal(goalLoopTransition({ decision: 'change_strategy' }, { round: 3, maxRounds: 3 }).status, 'exploration_exhausted');
assert.equal(goalLoopTransition({ decision: 'human_input' }, { round: 1, maxRounds: 3 }).status, 'waiting_for_human');
assert.equal(goalStrategyFingerprint('Try A!'), goalStrategyFingerprint(' try   a '));

assert.deepEqual(classifyLoopMessage('查一下 loop engineering 的情况'), {
  intent: 'status',
  risk: 'model_assessed',
  enqueue: false,
  readOnly: true
});
assert.deepEqual(classifyLoopMessage('用 loop engineering 绕过某个检查'), {
  intent: 'execute',
  risk: 'model_assessed',
  enqueue: true,
  readOnly: false
});

const routed = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  queue,
  message: '走 loop 检查 adb 设备',
  sourceChannel: 'feishu',
  sourceTarget: 'user-1',
  sourceAccount: 'main',
  sourceMessageId: 'message-1'
});
assert.equal(routed.action, 'enqueued');
assert.equal(routed.task.riskAssessment, 'model_assessed');
assert.equal(routed.task.source.target, 'user-1');

const run = await runQueueOnce(root, {
  queue,
  dispatcher: '/bin/true',
  progressNotifyCommand: '/bin/true',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000
});
assert.equal(run.processed, true);
assert.ok(run.progressNotifications.filter((item) => item.outcome === 'sent').length >= 5);
const progressLedger = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'progress_notifications');
assert.ok((await readdir(progressLedger)).length >= 5);
const contract = await readJson(path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'task_contract.json'));
assert.equal(contract.risk_level, 'model_assessed');
assert.equal(contract.requires_human_gate, false);

for (const suffix of ['second', 'third']) {
  await routeLoopMessage(root, {
    route: true,
    confirmExecute: true,
    queue,
    message: `走 loop ${suffix}`
  });
}
const drained = await runQueueDrain(root, {
  queue,
  dispatcher: '/bin/true',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000,
  maxTasks: 10
});
assert.equal(drained.processed, 2);
assert.equal(drained.remaining, 0);
assert.equal(drained.stopReason, 'empty');

const handoffQueue = 'handoff-smoke';
await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  queue: handoffQueue,
  message: '走 loop first handoff task'
});
let handoffEnqueue = null;
const handedOff = await runQueueDrain(root, {
  queue: handoffQueue,
  dispatcher: '/bin/sleep 0.1',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000,
  maxTasks: 10,
  onProgress: (event) => {
    if (event.status !== 'activated' || handoffEnqueue) return;
    handoffEnqueue = routeLoopMessage(root, {
      route: true,
      confirmExecute: true,
      queue: handoffQueue,
      message: '走 loop task enqueued while first is active'
    });
  }
});
await handoffEnqueue;
assert.equal(handedOff.processed, 2);
assert.equal(handedOff.remaining, 0);
assert.equal(handedOff.stopReason, 'empty');

const supersedeQueue = 'supersede-smoke';
const original = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  supersedeActive: true,
  queue: supersedeQueue,
  message: '走 loop original task'
});
let activated;
const activeReady = new Promise((resolve) => { activated = resolve; });
const originalRunPromise = runQueueOnce(root, {
  queue: supersedeQueue,
  dispatcher: '/bin/sleep 5',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000,
  onProgress: (event) => {
    if (event.phase === 'dispatch' && event.status === 'running') activated();
  }
});
await activeReady;
const replacement = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  supersedeActive: true,
  queue: supersedeQueue,
  message: '走 loop corrected replacement task'
});
assert.equal(replacement.action, 'supersede_requested');
assert.equal(replacement.supersededTaskId, original.task.id);
assert.equal(replacement.task.supersedesTaskId, original.task.id);
const originalRun = await originalRunPromise;
assert.equal(originalRun.status, 'superseded');
assert.equal(originalRun.run.dispatch.canceled, true);
assert.equal(originalRun.run.finalJudgement.outcome, 'superseded');
assert.match(originalRun.taskPath, /canceled/);
const replacementRun = await runQueueOnce(root, {
  queue: supersedeQueue,
  dispatcher: '/bin/true',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000
});
assert.equal(replacementRun.processed, true);
assert.equal(replacementRun.run.taskId, replacement.task.id);

const amendmentQueue = 'amendment-smoke';
const amendmentOriginal = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  supersedeActive: true,
  queue: amendmentQueue,
  message: '走 loop original task that will receive a supplement',
  sourceChannel: 'feishu',
  sourceTarget: 'user-1'
});
let amendmentActivated;
const amendmentReady = new Promise((resolve) => { amendmentActivated = resolve; });
let checkpointWrite = null;
const amendmentRunPromise = runQueueOnce(root, {
  queue: amendmentQueue,
  dispatcher: '/bin/sleep 0.2',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000,
  progressNotifyCommand: '/bin/true',
  progressHeartbeatMs: 25,
  checkpointPollMs: 10,
  onProgress: (event) => {
    if (event.phase === 'dispatch' && event.status === 'running') {
      amendmentActivated();
      checkpointWrite = writeJson(path.join(taskRuntimeDirFor(root, amendmentQueue, amendmentOriginal.task.id), 'checkpoints', 'cp-live.json'), {
        version: 1,
        task_id: amendmentOriginal.task.id,
        checkpoint_id: 'cp-live',
        status: 'ready_for_acceptance',
        summary: 'Live checkpoint visible to the source conversation.',
        files_changed: [],
        verification: [{ command: '/bin/true', outcome: 'passed' }],
        blockers: [],
        risks: [],
        next_action: 'acceptance_review'
      });
    }
  }
});
await amendmentReady;
const amendment = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  amendActive: true,
  queue: amendmentQueue,
  message: '继续当前 loop，补充要求：验收必须覆盖新的边界条件',
  sourceChannel: 'feishu',
  sourceTarget: 'user-1',
  sourceMessageId: 'amendment-1'
});
assert.equal(amendment.action, 'active_task_amended');
assert.equal(amendment.taskId, amendmentOriginal.task.id);
assert.equal(amendment.amendment.sequence, 1);
assert.equal(amendment.updatedPlans.length, 3);
assert.match(amendment.amendmentFile, /amendments\/0001\.json$/);
const amendedContract = await readJson(path.join(taskRuntimeDirFor(root, amendmentQueue, amendmentOriginal.task.id), 'task_contract.json'));
const amendedAcceptance = await readJson(path.join(taskRuntimeDirFor(root, amendmentQueue, amendmentOriginal.task.id), 'acceptance_plan.json'));
const amendedDev = await readJson(path.join(taskRuntimeDirFor(root, amendmentQueue, amendmentOriginal.task.id), 'dev_plan.json'));
assert.equal(amendedContract.amendment_version, 1);
assert.match(amendedContract.supplemental_requirements[0], /新的边界条件/);
assert.match(amendedAcceptance.supplemental_checks[0], /新的边界条件/);
assert.match(amendedDev.supplemental_instructions[0], /新的边界条件/);
const amendmentRun = await amendmentRunPromise;
await checkpointWrite;
assert.notEqual(amendmentRun.status, 'superseded');
assert.equal(amendmentRun.run.dispatch.canceled, false);
assert.ok(amendmentRun.progress.some((event) => event.status === 'heartbeat'));
assert.ok(amendmentRun.progress.some((event) => event.status === 'checkpoint_update'));
assert.ok(amendmentRun.progressNotifications.filter((item) => item.outcome === 'sent').length >= 7);
await assert.rejects(
  routeLoopMessage(root, {
    route: true,
    confirmExecute: true,
    amendActive: true,
    queue: amendmentQueue,
    message: '继续当前 loop，补充要求：任务结束后不应再接受补充'
  }),
  /No active loop task exists to amend/
);

const terminalFile = path.join(root, run.taskPath);
const terminalTask = await readJson(terminalFile);
terminalTask.status = 'needs_human_input';
const checkpointFile = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'checkpoints', 'cp-human.json');
await writeJson(checkpointFile, {
  version: 1,
  task_id: routed.task.id,
  checkpoint_id: 'cp-human',
  status: 'needs_human_input',
  summary: 'Waiting for a one-time code.',
  blockers: [{ human_action_required: 'Provide the SMS code.' }],
  verification: [],
  risks: [],
  next_action: 'wait_for_sms_code'
});
const failedFile = path.join(queueSubdirFor(root, queue, 'failed'), path.basename(terminalFile));
await writeJson(failedFile, terminalTask);
if (failedFile !== terminalFile) await rm(terminalFile, { force: true });

const gateDryRun = await notifyHumanInputRequests(root, { queue, dryRun: true });
assert.equal(gateDryRun.results[0].outcome, 'dry_run');
assert.match(gateDryRun.results[0].message, /Provide the SMS code/);
const gateSent = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(gateSent.sent, 1);
const gateId = gateSent.results[0].gateId;
const resolved = await resolveHumanInput(root, { queue, gateId, input: '123456', sourceMessageId: 'reply-1' });
assert.equal(resolved.outcome, 'resolved_and_requeued');
const requeuedTask = await readJson(path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(failedFile)));
assert.equal(requeuedTask.humanInput.response, '123456');
assert.match(requeuedTask.body, /Human input for gate/);
await writeJson(failedFile, { ...requeuedTask, status: 'needs_human_input' });
await rm(path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(failedFile)), { force: true });

const dryRun = await notifyTerminalTasks(root, { queue, dryRun: true });
assert.equal(dryRun.results[0].outcome, 'dry_run');
const sent = await notifyTerminalTasks(root, { queue, notifyCommand: '/bin/true' });
assert.equal(sent.sent, 1);
const repeated = await notifyTerminalTasks(root, { queue, notifyCommand: '/bin/true' });
assert.equal(repeated.results[0].outcome, 'already_notified');

console.log('route/notify self-test passed');
await import('./config-drift-self-test.mjs');
