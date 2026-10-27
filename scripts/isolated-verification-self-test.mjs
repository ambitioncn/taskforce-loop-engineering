import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { enqueueTask, runCommand, runQueueOnce } from '../lib/core.mjs';
import { runIsolatedVerification, validateIsolatedVerification } from '../lib/isolated-verification.mjs';

const base = await mkdtemp(path.join(tmpdir(), 'loop-isolation-self-test-'));
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const run = async (project, command, inputs, label, runtimeFiles = []) => {
  const evidenceDir = path.join(base, label);
  const result = await runIsolatedVerification({ cwd: project, command, inputs, runtimeFiles,
    evidenceDir, timeoutMs: 15000, runCommand, shellQuote: quote });
  let terminal;
  try { terminal = JSON.parse(await readFile(path.join(evidenceDir, 'terminal.json'), 'utf8')); }
  catch { throw new Error(`missing isolation terminal: ${JSON.stringify(result)}`); }
  return { result, terminal };
};

assert.throws(() => validateIsolatedVerification({ inputs: ['../private'] }), /safe relative/);
assert.throws(() => validateIsolatedVerification({ inputs: ['input.txt'], runtimeFiles: ['/etc/passwd'] }), /runtimeFiles/);

const pythonProject = path.join(base, 'python-project');
await mkdir(pythonProject);
await writeFile(path.join(pythonProject, 'input.txt'), 'hello\n');
await writeFile(path.join(pythonProject, 'hidden.txt'), 'private\n');
const python = await run(pythonProject, 'cat input.txt > /out/result.txt', ['input.txt'], 'python-pass');
assert.equal(python.result.exitCode, 0, JSON.stringify(python.terminal) + '\n' +
  (await readFile(path.join(base, 'python-pass', 'stderr.log'), 'utf8')).slice(0, 500));
assert.equal(python.terminal.status, 'passed');
assert.equal((await readFile(path.join(base, 'python-pass', 'output', 'result.txt'), 'utf8')).trim(), 'hello');

const hidden = await run(pythonProject, 'cat hidden.txt >/dev/null 2>&1 || true', ['input.txt'], 'undeclared');
assert.equal(hidden.terminal.exit_code, 0);
assert.equal(hidden.result.exitCode, 1);
assert.match(hidden.terminal.read_violations.join(' '), /undeclared available project input/);

// Root/nested reads must produce the same rejection, even after swallowing errors.
await mkdir(path.join(pythonProject, 'sub'));
await writeFile(path.join(pythonProject, 'sub', 'input.txt'), 'nested\n');
await writeFile(path.join(pythonProject, 'sub', 'hidden.txt'), 'private\n');
for (const [label, command] of [
  ['nested', 'cd sub; cat hidden.txt >/dev/null 2>&1 || true'],
  ['parent', 'cd sub; cat ../hidden.txt >/dev/null 2>&1 || true'],
]) {
  const probe = await run(pythonProject, command, ['input.txt', 'sub/input.txt'], label);
  assert.equal(probe.terminal.exit_code, 0);
  assert.equal(probe.result.exitCode, 1);
  assert.match(probe.terminal.read_violations.join(' '), /undeclared available project input/);
}
// Optional probes are allowed only when the source path is genuinely absent.
for (const [label, command] of [
  ['missing-root-parent', 'cat /nonexistent_r4/../work/hidden.txt >/dev/null 2>&1 || true'],
  ['missing-root-reentry', 'cat /work/../nonexistent_r4/../work/hidden.txt >/dev/null 2>&1 || true'],
  ['missing-alias', 'cat /work/../work/missing.txt >/dev/null 2>&1 || true'],
  ['missing-alias-parent', 'cat //work/absent/../hidden.txt >/dev/null 2>&1 || true'],
  ['file-alias-parent', 'cat ../work/input.txt/../hidden.txt >/dev/null 2>&1 || true'],
  ['missing-parent', 'cat absent/../hidden.txt >/dev/null 2>&1 || true'],
  ['nondirectory-parent', 'cat input.txt/../hidden.txt >/dev/null 2>&1 || true'],
  ['missing-trailing-slash', 'cat hidden.txt/ >/dev/null 2>&1 || true'],
  ['optional-exec', './optional.sh >/dev/null 2>&1 || true'],
  ['optional-access', `python3 -c "import os; assert not os.access('absent.txt', os.R_OK)"`],
  ['optional-nested', `cd sub; python3 -c "import os; assert not os.access('absent.txt', os.R_OK)"`],
  ['optional-unicode', "cat '不存在.txt' >/dev/null 2>&1 || true"],
  ['optional-fchdir', `python3 -c "import os; fd=os.open('sub', os.O_RDONLY); os.fchdir(fd); assert not os.access('absent.txt', os.R_OK)"`],
]) {
  const probe = await run(pythonProject, command, ['input.txt', 'sub/input.txt'], label);
  assert.equal(probe.result.exitCode, 0, label + JSON.stringify(probe.terminal));
}
for (const [label, command] of [
  ['relative-alias', 'cat ../work/hidden.txt >/dev/null 2>&1 || true'],
  ['absolute-alias', 'cat /work/../work/hidden.txt >/dev/null 2>&1 || true'],
  ['double-slash', 'cat //work/hidden.txt >/dev/null 2>&1 || true'],
  ['multi-reentry', 'cat /work/../../work/sub/../../work/hidden.txt >/dev/null 2>&1 || true'],
  ['existing-parent', 'cat sub/../hidden.txt >/dev/null 2>&1 || true'],
  ['hidden-access', `python3 -c "import os; os.access('hidden.txt', os.R_OK)"`],
  ['hidden-nested-access', `cd sub; python3 -c "import os; os.access('hidden.txt', os.R_OK)"`],
  ['hidden-exec', './hidden.txt >/dev/null 2>&1 || true'],
  ['hidden-fchdir', `python3 -c "import os; fd=os.open('sub', os.O_RDONLY); os.fchdir(fd); os.access('hidden.txt', os.R_OK)"`],
]) {
  const probe = await run(pythonProject, command, ['input.txt', 'sub/input.txt'], label);
  assert.equal(probe.terminal.exit_code, 0, label);
  assert.equal(probe.result.exitCode, 1, label);
  assert.match(probe.terminal.read_violations.join(' '), /undeclared available project input/, label);
}
for (const [index, name] of ['中文.txt', 'quote".txt', 'back\\slash.txt'].entries()) {
  await writeFile(path.join(pythonProject, name), 'content');
  const allowed = await run(pythonProject, `cat ${quote(name)} >/out/result`, [name], `filename-${index}`);
  assert.equal(allowed.result.exitCode, 0, JSON.stringify(allowed.terminal));
  const denied = await run(pythonProject, `cat ${quote(name)} >/dev/null 2>&1 || true`, ['input.txt'], `filename-hidden-${index}`);
  assert.equal(denied.result.exitCode, 1, JSON.stringify(denied.terminal));
  assert.match(denied.terminal.read_violations.join(' '), /undeclared available project input/);
}
const nestedPass = await run(pythonProject, 'cd sub; cat input.txt > /out/result',
  ['sub/input.txt'], 'nested-pass');
assert.equal(nestedPass.result.exitCode, 0, JSON.stringify(nestedPass.terminal));
await writeFile(path.join(pythonProject, 'test.sh'), '#!/bin/sh\ncat input.txt > /out/executed\n');
await chmod(path.join(pythonProject, 'test.sh'), 0o755);
const executable = await run(pythonProject, './test.sh', ['test.sh', 'input.txt'], 'exec-pass');
assert.equal(executable.result.exitCode, 0, JSON.stringify(executable.terminal));
await chmod(path.join(pythonProject, 'test.sh'), 0o744);
const changedMode = await run(pythonProject, './test.sh', ['test.sh', 'input.txt'], 'mode-change');
assert.equal(changedMode.result.exitCode, 0);
assert.notEqual(executable.terminal.input_digest, changedMode.terminal.input_digest);

const forged = await run(pythonProject, 'printf "fake" > /tmp/trace.log; cat hidden.txt >/dev/null 2>&1 || true',
  ['input.txt'], 'forged-trace');
assert.equal(forged.terminal.exit_code, 0);
assert.equal(forged.result.exitCode, 1);
assert.equal(forged.terminal.status, 'failed_or_unknown');
await symlink(base, path.join(pythonProject, 'outside'));
const linked = await run(pythonProject, 'true', ['outside/python-project/input.txt'], 'symlink-ancestor');
assert.equal(linked.result.exitCode, 1);
assert.match(linked.terminal.error, /symlink input ancestor/);

const nodeProject = path.join(base, 'node-project');
await mkdir(nodeProject);
await writeFile(path.join(nodeProject, 'input.txt'), 'node\n');
await writeFile(path.join(nodeProject, 'app.js'), 'require("fs").readFileSync("input.txt");\n');
const nodeBinary = realpathSync(process.execPath);
const node = await run(nodeProject, `${nodeBinary} app.js`,
  ['input.txt', 'app.js'], 'node-pass', nodeBinary.startsWith('/usr/') ? [] : [nodeBinary]);
assert.equal(node.result.exitCode, 0);
assert.equal(node.terminal.status, 'passed');
assert.equal(node.terminal.read_trace_verified, true);

const queueProject = path.join(base, 'queue-project');
await mkdir(queueProject);
await writeFile(path.join(queueProject, '.gitignore'), 'runtime/\n');
await writeFile(path.join(queueProject, 'input.txt'), 'queue\n');
await writeFile(path.join(queueProject, 'hidden.txt'), 'not declared\n');
await mkdir(path.join(queueProject, 'sub'));
await writeFile(path.join(queueProject, 'sub/input.txt'), 'nested\n');
await writeFile(path.join(queueProject, 'test.sh'), '#!/bin/sh\ncat input.txt > /out/result.txt\n');
await chmod(path.join(queueProject, 'test.sh'), 0o755);
const git = (...args) => execFileSync('git', args, { cwd: queueProject, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'loop@example.invalid');
git('config', 'user.name', 'loop');
git('add', '-A');
git('commit', '-qm', 'fixture');
await enqueueTask(queueProject, { queue: 'isolated', title: 'verify fixture', task: 'Run bounded verification' });
const queued = await runQueueOnce(queueProject, { queue: 'isolated', dispatcher: 'true',
  worktree: { enabled: true, baseDir: 'runtime/loops/isolated/worktrees', branchPrefix: 'loop/isolated',
    verifyCommands: ['./test.sh'], isolatedVerification: { inputs: ['input.txt', 'test.sh'] } } });
const queueVerification = queued.run?.verification ?? queued.verification;
assert.equal(queueVerification?.[0]?.result?.isolation?.status, 'passed', JSON.stringify(queued).slice(0, 2000));
assert.match(queueVerification[0].result.isolation.inputDigest, /^[0-9a-f]{64}$/);
await enqueueTask(queueProject, { queue: 'isolated', title: 'reject hidden input', task: 'Prove fail closed' });
const rejected = await runQueueOnce(queueProject, { queue: 'isolated', dispatcher: 'true',
  worktree: { enabled: true, baseDir: 'runtime/loops/isolated/worktrees', branchPrefix: 'loop/isolated',
    verifyCommands: ['cd sub; cat ../hidden.txt >/dev/null 2>&1 || true'], isolatedVerification: { inputs: ['input.txt', 'sub/input.txt'] } } });
assert.equal(rejected.status, 'verify_failed');
assert.equal(rejected.run.verification[0].result.isolation.status, 'failed_or_unknown');

// Exercise path semantics through the real disposable queue, not only the parser.
for (const [label, command, expected] of [
  ['bin-missing', 'cat /bin/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['bin-hidden', 'cat /bin/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['lib-missing', 'cat /lib/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['lib-hidden', 'cat /lib/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['usr-missing', 'cat /usr/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['usr-hidden', 'cat /usr/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['etc-missing', 'cat /etc/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['etc-hidden', 'cat /etc/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['lib64-missing', 'cat /lib64/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['lib64-hidden', 'cat /lib64/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['bin-kind', 'test -d /bin && ! test -L /bin', 'passed'],
  ['-proc-self-cwd-hidden.txt', 'cat /proc/self/cwd/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['-proc-self-cwd-missing.txt', 'cat /proc/self/cwd/missing.txt 2>/dev/null || true', 'passed'],
  ['-proc-self-cwd-absent-dotdot-hidden.txt', 'cat /proc/self/cwd/absent/../hidden.txt 2>/dev/null || true', 'passed'],
  ['-proc-self-cwd-hidden.txt-', 'cat /proc/self/cwd/hidden.txt/ 2>/dev/null || true', 'passed'],
  ['-proc-thread-self-cwd-hidden.txt', 'cat /proc/thread-self/cwd/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['-proc-thread-self-cwd-missing.txt', 'cat /proc/thread-self/cwd/missing.txt 2>/dev/null || true', 'passed'],
  ['-proc-thread-self-cwd-absent-dotdot-hidden.txt', 'cat /proc/thread-self/cwd/absent/../hidden.txt 2>/dev/null || true', 'passed'],
  ['-proc-thread-self-cwd-hidden.txt-', 'cat /proc/thread-self/cwd/hidden.txt/ 2>/dev/null || true', 'passed'],
  ['-proc-self-root-work-hidden.txt', 'cat /proc/self/root/work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['-proc-self-root-work-missing.txt', 'cat /proc/self/root/work/missing.txt 2>/dev/null || true', 'passed'],
  ['-proc-self-root-work-absent-dotdot-hidden.txt', 'cat /proc/self/root/work/absent/../hidden.txt 2>/dev/null || true', 'passed'],
  ['-proc-self-root-work-hidden.txt-', 'cat /proc/self/root/work/hidden.txt/ 2>/dev/null || true', 'passed'],
  ['dynamic-fd', 'cat /dev/fd/9/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['missing-parent', 'cat absent/../hidden.txt 2>/dev/null || true', 'passed'],
  ['existing-parent', 'cat sub/../hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['relative-alias', 'cat ../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['absolute-alias', 'cat /work/../work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['double-slash', 'cat //work/hidden.txt 2>/dev/null || true', 'failed_or_unknown'],
  ['missing-alias', 'cat //work/../work/missing.txt 2>/dev/null || true', 'passed'],
  ['file-alias', 'cat ../work/input.txt/../hidden.txt 2>/dev/null || true', 'passed'],
]) {
  await enqueueTask(queueProject, { queue: 'path-' + label, title: label, task: 'Verify path semantics' });
  const outcome = await runQueueOnce(queueProject, { queue: 'path-' + label, dispatcher: 'true',
    worktree: { enabled: true, baseDir: 'runtime/loops/path-' + label + '/worktrees',
      branchPrefix: 'loop/path-' + label, verifyCommands: [command],
      isolatedVerification: { inputs: ['input.txt', 'sub/input.txt'] } } });
  assert.equal(outcome.run.verification[0]?.result?.isolation?.status, expected, JSON.stringify(outcome));
  if (expected !== 'passed') assert.equal(outcome.status, 'verify_failed');
}

console.log('isolated verification: two projects passed; undeclared input and forged trace rejected');
