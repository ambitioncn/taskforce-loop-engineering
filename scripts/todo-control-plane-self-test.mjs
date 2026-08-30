import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimAction, markActionUnknown, reserveAction } from '../lib/action-reservations.mjs';
import { claimTodo, createTodo, decideHandoff, handoffTodo, inspectTodo, recoverTodos, registerAgent, releaseTodo, renewTodo } from '../lib/todo-control-plane.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-p2-'));
const agent = (id, capabilities = ['code'], authority_grants = ['local'], quota = 10) => registerAgent(root, { id, capabilities, authority_grants, quota_grants: { default: quota } });
const todo = (id, extra = {}) => createTodo(root, { id, title: `Todo ${id}`, required_capabilities: ['code'], authority_class: 'local', acceptance_contract: { checks: ['test'] }, evidence_requirements: ['test-output'], cost: 1, ...extra });

await Promise.all([agent('alpha'), agent('beta'), agent('observer', []), agent('poor', ['code'], ['local'], 0)]);
await todo('race');
const race = await Promise.all([claimTodo(root, { todoId: 'race', agentId: 'alpha', leaseMs: 1000 }), claimTodo(root, { todoId: 'race', agentId: 'beta', leaseMs: 1000 })]);
assert.equal(race.filter((item) => item.claimed).length, 1, 'exactly one agent wins an atomic claim');
const winner = race.find((item) => item.claimed);
const loser = race.find((item) => !item.claimed);
assert.match(loser.reason, /state:claimed/);
await assert.rejects(() => renewTodo(root, { todoId: 'race', agentId: loser === race[0] ? 'alpha' : 'beta', fencingToken: winner.fencing_token }), /Stale or invalid/);

await todo('capability');
assert.equal((await claimTodo(root, { todoId: 'capability', agentId: 'observer' })).reason, 'capability_mismatch');
await todo('quota');
const quotaRejected = await claimTodo(root, { todoId: 'quota', agentId: 'poor' });
assert.equal(quotaRejected.reason, 'quota_exhausted');
assert.equal(quotaRejected.decision, 'wait');
assert.equal(quotaRejected.scheduler_hint.action, 'wait');

await todo('dependency');
await todo('dependent', { dependencies: ['dependency'], priority: 100 });
const blocked = await claimTodo(root, { todoId: 'dependent', agentId: 'alpha' });
assert.match(blocked.reason, /dependencies/);
const dependencyClaim = await claimTodo(root, { todoId: 'dependency', agentId: 'alpha' });
await releaseTodo(root, { todoId: 'dependency', agentId: 'alpha', fencingToken: dependencyClaim.fencing_token, completed: true, evidence: 'passed' });
assert.equal((await claimTodo(root, { todoId: 'dependent', agentId: 'alpha' })).claimed, true, 'completion unlocks dependencies');

await todo('stale');
const stale = await claimTodo(root, { todoId: 'stale', agentId: 'alpha', leaseMs: 1 });
await new Promise((resolve) => setTimeout(resolve, 5));
await assert.rejects(() => renewTodo(root, { todoId: 'stale', agentId: 'alpha', fencingToken: stale.fencing_token }), /expired/);
assert.equal((await recoverTodos(root)).results.find((item) => item.todo_id === 'stale').outcome, 'runnable');
const reclaimed = await claimTodo(root, { todoId: 'stale', agentId: 'beta' });
assert.ok(reclaimed.fencing_token > stale.fencing_token, 'recovered work gets a higher fencing token');

await todo('handoff');
const owned = await claimTodo(root, { todoId: 'handoff', agentId: 'alpha' });
const packet = await handoffTodo(root, { todoId: 'handoff', agentId: 'alpha', targetAgentId: 'beta', fencingToken: owned.fencing_token });
assert.deepEqual(packet.idempotency_keys, []);
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/loop-engineering.mjs');
const restarted = spawnSync(process.execPath, [cli, 'todo-inspect', '--todo-id', 'handoff', '--root', root], { encoding: 'utf8' });
assert.equal(restarted.status, 0);
assert.equal(JSON.parse(restarted.stdout).state, 'handoff_pending', 'handoff survives a fresh CLI process');
const accepted = await decideHandoff(root, { handoffId: packet.id, agentId: 'beta', accept: true });
assert.equal(accepted.todo.claim.owner, 'beta');
assert.ok(accepted.todo.claim.fencing_token > owned.fencing_token);
await todo('handoff-reject');
const rejectOwned = await claimTodo(root, { todoId: 'handoff-reject', agentId: 'alpha' });
const rejectPacket = await handoffTodo(root, { todoId: 'handoff-reject', agentId: 'alpha', targetAgentId: 'beta', fencingToken: rejectOwned.fencing_token });
const rejected = await decideHandoff(root, { handoffId: rejectPacket.id, agentId: 'beta', accept: false, reason: 'busy' });
assert.equal(rejected.todo.claim.owner, 'alpha');

await todo('parked', { parked: { state: 'waiting_for_human' } });
assert.equal((await claimTodo(root, { todoId: 'parked', agentId: 'alpha' })).reason, 'parked_human_gate');

await reserveAction(root, { idempotencyKey: 'side-effect', kind: 'external_message', authorizationScope: 'todo:external', request: { body: 'once' } });
const action = await claimAction(root, { idempotencyKey: 'side-effect', owner: 'alpha', leaseMs: 1000 });
await markActionUnknown(root, { idempotencyKey: 'side-effect', fencingToken: action.fencingToken, reason: 'worker_crash' });
await todo('unknown-action', { idempotency_keys: ['side-effect'], authorization: { scope: 'todo:external', grant: 'preserved' } });
assert.match((await claimTodo(root, { todoId: 'unknown-action', agentId: 'beta' })).reason, /action_reconciliation/);
assert.equal((await inspectTodo(root, 'unknown-action')).authorization.grant, 'preserved');

const audit = await readFile(path.join(root, 'runtime', 'loops', 'control-plane', 'audit.jsonl'), 'utf8');
assert.match(audit, /todo_claimed/);
assert.match(audit, /handoff_accepted/);
console.log(JSON.stringify({ ok: true, root, assertions: ['atomic claim', 'capability', 'dependency', 'quota', 'lease fencing', 'orphan recovery', 'handoff accept/reject', 'parked gate', 'unknown action reconciliation', 'audit'] }));
