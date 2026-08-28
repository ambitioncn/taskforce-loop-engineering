import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctorReport, enqueueTask, notifyHumanInputRequests, projectStatus, queueStatus, reconcileProjectGates, resolveHumanInput, routeLoopMessage, taskRuntimeDirFor, writeTaskContract } from '../lib/core.mjs';

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

// A project may keep its authoritative backlog exclusively in backlogSource.
// Requiring a duplicate embedded backlog makes the two copies drift and used
// to prevent project-status from reading an otherwise valid project ledger.
await writeFile(projectFile, `${JSON.stringify({
  ...spec,
  backlog: undefined,
  backlogSource: 'project/backlog.json',
  acceptanceLedger: 'project/acceptance-ledger.json',
  terminalContract: 'project/terminal.md'
}, null, 2)}\n`);
const externalOnly = await projectStatus(root, { project: 'openreel' });
assert.equal(externalOnly.backlog.file, 'project/backlog.json');
assert.equal(externalOnly.backlog.count, 1);
assert.equal(externalOnly.consistency.ok, true);

// When a project deliberately uses its terminal contract as the completion
// ledger, accepted terminal bytes must project accepted status and suppress
// optional post-completion authorization gates.
const terminalContractFile = path.join(root, 'project', 'terminal-contract.json');
await writeFile(terminalContractFile, `${JSON.stringify({
  status: 'accepted', terminalState: { accepted: true }, unmet: [], blockers: []
}, null, 2)}\n`);
await writeFile(projectFile, `${JSON.stringify({
  ...spec,
  backlog: undefined,
  backlogSource: 'project/backlog.json',
  acceptanceLedger: undefined,
  terminalContract: 'project/terminal-contract.json'
}, null, 2)}\n`);
const terminalOnly = await projectStatus(root, { project: 'openreel' });
assert.equal(terminalOnly.projectCompletion, 'accepted');
assert.equal(terminalOnly.authority.completionSource, 'terminal_contract');
await writeFile(projectFile, `${JSON.stringify({
  ...spec,
  backlogSource: 'project/backlog.json',
  acceptanceLedger: 'project/acceptance-ledger.json',
  terminalContract: 'project/terminal.md'
}, null, 2)}\n`);

// A ready milestone with project in progress and a deferred authorization is
// converted into a structured waiting gate, not left as prose on a done task.
const deferred = await enqueueTask(root, { queue, title: 'OpenReel deferred S-01', task: 'Project openreel S-01', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const deferredDir = path.join(taskRuntimeDirFor(root, queue, deferred.task.id), 'checkpoints');
await mkdir(deferredDir, { recursive: true });
await writeFile(path.join(deferredDir, 'cp-ready.json'), `${JSON.stringify({
  version: 1, task_id: deferred.task.id, checkpoint_id: 'cp-ready', milestone_id: 'S-01', requirement_ids: ['S-01'],
  status: 'ready_for_acceptance', blockers: [], verification: ['local phase passed'], risks: [],
  project_completion: { status: 'in_progress' },
  deferred_gates: [{
    id: 'S-01-production', action: 'production_rollback_drill',
    required_authority: 'Owner authorization for the exact production rollback drill scope.',
    authorization_state: 'missing', needed_when: 'now', materialize: true
  }]
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

// A conditional formal blocker becomes current when the producer explicitly
// marks it needed now and materialize=true. It must stop once, rather than be
// filtered into a needs_revision/project_in_progress polling loop.
const conditionalNow = await enqueueTask(root, { queue, title: 'OpenReel conditional blocker now', task: 'Wait for a real external precondition', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const conditionalNowDir = path.join(taskRuntimeDirFor(root, queue, conditionalNow.task.id), 'checkpoints');
await mkdir(conditionalNowDir, { recursive: true });
await writeFile(path.join(conditionalNowDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: conditionalNow.task.id, checkpoint_id: 'cp1', status: 'blocked',
  blockers: [{
    action: 'Run the authorized provider probe.', required_authority: 'Restore the required remote execution precondition.',
    authorization_state: 'conditional', needed_when: 'now', materialize: true
  }],
  deferred_gates: []
}, null, 2)}\n`);
const conditionalNowNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(conditionalNowNotice.results.find((item) => item.taskId === conditionalNow.task.id)?.outcome, 'sent');
await resolveHumanInput(root, { queue, gateId: `${conditionalNow.task.id}:cp1`, input: 'external precondition restored' });
await reconcileProjectGates(root, { queue });

// Authorization already granted or already consumed is audit context, not a
// new human-input request. A future boundary is likewise dormant.
for (const authorizationState of ['authorized', 'consumed', 'future']) {
  const stateTask = await enqueueTask(root, { queue, title: `OpenReel ${authorizationState} authority`, task: 'Continue within recorded authority', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
  const stateDir = path.join(taskRuntimeDirFor(root, queue, stateTask.task.id), 'checkpoints');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'cp1.json'), `${JSON.stringify({
    version: 1, task_id: stateTask.task.id, checkpoint_id: 'cp1', status: 'ready_for_acceptance', blockers: [],
    project_completion: { status: 'in_progress' },
    deferred_gates: [{
      action: 'Execute the bounded action.', required_authority: 'Recorded owner authority.',
      authorization_state: authorizationState, authority_ref: 'test-authority',
      needed_when: authorizationState === 'future' ? 'after_acceptance' : 'now'
    }]
  }, null, 2)}\n`);
  const stateNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
  assert.equal(stateNotice.results.some((item) => item.taskId === stateTask.task.id), false, `${authorizationState} authority must not create a waiting gate`);
}

// A checkpoint may bind an active subproject backlog. This prevents a global
// project ledger from hiding the safe next milestone.
await writeFile(authoritativeBacklog, `${JSON.stringify({ status: 'ongoing', items: [{ id: 'GLOBAL-01', status: 'accepted', dependsOn: [] }] }, null, 2)}\n`);
const subprojectBacklog = path.join(root, 'project', 'cdqi2-backlog.json');
await writeFile(subprojectBacklog, `${JSON.stringify({
  status: 'ongoing', items: [
    { id: 'CDQI2-10', status: 'accepted', dependsOn: [] },
    { id: 'CDQI2-11', status: 'in_progress', dependsOn: ['CDQI2-10'] }
  ]
}, null, 2)}\n`);
const subprojectTask = await enqueueTask(root, { queue, title: 'OpenReel CDQI2 actionable backlog', task: 'Continue CDQI2-11', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const subprojectDir = path.join(taskRuntimeDirFor(root, queue, subprojectTask.task.id), 'checkpoints');
await mkdir(subprojectDir, { recursive: true });
await writeFile(path.join(subprojectDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: subprojectTask.task.id, checkpoint_id: 'cp1', milestone_id: 'CDQI2-11',
  backlog_source: 'project/cdqi2-backlog.json', status: 'ready_for_acceptance', blockers: [],
  project_completion: { status: 'in_progress' },
  deferred_gates: [{ action: 'Publish after T11.', required_authority: 'Owner publication approval.' }]
}, null, 2)}\n`);
const subprojectNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(subprojectNotice.results.some((item) => item.taskId === subprojectTask.task.id), false, 'safe checkpoint-bound backlog must prevent waiting');

// A genuinely missing current authorization becomes a waiting gate once no
// safe project work remains.
await writeFile(authoritativeBacklog, `${JSON.stringify({ status: 'ongoing', items: [{ id: 'GLOBAL-01', status: 'accepted', dependsOn: [] }] }, null, 2)}\n`);
const missing = await enqueueTask(root, { queue, title: 'OpenReel missing current authority', task: 'Perform currently gated action', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const missingDir = path.join(taskRuntimeDirFor(root, queue, missing.task.id), 'checkpoints');
await mkdir(missingDir, { recursive: true });
await writeFile(path.join(missingDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: missing.task.id, checkpoint_id: 'cp1', status: 'ready_for_acceptance', blockers: [],
  project_completion: { status: 'in_progress' },
  deferred_gates: [{ action: 'Publish now.', required_authority: 'Owner publication approval.', authorization_state: 'missing', needed_when: 'now' }]
}, null, 2)}\n`);
const missingNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(missingNotice.results.find((item) => item.taskId === missing.task.id)?.outcome, 'sent');
await reconcileProjectGates(root, { queue });

// A formal blocker that merely restates an in-scope production sequence
// covered by the project standing authorization must not stop the queue.
await writeFile(projectFile, `${JSON.stringify({
  ...spec,
  backlogSource: 'project/backlog.json',
  acceptanceLedger: 'project/acceptance-ledger.json',
  terminalContract: 'project/terminal.md',
  actionPolicy: {
    deploy: 'standing_authorization_openreel_2026-08-19',
    productionConfig: 'standing_authorization_openreel_2026-08-19',
    backupRestoreRollbackRehearsal: 'standing_authorization_openreel_2026-08-19'
  }
}, null, 2)}\n`);
const coveredBlocker = await enqueueTask(root, { queue, title: 'OpenReel covered production blocker', task: 'Deploy accepted candidate', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
const coveredContract = await writeTaskContract(root, queue, coveredBlocker.task);
assert.equal(coveredContract.contract.constraints.project_authorization.production_authorized, true);
const coveredDir = path.join(taskRuntimeDirFor(root, queue, coveredBlocker.task.id), 'checkpoints');
await mkdir(coveredDir, { recursive: true });
await writeFile(path.join(coveredDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: coveredBlocker.task.id, checkpoint_id: 'cp1', status: 'needs_human_input',
  blockers: [{ action: 'Back up, deploy, restart, verify readiness and rehearse rollback on the established production target.', required_authority: 'Separate process-control confirmation.' }],
  verification: ['candidate accepted'], risks: [], project_completion: { status: 'in_progress' }
}, null, 2)}\n`);
const coveredNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(coveredNotice.results.some((item) => item.taskId === coveredBlocker.task.id), false, 'standing-authorized production blocker must not create a gate');

// Explicitly authorized blocker metadata is also non-materializable, while a
// genuinely missing publication permission remains a human gate.
const publication = await enqueueTask(root, { queue, title: 'OpenReel publication blocker', task: 'Publish candidate', projectId: 'openreel', sourceChannel: 'test', sourceTarget: 'owner' });
await writeTaskContract(root, queue, publication.task);
const publicationDir = path.join(taskRuntimeDirFor(root, queue, publication.task.id), 'checkpoints');
await mkdir(publicationDir, { recursive: true });
await writeFile(path.join(publicationDir, 'cp1.json'), `${JSON.stringify({
  version: 1, task_id: publication.task.id, checkpoint_id: 'cp1', status: 'needs_human_input',
  blockers: [{ action: 'Publish externally now.', required_authority: 'Owner publication confirmation.', authorization_state: 'missing', needed_when: 'now' }],
  verification: ['candidate ready'], risks: [], project_completion: { status: 'in_progress' }
}, null, 2)}\n`);
const publicationNotice = await notifyHumanInputRequests(root, { queue, notifyCommand: '/bin/true' });
assert.equal(publicationNotice.results.find((item) => item.taskId === publication.task.id)?.outcome, 'sent', 'missing publication authority must create a gate');
await resolveHumanInput(root, { queue, gateId: `${publication.task.id}:cp1`, input: 'test resolution' });
await reconcileProjectGates(root, { queue });

// Once the authoritative project ledger accepts the terminal contract, an
// optional post-completion deferred action stays in operations backlog and
// neither creates nor retains a project-queue waiting gate.
await writeFile(authoritativeLedger, `${JSON.stringify({ status: 'accepted', unmet: [], blockers: [] }, null, 2)}\n`);
await reconcileProjectGates(root, { queue });
assert.equal((await queueStatus(root, queue)).waiting, 0);
assert.equal(JSON.parse(await readFile(path.join(root, deferredResult.ledger), 'utf8')).status, 'superseded');
const legacyTerminal = await enqueueTask(root, { queue, title: 'Legacy accepted-project gate', task: 'Project openreel terminal bookkeeping', projectId: 'openreel' });
const legacyCheckpointDir = path.join(taskRuntimeDirFor(root, queue, legacyTerminal.task.id), 'checkpoints');
await mkdir(legacyCheckpointDir, { recursive: true });
await writeFile(path.join(legacyCheckpointDir, 'cp-terminal.json'), `${JSON.stringify({ checkpoint_id: 'cp-terminal', status: 'ready_for_acceptance', blockers: [] }, null, 2)}\n`);
const legacyGateId = `${legacyTerminal.task.id}:cp-terminal`;
const legacyGateFile = path.join(root, 'runtime', 'loops', queue, 'human-input', 'gates', `${legacyTerminal.task.id}.cp-terminal.json`);
await writeFile(legacyGateFile, `${JSON.stringify({
  gate_id: legacyGateId, task_id: legacyTerminal.task.id, checkpoint_id: 'cp-terminal', project_id: 'openreel',
  requirement_ids: [], contract_hash: 'legacy', gate_kind: 'deferred_authorization', status: 'waiting_for_human'
}, null, 2)}\n`);
const legacyInbox = path.join(root, legacyTerminal.file);
const legacyWaiting = path.join(root, 'runtime', 'loops', queue, 'waiting', path.basename(legacyTerminal.file));
await writeFile(legacyWaiting, `${JSON.stringify({ ...legacyTerminal.task, status: 'waiting_for_human', waitingGateId: legacyGateId }, null, 2)}\n`);
await rename(legacyInbox, `${legacyInbox}.moved`);
await reconcileProjectGates(root, { queue });
assert.equal((await queueStatus(root, queue)).done >= 1, true, 'accepted project task must close in done, not canceled');
assert.equal(JSON.parse(await readFile(legacyGateFile, 'utf8')).status, 'superseded');
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

console.log(JSON.stringify({ status: 'ok', assertions: ['standing project authorization reaches task contract', 'structured gate context', 'B-01 waiting to zero', 'project-isolated supersede', 'doctor strong validation', 'authoritative ledger drift', 'ready milestone deferred gate', 'future gate does not stop safe actionable backlog', 'conditional policy prose does not create a gate', 'authorized and consumed authority do not create gates', 'checkpoint-bound subproject backlog remains actionable', 'missing current authority creates a gate', 'standing-authorized production blocker does not create a gate', 'missing publication blocker creates a gate', 'accepted project optional deferred gate stays out of queue'] }));
