import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appendFile, utimes as touch } from 'node:fs/promises';
import { claimAction, reserveAction, settleAction } from '../lib/action-reservations.mjs';
import { DurableJournal } from '../lib/durable-journal.mjs';
import { TransactionalStateKernel } from '../lib/transactional-state-kernel.mjs';
import { enqueueTask, ensureQueueDirs, queueCancel, queueRequeue, runCommand, runQueueOnce, queueStatus } from '../lib/core.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/loop-engineering.mjs', import.meta.url));
const loop = (root, ...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { cwd: root, encoding: 'utf8' });
const loopJson = (root, ...args) => {
  const result = loop(root, ...args, '--json');
  assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
};
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};
const roots = [];
const tempRoot = async (name) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `loop-safety-${name}-`));
  roots.push(root);
  return root;
};

try {
  // --task-id must never resolve outside the queue directories.
  {
    const parent = await tempRoot('traversal');
    const root = path.join(parent, 'ws');
    await writeJson(path.join(parent, 'outside', 'secret.json'), { keep: true });
    await mkdir(root, { recursive: true });
    for (const command of ['queue-cancel', 'queue-requeue']) {
      const result = loop(root, command, '--queue', 'q', '--task-id', '../../../../../outside/secret');
      assert.notEqual(result.status, 0, `${command} rejects a traversing task id`);
      assert.match(result.stderr, /Invalid task id/);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, 'outside', 'secret.json'), 'utf8')), { keep: true });
  }

  // A human gate for a task outside any project survives read-only status.
  {
    const root = await tempRoot('gate');
    loop(root, 'queue-init', '--queue', 'q');
    const queueDir = path.join(root, 'runtime/loops/q');
    await writeJson(path.join(queueDir, 'failed', 't1.json'), { version: 1, id: 't1', queue: 'q', title: 'Deploy fix', body: 'needs approval',
      status: 'needs_human_input', source: { channel: 'slack', target: 'C1', account: 'acct' } });
    await writeJson(path.join(queueDir, 'tasks', 't1', 'checkpoints', 'cp1.json'),
      { checkpoint_id: 'cp1', sequence: 1, status: 'needs_human_input', blockers: ['Need the production API key'] });
    const notified = loop(root, 'queue-human-input-notify', '--queue', 'q', '--notify-command', 'true', '--json');
    assert.equal(notified.status, 0, notified.stderr);
    assert.deepEqual(await readdir(path.join(queueDir, 'waiting')), ['t1.json']);
    for (const args of [['queue-status', '--queue', 'q'], ['queue-status', '--queue', 'q', '--json']]) {
      assert.equal(loop(root, ...args).status, 0);
      assert.deepEqual(await readdir(path.join(queueDir, 'waiting')), ['t1.json'], 'a non-project gate is not superseded by status');
      assert.deepEqual(await readdir(path.join(queueDir, 'canceled')), []);
    }
  }

  // A code-queue export is complete, and a dirty worktree is force-removed
  // only while it still matches that export.
  {
    const root = await tempRoot('export');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.email', 'loop@example.invalid'); git('config', 'user.name', 'loop');
    for (const index of [1, 2, 3]) await writeFile(path.join(root, `big${index}.txt`), `${Array.from({ length: 20000 }, (_, i) => i).join('\n')}\n`);
    await writeFile(path.join(root, 'small.txt'), 'hi\n');
    await writeFile(path.join(root, '.gitignore'), 'runtime/\nconfigs/\n');
    git('add', '-A'); git('commit', '-qm', 'init');
    loop(root, 'code-queue-init', '--queue', 'cq');
    const configFile = path.join(root, 'configs/loops/queues/cq.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.worktree.verifyCommands = [];
    delete config.preflightConfig;
    await writeJson(configFile, config);
    loop(root, 'enqueue', '--queue', 'cq', '--title', 'Change', '--task', 'do it');
    loop(root, 'run-queue', '--queue', 'cq', '--config', 'configs/loops/queues/cq.json',
      '--dispatcher', 'sed -i s/^/X/ big1.txt big2.txt big3.txt; echo changed >> small.txt; echo 新文件 > NEW_FILE.txt');
    const queueDir = path.join(root, 'runtime/loops/cq');
    const taskId = [...await readdir(path.join(queueDir, 'done')), ...await readdir(path.join(queueDir, 'failed'))][0].replace(/\.json$/, '');

    const exported = loopJson(root, 'code-worktree-export', '--queue', 'cq', '--task-id', taskId);
    assert.equal(exported.complete, true);
    assert.equal(exported.untrackedIncluded, 1);
    const patch = await readFile(path.join(root, exported.patchFile), 'utf8');
    assert.equal((patch.match(/^diff --git /gm) ?? []).length, 5, 'every tracked edit and the new file are exported');
    assert.equal(loopJson(root, 'code-patch-verify', '--patch', exported.patchFile).status, 'applies');

    loopJson(root, 'code-review-bundle', '--queue', 'cq', '--task-id', taskId);
    const worktreeDir = path.join(root, exported.worktree.path);
    await writeFile(path.join(worktreeDir, 'LATE_EDIT.txt'), 'written after export\n');
    let cleanup = loopJson(root, 'code-worktree-cleanup', '--queue', 'cq', '--confirm-cleanup');
    assert.equal(JSON.stringify(cleanup).includes('dirty_worktree_changed_since_export'), true, 'edits after export block cleanup');
    assert.equal((await readdir(worktreeDir)).includes('LATE_EDIT.txt'), true);

    await rm(path.join(worktreeDir, 'LATE_EDIT.txt'));
    const manifestFile = path.join(root, `${exported.patchFile}.json`);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeJson(manifestFile, { ...manifest, complete: undefined, contentSha256: undefined });
    cleanup = loopJson(root, 'code-worktree-cleanup', '--queue', 'cq', '--confirm-cleanup');
    assert.equal(JSON.stringify(cleanup).includes('dirty_export_incomplete_reexport_required'), true, 'a legacy export blocks cleanup');

    await writeJson(manifestFile, manifest);
    cleanup = loopJson(root, 'code-worktree-cleanup', '--queue', 'cq', '--confirm-cleanup');
    assert.equal(cleanup.removedWorktrees.length, 1, 'an unchanged, completely exported worktree is removed');
    const applied = loopJson(root, 'code-patch-apply', '--patch', exported.patchFile, '--confirm-apply');
    assert.equal(applied.applied, true);
    assert.equal(await readFile(path.join(root, 'NEW_FILE.txt'), 'utf8'), '新文件\n', 'the exported new file round-trips');
    assert.equal((await readFile(path.join(root, 'big3.txt'), 'utf8')).startsWith('X0\n'), true, 'edits before the truncation window survive');
    assert.equal((await readFile(path.join(root, 'NEW_FILE.txt'), 'utf8')), '新文件\n', 'the exported new file round-trips');
  }
  // Queue engine crash safety and exactly-once execution.
  {
    const spawnFailure = await runCommand('echo hi', { cwd: '/nonexistent-loop-dir' });
    assert.equal(spawnFailure.exitCode, 127, 'a spawn failure is a failed command, not a crash');
    assert.equal((await runCommand('echo \0')).exitCode, 127);

    const root = await tempRoot('queue');
    const queue = 'q';
    const queueDir = path.join(root, 'runtime/loops', queue);
    await ensureQueueDirs(root, queue);
    const log = path.join(root, 'exec.log');
    const list = async (subdir) => (await readdir(path.join(queueDir, subdir))).filter((name) => name.endsWith('.json')).sort();
    const executions = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);

    // Concurrent enqueues with the same (non-ASCII) title never overwrite.
    const enqueued = await Promise.all(Array.from({ length: 6 }, () => enqueueTask(root, { queue, title: '部署', task: 'x' })));
    assert.equal(new Set(enqueued.map((entry) => entry.task.id)).size, 6);
    assert.equal((await list('inbox')).length, 6);
    for (const name of await list('inbox')) await rm(path.join(queueDir, 'inbox', name));

    // A truncated queued task is quarantined instead of blocking the queue.
    await writeFile(path.join(queueDir, 'inbox', '0000_partial.json'), '{"id":"0000_par');
    const good = await enqueueTask(root, { queue, title: 'good', task: 'x' });
    let result = await runQueueOnce(root, { queue, dispatcher: `echo "$LOOP_TASK_ID" >> ${JSON.stringify(log)}` });
    assert.equal(result.processed, true);
    assert.deepEqual(await executions(), [good.task.id]);
    assert.equal((await readdir(path.join(queueDir, 'quarantine'))).some((name) => name.endsWith('0000_partial.json')), true);

    // An empty lock is respected while fresh and reclaimed once stale.
    const lockFile = path.join(queueDir, 'queue.lock');
    await writeFile(lockFile, '');
    await enqueueTask(root, { queue, title: 'after-lock', task: 'x' });
    assert.equal((await runQueueOnce(root, { queue, dispatcher: 'true' })).status, 'locked');
    const old = new Date(Date.now() - 120000);
    await utimes(lockFile, old, old);
    assert.equal((await runQueueOnce(root, { queue, dispatcher: 'true' })).processed, true, 'a stale unreadable lock is reclaimed');

    // A stale active copy of a finished task is quarantined, not re-run, and
    // a task that keeps crashing its runner stops being recovered.
    const finished = (await list('failed'))[0] ?? (await list('done'))[0];
    const finishedDir = (await list('failed')).includes(finished) ? 'failed' : 'done';
    await writeFile(path.join(queueDir, 'active', finished), await readFile(path.join(queueDir, finishedDir, finished)));
    await writeFile(path.join(queueDir, 'active', 'crashy.json'), JSON.stringify({ version: 1, id: 'crashy', queue, title: 'crashy', body: 'x', status: 'active', orphanRecoveryCount: 3 }));
    result = await runQueueOnce(root, { queue, dispatcher: `echo "$LOOP_TASK_ID" >> ${JSON.stringify(log)}` });
    assert.deepEqual(result.orphanRecovered.map((entry) => entry.outcome).sort(), ['orphan_recovery_exhausted', 'quarantined_duplicate']);
    assert.equal((await executions()).includes('crashy'), false);
    assert.equal((await list('failed')).includes('crashy.json'), true);

    // The lease is renewed while a dispatch outlasts leaseMs, so a second
    // runner cannot reclaim the lock and execute the same task again.
    const slow = await enqueueTask(root, { queue, title: 'slow', task: 'x' });
    const first = runQueueOnce(root, { queue, leaseMs: 300, dispatcher: `echo "$LOOP_TASK_ID" >> ${JSON.stringify(log)}; sleep 1.5` });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal((await runQueueOnce(root, { queue, leaseMs: 300, dispatcher: `echo "$LOOP_TASK_ID" >> ${JSON.stringify(log)}` })).status, 'locked');
    await first;
    assert.equal((await executions()).filter((id) => id === slow.task.id).length, 1);

    // Canceling an active task stops its dispatcher and leaves one copy.
    const victim = await enqueueTask(root, { queue, title: 'victim', task: 'x' });
    const running = runQueueOnce(root, { queue, dispatcher: `sleep 1.5; echo "$LOOP_TASK_ID finished" >> ${JSON.stringify(log)}` });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await queueCancel(root, queue, victim.task.id, { includeActive: true, reason: 'test' });
    const canceledRun = await running;
    assert.equal((await executions()).includes(`${victim.task.id} finished`), false, 'the dispatcher was stopped');
    assert.equal(canceledRun.run?.movedByOperator ?? JSON.parse(await readFile(path.join(root, canceledRun.runPath), 'utf8')).movedByOperator, true);
    assert.deepEqual([...await list('done'), ...await list('failed')].filter((name) => name.startsWith(victim.task.id)), []);
    assert.equal(JSON.parse(await readFile(path.join(queueDir, 'canceled', `${victim.task.id}.json`), 'utf8')).cancelReason, 'test');

    // Its stop marker must not supersede the task again after a requeue.
    await queueRequeue(root, queue, victim.task.id, { from: 'canceled' });
    await runQueueOnce(root, { queue, dispatcher: `echo "$LOOP_TASK_ID rerun" >> ${JSON.stringify(log)}` });
    assert.equal((await executions()).includes(`${victim.task.id} rerun`), true, 'a requeued task runs despite an old stop marker');
    assert.equal((await queueStatus(root, queue)).active, 0);
  }

  // Control-plane primitives: one idempotency key, one request; fenced and
  // zero-or-one kernel effects; a journal that survives torn and concurrent
  // appends.
  {
    const root = await tempRoot('primitives');
    for (let trial = 0; trial < 10; trial += 1) {
      const key = `charge:${trial}`;
      // A mutex left behind by a crashed process is what several waiters
      // used to break simultaneously.
      const crashedLock = path.join(root, 'runtime/loops/action-reservations', `${createHash('sha256').update(key).digest('hex')}.lock`);
      await mkdir(crashedLock, { recursive: true });
      const old = new Date(Date.now() - 60000);
      await touch(crashedLock, old, old);
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, amount) =>
        reserveAction(root, { idempotencyKey: key, kind: 'paid_api', authorizationScope: 'scope', request: { amount } })));
      assert.equal(results.filter((entry) => entry.status === 'fulfilled' && entry.value.created === true).length, 1, 'one key is granted to one request');
    }
    await reserveAction(root, { idempotencyKey: 'late', kind: 'paid_api', authorizationScope: 'scope', request: { amount: 1 } });
    const claim = await claimAction(root, { idempotencyKey: 'late', owner: 'w', leaseMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const late = await settleAction(root, { idempotencyKey: 'late', fencingToken: claim.fencingToken, evidence: 'upstream-1' });
    assert.equal(late.settled, false); assert.equal(late.record.state, 'unknown', 'a settle after lease expiry needs reconciliation');
    assert.equal(late.record.reconciliation.late_report.evidence, 'upstream-1');

    const kernel = new TransactionalStateKernel(path.join(root, 'kernel'));
    const a = await kernel.acquire(); await kernel.release(a);
    const b = await kernel.acquire();
    assert.notEqual(a.fencingToken, b.fencingToken);
    await assert.rejects(() => kernel.transact({ lease: a, effects: [{ type: 'state_transition', key: 'stale', payload: {} }] }), /Stale fencing token/);
    await kernel.transact({ lease: b, effects: [{ type: 'state_transition', key: 'fresh', payload: {} }] });
    await kernel.release(b);
    let executions = 0;
    const effect = { type: 'external_action', key: 'charge-42', payload: { amount: 100 } };
    await Promise.all([1, 2, 3].map(() => kernel.replayEffect(effect, async () => { executions += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return 'charged'; })));
    assert.equal(executions, 1, 'concurrent replayEffect executes once');
    const crashing = { type: 'external_action', key: 'crash-1', payload: {} };
    await assert.rejects(() => kernel.replayEffect(crashing, async () => { throw new Error('crashed after upstream accepted'); }));
    assert.equal((await kernel.replayEffect(crashing, async () => { executions += 1; })).reconcileRequired, true, 'an interrupted effect is not re-run');
    assert.equal(executions, 1);
    await kernel.reconcileEffect(crashing, { executed: true, outcome: 'accepted' });
    assert.equal((await kernel.replayEffect(crashing, async () => { executions += 1; })).replayed, true);
    assert.equal((await kernel.verifyReceiptChain()).ok, true);

    const journal = new DurableJournal(path.join(root, 'journal'));
    await journal.append('a', 1);
    await Promise.all(['b', 'c', 'd'].map((type, index) => journal.append(type, index)));
    assert.equal((await journal.replay()).count, 4, 'concurrent appends keep the chain valid');
    await appendFile(journal.logFile, '{"version":1,"transactionId":"x","ty');
    await journal.append('e', 5);
    assert.equal((await journal.replay()).count, 5, 'a torn tail is discarded, not buried');
  }

  console.log('safety regression self-test passed');
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
