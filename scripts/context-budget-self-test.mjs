import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextPolicy, contextRotation, openClawContextUsage, readBoundedJson } from '../lib/context-budget.mjs';
import { dispatchFailureClassification, enqueueTask, runQueueOnce, queueCancel } from '../lib/core.mjs';

const policy = contextPolicy();
assert.equal(contextRotation(null, 2, policy).rotate, false);
assert.equal(contextRotation(null, 3, policy).reason, 'bounded_tick_limit');
for (const [usedTokens, reason] of [[59, null], [60, 'context_soft_limit'], [75, 'context_hard_limit'], [110, 'context_hard_limit']]) {
  assert.equal(contextRotation({ usedTokens, windowTokens: 100 }, 1, policy).reason, reason);
}
assert.equal(contextRotation({ usedTokens: NaN, windowTokens: 100 }, 3, policy).reason, 'bounded_tick_limit');
assert.throws(() => contextPolicy({ contextBudget: { softRatio: 0.8, hardRatio: 0.7 } }));
assert.throws(() => contextPolicy({ sessionMaxTicks: 0 }));
assert.equal(openClawContextUsage({ result: { meta: { agentMeta: { contextTokens: 100, usage: { input: 90 } } } } }), null, 'aggregate usage is not context occupancy');
const usage = openClawContextUsage({ result: { meta: { agentMeta: { contextTokens: 100, lastCallUsage: { input: 20, cacheRead: 40, cacheWrite: 15 } } } } });
assert.equal(usage.usedTokens, 60, 'cache reads count once; writes are not added again');
assert.equal(dispatchFailureClassification({ exitCode: 0, stdout: 'Implemented context_length_exceeded handling' }).category, 'ok');
assert.equal(dispatchFailureClassification({ exitCode: 1, stderr: 'context_length_exceeded' }).category, 'context_overflow');
assert.equal(dispatchFailureClassification({ exitCode: 1, stderr: 'Permission denied; context_length_exceeded' }).requiresHumanAction, true);

const roots = [];
try {
  for (const scenario of ['yield', 'stale', 'malformed', 'missing-checkpoint', 'checkpoint-gate', 'pending-action', 'overflow', 'human-error', 'oversized', 'project-soft', 'project-hard', 'project-no-usage', 'terminal', 'pending-action-overflow', 'checkpoint-gate-overflow', 'stale-overflow', 'malformed-overflow', 'yield-overflow', 'yield-human-error', 'pending-action-failure']) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-context-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    await writeFile(worker, `import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
const original = ${JSON.stringify(scenario)};
const scenario = original.replace(/-(overflow|human-error|failure)$/, '');
if (scenario === 'overflow' || scenario === 'human-error') {
  console.error(scenario === 'human-error' ? 'Permission denied; context_length_exceeded' : 'context_length_exceeded');
  process.exit(1);
}
await mkdir(e.LOOP_CHECKPOINTS_DIR, { recursive: true });
const checkpoint = path.join(e.LOOP_CHECKPOINTS_DIR, e.LOOP_RUN_ID + '.json');
if (scenario.startsWith('project-') || scenario === 'terminal') {
  const plan = JSON.parse(await readFile(e.LOOP_DEV_PLAN_FILE, 'utf8'));
  for (const cp of plan.checkpoints) await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, cp.id + '.json'), JSON.stringify({ version: 1, task_id: e.LOOP_TASK_ID, checkpoint_id: cp.id, status: 'ready_for_acceptance', summary: 'Read-only inspection verified', files_changed: [], verification: [{ command: 'read-only inspection', outcome: 'passed' }], blockers: [], risks: [], next_action: 'continue local inspection', ...(scenario === 'terminal' ? {} : { project_completion: { status: 'in_progress' } }) }));
  if (scenario !== 'project-no-usage') await writeFile(e.LOOP_CONTEXT_USAGE_FILE, JSON.stringify({ version: 1, taskId: e.LOOP_TASK_ID, runId: e.LOOP_RUN_ID, generation: Number(e.LOOP_SESSION_GENERATION), attempt: Number(e.LOOP_ATTEMPT), usage: { usedTokens: scenario === 'project-soft' ? 60 : 80, windowTokens: 100 } }));
  process.exit(0);
}

if (scenario !== 'missing-checkpoint') await writeFile(checkpoint, JSON.stringify({ task_id: e.LOOP_TASK_ID, loop_run_id: e.LOOP_RUN_ID, checkpoint_id: e.LOOP_RUN_ID, status: scenario === 'checkpoint-gate' ? 'needs_human_input' : 'in_progress', summary: 'bounded progress', blockers: scenario === 'checkpoint-gate' ? ['Need approval'] : [], verification: [], risks: [], next_action: 'continue' }));
const handoff = { version: 1, taskId: e.LOOP_TASK_ID, runId: scenario === 'stale' ? 'old-run' : e.LOOP_RUN_ID, generation: Number(e.LOOP_SESSION_GENERATION), attempt: Number(e.LOOP_ATTEMPT), reason: 'context_budget', checkpoint, summary: 'progress', completed: ['read source'], remaining: ['verify changes'], evidence: [checkpoint], nextAction: 'inspect test', authority: 'local only', pendingActions: scenario === 'pending-action' ? ['unknown payment outcome'] : [], blockers: [] };
await writeFile(e.LOOP_CONTEXT_HANDOFF_FILE, scenario === 'malformed' ? '{' : scenario === 'oversized' ? ' '.repeat(17000) : JSON.stringify(handoff));
if (original !== scenario) { console.error(original.endsWith('-human-error') ? 'Permission denied; context_length_exceeded' : original.endsWith('-failure') ? 'generic failure' : 'context_length_exceeded'); process.exitCode = 1; }
`);
    await enqueueTask(root, { queue: 'test', title: scenario, task: 'Inspect a local file, then continue verification.' });
    const options = { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: 3, runtimeRecoveryMaxAttempts: 2 }, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    const first = await runQueueOnce(root, options);
    assert.equal(first.run.dispatchAttempts.length, 1, 'context failures must not retry the old session');
    if (scenario.startsWith('project-')) {
      assert.equal(first.status, 'project_in_progress', JSON.stringify(first.run.finalJudgement));
      const task = JSON.parse(await readFile(path.join(root, first.taskPath), 'utf8'));
      if (scenario === 'project-no-usage') {
        assert.equal(task.runtimeSessionGeneration ?? 0, 0);
        await runQueueOnce(root, options);
        const third = await runQueueOnce(root, options);
        const rotated = JSON.parse(await readFile(path.join(root, third.taskPath), 'utf8'));
        assert.equal(rotated.runtimeSessionGeneration, 1);
        assert.equal(rotated.sessionRotationReason, 'bounded_tick_limit');
      } else {
        assert.equal(task.runtimeSessionGeneration, 1);
        assert.equal(task.sessionRotationReason, scenario === 'project-soft' ? 'context_soft_limit' : 'context_hard_limit');
      }
    } else if (scenario === 'terminal') {
      assert.equal(first.status, 'completed');
      assert.equal((await runQueueOnce(root, options)).processed, false, 'high token usage cannot replay completed work');
    } else if (['yield', 'overflow', 'yield-overflow'].includes(scenario)) {
      assert.equal(first.status, 'runtime_interrupted', scenario);
      const task = JSON.parse(await readFile(path.join(root, first.taskPath), 'utf8'));
      assert.equal(task.runtimeSessionGeneration, 1);
      assert.equal(task.sessionTickCount, 0);
      if (scenario === 'yield') assert.ok(task.contextHandoffFile);
      const second = await runQueueOnce(root, options);
      assert.equal(second.status, 'runtime_interrupted');
      const third = await runQueueOnce(root, options);
      assert.equal(third.status, 'runtime_blocked', 'recovery is bounded');
    } else if (['pending-action', 'checkpoint-gate', 'human-error', 'pending-action-overflow', 'checkpoint-gate-overflow', 'yield-human-error', 'pending-action-failure'].includes(scenario)) {
      assert.equal(first.status, 'needs_human_input', scenario);
      assert.equal((await runQueueOnce(root, options)).processed, false, 'blocked work cannot auto-replay');
    } else assert.equal(first.status, 'runtime_blocked', scenario);
    if (scenario !== 'terminal') assert.notEqual(first.status, 'completed');
    if (scenario === 'oversized') assert.equal(await readBoundedJson(path.join(root, 'nonexistent')), null);
  }
  // A durable blocker must survive the window before handoff creation.
  for (const chronology of ['single', 'arbitrary-id', 'id-restart', 'missing', 'conflict']) {
  for (const failure of ['overflow', 'abandoned', 'exhausted', 'ordinary', 'ordinary-single']) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-context-no-handoff-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    await writeFile(worker, `import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
await mkdir(e.LOOP_CHECKPOINTS_DIR, { recursive: true });
const plan = JSON.parse(await readFile(e.LOOP_DEV_PLAN_FILE, 'utf8'));
const chronology = ${JSON.stringify(chronology)};
const oldId = chronology === 'id-restart' ? 'cp99' : 'cp1';
const newId = chronology === 'id-restart' ? 'cp1' : 'progress-latest';
if (chronology !== 'single') await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, oldId + '.json'), JSON.stringify({ task_id: e.LOOP_TASK_ID, checkpoint_id: oldId, sequence: chronology === 'missing' ? undefined : chronology === 'conflict' ? 3 : 1, created_at: chronology === 'missing' ? undefined : '2026-10-23T00:00:00Z', status: 'in_progress', summary: 'Old progress', blockers: [], risks: [], verification: [] }));
for (const cp of plan.checkpoints) await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, (chronology === 'single' ? cp.id : newId) + '.json'), JSON.stringify({ version: 1, task_id: e.LOOP_TASK_ID, loop_run_id: e.LOOP_RUN_ID, checkpoint_id: chronology === 'single' ? cp.id : newId, sequence: chronology === 'missing' ? undefined : 2, created_at: chronology === 'missing' ? undefined : '2026-10-23T00:01:00Z', status: 'needs_human_input', summary: 'External outcome unknown', files_changed: [], verification: [], blockers: ['Payment outcome unknown; reconcile before replay'], risks: [], next_action: 'Wait for human confirmation' }));
console.error(${JSON.stringify(failure === 'abandoned' ? '"kind": "incomplete_turn"' : failure.startsWith('ordinary') ? 'generic worker failure' : 'context_length_exceeded')});
process.exitCode = ${failure === 'abandoned' ? 0 : 1};`);
    await enqueueTask(root, { queue: 'test', title: 'blocker before handoff', task: 'Inspect local mocked data' });
    const options = { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: failure === 'ordinary-single' ? 1 : 3, runtimeRecoveryMaxAttempts: failure === 'exhausted' ? 0 : 2 }, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    const result = await runQueueOnce(root, options);
    assert.equal(result.run.acceptanceReviews.blocked, 1);
    assert.equal(result.run.finalJudgement.outcome, 'blocked');
    assert.equal(result.status, 'needs_human_input', failure);
    assert.equal(result.run.revisionRequest, null, 'human blockers must not create development revisions');
    assert.equal(result.run.dispatchAttempts.length, 1);
    const task = JSON.parse(await readFile(path.join(root, result.taskPath), 'utf8'));
    assert.equal(task.runtimeSessionGeneration ?? 0, 0, 'blocked work must not rotate');
    assert.equal(task.runtimeRecoveryCount ?? 0, 0, 'blocked work must not consume recovery');
    assert.equal((await runQueueOnce(root, options)).processed, false, 'no replay without a handoff either');
  }
  }
  // After one legitimate recovery, newly durable blockers stop the next run.
  for (const failure of ['ordinary', 'overflow']) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-recovered-blocker-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    await writeFile(worker, `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
if (Number(e.LOOP_SESSION_GENERATION) > 0) {
  await mkdir(e.LOOP_CHECKPOINTS_DIR, { recursive: true });
  for (const [id, sequence, blockers] of [['cp99', 1, []], ['progress-latest', 2, ['Unknown payment outcome']]]) await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, id + '.json'), JSON.stringify({task_id:e.LOOP_TASK_ID, checkpoint_id:id, sequence, status:blockers.length ? 'needs_human_input' : 'in_progress', blockers, risks:[], verification:[]}));
}
console.error(Number(e.LOOP_SESSION_GENERATION) > 0 && ${JSON.stringify(failure)} === 'ordinary' ? 'generic failure' : 'context_length_exceeded');
process.exitCode = 1;`);
    await enqueueTask(root, { queue: 'test', title: 'recovered blocker', task: 'Inspect mocked local data' });
    const options = { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: 3 }, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    assert.equal((await runQueueOnce(root, options)).status, 'runtime_interrupted');
    const result = await runQueueOnce(root, options);
    assert.equal(result.status, 'needs_human_input');
    assert.equal(result.run.dispatchAttempts.length, 1);
    assert.equal(result.run.revisionRequest, null);
    const task = JSON.parse(await readFile(path.join(root, result.taskPath), 'utf8'));
    assert.equal(task.runtimeSessionGeneration, 1);
    assert.equal(task.runtimeRecoveryCount, 1);
    assert.equal((await runQueueOnce(root, options)).processed, false);
  }
  // Cancellation takes precedence even with a blocker and invalid handoff.
  {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-cancel-blocker-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    const marker = path.join(root, 'ready');
    await writeFile(worker, `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
await mkdir(e.LOOP_CHECKPOINTS_DIR, {recursive:true});
await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, 'pending.json'), JSON.stringify({ task_id:e.LOOP_TASK_ID, checkpoint_id:'pending', status:'needs_human_input', blockers:['Unknown outcome'] }));
await writeFile(e.LOOP_CONTEXT_HANDOFF_FILE, '{}');
await writeFile(${JSON.stringify(marker)}, 'ready');
setInterval(() => {}, 1000);`);
    const queued = await enqueueTask(root, { queue: 'test', title: 'cancel blocker', task: 'Inspect mocked local data' });
    const options = { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: 3 }, timeoutMs: 5000, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    const running = runQueueOnce(root, options);
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      ready = await readFile(marker, 'utf8').then(() => true, () => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ready, true);
    await queueCancel(root, 'test', queued.task.id, { includeActive: true, reason: 'cancel regression' });
    const result = await running;
    assert.equal(result.status, 'superseded');
    assert.equal(result.run.dispatchAttempts.length, 1);
    assert.equal(result.run.revisionRequest, null);
    assert.equal((await runQueueOnce(root, options)).processed, false);
  }
  // Ordinary failures still retry without blockers, or after a later snapshot
  // resolves a historical blocker. Test through the real dispatch loop.
  for (const scenario of ['absent', 'resolved']) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-retry-control-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    await writeFile(worker, `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
await mkdir(e.LOOP_CHECKPOINTS_DIR, { recursive: true });
if (${JSON.stringify(scenario)} === 'resolved') {
  for (const [id, blockers] of [['cp1', ['Await approval']], ['cp2', []]]) {
    await writeFile(path.join(e.LOOP_CHECKPOINTS_DIR, id + '.json'), JSON.stringify({ task_id: e.LOOP_TASK_ID, loop_run_id: e.LOOP_RUN_ID, checkpoint_id: id, sequence: id === 'cp1' ? 1 : 2, status: blockers.length ? 'needs_human_input' : 'in_progress', summary: 'Local progress', blockers, verification: [], risks: [], next_action: 'Continue local verification' }));
  }
}
console.error('generic worker failure');
process.exitCode = 1;`);
    await enqueueTask(root, { queue: 'test', title: scenario, task: 'Inspect local mocked data' });
    const result = await runQueueOnce(root, { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: 3 }, checkpointPollMs: 0, progressHeartbeatMs: 0 });
    assert.equal(result.run.dispatchAttempts.length, 3, scenario);
    assert.equal(result.status, 'failed', scenario);
    assert.equal(result.run.finalJudgement.outcome, 'needs_revision', scenario);
  }
  // Exercise the real output observer in a subprocess: no unbounded parse
  // buffer, byte-for-byte full logs, bound usage report and clipped runner tail.
  for (const scenario of ['json', 'oversized-output']) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-context-output-'));
    roots.push(root);
    const observer = path.join(root, 'observer.mjs');
    const output = scenario === 'json' ? JSON.stringify({ result: { meta: { agentMeta: { contextTokens: 100, lastCallUsage: { input: 20, cacheRead: 40 } } } } }) : 'x'.repeat(2 * 1024 * 1024 + 1);
    const outputFile = path.join(root, 'output.txt');
    await writeFile(outputFile, output);
    await writeFile(observer, `import { spawn } from 'node:child_process';
import { observeOpenClawWorker } from ${JSON.stringify(new URL('../lib/context-budget.mjs', import.meta.url).href)};
const child = spawn(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', ${JSON.stringify(outputFile)}], { stdio: ['ignore', 'pipe', 'pipe'] });
process.exitCode = await observeOpenClawWorker(child);`);
    const usageFile = path.join(root, 'usage.json');
    const result = spawnSync(process.execPath, [observer], { encoding: 'utf8', env: { ...process.env, LOOP_CONTEXT_USAGE_FILE: usageFile, LOOP_WORKER_OUTPUT_PREFIX: path.join(root, 'worker'), LOOP_TASK_ID: 't', LOOP_RUN_ID: 'r', LOOP_SESSION_GENERATION: '2', LOOP_ATTEMPT: '1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(root, 'worker.stdout.log'), 'utf8'), output);
    assert.ok(Buffer.byteLength(result.stdout) <= 16384);
    const report = JSON.parse(await readFile(usageFile, 'utf8'));
    assert.equal(report.generation, 2);
    assert.equal(report.attempt, 1);
    assert.equal(report.usage?.usedTokens ?? null, scenario === 'json' ? 60 : null);
  }
  // Real observer + real queue: early human signals cannot be lost to tail
  // clipping, even across chunks/UTF-8 boundaries or with custom retry policy.
  for (const [signal, channel, retry] of [
    ['Permission denied', 'stderr', {}],
    ['需要用户确认', 'stdout', {}],
    ['CUSTOM_APPROVAL', 'stderr', { requiresHumanActionPatterns: ['CUSTOM_APPROVAL'] }],
    ['context_length_exceeded', 'stderr', {}]
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-context-signals-'));
    roots.push(root);
    const worker = path.join(root, 'worker.mjs');
    await writeFile(worker, `import { spawn } from 'node:child_process';
import { observeOpenClawWorker } from ${JSON.stringify(new URL('../lib/context-budget.mjs', import.meta.url).href)};
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const bytes = Buffer.from(${JSON.stringify(signal)}); (async () => { for (const byte of bytes) { process.${channel}.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 2)); } process.${channel}.write('x'.repeat(100000)); process.stderr.write('context_length_exceeded'); process.exitCode = 1; })();`)}], { stdio: ['ignore', 'pipe', 'pipe'] });
process.exitCode = await observeOpenClawWorker(child);`);
    await enqueueTask(root, { queue: 'test', title: 'signal preservation', task: 'Inspect local source' });
    const options = { queue: 'test', dispatcher: `node '${worker}'`, retry: { maxAttempts: 3, ...retry }, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    const result = await runQueueOnce(root, options);
    assert.equal(result.status, signal === 'context_length_exceeded' ? 'runtime_interrupted' : 'needs_human_input');
    assert.equal(result.run.dispatchAttempts.length, 1);
    if (signal !== 'context_length_exceeded') assert.equal((await runQueueOnce(root, options)).processed, false);
  }
  console.log('Context budget: thresholds, telemetry, handoff binding, gates, overflow and bounded recovery passed.');
} finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
