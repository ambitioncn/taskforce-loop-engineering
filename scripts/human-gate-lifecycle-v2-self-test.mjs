import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureQueueDirs,
  parkQueueTask,
  queueStatus,
  queueSubdirFor,
  readJson,
  resumeParkedTask,
  tickParkedTasks,
  writeJson
} from '../lib/core.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-human-gate-v2-'));
const queue = 'vps-fixture';
const taskId = 'vps-down-ssh-banner-timeout';
const taskFile = path.join(queueSubdirFor(root, queue, 'inbox'), `${taskId}.json`);

try {
  await ensureQueueDirs(root, queue);
  await writeJson(taskFile, { version: 1, id: taskId, title: 'Recover provider VPS', status: 'queued' });
  const parked = await parkQueueTask(root, {
    queue,
    taskId,
    kind: 'external_condition',
    reason: 'VPS is down; SSH banner timed out.',
    now: '2026-08-13T00:00:00.000Z',
    executionKey: 'provider-call-1',
    authorization: { state: 'unconsumed', scope: 'provider_call' },
    policy: { timeoutMs: 2_000, reminderIntervalMs: 1_000, escalationIntervalMs: 2_000, maxReminders: 1 }
  });
  assert.equal(parked.outcome, 'parked');
  assert.equal(parked.task.parked.authorization.state, 'unconsumed');
  assert.equal(parked.task.parked.execution_boundary.action_executed, false);

  const status = await queueStatus(root, queue);
  assert.equal(status.waitingStates.timed_out_or_escalated, 1);
  assert.equal(status.waitingTasks[0].waitKind, 'external_condition');
  assert.equal(status.waitingTasks[0].authorizationState, 'unconsumed');

  const notifyCommand = 'node -e "process.exit(0)"';
  const reminder = await tickParkedTasks(root, { queue, now: '2026-08-13T00:00:01.000Z', notifyCommand });
  assert.equal(reminder.results[0].type, 'reminder');
  const duplicateTick = await tickParkedTasks(root, { queue, now: '2026-08-13T00:00:01.000Z', notifyCommand });
  assert.equal(duplicateTick.results[0].outcome, 'throttled');
  const escalation = await tickParkedTasks(root, { queue, now: '2026-08-13T00:00:03.000Z', notifyCommand });
  assert.equal(escalation.results[0].type, 'escalation');

  await assert.rejects(
    resumeParkedTask(root, { queue, taskId, recoverySignal: 'ssh banner verified' }),
    /--verified/
  );
  const resumed = await resumeParkedTask(root, {
    queue,
    taskId,
    verified: true,
    recoverySignal: 'probe=vps-1;ssh_banner=verified',
    now: '2026-08-13T00:00:04.000Z'
  });
  assert.equal(resumed.outcome, 'verified_and_requeued');
  assert.equal(resumed.task.parked.state, 'runnable');
  assert.equal(resumed.task.parked.authorization.state, 'unconsumed');
  assert.equal(resumed.task.parked.execution_boundary.action_executed, false);
  assert.ok(resumed.signalSha256);

  const afterRestart = await resumeParkedTask(root, {
    queue,
    taskId,
    verified: true,
    recoverySignal: 'probe=vps-1;ssh_banner=verified'
  });
  assert.equal(afterRestart.outcome, 'already_resumed');
  const durable = await readJson(path.join(queueSubdirFor(root, queue, 'inbox'), `${taskId}.json`));
  assert.equal(durable.parked.execution_boundary.key, 'provider-call-1');
  assert.equal(durable.parked.authorization.state, 'unconsumed');
  console.log('human-gate-lifecycle-v2 self-test: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
