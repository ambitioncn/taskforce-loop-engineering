import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeAcceptanceReviews, buildFinalJudgement, enqueueTask, runQueueOnce } from '../lib/core.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-revision-coverage-'));
const contract = { task_id: 'coverage-task', task_scope: 'project', requires_human_gate: false };
const plan = { checkpoints: [{ id: 'stable' }] };
const acceptance = { functional_checks: [], regression_checks: [], negative_tests: [], edge_cases: [], manual_review: [], automation: [], rubric: [] };
const phase = id => ({ task_id: contract.task_id, checkpoint_id: id, milestone_id: 'stable', status: 'in_progress', summary: 'Phase completed; integration pending', verification: ['phase test passed'], risks: ['integration pending'], blockers: [], project_completion: { status: 'in_progress' } });
const history = [phase('p1'), phase('p2'), phase('p3')];
const bytes = cp => JSON.stringify(cp);
const digest = cp => createHash('sha256').update(bytes(cp)).digest('hex');
const final = () => ({ ...phase('done'), sequence: 4, status: 'ready_for_acceptance', summary: 'Integration completed', risks: [], verification: ['integration test passed'], project_completion: { status: 'accepted' }, revises_checkpoint_id: 'p3', revision_coverage: history.map(cp => ({ checkpoint_id: cp.checkpoint_id, checkpoint_sha256: digest(cp), resolution: 'Integrated and verified this phase', verification: ['integration test passed'] })) });
let cases = 0;
try {
  async function judge(name, records) {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, 'checkpoints'), { recursive: true });
    await mkdir(path.join(dir, 'reviews'));
    for (const [i, cp] of records.entries()) await writeFile(path.join(dir, 'checkpoints', `${i}.json`), typeof cp === 'string' ? cp : bytes(cp));
    const reviews = await writeAcceptanceReviews(dir, 'disposable', { id: contract.task_id }, { contract }, { plan: acceptance }, { plan, checkpointsDir: 'checkpoints', reviewsDir: 'reviews' }, { persist: false });
    cases++;
    return buildFinalJudgement(contract, acceptance, plan, { count: records.length }, reviews, { dispatchStatus: 'completed' });
  }
  assert.equal((await judge('complete', [...history, final()])).outcome, 'ready_to_apply');
  assert.equal((await judge('reverse-order', [final(), ...history.toReversed()])).outcome, 'ready_to_apply');
  for (const [name, mutate] of [
    ['no-coverage', cp => { delete cp.revision_coverage; }],
    ['partial', cp => { cp.revision_coverage.pop(); }],
    ['stale-digest', cp => { cp.revision_coverage[0].checkpoint_sha256 = 'old'; }],
    ['unknown-target', cp => { cp.revision_coverage[0].checkpoint_id = 'missing'; }],
    ['no-resolution', cp => { cp.revision_coverage[0].resolution = ''; }],
    ['no-evidence', cp => { cp.revision_coverage[0].verification = []; }],
    ['unbound-evidence', cp => { cp.revision_coverage[0].verification = ['invented verification']; }],
    ['rename', cp => { cp.milestone_id = 'renamed'; }],
    ['different-task', cp => { cp.task_id = 'other'; }],
    ['duplicate-coverage', cp => { cp.revision_coverage.push(cp.revision_coverage[0]); }],
    ['malformed-coverage', cp => { cp.revision_coverage = {}; }]
  ]) {
    const cp = final(); mutate(cp);
    assert.equal((await judge(name, [...history, cp])).outcome, 'needs_revision', name);
  }
  for (const [name, patch, expected] of [
    ['real-defect', { status: 'needs_revision' }, 'needs_revision'],
    ['invalid-phase-coverage', { revision_coverage: [{ checkpoint_id: 'missing' }] }, 'needs_revision'],
    ['missing-verification', { verification: [] }, 'needs_revision'],
    ['missing-summary', { summary: '' }, 'needs_revision'],
    ['different-milestone', { milestone_id: 'other' }, 'needs_revision'],
    ['human-gate', { status: 'needs_human_input', blockers: ['Owner approval required'] }, 'blocked'],
    ['reversed-clock', { sequence: 5 }, 'needs_revision']
  ]) {
    const records = structuredClone(history); Object.assign(records[0], patch);
    const cp = final(); cp.revision_coverage[0].checkpoint_sha256 = digest(records[0]);
    assert.equal((await judge(name, [...records, cp])).outcome, expected, name);
  }
  assert.equal((await judge('corruption', [...history, '{', final()])).outcome, 'needs_revision');
  assert.equal((await judge('duplicate-id', [...history, history[0], final()])).outcome, 'needs_revision');
  // Ordered unrelated failure must survive even without the coverage protocol.
  const unrelated = { ...phase('unrelated'), milestone_id: 'other', sequence: 1, status: 'needs_revision' };
  const done = final(); delete done.revision_coverage;
  assert.equal((await judge('ordered-cross-scope', [unrelated, done])).outcome, 'needs_revision');
  const renamed = { ...done, milestone_id: 'renamed' };
  assert.equal((await judge('renamed-terminal', [renamed])).outcome, 'needs_revision');
  // Invalid coverage must not silently use clocks instead.
  const ordered = history.map((cp, i) => ({ ...cp, sequence: i + 1 }));
  assert.equal((await judge('invalid-coverage-with-clocks', [...ordered, final()])).outcome, 'needs_revision');
  console.log(`revision coverage self-test passed (${cases} cases)`);
} finally {
  await rm(root, { recursive: true, force: true });
}


// Exercise the same protocol through dispatch, final judgement and queue state.
for (const scenario of ['covered', 'uncovered', 'cross-scope', 'invalid-phase-coverage', 'blocked']) {
  const queueRoot = await mkdtemp(path.join(tmpdir(), 'loop-coverage-queue-'));
  try {
    const { task } = await enqueueTask(queueRoot, { queue: 'probe', title: scenario, task: '开发完整项目并完成整体目标' });
    const dir = path.join(queueRoot, 'runtime/loops/probe/tasks', task.id);
    await mkdir(path.join(dir, 'checkpoints'), { recursive: true });
    const records = history.map(cp => ({ ...cp, task_id: task.id }));
    if (scenario === 'cross-scope') records[0].milestone_id = 'unrelated';
    if (scenario === 'invalid-phase-coverage') records[0].revision_coverage = [{ checkpoint_id: 'missing' }];
    if (scenario === 'blocked') Object.assign(records[0], { status: 'needs_human_input', blockers: ['Owner approval required'] });
    for (const cp of records) await writeFile(path.join(dir, 'checkpoints', cp.checkpoint_id + '.json'), bytes(cp));
    await writeFile(path.join(dir, 'dev_plan.json'), bytes({ task_id: task.id, generated_by: 'project_scope_worker_revision_after_deterministic_planner_v1', ...plan }));
    await writeFile(path.join(dir, 'acceptance_plan.json'), bytes({ task_id: task.id, generated_by: 'project_scope_worker_revision_after_deterministic_planner_v1', ...acceptance }));
    const cp = { ...final(), task_id: task.id };
    cp.revision_coverage.forEach((entry, i) => { entry.checkpoint_sha256 = digest(records[i]); });
    if (scenario === 'uncovered') delete cp.revision_coverage;
    const worker = path.join(queueRoot, 'worker.mjs');
    await writeFile(worker, `import {writeFile} from 'node:fs/promises'; import path from 'node:path'; await writeFile(path.join(process.env.LOOP_CHECKPOINTS_DIR, 'done.json'), ${JSON.stringify(bytes(cp))});`);
    const options = { queue: 'probe', dispatcher: `${process.execPath} '${worker}'`, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    const result = await runQueueOnce(queueRoot, options);
    const effectiveContract = JSON.parse(await readFile(path.join(dir, 'task_contract.json'), 'utf8'));
    const expected = scenario === 'covered' ? (effectiveContract.requires_human_gate ? 'ready_for_human_review' : 'ready_to_apply') : scenario === 'blocked' ? 'blocked' : 'needs_revision';
    assert.equal(result.run.finalJudgement.outcome, expected, scenario);
    assert.equal((await runQueueOnce(queueRoot, options)).processed, false, 'terminal or revision queue must not replay');
    console.log(JSON.stringify({ test: 'revision-coverage-queue', scenario, outcome: expected, node: process.version, replay: false }));
  } finally {
    await rm(queueRoot, { recursive: true, force: true });
  }
}
