import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureQueueDirs, projectRelayNext, queueStatus } from '../lib/core.mjs';

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
const task = { id: 'accepted-task', projectId: project, source: { channel: 'feishu', target: 'owner', account: 'main', message_id: 'message-1' } };
const finalJudgement = { outcome: 'ready_to_apply', requires_human_gate: false };
await ensureQueueDirs(root, queue);
await writeJson(configFile, spec);
await writeJson(backlogFile, { items: [item] });
await writeJson(ledgerFile, { status: 'in_progress' });

assert.equal(await projectRelayNext(root, { queue, task, finalJudgement: { outcome: 'blocked' } }), null);
assert.equal(await projectRelayNext(root, { queue, task: { ...task, source: null }, finalJudgement }), null);
await writeJson(configFile, { ...spec, queues: [{ queue, kind: 'standard', autostart: false }] });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null);
await writeJson(configFile, spec);
for (const unsafe of [{ ...item, humanGateRequired: true }, { ...item, externalActionsAllowed: true },
  { ...item, scope: 'production' }, { ...item, autoRun: false }, { ...item, blocked: true },
  { ...item, dependsOn: ['unaccepted'] }]) {
  await writeJson(backlogFile, { items: [unsafe] });
  assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null);
}
await writeJson(backlogFile, { items: [item] });
await writeJson(configFile, { ...spec, acceptanceLedger: 'project/missing-ledger.json' });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'missing terminal authority fails closed');
await writeJson(configFile, spec);
const result = await projectRelayNext(root, { queue, task, finalJudgement });
assert.equal(result.itemId, 'local-1');
const queued = JSON.parse(await readFile(path.join(root, result.file), 'utf8'));
assert.equal(queued.projectId, project);
assert.equal(queued.source.message_id, 'message-1');
assert.match(queued.body, /\[project-relay:relay-project\/local-1\]/);
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'busy queue must not enqueue twice');
assert.equal((await queueStatus(root, queue)).queued, 1);
await writeJson(ledgerFile, { status: 'accepted' });
assert.equal(await projectRelayNext(root, { queue, task, finalJudgement }), null, 'accepted project cannot relay');
console.log('project relay self-test passed');
