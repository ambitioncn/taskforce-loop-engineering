import assert from 'node:assert/strict';
import { buildFinalJudgement, dispatchFailureClassification, selectEffectiveAcceptanceReviews } from '../lib/core.mjs';

const basePlan = { rubric: [], automation: [] };
const baseContract = { task_id: 't1', risk_level: 'L1', requires_human_gate: false, task_scope: 'scoped_task' };

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
