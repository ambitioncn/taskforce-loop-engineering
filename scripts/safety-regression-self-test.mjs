import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  console.log('safety regression self-test passed');
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
