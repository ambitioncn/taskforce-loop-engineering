import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureQueueDirs, queueSubdirFor, readJson, refreshTaskAcceptance, writeJson } from '../lib/core.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-async-acceptance-'));
const queue = 'async-refresh';
const taskId = 'detached-soak';
const runtimeDir = path.join(root, 'runtime', 'loops', queue, 'tasks', taskId);

try {
  await ensureQueueDirs(root, queue);
  await writeJson(path.join(queueSubdirFor(root, queue, 'failed'), `${taskId}.json`), {
    version: 1, id: taskId, title: 'Detached soak', status: 'blocked'
  });
  await writeJson(path.join(runtimeDir, 'task_contract.json'), {
    version: 1, task_id: taskId, task_scope: 'project', risk_level: 'L1', requires_human_gate: false,
    constraints: { blocked_actions: [] }
  });
  await writeJson(path.join(runtimeDir, 'acceptance_plan.json'), {
    version: 1, functional_checks: [], regression_checks: [], negative_tests: [], manual_review: [], automation: [], rubric: []
  });
  await writeJson(path.join(runtimeDir, 'dev_plan.json'), { version: 1, checkpoints: [{ id: 'cp1' }] });
  await writeJson(path.join(runtimeDir, 'checkpoints', 'cp1.json'), {
    version: 1, task_id: taskId, checkpoint_id: 'cp1', milestone_id: 'cp1', sequence: 1,
    status: 'blocked', summary: 'Soak still running.', files_changed: ['soak.json'], verification: ['pending'], blockers: ['pending'], risks: [], project_completion: { status: 'in_progress' }
  });
  await writeJson(path.join(runtimeDir, 'final_judgement.json'), { version: 1, task_id: taskId, outcome: 'blocked' });
  assert.equal((await refreshTaskAcceptance(root, { queue, taskId })).outcome, 'already_current');

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeJson(path.join(runtimeDir, 'checkpoints', 'cp2.json'), {
    version: 1, task_id: taskId, checkpoint_id: 'cp2', milestone_id: 'cp1', revises_checkpoint_id: 'cp1', sequence: 2,
    status: 'ready_for_acceptance', summary: 'Detached soak completed.', files_changed: ['soak.json'], verification: ['passed=true'], blockers: [], risks: [], project_completion: { status: 'accepted' }
  });
  const refreshed = await refreshTaskAcceptance(root, { queue, taskId });
  assert.equal(refreshed.outcome, 'refreshed');
  assert.equal(refreshed.status, 'completed');
  assert.equal((await readJson(path.join(runtimeDir, 'final_judgement.json'))).outcome, 'ready_to_apply');
  assert.equal((await refreshTaskAcceptance(root, { queue, taskId })).outcome, 'already_current');
  assert.equal((await readJson(path.join(queueSubdirFor(root, queue, 'done'), `${taskId}.json`))).status, 'completed');
  console.log('async acceptance refresh self-test passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
