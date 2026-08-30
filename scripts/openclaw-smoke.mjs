#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', workerAgent: 'main', openclawBin: 'openclaw', loopBin: 'loop-engineering', json: false, keepArtifacts: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--queue') out.queue = argv[++i];
    else if (arg === '--worker-agent') out.workerAgent = argv[++i];
    else if (arg === '--openclaw-bin') out.openclawBin = argv[++i];
    else if (arg === '--loop-bin') out.loopBin = argv[++i];
    else if (arg === '--keep-artifacts') out.keepArtifacts = true;
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

async function exists(file) { try { await access(file); return true; } catch { return false; } }
function safeId(value) { if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('queue contains unsupported characters.'); return value; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: loop-engineering-openclaw-smoke [--root workspace] [--queue agent-tasks] [--worker-agent main] [--openclaw-bin openclaw] [--loop-bin loop-engineering] [--keep-artifacts] [--json]');
    return;
  }
  safeId(args.queue);
  const runToken = `${Date.now()}-${process.pid}`;
  const smokeQueue = `smoke-${args.queue}-${runToken}`;
  const baseConfig = path.join(args.root, `configs/loops/queues/${args.queue}.json`);
  const smokeConfig = path.join(args.root, `configs/loops/queues/${smokeQueue}.json`);
  const smokeRuntime = path.join(args.root, 'runtime', 'loops', smokeQueue);
  const doctorScript = new URL('./openclaw-doctor.mjs', import.meta.url).pathname;
  const steps = [];
  let taskId = null;
  try {
    const doctor = await run(process.execPath, [doctorScript, '--root', args.root, '--queue', args.queue, '--worker-agent', args.workerAgent, '--openclaw-bin', args.openclawBin, '--json'], { cwd: args.root });
    steps.push({ id: 'doctor', ok: doctor.code === 0 });
    if (doctor.code !== 0) throw new Error(`doctor failed: ${doctor.stderr || doctor.stdout}`);
    const doctorReport = JSON.parse(doctor.stdout);
    const gateSelfTestOk = doctorReport.checks?.some((check) => check.id === 'human_gate_bridge_self_test' && check.ok);
    steps.push({ id: 'human_gate_bridge_self_test', ok: gateSelfTestOk === true });
    if (!gateSelfTestOk) throw new Error('doctor did not verify the installed Human Gate bridge');
    const config = JSON.parse(await readFile(baseConfig, 'utf8'));
    config.queue = smokeQueue;
    config.description = 'Temporary read-only OpenClaw integration smoke queue.';
    config.retry = { ...(config.retry || {}), maxAttempts: 1 };
    await mkdir(path.dirname(smokeConfig), { recursive: true });
    await writeFile(smokeConfig, `${JSON.stringify(config, null, 2)}\n`);
    const smokeRuntimeRel = path.relative(args.root, smokeRuntime);
    const message = `走 loop：Perform a read-only integration smoke. Do not change user or project files, configuration, credentials, or external state. Writing the required Loop checkpoint and verification evidence under ${smokeRuntimeRel}/ is allowed and required; do not write anywhere else. Report SMOKE_OK with verification evidence.`;
    const route = await run(args.loopBin, ['route-message', '--root', args.root, '--queue', smokeQueue, '--message', message, '--route', '--confirm-execute', '--source-channel', 'feishu', '--source-target', 'user:loop-smoke-dry-run', '--source-account', 'doctor', '--source-message-id', `smoke-${runToken}`, '--source-reply-to', `smoke-${runToken}`, '--json'], { cwd: args.root });
    steps.push({ id: 'route', ok: route.code === 0 });
    if (route.code !== 0) throw new Error(`route failed: ${route.stderr || route.stdout}`);
    const routed = JSON.parse(route.stdout);
    taskId = routed.task?.id || null;
    const execute = await run(args.loopBin, ['run-queue', '--root', args.root, '--config', path.relative(args.root, smokeConfig), '--json'], { cwd: args.root });
    steps.push({ id: 'worker_execution', ok: execute.code === 0 });
    if (execute.code !== 0) throw new Error(`worker execution failed: ${execute.stderr || execute.stdout}`);
    const taskDir = taskId ? path.join(smokeRuntime, 'tasks', taskId) : '';
    for (const artifact of ['task_contract.json', 'dev_plan.json', 'acceptance_plan.json', 'final_judgement.json']) {
      const ok = Boolean(taskDir) && await exists(path.join(taskDir, artifact));
      steps.push({ id: `artifact:${artifact}`, ok });
      if (!ok) throw new Error(`missing smoke artifact: ${artifact}`);
    }
    const notifyEnv = { ...process.env, LOOP_NOTIFICATION_DRY_RUN: '1' };
    const notifyCommand = 'node scripts/loops/openclaw-loop-notify.mjs';
    const humanNotify = await run(args.loopBin, ['queue-human-input-notify', '--root', args.root, '--queue', smokeQueue, '--notify-command', notifyCommand, '--json'], { cwd: args.root, env: notifyEnv });
    steps.push({ id: 'human_gate_scan', ok: humanNotify.code === 0 });
    const terminalNotify = await run(args.loopBin, ['queue-terminal-notify', '--root', args.root, '--queue', smokeQueue, '--notify-command', notifyCommand, '--json'], { cwd: args.root, env: notifyEnv });
    const terminal = terminalNotify.code === 0 ? JSON.parse(terminalNotify.stdout) : null;
    const terminalOk = terminalNotify.code === 0 && terminal?.sent === 1;
    steps.push({ id: 'terminal_dry_run_return', ok: terminalOk });
    if (!terminalOk) throw new Error(`terminal dry-run failed: ${terminalNotify.stderr || terminalNotify.stdout}`);
    const report = { version: 1, status: 'ok', readOnlyTask: true, externalWrite: false, queue: args.queue, smokeQueue, workerAgent: args.workerAgent, taskId, steps, keptArtifacts: args.keepArtifacts };
    console.log(args.json ? JSON.stringify(report, null, 2) : `OpenClaw Loop smoke: ok\ntask: ${taskId}\nexternal write: no\nartifacts: ${args.keepArtifacts ? smokeRuntime : 'cleaned'}`);
  } finally {
    if (!args.keepArtifacts) {
      if (smokeQueue.startsWith(`smoke-${args.queue}-`)) {
        await rm(smokeConfig, { force: true });
        await rm(smokeRuntime, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
