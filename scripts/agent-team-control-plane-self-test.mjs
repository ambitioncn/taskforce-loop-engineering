import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acknowledgeWake, claimTodo, createTodo, decideHandoff, handoffTodo, matchTodo, registerAgent, resolveOwnershipConflict, sendPeerMessage, teamWorkbench, wakeAgent } from '../lib/todo-control-plane.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-agent-team-'));
for (const [id, runtime, capabilities, max] of [
  ['openclaw-worker', 'openclaw', ['code', 'research'], 2],
  ['codex-worker', 'codex-cli', ['code', 'review'], 1],
  ['claude-worker', 'claude-code', ['research', 'review'], 1]
]) await registerAgent(root, { id, runtime, capabilities, authority_grants: ['local'], quota_grants: { default: 20 }, max_concurrent: max, wake: { mode: 'runtime-session', target: `${runtime}:session` } });
const make = (id, capabilities, dependencies = []) => createTodo(root, { id, title: id, required_capabilities: capabilities, dependencies, authority_class: 'local', acceptance_contract: { checks: ['verified'] }, evidence_requirements: ['artifact'], cost: 1 });
await make('research', ['research']); await make('implementation', ['code'], ['research']); await make('review', ['review'], ['implementation']);
const researchMatch = await matchTodo(root, { todoId: 'research' });
assert.equal(researchMatch.selected_agent_id, 'claude-worker');
assert.match(researchMatch.candidates.find((candidate) => candidate.agent_id === 'codex-worker').reasons.join(','), /capability_mismatch/);
const wake = await wakeAgent(root, { todoId: 'research', agentId: researchMatch.selected_agent_id });
assert.equal(wake.runtime, 'claude-code'); assert.equal((await acknowledgeWake(root, { wakeId: wake.id, agentId: 'claude-worker' })).state, 'acknowledged');
const researchClaim = await claimTodo(root, { todoId: 'research', agentId: 'claude-worker' }); assert.equal(researchClaim.claimed, true);
const peer = await sendPeerMessage(root, { todoId: 'research', fromAgentId: 'claude-worker', toAgentId: 'openclaw-worker', kind: 'request_evidence', body: 'Please validate source evidence.', evidenceRefs: ['artifact:research-plan'] }); assert.equal(peer.to_agent_id, 'openclaw-worker');
const handoff = await handoffTodo(root, { todoId: 'research', agentId: 'claude-worker', targetAgentId: 'openclaw-worker', fencingToken: researchClaim.fencing_token });
const accepted = await decideHandoff(root, { handoffId: handoff.id, agentId: 'openclaw-worker', accept: true }); assert.equal(accepted.todo.claim.owner, 'openclaw-worker');
const conflict = await resolveOwnershipConflict(root, { todoId: 'research', winnerAgentId: 'claude-worker', contenders: ['openclaw-worker', 'claude-worker'], reason: 'research capability and dependency ownership', leaseMs: 1000 });
assert.equal(conflict.todo.claim.owner, 'claude-worker'); assert.ok(conflict.todo.claim.fencing_token > accepted.todo.claim.fencing_token);
const workbench = await teamWorkbench(root); assert.equal(workbench.agents.length, 3); assert.equal(workbench.peer_messages.length, 1); assert.equal(workbench.conflicts.length, 1);
assert.ok(workbench.governance.unmatched_runnable.includes('implementation'));
assert.deepEqual(new Set(workbench.agents.map((agent) => agent.runtime)), new Set(['openclaw', 'codex-cli', 'claude-code']));
console.log(JSON.stringify({ status: 'passed', boundary: 'durable control-plane runtime identities; credential-free external effects', assertions: 15, runtimes: workbench.agents.map(({ id, runtime }) => ({ id, runtime })) }));
