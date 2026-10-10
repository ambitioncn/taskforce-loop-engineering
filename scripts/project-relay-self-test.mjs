import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { ensureQueueDirs, projectRelayNext, projectRelayReconcile, projectRelayResume, queueSchedulerTick, queueStatus } from '../lib/core.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'loop-project-relay-'));
const queue = 'relay-test';
const project = 'relay-project';
const configFile = path.join(root, 'configs/loops/projects', `${project}.json`);
const backlogFile = path.join(root, 'project/backlog.json');
const ledgerFile = path.join(root, 'project/ledger.json');
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
};
const spec = { schemaVersion: 1, project, type: 'code_project', queues: [{ queue, kind: 'standard', autostart: true }],
  backlogSource: 'project/backlog.json', acceptanceLedger: 'project/ledger.json' };
const item = { id: 'local-1', status: 'ready', title: 'Local proof', task: 'Verify the local entry', autoRun: true,
  scope: 'local_only', externalActionsAllowed: false, humanGateRequired: false, dependsOn: [] };
const predecessor = { id: 'local-0', status: 'accepted' };
const task = { id: 'accepted-task', projectId: project, backlogItemId: predecessor.id,
  source: { channel: 'feishu', target: 'owner', account: 'main', message_id: 'message-1' } };
const finalJudgement = { outcome: 'ready_to_apply', requires_human_gate: false };
await ensureQueueDirs(root, queue);
await writeJson(configFile, spec);
await writeJson(backlogFile, { items: [predecessor, item] });
await writeJson(ledgerFile, { status: 'in_progress' });

assert.equal(await projectRelayNext(root, { queue, task, finalJudgement: { outcome: 'blocked' } }), null);
assert.equal(await projectRelayNext(root, { queue, task: { ...task, source: null }, finalJudgement }), null);
await writeJson(configFile, { ...spec, queues: [{ queue, kind: 'standard', autostart: false }] });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null);
await writeJson(configFile, spec);
for (const unsafe of [{ ...item, humanGateRequired: true }, { ...item, externalActionsAllowed: true },
  { ...item, scope: 'production' }, { ...item, autoRun: false }, { ...item, blocked: true },
  { ...item, dependsOn: ['unaccepted'] }]) {
  await writeJson(backlogFile, { items: [predecessor, unsafe] });
  assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null);
}
await writeJson(backlogFile, { items: [predecessor, item] });
await writeJson(configFile, { ...spec, acceptanceLedger: 'project/missing-ledger.json' });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'missing terminal authority fails closed');
await writeJson(configFile, spec);
assert.equal(await projectRelayNext(root, { queue, task: { ...task, backlogItemId: undefined }, finalJudgement }), null,
  'unbound predecessor cannot authorize a relay');
await writeJson(backlogFile, { items: [{ ...predecessor, status: 'ready' }, item] });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null,
  'a completed task with a stale ready backlog item cannot relay itself');
await writeJson(backlogFile, { items: [predecessor, item] });
await writeJson(ledgerFile, null);
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'null ledger fails closed');
await writeJson(ledgerFile, { status: 'unknown' });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'unknown ledger state fails closed');
await writeJson(ledgerFile, { status: 'in_progress' });
await unlink(backlogFile);
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'missing authoritative backlog fails closed');
await writeJson(backlogFile, { items: [predecessor, item] });
const result = await projectRelayNext(root, { queue, task, finalJudgement });
assert.equal(result.itemId, 'local-1');
const queued = JSON.parse(await readFile(path.join(root, result.file), 'utf8'));
assert.equal(queued.projectId, project);
assert.equal(queued.backlogItemId, item.id);
assert.equal(queued.source.message_id, 'message-1');
assert.match(queued.body, /\[project-relay:relay-project\/local-1\]/);
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'busy queue must not enqueue twice');
assert.equal((await queueStatus(root, queue)).queued, 1);
await writeJson(ledgerFile, { status: 'accepted' });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'accepted project cannot relay');
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'reconciliation is opt-in');
await writeJson(configFile, { ...spec, relayStatusReconciliation: true });
await writeJson(path.join(root, 'runtime/loops', queue, 'done', `${queued.id}.json`), { ...queued, status: 'completed' });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'a queue row alone is not acceptance');
await writeJson(path.join(root, 'runtime/loops', queue, 'tasks', queued.id, 'final_judgement.json'), { outcome: 'ready_to_apply', requires_human_gate: false });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'accepted project cannot mutate backlog');
await writeJson(ledgerFile, { status: 'in_progress' });
await writeJson(path.join(root, 'runtime/loops', queue, 'done', `${queued.id}.json`), { ...queued, backlogItemId: 'wrong', status: 'completed' });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'marker without matching backlog binding is not evidence');
await writeJson(path.join(root, 'runtime/loops', queue, 'done', `${queued.id}.json`), { ...queued, status: 'completed' });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 1);
assert.equal((await readFile(backlogFile, 'utf8')).includes('"status": "completed"'), true);
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'reconciliation is idempotent');
await writeJson(backlogFile, { items: [{ ...item, externalActionsAllowed: true }] });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'unsafe backlog rows are not promoted');
await writeJson(backlogFile, { items: [item] });
await writeJson(path.join(root, 'runtime/loops', queue, 'done', 'duplicate.json'), { ...queued, id: 'duplicate', status: 'completed' });
await writeJson(path.join(root, 'runtime/loops', queue, 'tasks', 'duplicate', 'final_judgement.json'), { outcome: 'ready_to_apply' });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'duplicate task evidence cannot promote a row');
await writeJson(backlogFile, { items: [item] });
await writeJson(path.join(root, 'runtime/loops', queue, 'scheduler/state.json'), { nextRunAt: '2999-01-01T00:00:00.000Z' });
const planned = await queueSchedulerTick(root, { queue, planOnly: true });
assert.equal(planned.relayReconciliation.length, 0, 'plan-only scheduler cannot mutate the backlog');
assert.equal(JSON.parse(await readFile(backlogFile, 'utf8')).items[0].status, 'ready');
await writeJson(path.join(root, 'runtime/loops', queue, 'done', 'duplicate.json'), { ...queued, id: 'duplicate', projectId: 'another-project', status: 'completed' });
await writeJson(backlogFile, { items: [item, { ...item }] });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'duplicate backlog ids cannot be reconciled');
await writeJson(backlogFile, { items: [item] });
await writeJson(ledgerFile, { status: 'unknown' });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'invalid project acceptance cannot change backlog');
await writeJson(ledgerFile, { status: 'in_progress' });
await unlink(backlogFile);
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'missing authoritative backlog fails closed');
await writeJson(backlogFile, { items: [item] });
await rm(path.join(root, result.file));
const tick = await queueSchedulerTick(root, { queue });
assert.deepEqual(tick.relayReconciliation, [{ project, changed: 1 }], 'idle scheduler repairs interrupted status writes');
assert.equal((await readFile(backlogFile, 'utf8')).includes('"status": "completed"'), true);
// A relay item that needed a revision round is still reconcilable through
// its lineage: the revision body has no leading marker, but its revisionOf
// chain ends at the bound relay task.
const revisedItem = { ...item, id: 'local-2' };
const doneDir = path.join(root, 'runtime/loops', queue, 'done');
const judgementFor = (id) => path.join(root, 'runtime/loops', queue, 'tasks', id, 'final_judgement.json');
const relayRootTask = { ...queued, id: 'relay-root', backlogItemId: revisedItem.id, status: 'completed',
  body: `[project-relay:${project}/${revisedItem.id}]\nVerify the local entry` };
const revisionTask = { ...relayRootTask, id: 'relay-revision', revisionOf: relayRootTask.id, revisionRound: 1,
  body: `Revision round for a loop-managed task.\n\nOriginal task body:\n${relayRootTask.body}` };
await writeJson(backlogFile, { items: [revisedItem] });
await writeJson(path.join(doneDir, `${relayRootTask.id}.json`), relayRootTask);
await writeJson(judgementFor(relayRootTask.id), { outcome: 'needs_revision', requires_human_gate: false });
await writeJson(path.join(doneDir, `${revisionTask.id}.json`), revisionTask);
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'a lineage without an accepted round is not evidence');
await writeJson(judgementFor(revisionTask.id), { outcome: 'ready_to_apply', requires_human_gate: true });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'a gated revision is not evidence');
await writeJson(path.join(doneDir, `${revisionTask.id}.json`), { ...revisionTask, revisionOf: 'unknown-task' });
await writeJson(judgementFor(revisionTask.id), { outcome: 'ready_to_apply', requires_human_gate: false });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'a revision without a relay root is not evidence');
await writeJson(path.join(doneDir, `${relayRootTask.id}.json`), { ...relayRootTask, backlogItemId: 'other-item' });
await writeJson(path.join(doneDir, `${revisionTask.id}.json`), revisionTask);
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'a lineage with a different binding is not evidence');
await writeJson(path.join(doneDir, `${relayRootTask.id}.json`), relayRootTask);
await writeJson(path.join(doneDir, 'second-root.json'), { ...relayRootTask, id: 'second-root' });
await writeJson(judgementFor('second-root'), { outcome: 'needs_revision', requires_human_gate: false });
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 0, 'two independent relay lineages fail closed');
await unlink(path.join(doneDir, 'second-root.json'));
assert.equal((await projectRelayReconcile(root, { queue, project })).changed, 1, 'an accepted revision round completes its relay item');
assert.equal(JSON.parse(await readFile(backlogFile, 'utf8')).items[0].status, 'completed');
// Reconciliation must not overwrite a backlog edited after it was read.
await writeJson(backlogFile, { items: [revisedItem] });
const concurrentEdit = { items: [{ ...revisedItem, note: 'edited by an agent' }] };
const raced = await projectRelayReconcile(root, { queue, project, beforeWrite: () => writeJson(backlogFile, concurrentEdit) });
assert.deepEqual(raced, { changed: 0, conflict: true }, 'a concurrent backlog edit aborts reconciliation');
assert.deepEqual(JSON.parse(await readFile(backlogFile, 'utf8')), concurrentEdit, 'the concurrent edit survives');
assert.deepEqual((await readdir(path.dirname(backlogFile))).filter((name) => name.endsWith('.tmp')), [], 'no temporary backlog is left behind');

// Fresh workspace for relay retry, duplicate ids, and scheduler locking.
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'loop-project-relay-resume-'));
  const queueDir = path.join(root, 'runtime/loops', queue);
  const backlogFile = path.join(root, 'project/backlog.json');
  await ensureQueueDirs(root, queue);
  await writeJson(path.join(root, 'configs/loops/projects', `${project}.json`), spec);
  await writeJson(path.join(root, 'project/ledger.json'), { status: 'in_progress' });
  const next = { ...item, id: 'local-2' };

  // Duplicate or malformed rows can neither prove a predecessor nor be relayed.
  await writeJson(backlogFile, { items: [null, predecessor, { ...predecessor, status: 'ready' }, next] });
  assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'duplicate predecessor ids fail closed');
  await writeJson(backlogFile, { items: [null, predecessor, next, { ...next, title: 'Shadow' }] });
  assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'duplicate candidate ids are not relayed');
  await writeJson(backlogFile, { items: [predecessor, next, { ...next, title: 'Shadow' }, { ...item, id: 'local-3', dependsOn: ['local-2'] }] });
  assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'a duplicated dependency is never complete');

  // The accepted predecessor finished while the queue was busy, so the
  // completion-time relay was skipped. An idle scheduler tick resumes it.
  await writeJson(backlogFile, { items: [predecessor, next] });
  const accepted = { ...task, title: 'Accepted', body: 'Accepted work', status: 'completed', finishedAt: '2026-10-01T00:00:00.000Z' };
  await writeJson(path.join(queueDir, 'done', `${accepted.id}.json`), accepted);
  await writeJson(path.join(queueDir, 'tasks', accepted.id, 'final_judgement.json'), finalJudgement);
  const older = { ...accepted, id: 'older-task', backlogItemId: 'local-0', finishedAt: '2026-09-01T00:00:00.000Z' };
  await writeJson(path.join(queueDir, 'done', `${older.id}.json`), older);
  await writeJson(path.join(queueDir, 'scheduler/state.json'), { nextRunAt: '2999-01-01T00:00:00.000Z' });

  await writeJson(path.join(queueDir, 'inbox', 'busy.json'), { id: 'busy', title: 'Busy', body: 'User work', status: 'queued' });
  assert.equal(await projectRelayResume(root, { queue, project }), null, 'a busy queue still defers the relay');
  await unlink(path.join(queueDir, 'inbox', 'busy.json'));

  const lockFile = path.join(queueDir, 'queue.lock');
  await writeFile(lockFile, JSON.stringify({ version: 1, queue, pid: process.pid,
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const locked = await queueSchedulerTick(root, { queue });
  assert.equal(locked.relayMaintenance, 'queue_locked');
  assert.deepEqual(locked.projectRelay, [], 'a tick without the queue lock cannot relay');
  assert.equal((await queueStatus(root, queue)).queued, 0);
  await unlink(lockFile);

  await writeJson(path.join(queueDir, 'tasks', accepted.id, 'final_judgement.json'), { outcome: 'needs_revision', requires_human_gate: false });
  assert.deepEqual((await queueSchedulerTick(root, { queue })).projectRelay, [], 'the newest bound task must be accepted');
  await writeJson(path.join(queueDir, 'tasks', accepted.id, 'final_judgement.json'), finalJudgement);

  const resumed = await queueSchedulerTick(root, { queue });
  assert.equal(resumed.relayMaintenance, 'completed');
  assert.equal(resumed.projectRelay.length, 1);
  assert.equal(resumed.projectRelay[0].itemId, 'local-2');
  const relayed = JSON.parse(await readFile(path.join(root, resumed.projectRelay[0].file), 'utf8'));
  assert.equal(relayed.backlogItemId, 'local-2');
  assert.equal(relayed.source.message_id, 'message-1');
  assert.deepEqual((await queueSchedulerTick(root, { queue })).projectRelay, [], 'a resumed relay is not enqueued twice');
  assert.equal((await queueStatus(root, queue)).queued, 1);
  await rm(root, { recursive: true, force: true });
}
// A failed or canceled relay task stops the chain: an idle tick must not skip
// it and relay the next independent item. Ambiguous ordering fails closed.
for (const stop of ['canceled', 'failed', 'tied']) {
  const root = await mkdtemp(path.join(os.tmpdir(), `loop-project-relay-stop-${stop}-`));
  const queueDir = path.join(root, 'runtime/loops', queue);
  await ensureQueueDirs(root, queue);
  await writeJson(path.join(root, 'configs/loops/projects', `${project}.json`), spec);
  await writeJson(path.join(root, 'project/ledger.json'), { status: 'in_progress' });
  await writeJson(path.join(root, 'project/backlog.json'), { items: [predecessor, { ...item, id: 'local-1' }, { ...item, id: 'local-2' }] });
  await writeJson(path.join(queueDir, 'done', `${task.id}.json`), { ...task, status: 'completed', body: 'Accepted work',
    enqueuedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T01:00:00.000Z' });
  await writeJson(path.join(queueDir, 'tasks', task.id, 'final_judgement.json'), finalJudgement);
  const stopped = { ...task, id: 'relay-local-1', backlogItemId: 'local-1', body: `[project-relay:${project}/local-1]\nVerify`,
    status: stop === 'tied' ? 'completed' : stop,
    enqueuedAt: stop === 'tied' ? '2026-10-01T00:00:00.000Z' : '2026-10-01T01:00:01.000Z' };
  await writeJson(path.join(queueDir, stop === 'tied' ? 'done' : stop, `${stopped.id}.json`), stopped);
  await writeJson(path.join(queueDir, 'scheduler/state.json'), { nextRunAt: '2999-01-01T00:00:00.000Z' });
  const tick = await queueSchedulerTick(root, { queue });
  assert.equal(tick.relayMaintenance, 'completed');
  assert.deepEqual(tick.projectRelay, [], `a ${stop} relay task stops the relay chain`);
  assert.equal((await queueStatus(root, queue)).queued, 0);
  await rm(root, { recursive: true, force: true });
}
console.log('project relay self-test passed');
