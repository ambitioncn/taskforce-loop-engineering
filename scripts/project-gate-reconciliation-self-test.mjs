import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctorReport, enqueueTask, notifyHumanInputRequests, projectStatus, queueStatus, reconcileProjectGates, routeLoopMessage, taskRuntimeDirFor, writeTaskContract } from '../lib/core.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'loop-project-gates-'));
const queue = 'shared';
const projectFile = path.join(root, 'configs', 'loops', 'projects', 'openreel.json');
const spec = { schemaVersion: 1, project: 'openreel', type: 'code_project', queues: [{ queue, kind: 'standard' }], backlog: [
  { id: 'B-01', required: true, status: 'human_gated', dependsOn: [] },
  { id: 'S-01', required: true, status: 'human_gated', dependsOn: [] }
] };
await mkdir(path.dirname(projectFile), { recursive: true });
await writeFile(projectFile, `${JSON.stringify(spec, null, 2)}\n`);

// A project standing authorization must reach the generated task contract.
// It authorizes only the configured in-scope production and bounded paid
// actions; unrelated external, destructive, credential, push and publish
// actions remain blocked.
await writeFile(projectFile, `${JSON.stringify({
  ...spec,
  actionPolicy: {
    deploy: 'standing_authorization_openreel_2026-08-19',
    productionConfig: 'standing_authorization_openreel_2026-08-19',
    backupRestoreRollbackRehearsal: 'standing_authorization_openreel_2026-08-19',
    paidActionPerActionCnyLimit: 100,
    externalWrites: 'human_confirm',
    destructiveActions: 'human_confirm'
  }
}, null, 2)}\n`);
const authorizedTask = await enqueueTask(root, { queue, title: 'OpenReel production acceptance', task: 'Continue project openreel production acceptance under its action policy', projectId: 'openreel' });
const authorizedContract = (await writeTaskContract(root, queue, authorizedTask.task)).contract;
assert.equal(authorizedContract.constraints.project_authorization.project, 'openreel');
assert.equal(authorizedContract.constraints.project_authorization.production_authorized, true);
assert.equal(authorizedContract.constraints.project_authorization.paid_action_per_action_cny_limit, 100);
assert.equal(authorizedContract.constraints.blocked_actions.includes('production_config_change_without_explicit_confirmation'), false);
assert(authorizedContract.constraints.allowed_actions.includes('in_scope_production_deploy_config_backup_restore_rollback_under_standing_authorization'));
assert(authorizedContract.constraints.allowed_actions.includes('paid_provider_action_with_existing_credentials_within_per_action_cny_limit'));
assert(authorizedContract.constraints.blocked_actions.includes('credential_change_without_explicit_confirmation'));
await writeFile(projectFile, `${JSON.stringify(spec, null, 2)}\n`);

const b = await enqueueTask(root, { queue, title: 'OpenReel B-01', task: 'Project openreel requirement B-01', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const checkpointDir = path.join(taskRuntimeDirFor(root, queue, b.task.id), 'checkpoints');
await mkdir(checkpointDir, { recursive: true });
await writeFile(path.join(checkpointDir, 'cp1.json'), `${JSON.stringify({ version: 1, task_id: b.task.id, checkpoint_id: 'cp1', milestone_id: 'B-01', requirement_ids: ['B-01'], status: 'needs_human_input', blockers: ['Authorize B-01'] }, null, 2)}\n`);
const notified = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(notified.sent, 1);
assert.equal((await queueStatus(root, queue)).waiting, 1);
const gateFile = path.join(root, notified.results[0].ledger);
const gate = JSON.parse(await readFile(gateFile, 'utf8'));
assert.equal(gate.project_id, 'openreel');
assert.equal(gate.milestone_id, 'B-01');
assert.deepEqual(gate.requirement_ids, ['B-01']);
assert.equal(typeof gate.contract_hash, 'string');

spec.backlog[0] = { ...spec.backlog[0], required: false, status: 'out_of_scope', disposition: 'canceled_by_owner' };
await writeFile(projectFile, `${JSON.stringify(spec, null, 2)}\n`);
const status = await queueStatus(root, queue);
assert.equal(status.waiting, 0, 'B-01 waiting gate must disappear after B-01 leaves project scope');
assert.equal(status.canceled, 1);
assert.equal(JSON.parse(await readFile(gateFile, 'utf8')).status, 'canceled');

const other = await enqueueTask(root, { queue, title: 'Other project task', task: 'Project other', projectId: 'other' });
const openreel = await enqueueTask(root, { queue, title: 'OpenReel target', task: 'Project openreel', projectId: 'openreel' });
await rename(path.join(root, other.file), path.join(root, 'runtime', 'loops', queue, 'active', path.basename(other.file)));
await rename(path.join(root, openreel.file), path.join(root, 'runtime', 'loops', queue, 'active', path.basename(openreel.file)));
const replacement = await routeLoopMessage(root, { route: true, confirmExecute: true, supersedeActive: true, queue, message: '走 loop：继续 openreel 项目' });
assert.equal(replacement.supersededTaskId, openreel.task.id);
assert.equal(await readFile(path.join(taskRuntimeDirFor(root, queue, other.task.id), 'supersede_request.json'), 'utf8').then(() => true, () => false), false);

const invalidGate = { ...gate, gate_id: `${openreel.task.id}:bad`, task_id: openreel.task.id, checkpoint_id: 'bad', status: 'waiting_for_human', requirement_ids: ['MISSING'] };
const invalidFile = path.join(root, 'runtime', 'loops', queue, 'human-input', 'gates', `${openreel.task.id}.bad.json`);
await writeFile(invalidFile, `${JSON.stringify(invalidGate, null, 2)}\n`);
const doctor = await doctorReport(root);
assert.equal(doctor.ok, false);
assert(doctor.checks.some((check) => check.id === `human-gate:${invalidGate.gate_id}` && !check.ok));
await reconcileProjectGates(root, { queue });

// project-status treats the configured ledger/backlog as authoritative and
// exposes registry drift instead of silently reporting stale completion data.
const authoritativeBacklog = path.join(root, 'project', 'backlog.json');
const authoritativeLedger = path.join(root, 'project', 'acceptance-ledger.json');
await mkdir(path.dirname(authoritativeBacklog), { recursive: true });
await writeFile(authoritativeBacklog, `${JSON.stringify({ status: 'ongoing', items: [{ id: 'S-01', required: true, status: 'accepted' }] }, null, 2)}\n`);
await writeFile(authoritativeLedger, `${JSON.stringify({ status: 'ongoing', unmet: ['S-01'], blockers: [{ id: 'S-01' }] }, null, 2)}\n`);
await writeFile(projectFile, `${JSON.stringify({ ...spec, backlogSource: 'project/backlog.json', acceptanceLedger: 'project/acceptance-ledger.json', terminalContract: 'project/terminal.md' }, null, 2)}\n`);
const drifted = await projectStatus(root, { project: 'openreel' });
assert.equal(drifted.projectCompletion, 'in_progress');
assert.equal(drifted.authority.acceptanceLedger, 'project/acceptance-ledger.json');
assert.equal(drifted.consistency.ok, false);
assert(drifted.needsAttention.includes('authoritative_source_drift'));

// A ready milestone with project in progress and a deferred authorization is
// converted into a structured waiting gate, not left as prose on a done task.
const deferred = await enqueueTask(root, { queue, title: 'OpenReel deferred S-01', task: 'Project openreel S-01', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const deferredDir = path.join(taskRuntimeDirFor(root, queue, deferred.task.id), 'checkpoints');
await mkdir(deferredDir, { recursive: true });
await writeFile(path.join(deferredDir, 'cp-ready.json'), `${JSON.stringify({
  version: 1, task_id: deferred.task.id, checkpoint_id: 'cp-ready', milestone_id: 'S-01', requirement_ids: ['S-01'],
  status: 'ready_for_acceptance', blockers: [], verification: ['local phase passed'], risks: [],
  project_completion: { status: 'in_progress' },
  deferred_gates: [{ id: 'S-01-production', action: 'production_rollback_drill', required_authority: 'Owner authorization for the exact production rollback drill scope.' }]
}, null, 2)}\n`);
const deferredNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
const deferredResult = deferredNotice.results.find((item) => item.taskId === deferred.task.id);
assert.equal(deferredResult.outcome, 'sent');
const deferredGate = JSON.parse(await readFile(path.join(root, deferredResult.ledger), 'utf8'));
assert.equal(deferredGate.gate_kind, 'deferred_authorization');
assert.equal(deferredGate.authorization_requirements[0].action, 'production_rollback_drill');
assert.match(deferredGate.authorization_requirements[0].required_authority, /Owner authorization/);
assert.equal((await queueStatus(root, queue)).waiting >= 1, true);

// A future authorization must not stop the project while an unrelated safe
// backlog item remains actionable.
await reconcileProjectGates(root, { queue });
await writeFile(authoritativeBacklog, `${JSON.stringify({
  status: 'ongoing',
  items: [
    { id: 'LOCAL-01', status: 'phase_complete', dependsOn: [] },
    { id: 'LOCAL-02', status: 'pending', dependsOn: ['LOCAL-01'] }
  ]
}, null, 2)}\n`);
const futureGateTask = await enqueueTask(root, { queue, title: 'OpenReel future production gate', task: 'Continue safe local backlog', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const futureGateDir = path.join(taskRuntimeDirFor(root, queue, futureGateTask.task.id), 'checkpoints');
await mkdir(futureGateDir, { recursive: true });
await writeFile(path.join(futureGateDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: futureGateTask.task.id, checkpoint_id: 'cp1', status: 'ready_for_acceptance', blockers: [],
  project_completion: { status: 'in_progress' }, next_action: 'Implement LOCAL-02 locally.',
  deferred_gates: [{ id: 'production-later', action: 'production_deploy', required_authority: 'Owner authorization after local candidate acceptance.' }]
}, null, 2)}\n`);
const futureNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(futureNotice.results.some((item) => item.taskId === futureGateTask.task.id), false);
assert.equal((await queueStatus(root, queue)).waiting, 0);

// Conditional policy boundaries are not current blockers. Plain prose in
// deferred_gates must not materialize a gate without a concrete action and
// authority requirement.
await reconcileProjectGates(root, { queue });
const conditional = await enqueueTask(root, { queue, title: 'OpenReel conditional policy boundary', task: 'Continue safe OpenReel backlog', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const conditionalDir = path.join(taskRuntimeDirFor(root, queue, conditional.task.id), 'checkpoints');
await mkdir(conditionalDir, { recursive: true });
await writeFile(path.join(conditionalDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: conditional.task.id, checkpoint_id: 'cp1', status: 'ready_for_acceptance', blockers: [],
  project_completion: { status: 'in_progress' },
  deferred_gates: ['Any future paid action above the standing limit requires confirmation.']
}, null, 2)}\n`);
const conditionalNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(conditionalNotice.results.some((item) => item.taskId === conditional.task.id), false);

// Once the authoritative project ledger accepts the terminal contract, an
// optional post-completion deferred action stays in operations backlog and
// neither creates nor retains a project-queue waiting gate.
await writeFile(authoritativeLedger, `${JSON.stringify({ status: 'accepted', unmet: [], blockers: [] }, null, 2)}\n`);
await reconcileProjectGates(root, { queue });
assert.equal((await queueStatus(root, queue)).waiting, 0);
assert.equal(JSON.parse(await readFile(path.join(root, deferredResult.ledger), 'utf8')).status, 'superseded');
const acceptedOptional = await enqueueTask(root, { queue, title: 'OpenReel optional operations transfer', task: 'Project openreel optional post-completion transfer', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const acceptedOptionalDir = path.join(taskRuntimeDirFor(root, queue, acceptedOptional.task.id), 'checkpoints');
await mkdir(acceptedOptionalDir, { recursive: true });
await writeFile(path.join(acceptedOptionalDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: acceptedOptional.task.id, checkpoint_id: 'cp1', milestone_id: 'cp1',
  status: 'ready_for_acceptance', blockers: [], project_completion: { status: 'accepted' },
  deferred_gates: [{ id: 'optional-transfer', required_authority: 'Separate authorization for optional production transfer.' }]
}, null, 2)}\n`);
const acceptedNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(acceptedNotice.results.some((item) => item.taskId === acceptedOptional.task.id), false);
assert.equal((await queueStatus(root, queue)).waiting, 0);

console.log(JSON.stringify({ status: 'ok', assertions: ['standing project authorization reaches task contract', 'structured gate context', 'B-01 waiting to zero', 'project-isolated supersede', 'doctor strong validation', 'authoritative ledger drift', 'ready milestone deferred gate', 'future gate does not stop safe actionable backlog', 'conditional policy prose does not create a gate', 'accepted project optional deferred gate stays out of queue'] }));
