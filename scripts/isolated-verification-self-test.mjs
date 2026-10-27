import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { enqueueTask, runCommand, runQueueOnce } from '../lib/core.mjs';
import { runIsolatedVerification, validateIsolatedVerification } from '../lib/isolated-verification.mjs';

const base = await mkdtemp(path.join(tmpdir(), 'loop-isolation-self-test-'));
const quote = (value) => `'${String(value).replace(/'/g, `'\''`)}'`;
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
assert.equal(python.result.exitCode, 0);
assert.equal(python.terminal.status, 'passed');
assert.equal((await readFile(path.join(base, 'python-pass', 'output', 'result.txt'), 'utf8')).trim(), 'hello');

const hidden = await run(pythonProject, 'cat hidden.txt >/dev/null 2>&1 || true', ['input.txt'], 'undeclared');
assert.equal(hidden.terminal.exit_code, 0);
assert.equal(hidden.result.exitCode, 1);
assert.match(hidden.terminal.read_violations.join(' '), /undeclared available project input/);

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
  ['input.txt', 'app.js'], 'node-pass', [nodeBinary]);
assert.equal(node.result.exitCode, 0);
assert.equal(node.terminal.status, 'passed');
assert.equal(node.terminal.read_trace_verified, true);

const queueProject = path.join(base, 'queue-project');
await mkdir(queueProject);
await writeFile(path.join(queueProject, '.gitignore'), 'runtime/\n');
await writeFile(path.join(queueProject, 'input.txt'), 'queue\n');
await writeFile(path.join(queueProject, 'hidden.txt'), 'not declared\n');
const git = (...args) => execFileSync('git', args, { cwd: queueProject, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'loop@example.invalid');
git('config', 'user.name', 'loop');
git('add', '-A');
git('commit', '-qm', 'fixture');
await enqueueTask(queueProject, { queue: 'isolated', title: 'verify fixture', task: 'Run bounded verification' });
const queued = await runQueueOnce(queueProject, { queue: 'isolated', dispatcher: 'true',
  worktree: { enabled: true, baseDir: 'runtime/loops/isolated/worktrees', branchPrefix: 'loop/isolated',
    verifyCommands: ['cat input.txt > /out/result.txt'], isolatedVerification: { inputs: ['input.txt'] } } });
const queueVerification = queued.run?.verification ?? queued.verification;
assert.equal(queueVerification?.[0]?.result?.isolation?.status, 'passed', JSON.stringify(queued).slice(0, 2000));
assert.match(queueVerification[0].result.isolation.inputDigest, /^[0-9a-f]{64}$/);
await enqueueTask(queueProject, { queue: 'isolated', title: 'reject hidden input', task: 'Prove fail closed' });
const rejected = await runQueueOnce(queueProject, { queue: 'isolated', dispatcher: 'true',
  worktree: { enabled: true, baseDir: 'runtime/loops/isolated/worktrees', branchPrefix: 'loop/isolated',
    verifyCommands: ['cat hidden.txt >/dev/null 2>&1 || true'], isolatedVerification: { inputs: ['input.txt'] } } });
assert.equal(rejected.status, 'verify_failed');
assert.equal(rejected.run.verification[0].result.isolation.status, 'failed_or_unknown');

console.log('isolated verification: two projects passed; undeclared input and forged trace rejected');
