#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyLoopMessage,
  goalLoopTransition,
  goalStrategyFingerprint,
  normalizeGoalDecision,
  notifyHumanInputRequests,
  notifyTerminalTasks,
  queueHumanDecision,
  queueDirFor,
  queueStatus,
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
assert.deepEqual(classifyLoopMessage('用 loop engineering 把现有的 growth os 与文件对齐，把需要增强的功能补齐'), {
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

const orphanQueue = 'orphan-recovery-smoke';
const orphanRouted = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  queue: orphanQueue,
  message: '走 loop 验证异常退出自动恢复',
  sourceChannel: 'feishu',
  sourceTarget: 'user-1'
});
const orphanName = `${orphanRouted.task.id}.json`;
const orphanInbox = path.join(queueSubdirFor(root, orphanQueue, 'inbox'), orphanName);
const orphanActive = path.join(queueSubdirFor(root, orphanQueue, 'active'), orphanName);
await writeJson(orphanActive, { ...(await readJson(orphanInbox)), status: 'active', startedAt: new Date().toISOString() });
await rm(orphanInbox, { force: true });
// A future lease owned by a dead PID must not hide the orphan until expiry.
await writeJson(path.join(queueDirFor(root, orphanQueue), 'queue.lock'), {
  version: 1,
  queue: orphanQueue,
  pid: 2_147_483_647,
  acquiredAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
});
await writeJson(path.join(taskRuntimeDirFor(root, orphanQueue, orphanRouted.task.id), 'checkpoints', 'cp-before-crash.json'), {
  version: 1,
  task_id: orphanRouted.task.id,
  checkpoint_id: 'cp-before-crash',
  status: 'in_progress',
  summary: 'Durable progress written before the parent runner exited.',
  files_changed: [],
  verification: [],
  blockers: [],
  risks: [],
  next_action: 'resume_from_checkpoint'
});
const orphanRun = await runQueueOnce(root, {
  queue: orphanQueue,
  dispatcher: '/bin/true',
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000
});
assert.equal(orphanRun.processed, true);
assert.equal(orphanRun.run.orphanRecovered.length, 1);
assert.equal(orphanRun.run.orphanRecovered[0].taskId, orphanRouted.task.id);
assert.ok(orphanRun.progress.some((event) => event.status === 'orphan_recovered'));
const orphanTerminal = await readJson(path.join(root, orphanRun.taskPath));
assert.equal(orphanTerminal.orphanRecoveryCount, 1);
assert.equal(orphanTerminal.requeuedFrom, 'active');
assert.equal(orphanTerminal.recoveryReason, 'dead_queue_lock_owner_pid');
assert.equal((await readJson(path.join(taskRuntimeDirFor(root, orphanQueue, orphanRouted.task.id), 'checkpoints', 'cp-before-crash.json'))).checkpoint_id, 'cp-before-crash');

const reviewQueue = 'human-review-smoke';
const reviewTask = await routeLoopMessage(root, {
  route: true,
  confirmExecute: true,
  queue: reviewQueue,
  message: '走 loop 生成需要人工验收的交付物',
  sourceChannel: 'feishu',
  sourceTarget: 'user-1'
});
let reviewCheckpointWrite = null;
const reviewRun = await runQueueOnce(root, {
  queue: reviewQueue,
  dispatcher: '/bin/sleep 0.1',
  requiresHumanGate: true,
  timeoutMs: 10_000,
  leaseMs: 20_000,
  staleActiveMs: 60_000,
  onProgress: (event) => {
    if (event.phase !== 'dispatch' || event.status !== 'running' || reviewCheckpointWrite) return;
    reviewCheckpointWrite = writeJson(path.join(taskRuntimeDirFor(root, reviewQueue, reviewTask.task.id), 'checkpoints', 'cp-review.json'), {
      version: 1,
      task_id: reviewTask.task.id,
      checkpoint_id: 'cp-review',
      status: 'ready_for_acceptance',
      summary: 'The deliverable is complete and explicitly awaits human acceptance.',
      files_changed: [],
      verification: [{ command: '/bin/true', outcome: 'passed' }],
      blockers: [],
      risks: [],
      next_action: 'human_acceptance'
    });
  }
});
await reviewCheckpointWrite;
assert.equal(reviewRun.status, 'ready_for_human_review');
assert.match(reviewRun.taskPath, /failed/);
const reviewStatus = await queueStatus(root, reviewQueue);
assert.equal(reviewStatus.done, 0);
assert.equal(reviewStatus.failed, 1);
const reviewNotice = await notifyTerminalTasks(root, { queue: reviewQueue, dryRun: true });
assert.equal(reviewNotice.results[0].outcome, 'dry_run');
assert.match(reviewNotice.results[0].message, /ready for human acceptance/);
assert.match(reviewNotice.results[0].message, /approve, request_changes, or reject/);
const reviewDecision = await queueHumanDecision(root, reviewQueue, reviewTask.task.id, { decision: 'approve' });
assert.equal(reviewDecision.transitionedTask.status, 'completed');
const approvedStatus = await queueStatus(root, reviewQueue);
assert.equal(approvedStatus.done, 1);
assert.equal(approvedStatus.failed, 0);

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
assert.equal((await readJson(path.join(queueSubdirFor(root, queue, 'waiting'), path.basename(failedFile)))).status, 'waiting_for_human');
await assert.rejects(access(failedFile));
const resolved = await resolveHumanInput(root, { queue, gateId, input: '123456', sourceMessageId: 'reply-1', secretInput: true });
assert.equal(resolved.outcome, 'resolved_and_requeued');
const requeuedTask = await readJson(path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(failedFile)));
assert.equal(requeuedTask.humanInput.secret_received, true);
assert.equal(requeuedTask.body.includes('123456'), false);
const resolvedGate = await readJson(path.join(root, resolved.ledger ?? gateSent.results[0].ledger));
assert.equal(JSON.stringify(resolvedGate).includes('123456'), false);
assert.equal(resolvedGate.response_sha256.length, 64);

// Non-sensitive decisions and attestations remain available to the next worker
// tick instead of being destroyed like OTPs and credentials.
const attestationCheckpoint = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'checkpoints', 'cp-attestation.json');
await writeJson(attestationCheckpoint, {
  version: 1, task_id: routed.task.id, checkpoint_id: 'cp-attestation', status: 'needs_human_input',
  blockers: [{ id: 'review-decision', reason: 'Provide the independent review decision.' }],
  verification: [], risks: [], next_action: 'wait'
});
await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
const attestationGateId = `${routed.task.id}:cp-attestation`;
const attestationResolved = await resolveHumanInput(root, {
  queue,
  gateId: attestationGateId,
  input: 'Reviewer accepts the candidate for the next gated stage.'
});
assert.equal(attestationResolved.gate.input_kind, 'attestation');
assert.equal(attestationResolved.gate.secret_received, false);
assert.equal(attestationResolved.gate.response, 'Reviewer accepts the candidate for the next gated stage.');
assert.equal(attestationResolved.gate.response_ref, undefined);

// A project-in-progress judgement with a newer effective checkpoint must not
// resurrect historical waiting gates from older checkpoints.
const attestationDoneCheckpoint = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'checkpoints', 'cp-attestation-done.json');
await writeJson(attestationDoneCheckpoint, {
  version: 1, task_id: routed.task.id, checkpoint_id: 'cp-attestation-done',
  revises_checkpoint_id: 'cp-attestation', sequence: 2, status: 'ready_for_acceptance',
  blockers: [], verification: [{ observation: 'attestation', result: 'accepted' }], risks: [], next_action: 'continue'
});
const finalJudgementFile = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'final_judgement.json');
await writeJson(finalJudgementFile, {
  version: 1, task_id: routed.task.id, outcome: 'project_in_progress',
  coverage: { effective_review_ids: ['cp-attestation-done'] }
});
const noHistoricalGateReplay = await notifyHumanInputRequests(root, { queue, dryRun: true });
assert.equal(noHistoricalGateReplay.inspected, 0);
await rm(finalJudgementFile, { force: true });

// Queued tasks receive a non-sensitive event reference without being moved.
const queuedCheckpoint = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'checkpoints', 'cp-queued.json');
await writeJson(queuedCheckpoint, {
  version: 1, task_id: routed.task.id, checkpoint_id: 'cp-queued', status: 'needs_human_input',
  blockers: ['Provide queued input.'], verification: [], risks: [], next_action: 'wait'
});
await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
const queuedGateId = `${routed.task.id}:cp-queued`;
const waitingTaskFile = path.join(queueSubdirFor(root, queue, 'waiting'), path.basename(failedFile));
assert.equal((await readJson(waitingTaskFile)).status, 'waiting_for_human');
const queuedResolved = await resolveHumanInput(root, { queue, gateId: queuedGateId, input: 'queued-secret' });
assert.equal(queuedResolved.outcome, 'resolved_and_requeued');
const queuedAfterInput = await readJson(path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(failedFile)));
assert.equal(queuedAfterInput.status, 'queued');
assert.equal(JSON.stringify(queuedAfterInput).includes('queued-secret'), false);

// Active tasks are not mutated; their event is consumed at the next safe tick.
const inboxRequeued = path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(failedFile));
const activeRequeued = path.join(queueSubdirFor(root, queue, 'active'), path.basename(failedFile));
await rename(inboxRequeued, activeRequeued);
const activeBefore = await readJson(activeRequeued);
const activeCheckpoint = path.join(taskRuntimeDirFor(root, queue, routed.task.id), 'checkpoints', 'cp-active.json');
await writeJson(activeCheckpoint, {
  version: 1, task_id: routed.task.id, checkpoint_id: 'cp-active', status: 'needs_human_input',
  blockers: ['Provide active input.'], verification: [], risks: [], next_action: 'wait'
});
await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
const activeResolved = await resolveHumanInput(root, { queue, gateId: `${routed.task.id}:cp-active`, input: 'active-secret' });
assert.equal(activeResolved.outcome, 'resolved_pending_safe_boundary');
assert.deepEqual(await readJson(activeRequeued), activeBefore);
await rename(activeRequeued, inboxRequeued);
await writeJson(failedFile, { ...requeuedTask, status: 'needs_human_input' });
await rm(inboxRequeued, { force: true });

const dryRun = await notifyTerminalTasks(root, { queue, dryRun: true });
assert.equal(dryRun.results[0].outcome, 'dry_run');
const sent = await notifyTerminalTasks(root, { queue, notifyCommand: '/bin/true' });
assert.equal(sent.sent, 1);
const repeated = await notifyTerminalTasks(root, { queue, notifyCommand: '/bin/true' });
assert.equal(repeated.results[0].outcome, 'already_notified');

console.log('route/notify self-test passed');
await import('./config-drift-self-test.mjs');
