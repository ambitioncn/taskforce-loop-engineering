import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Goal, initGoal, reviewGoal, runGoal, statusGoal } from '../lib/goal-api.mjs';
import { TransactionalStateKernel } from '../lib/transactional-state-kernel.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-competitive-'));
const results = [];
const fixture = async (id, run) => { try { await run(); results.push({ id, ok: true }); } catch (error) { results.push({ id, ok: false, error: error.message }); } };

await fixture('crash_recovery', async () => {
  await initGoal(root, { id: 'crash', goal: 'Recover durable progress after process interruption.' });
  await runGoal(root, 'crash', { triggerId: 'before-crash' });
  const kernelDir = path.join(root, 'runtime', 'loops', 'goals', 'crash', 'kernel');
  await rm(path.join(kernelDir, 'receipts.jsonl'), { force: true });
  await mkdir(kernelDir, { recursive: true });
  await writeFile(path.join(kernelDir, 'writer.lock'), JSON.stringify({ owner: 'pid:2147483647' }));
  await runGoal(root, 'crash', { triggerId: 'after-crash' });
  const reopened = await statusGoal(root, 'crash');
  assert.equal(reopened.runtime.generation, 2); assert.equal(reopened.receipt_chain.ok, true);
});
await fixture('duplicate_trigger', async () => {
  await initGoal(root, { id: 'duplicate', goal: 'Apply each duplicate trigger at most once.' });
  await runGoal(root, 'duplicate', { triggerId: 'same' });
  const duplicate = await runGoal(root, 'duplicate', { triggerId: 'same' });
  assert.equal(duplicate.replayed, 1); assert.equal(duplicate.receipts.length, 0);
});
await fixture('human_wait_resume', async () => {
  await initGoal(root, { id: 'human', goal: 'Wait for and resume from a human decision.' });
  await reviewGoal(root, 'human', { decision: 'wait', key: 'gate:1', reason: 'choose' });
  assert.equal((await statusGoal(root, 'human')).runtime.status, 'waiting_for_human');
  await reviewGoal(root, 'human', { decision: 'accept', key: 'gate:1:resume' });
  assert.equal((await statusGoal(root, 'human')).runtime.status, 'accepted');
});
await fixture('standing_authorization', async () => {
  await initGoal(root, { id: 'standing', goal: 'Respect bounded standing authorization scopes.' });
  const result = await runGoal(root, 'standing', { effects: [{ type: 'action_reservation', key: 'auth:deploy:1', payload: { authorization: { kind: 'standing', scope: 'staging', limit: 1 }, action: 'deploy' } }] });
  assert.equal(result.receipts[0].effect_type, 'action_reservation');
  assert.equal(result.state.applied_effects['auth:deploy:1'].effect.payload.authorization.scope, 'staging');
});
await fixture('idempotent_external_action', async () => {
  const kernel = new TransactionalStateKernel(path.join(root, 'external-kernel')); let calls = 0;
  const effect = { type: 'external_action', key: 'provider:request-1', payload: { idempotency_key: 'request-1' } };
  const execute = ({ key }) => { calls++; return { accepted: true, upstream_key: key }; };
  await kernel.replayEffect(effect, execute); const replay = await kernel.replayEffect(effect, execute);
  assert.equal(calls, 1); assert.equal(replay.replayed, true);
});
await fixture('false_milestone_completion', async () => {
  const kernel = new TransactionalStateKernel(path.join(root, 'completion-kernel'));
  await assert.rejects(kernel.transact({ effects: [{ type: 'completion', key: 'milestone:1', payload: { milestone: true } }], complete: { terminalContract: { required: ['m1', 'm2'] }, validate: async () => ({ ok: false, reason: 'required backlog remains' }) } }), /Completion fence rejected/);
  assert.notEqual((await kernel.inspect()).status, 'completed');
});
await fixture('repeated_revision', async () => {
  await initGoal(root, { id: 'revision', goal: 'Preserve repeated revision lineage without collision.' });
  await reviewGoal(root, 'revision', { decision: 'revise', revision: 1, key: 'revision:1', parent: null });
  await reviewGoal(root, 'revision', { decision: 'revise', revision: 2, key: 'revision:2', parent: 'revision:1' });
  const status = await statusGoal(root, 'revision');
  assert.equal(status.runtime.applied_effects['revision:2'].effect.payload.parent, 'revision:1'); assert.equal(status.receipt_chain.count, 2);
});

assert.deepEqual(Object.keys(Goal), ['init', 'run', 'status', 'review', 'doctor']);
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: results.every((item) => item.ok), fixtures: results }, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;
