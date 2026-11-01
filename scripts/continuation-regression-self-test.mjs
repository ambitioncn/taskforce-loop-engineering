import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { buildFinalJudgement, enqueueTask, inferTaskScope, notifyTerminalTasks, queueRequeue, runQueueOnce, writeJson } from '../lib/core.mjs';

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
  // Context handoffs: capped, blockers surfaced, and never stale.
  {
    const handoffWorker = async (root, extra) => {
      const worker = path.join(root, 'handoff-worker.mjs');
      await writeFile(worker, `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const e = process.env;
await mkdir(e.LOOP_CHECKPOINTS_DIR, { recursive: true });
const checkpoint = path.join(e.LOOP_CHECKPOINTS_DIR, e.LOOP_RUN_ID + '.json');
await writeFile(checkpoint, JSON.stringify({ task_id: e.LOOP_TASK_ID, loop_run_id: e.LOOP_RUN_ID, checkpoint_id: e.LOOP_RUN_ID, status: 'in_progress', summary: 'still working', blockers: [], verification: [{ command: 'npm test', outcome: 'failed', log: e.LOOP_WORKER_OUTPUT_PREFIX + '.stdout.log' }], risks: [], next_action: 'continue' }));
const handoff = { version: 1, taskId: e.LOOP_TASK_ID, runId: e.LOOP_RUN_ID, generation: Number(e.LOOP_SESSION_GENERATION), attempt: Number(e.LOOP_ATTEMPT), reason: 'context_budget', checkpoint, summary: 's', completed: [], remaining: ['fix tests'], evidence: [checkpoint], nextAction: 'fix', authority: 'local', pendingActions: [], blockers: [] };
${extra}
await writeFile(e.LOOP_CONTEXT_HANDOFF_FILE, JSON.stringify(handoff));
`);
      return { queue: 'regress', dispatcher: `node '${worker}'`, retry: { maxAttempts: 1, runtimeRecoveryMaxAttempts: 2, maxContextHandoffs: 3 }, checkpointPollMs: 0, progressHeartbeatMs: 0 };
    };
    // A worker whose evidence differs every turn (a run-specific log path)
    // still stops after maxContextHandoffs instead of looping forever.
    {
      const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-handoff-loop-')); roots.push(root);
      await enqueueTask(root, { queue: 'regress', title: 't', task: 'Fix the failing test.' });
      const options = await handoffWorker(root, '');
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await runQueueOnce(root, options);
        if (!result.processed) break;
        statuses.push(result.status);
      }
      assert.deepEqual(statuses, ['runtime_interrupted', 'runtime_interrupted', 'runtime_interrupted', 'runtime_blocked']);
    }
    // Handoff blockers and pending external actions reach the human.
    {
      const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-handoff-blocker-')); roots.push(root);
      await enqueueTask(root, { queue: 'regress', title: 't', task: 'Fix the failing test.', sourceChannel: 'telegram', sourceTarget: '1' });
      const options = await handoffWorker(root, "handoff.blockers = ['NEED_PROD_DB_PASSWORD']; handoff.pendingActions = ['payment request 42'];");
      const result = await runQueueOnce(root, options);
      assert.equal(result.status, 'needs_human_input');
      const judgement = JSON.parse(await readFile(path.join(root, result.run.finalJudgement.path), 'utf8'));
      assert.match(judgement.reasons.join(' '), /NEED_PROD_DB_PASSWORD/);
      assert.match(judgement.next_actions[0], /payment request 42/);
      const notice = await notifyTerminalTasks(root, { queue: 'regress', dryRun: true });
      assert.match(notice.results[0].message, /NEED_PROD_DB_PASSWORD/);
      assert.match(notice.results[0].message, /payment request 42/);
    }
    // A later session is not pointed at an earlier session's handoff.
    {
      const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-handoff-stale-')); roots.push(root);
      const { task } = await enqueueTask(root, { queue: 'regress', title: 't', task: 'Fix the failing test.' });
      const options = await handoffWorker(root, "if (Number(e.LOOP_SESSION_GENERATION) > 0) { console.error('maximum context length exceeded'); process.exit(1); }");
      await runQueueOnce(root, options);
      await runQueueOnce(root, options);
      const inbox = JSON.parse(await readFile(path.join(root, 'runtime/loops/regress/inbox', `${task.id}.json`), 'utf8'));
      assert.equal(inbox.contextHandoffFile, undefined, 'a run without a handoff clears the previous one');
    }
  }

  // Scope inference: ordinary words containing 不/别 and temporal "after the
  // first step" are not bounded-scope negations or cues.
  for (const [body, expected] of [
    ['继续整体项目，特别要求只处理第 3 项', 'scoped_task'],
    ['继续整体项目：在不同模块中只处理第 2 项', 'scoped_task'],
    ['Continue the project-level plan: no UI changes needed - only complete backlog item 2', 'scoped_task'],
    ['Continue the project-level work. Without network access complete backlog item 2', 'scoped_task'],
    ['项目级任务：完成第一步之后不要停，继续完成完整项目', 'project'],
    ['继续整体项目，不要只处理第 3 项', 'project'],
    ['完成完整项目，不仅是有界里程碑，而且不是仅完成第一步', 'project']
  ]) assert.equal(inferTaskScope({ body }), expected, body);

  // Malformed coverage evidence and id collisions do not crash or overcount.
  {
    const contract = { task_id: 't', task_scope: 'scoped_task', requires_human_gate: false };
    const plan = { checkpoints: [{ id: 'cp1' }, { id: 'cp2' }] };
    const collision = { reviews: [
      { checkpointId: 'cp1', milestoneId: 'cp1', sequence: 1, checkpointCreatedAt: '2026-01-01T00:00:00Z', status: 'revise' },
      { checkpointId: 'cp2', milestoneId: 'cp1', revisesCheckpointId: 'cp1', sequence: 2, checkpointCreatedAt: '2026-01-02T00:00:00Z', status: 'accepted' }
    ] };
    const judged = buildFinalJudgement(contract, { rubric: [], automation: [] }, plan, { count: 2 }, collision, { dispatchStatus: 'completed' });
    assert.equal(judged.outcome, 'needs_revision', 'one review cannot cover two milestones');
    const malformed = { reviews: [
      { checkpointId: 'cp1', milestoneId: 'cp1', taskId: 't', sequence: 1, status: 'revise', phaseOnly: true, checkpointDigest: 'a'.repeat(64) },
      { checkpointId: 'cp2', milestoneId: 'cp1', taskId: 't', sequence: 2, status: 'accepted', verification: { commands: ['npm test'] },
        revisionCoverage: [{ checkpoint_id: 'cp1', checkpoint_sha256: 'a'.repeat(64), resolution: 'fixed', verification: ['npm test'] }] }
    ] };
    assert.doesNotThrow(() => buildFinalJudgement(contract, { rubric: [], automation: [] }, { checkpoints: [{ id: 'cp1' }] }, { count: 2 }, malformed, { dispatchStatus: 'completed' }));
  }

  // An unreadable gate checkpoint does not stop the queue.
  {
    const root = await mkdtemp(path.join(tmpdir(), 'loop-continuation-gate-')); roots.push(root);
    const gates = path.join(root, 'runtime/loops/regress/human-input/gates');
    await mkdir(gates, { recursive: true });
    await writeJson(path.join(gates, 'broken.json'), { gate_id: 'broken', status: 'waiting_for_human', task_id: 'ghost', checkpoint_id: 'cp1', project_id: 'p' });
    await mkdir(path.join(root, 'runtime/loops/regress/tasks/ghost/checkpoints'), { recursive: true });
    await writeFile(path.join(root, 'runtime/loops/regress/tasks/ghost/checkpoints/cp1.json'), '{"truncated');
    await enqueueTask(root, { queue: 'regress', title: 'healthy', task: 'Fix the login redirect bug.' });
    const result = await runQueueOnce(root, { queue: 'regress', dispatcher: 'true', checkpointPollMs: 0, progressHeartbeatMs: 0 });
    assert.equal(result.processed, true);
  }

  console.log('continuation regression self-test passed');
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
