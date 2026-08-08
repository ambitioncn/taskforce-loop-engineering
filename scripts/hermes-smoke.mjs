#!/usr/bin/env node
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', hermesBin: 'hermes', loopBin: 'loop-engineering', json: false, keepArtifacts: false };
  for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--root') out.root = path.resolve(argv[++i]); else if (arg === '--queue') out.queue = argv[++i]; else if (arg === '--hermes-bin') out.hermesBin = argv[++i]; else if (arg === '--loop-bin') out.loopBin = argv[++i]; else if (arg === '--keep-artifacts') out.keepArtifacts = true; else if (arg === '--json') out.json = true; else if (arg === '--help' || arg === '-h') out.help = true; else throw new Error(`Unknown argument: ${arg}`); }
  return out;
}
function run(command, args, options = {}) { return new Promise((resolve) => { const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` })); child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })); }); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function safeId(value) { if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('queue contains unsupported characters.'); return value; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: loop-engineering-hermes-smoke [--root workspace] [--queue agent-tasks] [--hermes-bin hermes] [--loop-bin loop-engineering] [--keep-artifacts] [--json]'); return; }
  safeId(args.queue); const runToken = `${Date.now()}-${process.pid}`; const smokeQueue = `smoke-${args.queue}-${runToken}`;
  const baseConfig = path.join(args.root, `configs/loops/queues/${args.queue}.json`); const smokeConfig = path.join(args.root, `configs/loops/queues/${smokeQueue}.json`); const smokeRuntime = path.join(args.root, 'runtime', 'loops', smokeQueue); const doctorScript = new URL('./hermes-doctor.mjs', import.meta.url).pathname;
  const steps = []; let taskId = null;
  try {
    const doctor = await run(process.execPath, [doctorScript, '--root', args.root, '--queue', args.queue, '--hermes-bin', args.hermesBin, '--json'], { cwd: args.root }); steps.push({ id: 'doctor', ok: doctor.code === 0 }); if (doctor.code !== 0) throw new Error(`doctor failed: ${doctor.stderr || doctor.stdout}`);
    const config = JSON.parse(await readFile(baseConfig, 'utf8')); config.queue = smokeQueue; config.description = 'Temporary read-only Hermes integration smoke queue.'; config.retry = { ...(config.retry || {}), maxAttempts: 1 }; await mkdir(path.dirname(smokeConfig), { recursive: true }); await writeFile(smokeConfig, `${JSON.stringify(config, null, 2)}\n`);
    const message = '走 loop：Perform a read-only Hermes integration smoke. Do not change files or external state. Report SMOKE_OK with verification evidence.';
    const route = await run(args.loopBin, ['route-message', '--root', args.root, '--queue', smokeQueue, '--message', message, '--route', '--confirm-execute', '--source-channel', 'telegram', '--source-target', 'telegram:loop-smoke-dry-run', '--source-message-id', `smoke-${runToken}`, '--json'], { cwd: args.root }); steps.push({ id: 'route', ok: route.code === 0 }); if (route.code !== 0) throw new Error(`route failed: ${route.stderr || route.stdout}`);
    taskId = JSON.parse(route.stdout).task?.id || null;
    const execute = await run(args.loopBin, ['run-queue', '--root', args.root, '--config', path.relative(args.root, smokeConfig), '--json'], { cwd: args.root }); steps.push({ id: 'worker_execution', ok: execute.code === 0 }); if (execute.code !== 0) throw new Error(`worker execution failed: ${execute.stderr || execute.stdout}`);
    const taskDir = taskId ? path.join(smokeRuntime, 'tasks', taskId) : '';
    for (const artifact of ['task_contract.json', 'dev_plan.json', 'acceptance_plan.json', 'final_judgement.json']) { const ok = Boolean(taskDir) && await exists(path.join(taskDir, artifact)); steps.push({ id: `artifact:${artifact}`, ok }); if (!ok) throw new Error(`missing smoke artifact: ${artifact}`); }
    const notifyEnv = { ...process.env, LOOP_NOTIFICATION_DRY_RUN: '1' }; const notifyCommand = 'node scripts/loops/hermes-loop-notify.mjs';
    const humanNotify = await run(args.loopBin, ['queue-human-input-notify', '--root', args.root, '--queue', smokeQueue, '--notify-command', notifyCommand, '--json'], { cwd: args.root, env: notifyEnv }); steps.push({ id: 'human_gate_scan', ok: humanNotify.code === 0 });
    const terminalNotify = await run(args.loopBin, ['queue-terminal-notify', '--root', args.root, '--queue', smokeQueue, '--notify-command', notifyCommand, '--json'], { cwd: args.root, env: notifyEnv }); const terminal = terminalNotify.code === 0 ? JSON.parse(terminalNotify.stdout) : null; const terminalOk = terminalNotify.code === 0 && terminal?.sent === 1; steps.push({ id: 'terminal_dry_run_return', ok: terminalOk }); if (!terminalOk) throw new Error(`terminal dry-run failed: ${terminalNotify.stderr || terminalNotify.stdout}`);
    const report = { version: 1, platform: 'hermes', status: 'ok', readOnlyTask: true, externalWrite: false, queue: args.queue, smokeQueue, taskId, steps, keptArtifacts: args.keepArtifacts };
    console.log(args.json ? JSON.stringify(report, null, 2) : `Hermes Loop smoke: ok\ntask: ${taskId}\nexternal write: no\nartifacts: ${args.keepArtifacts ? smokeRuntime : 'cleaned'}`);
  } finally { if (!args.keepArtifacts && smokeQueue.startsWith(`smoke-${args.queue}-`)) { await rm(smokeConfig, { force: true }); await rm(smokeRuntime, { recursive: true, force: true }); } }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
