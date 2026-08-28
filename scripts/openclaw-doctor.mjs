#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', workerAgent: 'main', openclawBin: 'openclaw', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--queue') out.queue = argv[++i];
    else if (arg === '--worker-agent') out.workerAgent = argv[++i];
    else if (arg === '--openclaw-bin') out.openclawBin = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

async function present(file) { try { await access(file); return true; } catch { return false; } }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: loop-engineering-openclaw-doctor [--root workspace] [--queue agent-tasks] [--worker-agent main] [--openclaw-bin openclaw] [--json]');
    return;
  }
  const required = [
    `configs/loops/queues/${args.queue}.json`,
    'configs/loops/workspace-health.json',
    'scripts/loops/openclaw-loop-dispatch.mjs',
    'scripts/loops/openclaw-loop.mjs',
    'scripts/loops/openclaw-loop-notify.mjs',
    'AGENTS.md'
  ];
  const systemdUserDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  required.push(
    path.relative(args.root, path.join(systemdUserDir, 'loop-engineering-dashboard.service')),
    path.relative(args.root, path.join(systemdUserDir, 'openclaw-gateway.service.d', 'loop-engineering-dashboard.conf'))
  );
  const checks = [];
  for (const relative of required) checks.push({ id: `file:${relative}`, ok: await present(path.join(args.root, relative)) });
  const cli = await run(args.openclawBin, ['--version'], { cwd: args.root });
  checks.push({ id: 'openclaw_cli', ok: cli.code === 0, detail: (cli.stdout || cli.stderr).trim().slice(0, 300) });
  const agentsResult = await run(args.openclawBin, ['agents', 'list', '--json'], { cwd: args.root });
  let agents = [];
  try { agents = JSON.parse(agentsResult.stdout); } catch { /* reported below */ }
  checks.push({ id: 'worker_agent', ok: agentsResult.code === 0 && Array.isArray(agents) && agents.some((agent) => agent?.id === args.workerAgent), detail: args.workerAgent });
  const queueFile = path.join(args.root, `configs/loops/queues/${args.queue}.json`);
  if (await present(queueFile)) {
    try {
      const queue = JSON.parse(await readFile(queueFile, 'utf8'));
      checks.push({ id: 'queue_config', ok: queue.queue === args.queue && queue.dispatcher === 'node scripts/loops/openclaw-loop-dispatch.mjs' });
    } catch (error) { checks.push({ id: 'queue_config', ok: false, detail: error.message }); }
  }
  const notifier = path.join(args.root, 'scripts/loops/openclaw-loop-notify.mjs');
  if (await present(notifier)) {
    const smoke = await run(process.execPath, [notifier, 'Loop Engineering notification dry-run'], {
      cwd: args.root,
      env: { ...process.env, LOOP_NOTIFICATION_DRY_RUN: '1', LOOP_NOTIFICATION_SOURCE: JSON.stringify({ channel: 'feishu', target: 'user:loop-doctor-dry-run', account: 'doctor', reply_to: 'doctor-message' }) }
    });
    checks.push({ id: 'notification_dry_run', ok: smoke.code === 0, detail: (smoke.stdout || smoke.stderr).trim().slice(0, 500) });
  }
  const failed = checks.filter((check) => !check.ok);
  const report = { version: 1, status: failed.length ? 'fail' : 'ok', readOnly: true, externalWrite: false, root: args.root, queue: args.queue, workerAgent: args.workerAgent, checks, failed: failed.map((check) => check.id) };
  console.log(args.json ? JSON.stringify(report, null, 2) : `OpenClaw Loop doctor: ${report.status}\nchecks: ${checks.length - failed.length}/${checks.length}\nfailed: ${report.failed.join(', ') || 'none'}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
