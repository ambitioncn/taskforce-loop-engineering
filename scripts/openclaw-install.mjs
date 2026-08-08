#!/usr/bin/env node
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', workerAgent: null, openclawBin: 'openclaw', systemctlBin: 'systemctl', json: false, confirmInstall: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--queue') out.queue = argv[++i];
    else if (arg === '--worker-agent') out.workerAgent = argv[++i];
    else if (arg === '--openclaw-bin') out.openclawBin = argv[++i];
    else if (arg === '--systemctl-bin') out.systemctlBin = argv[++i];
    else if (arg === '--confirm-install') out.confirmInstall = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function systemdEscapePath(value) {
  return [...Buffer.from(String(value))]
    .map((byte) => /[A-Za-z0-9/_.:-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, '0')}`)
    .join('');
}

function safeId(value, label) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsupported characters.`);
  return value;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

async function resolveWorkerAgent(args) {
  const result = await run(args.openclawBin, ['agents', 'list', '--json'], { cwd: args.root });
  if (result.code !== 0) throw new Error(`Cannot inspect OpenClaw agents with ${args.openclawBin}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  let agents;
  try { agents = JSON.parse(result.stdout); } catch { throw new Error('OpenClaw agents list did not return valid JSON.'); }
  if (!Array.isArray(agents)) throw new Error('OpenClaw agents list did not return an array.');
  const ids = agents.map((agent) => agent?.id).filter((id) => typeof id === 'string' && id);
  if (args.workerAgent) {
    if (!ids.includes(args.workerAgent)) throw new Error(`Worker agent ${args.workerAgent} does not exist. Available agents: ${ids.join(', ') || 'none'}. Create it first or choose an existing agent.`);
    return { workerAgent: args.workerAgent, selection: 'explicit', availableAgents: ids };
  }
  if (ids.includes('main')) return { workerAgent: 'main', selection: 'default_main', availableAgents: ids };
  if (ids.length === 1) return { workerAgent: ids[0], selection: 'only_available', availableAgents: ids };
  throw new Error(`Cannot choose a worker agent automatically. Available agents: ${ids.join(', ') || 'none'}. Pass --worker-agent <id>; create the agent first if needed.`);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function dispatcherSource({ workerAgent, openclawBin }) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const task = JSON.parse(await readFile(process.env.LOOP_TASK_FILE, 'utf8'));
const sessionGeneration = Number.parseInt(process.env.LOOP_SESSION_GENERATION || '0', 10) || 0;
const prompt = [
  'You are receiving an already loop-managed task.',
  'Do not route or enqueue this task again, even if its quoted request contains a loop trigger.',
  'Read the task contract, development plan, and acceptance plan before implementation.',
  \`Task id: \${task.id}\`,
  \`Task contract: \${process.env.LOOP_TASK_CONTRACT_FILE || 'not provided'}\`,
  \`Development plan: \${process.env.LOOP_DEV_PLAN_FILE || 'not provided'}\`,
  \`Acceptance plan: \${process.env.LOOP_ACCEPTANCE_PLAN_FILE || 'not provided'}\`,
  \`Live amendments: \${process.env.LOOP_LATEST_AMENDMENT_FILE || 'not provided'}\`,
  \`Checkpoints dir: \${process.env.LOOP_CHECKPOINTS_DIR || 'not provided'}\`,
  '', task.body, '',
  'Before writing each checkpoint and before final completion, reread the live amendment file if it exists. Treat every recorded amendment as part of the task contract and acceptance criteria.',
  'Write a checkpoint when possible. Include the latest amendment_version applied. Finish with status, evidence, verification, blockers, and next action.'
].join('\\n');
const child = spawn(${JSON.stringify(openclawBin)}, [
  'agent', '--agent', ${JSON.stringify(workerAgent)},
  '--session-key', \`agent:${workerAgent}:loop-task-\${task.id}-g\${sessionGeneration}\`,
  '--message', prompt, '--json', '--timeout', '1800'
], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
`;
}

function wrapperSource({ queue, loopBin }) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const [command, ...rest] = process.argv.slice(2);
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [${JSON.stringify(loopBin)}, ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runWhenUnlocked(args, waitMs = 300000) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const code = await run(args);
    if (code !== 2 || Date.now() >= deadline) return code;
    await wait(250);
  }
}
if (command === 'route') {
  const messageIndex = rest.indexOf('--message');
  const message = messageIndex >= 0 ? String(rest[messageIndex + 1] || '') : '';
  const amendment = /(?:继续(?:当前|这个)?\\s*loop|给(?:当前|这个)?\\s*loop\\s*(?:补充|增加|加)|补充当前\\s*loop)/i.test(message);
  const routeMode = amendment ? '--amend-active' : '--supersede-active';
  const routeCode = await run(['route-message', '--queue', ${JSON.stringify(queue)}, '--route', '--confirm-execute', routeMode, ...rest]);
  const queueOnly = /(?:只入队|只排队|暂不执行|不立即执行)/.test(message);
  const runCode = routeCode || queueOnly || amendment ? routeCode : await runWhenUnlocked(['run-queue', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  const humanNotifyCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  const terminalNotifyCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  process.exitCode = routeCode || runCode || humanNotifyCode || terminalNotifyCode;
} else if (command === 'run-once') {
  const runCode = await run(['run-queue', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/openclaw-loop-notify.mjs', ...rest]);
  const humanNotifyCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  const terminalNotifyCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  process.exitCode = runCode || humanNotifyCode || terminalNotifyCode;
} else if (command === 'scheduler-tick') {
  const tickCode = await run(['queue-scheduler-tick', '--config', ${JSON.stringify(`configs/loops/queues/${queue}.json`)}, '--progress-notify-command', 'node scripts/loops/openclaw-loop-notify.mjs', ...rest]);
  const humanNotifyCode = await run(['queue-human-input-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  const terminalNotifyCode = await run(['queue-terminal-notify', '--queue', ${JSON.stringify(queue)}, '--notify-command', 'node scripts/loops/openclaw-loop-notify.mjs']);
  process.exitCode = tickCode || humanNotifyCode || terminalNotifyCode;
} else {
  console.error('Usage: node scripts/loops/openclaw-loop.mjs route --message "走 loop：任务" [source metadata]');
  process.exitCode = 1;
}
`;
}

function schedulerServiceSource({ root, queue }) {
  return `[Unit]\nDescription=Taskforce Loop Engineering scheduler for ${queue}\nAfter=default.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${systemdEscapePath(root)}\nExecStart=${systemdEscapePath(process.execPath)} ${systemdEscapePath(path.join(root, 'scripts', 'loops', 'openclaw-loop.mjs'))} scheduler-tick --json\n`;
}

function schedulerTimerSource({ queue }) {
  return `[Unit]\nDescription=Wake Taskforce Loop Engineering scheduler for ${queue}\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=1min\nAccuracySec=10s\nPersistent=true\nUnit=openclaw-loop-${queue}-scheduler.service\n\n[Install]\nWantedBy=timers.target\n`;
}

function notifierSource({ openclawBin }) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const message = process.argv.slice(2).join(' ').trim();
const rawSource = process.env.LOOP_HUMAN_INPUT_SOURCE || process.env.LOOP_NOTIFICATION_SOURCE || '';
if (!message) { console.error('loop notifier requires a message argument.'); process.exit(2); }
let source;
try { source = JSON.parse(rawSource); } catch { console.error('loop notifier received invalid source metadata.'); process.exit(2); }
if (!source || typeof source !== 'object' || !source.channel || !source.target) {
  console.error('loop notifier requires source.channel and source.target; refusing an unscoped delivery.');
  process.exit(2);
}
const args = ['message', 'send', '--channel', String(source.channel), '--target', String(source.target), '--message', message, '--json'];
if (source.account) args.push('--account', String(source.account));
if (source.reply_to) args.push('--reply-to', String(source.reply_to));
if (process.env.LOOP_NOTIFICATION_DRY_RUN === '1') args.push('--dry-run');
const child = spawn(${JSON.stringify(openclawBin)}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
`;
}

function instructionsBlock({ queue }) {
  return `\n<!-- loop-engineering:openclaw:start -->
## Loop Engineering conversation routing

- Route only explicit loop requests. \`走 loop\` means enqueue and immediately execute one tick; only \`只入队\` or \`只排队\` suppresses execution.
- Run \`node scripts/loops/openclaw-loop.mjs route --message "<full user message>"\` from this workspace and preserve source metadata when available.
- An already loop-managed task must be executed directly and never routed again.
- Status questions are read-only. High-risk external, destructive, production, credential, or memory migration actions remain separately gated.
- Queue: \`${queue}\`.
<!-- loop-engineering:openclaw:end -->\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: loop-engineering-openclaw-install [--root workspace] [--queue agent-tasks] [--worker-agent agent-id] [--openclaw-bin openclaw] [--systemctl-bin systemctl] [--confirm-install] [--force] [--json]');
    return;
  }
  safeId(args.queue, 'queue');
  if (args.workerAgent) safeId(args.workerAgent, 'worker agent');
  const worker = await resolveWorkerAgent(args);
  args.workerAgent = worker.workerAgent;
  args.loopBin = new URL('../bin/loop-engineering.mjs', import.meta.url).pathname;
  const systemdUserDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const schedulerUnit = `openclaw-loop-${args.queue}-scheduler.service`;
  const schedulerTimer = `openclaw-loop-${args.queue}-scheduler.timer`;
  const files = {
    workspaceHealth: path.join(args.root, 'configs', 'loops', 'workspace-health.json'),
    queueConfig: path.join(args.root, 'configs', 'loops', 'queues', `${args.queue}.json`),
    dispatcher: path.join(args.root, 'scripts', 'loops', 'openclaw-loop-dispatch.mjs'),
    wrapper: path.join(args.root, 'scripts', 'loops', 'openclaw-loop.mjs'),
    notifier: path.join(args.root, 'scripts', 'loops', 'openclaw-loop-notify.mjs'),
    manifest: path.join(args.root, 'runtime', 'loop-engineering-openclaw-install.json'),
    instructions: path.join(args.root, 'AGENTS.md'),
    schedulerService: path.join(systemdUserDir, schedulerUnit),
    schedulerTimer: path.join(systemdUserDir, schedulerTimer)
  };
  const conflicts = [];
  for (const [kind, file] of Object.entries(files)) if (!['instructions', 'workspaceHealth', 'manifest'].includes(kind) && await exists(file)) conflicts.push(path.relative(args.root, file));
  const report = { version: 1, status: args.confirmInstall ? 'installed' : 'plan_only', readOnly: !args.confirmInstall, root: args.root, queue: args.queue, workerAgent: args.workerAgent, workerSelection: worker.selection, availableAgents: worker.availableAgents, workerValidated: true, createsWorkerAgent: false, openclawBin: args.openclawBin, systemctlBin: args.systemctlBin, scheduler: { required: true, unit: schedulerUnit, timer: schedulerTimer }, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.relative(args.root, file)])), conflicts };
  report.next = args.confirmInstall ? 'Run loop-engineering-openclaw-doctor, then route a harmless smoke task.' : 'Review this plan, then rerun with --confirm-install.';
  if (conflicts.length && !args.force && args.confirmInstall) throw new Error(`Refusing to overwrite: ${conflicts.join(', ')}. Use --force after review.`);
  if (args.confirmInstall) {
    await mkdir(path.dirname(files.queueConfig), { recursive: true });
    await mkdir(path.dirname(files.dispatcher), { recursive: true });
    await mkdir(path.join(args.root, 'runtime', 'loops', args.queue), { recursive: true });
    if (!await exists(files.workspaceHealth)) {
      await writeFile(files.workspaceHealth, `${JSON.stringify({
        id: 'workspace-health', goal: 'Keep this workspace loop-ready and detect obvious drift.', level: 'L1', mode: 'report-only',
        maxRuntimeMs: 120000,
        breaker: { maxConsecutiveFailures: 3, sameFailureThreshold: 2 },
        checks: [{ id: 'workspace-root', type: 'files', paths: ['.'] }]
      }, null, 2)}\n`);
    }
    const queueContent = `${JSON.stringify({
      queue: args.queue,
      description: `OpenClaw conversation queue dispatched to agent ${args.workerAgent}.`,
      dispatcher: 'node scripts/loops/openclaw-loop-dispatch.mjs',
      preflightConfig: 'configs/loops/workspace-health.json',
      timeoutMs: 1800000, leaseMs: 1860000, staleActiveMs: 3600000,
      scheduler: { required: true, heartbeatMaxAgeMs: 300000, initialInterval: '1m', minInterval: '1m', maxInterval: '4h', speedupFactor: 0.5, backoffFactor: 2, idleBackoffFactor: 2, humanGateBackoffFactor: 3, longRunHeadroomFactor: 1.25, jitter: '10s' },
      retry: { maxAttempts: 1, runtimeRecoveryMaxAttempts: 2, sessionMaxTicks: 10, retryDelayMs: 0, retryExitCodes: [1], requiresHumanActionPatterns: ['requires human', '需要人工', 'Permission denied', 'Operation not permitted'] },
      revisionPolicy: { enabled: true, maxRevisionRounds: 3, sameFailureThreshold: 2, requireStrategyChange: true }
    }, null, 2)}\n`;
    const dispatcherContent = dispatcherSource(args);
    const wrapperContent = wrapperSource(args);
    const notifierContent = notifierSource(args);
    const schedulerServiceContent = schedulerServiceSource(args);
    const schedulerTimerContent = schedulerTimerSource(args);
    await writeFile(files.queueConfig, queueContent);
    await writeFile(files.dispatcher, dispatcherContent);
    await writeFile(files.wrapper, wrapperContent);
    await writeFile(files.notifier, notifierContent);
    await mkdir(systemdUserDir, { recursive: true });
    await writeFile(files.schedulerService, schedulerServiceContent);
    await writeFile(files.schedulerTimer, schedulerTimerContent);
    const daemonReload = await run(args.systemctlBin, ['--user', 'daemon-reload'], { cwd: args.root });
    if (daemonReload.code !== 0) throw new Error(`Cannot reload user systemd units: ${(daemonReload.stderr || daemonReload.stdout).trim() || `exit ${daemonReload.code}`}`);
    const enableTimer = await run(args.systemctlBin, ['--user', 'enable', '--now', schedulerTimer], { cwd: args.root });
    if (enableTimer.code !== 0) throw new Error(`Cannot enable Loop scheduler timer ${schedulerTimer}: ${(enableTimer.stderr || enableTimer.stdout).trim() || `exit ${enableTimer.code}`}`);
    const instructions = await exists(files.instructions) ? await readFile(files.instructions, 'utf8') : '';
    const managedInstructions = instructionsBlock(args);
    if (!instructions.includes('<!-- loop-engineering:openclaw:start -->')) await appendFile(files.instructions, managedInstructions);
    await mkdir(path.dirname(files.manifest), { recursive: true });
    await writeFile(files.manifest, `${JSON.stringify({
      version: 2, queue: args.queue, workerAgent: args.workerAgent, openclawBin: args.openclawBin, systemctlBin: args.systemctlBin, installedAt: new Date().toISOString(),
      managedFiles: [
        { path: path.relative(args.root, files.queueConfig), sha256: sha256(queueContent) },
        { path: path.relative(args.root, files.dispatcher), sha256: sha256(dispatcherContent) },
        { path: path.relative(args.root, files.wrapper), sha256: sha256(wrapperContent) },
        { path: path.relative(args.root, files.notifier), sha256: sha256(notifierContent) }
      ],
      managedUnits: [
        { path: files.schedulerService, unit: schedulerUnit, sha256: sha256(schedulerServiceContent) },
        { path: files.schedulerTimer, unit: schedulerTimer, sha256: sha256(schedulerTimerContent) }
      ],
      managedInstructions: { path: 'AGENTS.md', sha256: sha256(managedInstructions), content: managedInstructions },
      retainedOnUninstall: [`runtime/loops/${args.queue}`]
    }, null, 2)}\n`);
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : `OpenClaw integration: ${report.status}\nqueue: ${report.queue}\nworker: ${report.workerAgent}\nconflicts: ${report.conflicts.join(', ') || 'none'}\nnext: ${report.next}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
