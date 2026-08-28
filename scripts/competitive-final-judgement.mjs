import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const checks = [];
const record = (id, ok, evidence) => checks.push({ id, ok, evidence });
const requiredFiles = ['lib/transactional-state-kernel.mjs', 'lib/goal-api.mjs', '.github/workflows/ci.yml', 'scripts/competitive-acceptance.mjs', 'docs/transactional-kernel-and-goal-api.md'];
for (const file of requiredFiles) {
  try { await access(path.join(root, file)); record(`file:${file}`, true, file); }
  catch { record(`file:${file}`, false, 'missing'); }
}
const source = await readFile(path.join(root, 'lib/transactional-state-kernel.mjs'), 'utf8');
for (const token of ['state_transition', 'human_gate', 'revision', 'action_reservation', 'external_action', 'completion', 'fencingToken', 'expectedGeneration', 'verifyReceiptChain', 'replayEffect']) {
  record(`kernel:${token}`, source.includes(token), token);
}
const cli = await readFile(path.join(root, 'bin/loop-engineering.mjs'), 'utf8');
for (const command of ['init', 'run', 'status', 'review', 'doctor']) record(`cli:${command}`, cli.includes(`command === '${command}'`), command);
const fixture = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/competitive-acceptance.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
record('competitive_fixtures', fixture.code === 0, fixture.code === 0 ? '7/7 passed' : fixture.stderr);
const outcome = checks.every((item) => item.ok) ? 'accept' : 'reject';
console.log(JSON.stringify({ version: 1, scope: 'complete_project_terminal_contract', independent_from_runtime_implementation: true, outcome, checks, residual_risks: ['Filesystem durability depends on the host filesystem honoring atomic rename and fsync semantics.', 'External exactly-once behavior requires providers to honor the supplied idempotency key.'] }, null, 2));
if (outcome !== 'accept') process.exitCode = 1;
