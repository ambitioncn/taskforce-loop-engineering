import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFinalJudgement, enqueueTask, queueRequeue, runQueueOnce } from '../lib/core.mjs';

// A worker that follows the dev plan's checkpoint template exactly. `script`
// receives the tick number and returns { status, exit } decisions.
async function templateWorker(root, body) {
  const worker = path.join(root, 'worker.mjs');
  await writeFile(worker, `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(process.env.LOOP_CHECKPOINTS_DIR, '..');
const plan = JSON.parse(await readFile(path.join(dir, 'dev_plan.json'), 'utf8'));
const schema = plan.checkpoint_schema;
const marker = ${JSON.stringify(path.join(root, 'tick'))};
let tick = 0; try { tick = Number(await readFile(marker, 'utf8')); } catch {}
await writeFile(marker, String(tick + 1));
const n = Number(schema.checkpoint_id.slice(2));
const write = (fields) => writeFile(path.join(process.env.LOOP_CHECKPOINTS_DIR, schema.checkpoint_id + '.json'), JSON.stringify({
  task_id: plan.task_id, checkpoint_id: schema.checkpoint_id, milestone_id: schema.milestone_id,
  revises_checkpoint_id: schema.revises_checkpoint_id, sequence: n, created_at: new Date(Date.UTC(2026, 0, n)).toISOString(),
  summary: 'work', files_changed: [], verification: ['npm test passed (' + schema.checkpoint_id + ')'], blockers: [], risks: [], deferred_gates: [], ...fields }));
${body}`);
  return { queue: 'regress', dispatcher: `node '${worker}'`, checkpointPollMs: 0, progressHeartbeatMs: 0 };
}

const roots = [];
try {
  // A bounded task revised once along the template is accepted; before, the
  // revision got a new milestone id and the first review stayed live.
  {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-revise-')); roots.push(root);
    const { task } = await enqueueTask(root, { queue: 'regress', title: 'fix bug', task: 'Fix the login redirect bug in the auth module.' });
    const options = await templateWorker(root, `await write({ status: tick === 0 ? 'in_progress' : 'ready_for_acceptance' });`);
    const first = await runQueueOnce(root, options);
    assert.equal(first.run.finalJudgement.outcome, 'needs_revision');
    await queueRequeue(root, 'regress', task.id);
    const second = await runQueueOnce(root, options);
    assert.notEqual(second.run.finalJudgement.outcome, 'needs_revision', JSON.stringify(second.run.finalJudgement.reasons));
  }

  // A project interrupted after writing an accepted checkpoint continues
  // after recovery instead of failing as "no progress" or "not covered".
  {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-recover-')); roots.push(root);
    await enqueueTask(root, { queue: 'regress', title: 'project', task: '开发完整项目并完成整体目标' });
    const options = await templateWorker(root, `if (tick === 2) process.exit(0);
await write({ status: 'ready_for_acceptance', project_completion: { status: 'in_progress' } });
if (tick === 1) { console.error('gateway is draining for restart'); process.exit(1); }`);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await runQueueOnce(root, options)).run?.status ?? 'not_processed');
    assert.deepEqual(statuses, ['project_in_progress', 'runtime_interrupted', 'project_in_progress', 'project_in_progress']);
  }

  // Checkpoints written by the 0.16.1-0.16.4 template carry a new milestone
  // id per revision; an explicit revises_checkpoint_id keeps them one chain,
  // so a resolved historical blocker does not veto the accepted revision.
  {
    const contract = { task_id: 't', task_scope: 'scoped_task', requires_human_gate: false };
    const reviews = { reviews: [
      { checkpointId: 'cp1', milestoneId: 'cp1', sequence: 1, checkpointCreatedAt: '2026-01-01T00:00:00Z', status: 'blocked' },
      { checkpointId: 'cp2', milestoneId: 'cp2', revisesCheckpointId: 'cp1', sequence: 2, checkpointCreatedAt: '2026-01-02T00:00:00Z', status: 'accepted', taskTerminal: true }
    ] };
    const judgement = buildFinalJudgement(contract, { rubric: [], automation: [] }, { checkpoints: [{ id: 'cp2' }] }, { count: 2 }, reviews, { dispatchStatus: 'completed' });
    assert.equal(judgement.outcome, 'ready_to_apply');
    assert.deepEqual(judgement.coverage.effective_review_ids, ['cp2']);
    // Without the revision link a different milestone's blocker stays live.
    const unlinked = { reviews: [reviews.reviews[0], { ...reviews.reviews[1], revisesCheckpointId: null }] };
    assert.equal(buildFinalJudgement(contract, { rubric: [], automation: [] }, { checkpoints: [{ id: 'cp2' }] }, { count: 2 }, unlinked, { dispatchStatus: 'completed' }).outcome, 'blocked');
  }
  console.log('continuation regression self-test passed');
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
