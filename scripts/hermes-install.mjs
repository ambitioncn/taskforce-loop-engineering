#!/usr/bin/env node
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', hermesBin: 'hermes', systemctlBin: 'systemctl', json: false, confirmInstall: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--queue') out.queue = argv[++i];
    else if (arg === '--hermes-bin') out.hermesBin = argv[++i];
    else if (arg === '--systemctl-bin') out.systemctlBin = argv[++i];
    else if (arg === '--confirm-install') out.confirmInstall = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function safeId(value, label) { if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsupported characters.`); return value; }
function systemdEscapePath(value) {
  return [...Buffer.from(String(value))].map((byte) => /[A-Za-z0-9/_.:-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join('');
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function resolveExecutable(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const resolved = path.resolve(command); if (!await exists(resolved)) throw new Error(`Executable not found: ${resolved}`); return resolved;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) { const candidate = path.join(dir, command); if (await exists(candidate)) return candidate; }
  throw new Error(`Executable not found on PATH: ${command}`);
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

function dispatcherSource({ hermesBin }) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const task = JSON.parse(await readFile(process.env.LOOP_TASK_FILE, 'utf8'));
const prompt = [
  'You are receiving an already loop-managed task.',
  'Do not route or enqueue this task again.',
  'Read the task contract, development plan, acceptance plan, and live amendments before implementation.',
  \`Task id: \${task.id}\`,
  \`Task contract: \${process.env.LOOP_TASK_CONTRACT_FILE || 'not provided'}\`,
  \`Development plan: \${process.env.LOOP_DEV_PLAN_FILE || 'not provided'}\`,
  \`Acceptance plan: \${process.env.LOOP_ACCEPTANCE_PLAN_FILE || 'not provided'}\`,
  \`Live amendments: \${process.env.LOOP_LATEST_AMENDMENT_FILE || 'not provided'}\`,
  \`Checkpoints dir: \${process.env.LOOP_CHECKPOINTS_DIR || 'not provided'}\`,
  '', task.body, '',
  'Before each checkpoint and final completion, reread the live amendment file. Write a checkpoint when possible and finish with status, evidence, verification, blockers, and next action.'
].join('\\n');
const child = spawn(${JSON.stringify(hermesBin)}, ['-z', prompt], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
`;
}

function wrapperSource({ queue, loopBin }) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const [command, ...rest] = process.argv.slice(2);
function run(args) { return new Promise((resolve) => { const child = spawn(process.execPath, [${JSON.stringify(loopBin)}, ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' }); child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1))); }); }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runWhenUnlocked(args, waitMs = 300000) { const deadline = Date.now() + waitMs; while (true) { const code = await run(args); if (code !== 2 || Date.now() >= deadline) return code; await wait(250); } }
if (command === 'route') {
  const messageIndex = rest.indexOf('--message'); const message = messageIndex >= 0 ? String(rest[messageIndex + 1] || '') : '';
  const amendment = /(?:继续(?:当前|这个)?\\s*loop|给(?:当前|这个)?\\s*loop\\s*(?:补充|增加|加)|补充当前\\s*loop)/i.test(message);
  const routeCode = await run(['route-message', '--queue', ${JSON.stringify(queue)}, '--route', '--confirm-execute', amendment ? '--amend-active' : '--supersede-active', ...rest]);
  const queueOnly = /(?:只入队|只排队|暂不执行|不立即执行)/.test(message);
  const runCode = routeCode || queueOnly || amendment ? routeCode : await runWhenUnlocked(['run-queue', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  const humanCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  const terminalCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  process.exitCode = routeCode || runCode || humanCode || terminalCode;
} else if (command === 'run-once') {
  const runCode = await run(['run-queue', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/hermes-loop-notify.mjs', ...rest]);
  const humanCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  const terminalCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  process.exitCode = runCode || humanCode || terminalCode;
} else if (command === 'scheduler-tick') {
  const tickCode = await run(['queue-scheduler-tick', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/hermes-loop-notify.mjs', ...rest]);
  const humanCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  const terminalCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/hermes-loop-notify.mjs']);
  process.exitCode = tickCode || humanCode || terminalCode;
} else { console.error('Usage: node scripts/loops/hermes-loop.mjs route|run-once|scheduler-tick'); process.exitCode = 1; }
`;
}

function notifierSource({ hermesBin }) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const message = process.argv.slice(2).join(' ').trim();
const rawSource = process.env.LOOP_HUMAN_INPUT_SOURCE || process.env.LOOP_NOTIFICATION_SOURCE || '';
if (!message) { console.error('loop notifier requires a message'); process.exit(2); }
let source; try { source = JSON.parse(rawSource); } catch { console.error('loop notifier received invalid source metadata'); process.exit(2); }
if (!source || typeof source !== 'object' || !source.target) { console.error('Hermes loop notifier requires source.target in platform[:chat[:thread]] form'); process.exit(2); }
const args = ['send', '--to', String(source.target), '--quiet', message];
if (process.env.LOOP_NOTIFICATION_DRY_RUN === '1') { console.log(JSON.stringify({ dryRun: true, command: ${JSON.stringify(hermesBin)}, args })); }
else { const child = spawn(${JSON.stringify(hermesBin)}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' }); child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); }); }
`;
}

function schedulerServiceSource({ root, queue }) { return `[Unit]\nDescription=Taskforce Loop Engineering Hermes scheduler for ${queue}\nAfter=default.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${systemdEscapePath(root)}\nExecStart=${systemdEscapePath(process.execPath)} ${systemdEscapePath(path.join(root, 'scripts', 'loops', 'hermes-loop.mjs'))} scheduler-tick --json\n`; }
function schedulerTimerSource({ queue }) { return `[Unit]\nDescription=Wake Taskforce Loop Engineering Hermes scheduler for ${queue}\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=1min\nAccuracySec=10s\nPersistent=true\nUnit=hermes-loop-${queue}-scheduler.service\n\n[Install]\nWantedBy=timers.target\n`; }
function instructionsBlock({ queue }) { return `\n<!-- loop-engineering:hermes:start -->\n## Loop Engineering conversation routing (Hermes)\n\n- Route only explicit Loop Engineering requests. Already managed tasks must never be routed again.\n- Run \`node scripts/loops/hermes-loop.mjs route --message "<full user message>"\` and pass \`--source-channel <platform> --source-target <platform:chat_id[:thread_id]>\` so notifications return to the originating Hermes conversation.\n- \`走 loop\` executes immediately; only \`只入队\` or \`只排队\` suppresses execution. External, destructive, production, credential, or memory migration actions remain separately gated.\n- Queue: \`${queue}\`.\n<!-- loop-engineering:hermes:end -->\n`; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: loop-engineering-hermes-install [--root workspace] [--queue agent-tasks] [--hermes-bin hermes] [--systemctl-bin systemctl] [--confirm-install] [--force] [--json]'); return; }
  safeId(args.queue, 'queue');
  args.hermesBin = await resolveExecutable(args.hermesBin);
  const hermes = await run(args.hermesBin, ['--version'], { cwd: args.root });
  if (hermes.code !== 0) throw new Error(`Cannot run Hermes CLI with ${args.hermesBin}: ${(hermes.stderr || hermes.stdout).trim() || `exit ${hermes.code}`}`);
  const loopBin = new URL('../bin/loop-engineering.mjs', import.meta.url).pathname;
  const systemdUserDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const unit = `hermes-loop-${args.queue}-scheduler.service`; const timer = `hermes-loop-${args.queue}-scheduler.timer`;
  const files = { workspaceHealth: path.join(args.root, 'configs/loops/workspace-health.json'), queueConfig: path.join(args.root, 'configs/loops/queues', `${args.queue}.json`), dispatcher: path.join(args.root, 'scripts/loops/hermes-loop-dispatch.mjs'), wrapper: path.join(args.root, 'scripts/loops/hermes-loop.mjs'), notifier: path.join(args.root, 'scripts/loops/hermes-loop-notify.mjs'), manifest: path.join(args.root, 'runtime/loop-engineering-hermes-install.json'), instructions: path.join(args.root, 'AGENTS.md'), schedulerService: path.join(systemdUserDir, unit), schedulerTimer: path.join(systemdUserDir, timer) };
  const conflicts = []; for (const [kind, file] of Object.entries(files)) if (!['instructions', 'workspaceHealth', 'manifest'].includes(kind) && await exists(file)) conflicts.push(path.relative(args.root, file));
  const report = { version: 1, platform: 'hermes', status: args.confirmInstall ? 'installed' : 'plan_only', readOnly: !args.confirmInstall, root: args.root, queue: args.queue, hermesBin: args.hermesBin, hermesVersion: (hermes.stdout || hermes.stderr).trim().slice(0, 200), scheduler: { required: true, unit, timer }, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.relative(args.root, file)])), conflicts };
  if (conflicts.length && !args.force && args.confirmInstall) throw new Error(`Refusing to overwrite: ${conflicts.join(', ')}. Use --force after review.`);
  if (args.confirmInstall) {
    await mkdir(path.dirname(files.queueConfig), { recursive: true }); await mkdir(path.dirname(files.dispatcher), { recursive: true }); await mkdir(path.join(args.root, 'runtime', 'loops', args.queue), { recursive: true });
    if (!await exists(files.workspaceHealth)) await writeFile(files.workspaceHealth, `${JSON.stringify({ id: 'workspace-health', goal: 'Keep this workspace loop-ready and detect obvious drift.', level: 'L1', mode: 'report-only', maxRuntimeMs: 120000, breaker: { maxConsecutiveFailures: 3, sameFailureThreshold: 2 }, checks: [{ id: 'workspace-root', type: 'files', paths: ['.'] }] }, null, 2)}\n`);
    const queueContent = `${JSON.stringify({ queue: args.queue, description: 'Hermes conversation queue.', dispatcher: 'node scripts/loops/hermes-loop-dispatch.mjs', preflightConfig: 'configs/loops/workspace-health.json', timeoutMs: 1800000, leaseMs: 1860000, staleActiveMs: 3600000, scheduler: { required: true, heartbeatMaxAgeMs: 300000, initialInterval: '1m', minInterval: '1m', maxInterval: '4h', speedupFactor: 0.5, backoffFactor: 2, idleBackoffFactor: 2, humanGateBackoffFactor: 3, longRunHeadroomFactor: 1.25, jitter: '10s' }, retry: { maxAttempts: 1, runtimeRecoveryMaxAttempts: 2, sessionMaxTicks: 10, retryDelayMs: 0, retryExitCodes: [1], requiresHumanActionPatterns: ['requires human', '需要人工', 'Permission denied', 'Operation not permitted'] }, revisionPolicy: { enabled: true, maxRevisionRounds: 3, sameFailureThreshold: 2, requireStrategyChange: true } }, null, 2)}\n`;
    const contents = { queueConfig: queueContent, dispatcher: dispatcherSource(args), wrapper: wrapperSource({ queue: args.queue, loopBin }), notifier: notifierSource(args), schedulerService: schedulerServiceSource({ root: args.root, queue: args.queue }), schedulerTimer: schedulerTimerSource({ queue: args.queue }) };
    await mkdir(systemdUserDir, { recursive: true });
    for (const [kind, content] of Object.entries(contents)) await writeFile(files[kind], content);
    const reload = await run(args.systemctlBin, ['--user', 'daemon-reload'], { cwd: args.root }); if (reload.code !== 0) throw new Error(`Cannot reload user systemd units: ${(reload.stderr || reload.stdout).trim()}`);
    const enable = await run(args.systemctlBin, ['--user', 'enable', '--now', timer], { cwd: args.root }); if (enable.code !== 0) throw new Error(`Cannot enable Hermes Loop scheduler ${timer}: ${(enable.stderr || enable.stdout).trim()}`);
    const marker = instructionsBlock({ queue: args.queue }); const current = await readFile(files.instructions, 'utf8').catch(() => ''); if (!current.includes('<!-- loop-engineering:hermes:start -->')) await appendFile(files.instructions, marker);
    await mkdir(path.dirname(files.manifest), { recursive: true }); await writeFile(files.manifest, `${JSON.stringify({ version: 1, platform: 'hermes', installedAt: new Date().toISOString(), root: args.root, queue: args.queue, hermesBin: args.hermesBin, files: Object.entries(contents).map(([kind, content]) => ({ kind, path: files[kind], sha256: sha256(content) })), scheduler: { unit, timer } }, null, 2)}\n`);
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : `Hermes Loop installer: ${report.status}\nqueue: ${args.queue}\nscheduler: ${timer}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
