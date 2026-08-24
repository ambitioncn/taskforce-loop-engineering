import assert from 'node:assert/strict';
import { buildFinalJudgement, dispatchFailureClassification, inferTaskScope, selectEffectiveAcceptanceReviews } from '../lib/core.mjs';

const basePlan = { rubric: [], automation: [] };
const baseContract = { task_id: 't1', risk_level: 'L1', requires_human_gate: false, task_scope: 'scoped_task' };

assert.equal(inferTaskScope({ body: '开发完整项目并完成整体目标' }), 'project');
assert.equal(inferTaskScope({ body: '继续同一整体项目，仅推进 T-01 第 2 项；阶段完成后不能称整体项目完成' }), 'scoped_task');
assert.equal(inferTaskScope({ body: 'Continue the project, only complete boundary item 2' }), 'scoped_task');
assert.equal(inferTaskScope({ body: '继续同一整体项目，取消团队功能并从项目完成门槛中移除，其他 backlog 不变' }), 'scoped_task');
assert.equal(inferTaskScope({ body: 'Continue the overall project with a product-scope amendment: remove the team feature from the completion gate.' }), 'scoped_task');

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = {
    reviews: [
      { checkpointId: 'cp1', sequence: 1, status: 'blocked' },
      { checkpointId: 'cp2', sequence: 2, status: 'accepted' },
      { checkpointId: 'cp10', sequence: 10, status: 'accepted' }
    ]
  };
  assert.equal(selectEffectiveAcceptanceReviews(devPlan, reviews)[0].checkpointId, 'cp10');
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = {
    reviews: [
      // Acceptance reviews are regenerated in filename traversal order. A
      // legacy cp9 review can consequently have a later review timestamp than
      // the real latest cp46 checkpoint; that timestamp must not win.
      { checkpointId: 'cp46', sequence: 9, createdAt: '2026-08-07T18:27:18.990Z', status: 'blocked' },
      { checkpointId: 'cp9', sequence: 1, createdAt: '2026-08-07T18:27:18.992Z', status: 'accepted' }
    ]
  };
  assert.equal(selectEffectiveAcceptanceReviews(devPlan, reviews)[0].checkpointId, 'cp46');
}

{
  const classification = dispatchFailureClassification({
    exitCode: 1,
    timedOut: false,
    stderr: 'CLI transcript compaction failed: Compaction timed out',
    stdout: ''
  });
  assert.equal(classification.category, 'compaction_timeout');
  assert.equal(classification.recoverableRuntime, true);
}

{
  const classification = dispatchFailureClassification({
    exitCode: 0,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({
      replayInvalid: true,
      livenessState: 'abandoned',
      error: {
        kind: 'incomplete_turn',
        message: 'Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.'
      }
    }, null, 2)
  });
  assert.equal(classification.category, 'incomplete_turn');
  assert.equal(classification.recoverableRuntime, true);
  assert.equal(classification.requiresHumanAction, false);
}

{
  const classification = dispatchFailureClassification({
    exitCode: 0,
    timedOut: false,
    stderr: '',
    stdout: JSON.stringify({ livenessState: 'working', completion: { stopReason: 'stop' } })
  });
  assert.equal(classification.category, 'ok');
  assert.equal(classification.recoverableRuntime, undefined);
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = { reviews: [{ checkpointId: 'cp38', sequence: 38, status: 'accepted', projectCompletion: { status: 'in_progress' } }] };
  const judgement = buildFinalJudgement(
    { ...baseContract, task_scope: 'project' },
    basePlan,
    devPlan,
    { count: 38 },
    reviews,
    {
      dispatchStatus: 'runtime_interrupted',
      dispatchFailureClassification: { category: 'compaction_timeout', recoverableRuntime: true }
    }
  );
  assert.equal(judgement.outcome, 'runtime_interrupted');
  assert.equal(judgement.reasons.some((reason) => reason.includes('development')), false);
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = {
    reviews: [
      { checkpointId: 'cp5', milestoneId: 'G-01-retry', sequence: 5, createdAt: '2026-08-07T04:00:00.000Z', status: 'accepted' },
      { checkpointId: 'cp14', milestoneId: 'G-01-auth', sequence: 3, createdAt: '2026-08-07T12:00:00.000Z', status: 'blocked' }
    ]
  };
  assert.equal(selectEffectiveAcceptanceReviews(devPlan, reviews)[0].checkpointId, 'cp14');
}

{
  const devPlan = { checkpoints: [{ id: 'design' }, { id: 'verify' }] };
  const reviews = {
    reviews: [
      { checkpointId: 'design', milestoneId: 'design', sequence: 1, status: 'accepted' },
      { checkpointId: 'verify-v1', milestoneId: 'verify', sequence: 2, status: 'blocked' },
      { checkpointId: 'verify-v2', milestoneId: 'verify', sequence: 3, status: 'accepted' }
    ]
  };
  assert.deepEqual(selectEffectiveAcceptanceReviews(devPlan, reviews).map((review) => review.checkpointId), ['design', 'verify-v2']);
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = { reviews: [{ checkpointId: 'cp5', sequence: 5, status: 'accepted', projectCompletion: { status: 'in_progress' } }] };
  const judgement = buildFinalJudgement(
    { ...baseContract, task_scope: 'project' },
    basePlan,
    devPlan,
    { count: 5 },
    reviews,
    { dispatchStatus: 'completed' }
  );
  assert.equal(judgement.outcome, 'project_in_progress');
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = { reviews: [{
    checkpointId: 'cp1', sequence: 1, status: 'accepted',
    projectCompletion: { status: 'in_progress' },
    deferredGates: [{ id: 'deploy', required_authority: 'owner deployment approval' }]
  }] };
  const judgement = buildFinalJudgement(baseContract, basePlan, devPlan, { count: 1 }, reviews, { dispatchStatus: 'completed' });
  assert.equal(judgement.outcome, 'project_in_progress');
  assert.equal(judgement.coverage.deferred_gates, 1);
  assert.match(judgement.reasons.join(' '), /structured|waiting gates/);
}

{
  const devPlan = { checkpoints: [{ id: 'cp1' }] };
  const reviews = { reviews: [{ checkpointId: 'cp6', sequence: 6, status: 'accepted', projectCompletion: { status: 'accepted' } }] };
  const judgement = buildFinalJudgement(
    { ...baseContract, task_scope: 'project' },
    basePlan,
    devPlan,
    { count: 6 },
    reviews,
    { dispatchStatus: 'completed' }
  );
  assert.equal(judgement.outcome, 'ready_to_apply');
}

console.log('final judgement self-test passed');
