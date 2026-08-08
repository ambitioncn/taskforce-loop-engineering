#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', hermesBin: 'hermes', json: false };
  for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--root') out.root = path.resolve(argv[++i]); else if (arg === '--queue') out.queue = argv[++i]; else if (arg === '--hermes-bin') out.hermesBin = argv[++i]; else if (arg === '--json') out.json = true; else if (arg === '--help' || arg === '-h') out.help = true; else throw new Error(`Unknown argument: ${arg}`); }
  return out;
}
function run(command, args, options = {}) { return new Promise((resolve) => { const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` })); child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })); }); }
async function present(file) { try { await access(file); return true; } catch { return false; } }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: loop-engineering-hermes-doctor [--root workspace] [--queue agent-tasks] [--hermes-bin hermes] [--json]'); return; }
  const required = [`configs/loops/queues/${args.queue}.json`, 'configs/loops/workspace-health.json', 'scripts/loops/hermes-loop-dispatch.mjs', 'scripts/loops/hermes-loop.mjs', 'scripts/loops/hermes-loop-notify.mjs', 'runtime/loop-engineering-hermes-install.json', 'AGENTS.md'];
  const checks = []; for (const relative of required) checks.push({ id: `file:${relative}`, ok: await present(path.join(args.root, relative)) });
  const cli = await run(args.hermesBin, ['--version'], { cwd: args.root }); checks.push({ id: 'hermes_cli', ok: cli.code === 0, detail: (cli.stdout || cli.stderr).trim().slice(0, 300) });
  const sendHelp = await run(args.hermesBin, ['send', '--help'], { cwd: args.root }); checks.push({ id: 'hermes_send', ok: sendHelp.code === 0, detail: (sendHelp.stdout || sendHelp.stderr).trim().slice(0, 300) });
  const queueFile = path.join(args.root, `configs/loops/queues/${args.queue}.json`);
  if (await present(queueFile)) { try { const queue = JSON.parse(await readFile(queueFile, 'utf8')); checks.push({ id: 'queue_config', ok: queue.queue === args.queue && queue.dispatcher === 'node scripts/loops/hermes-loop-dispatch.mjs' }); } catch (error) { checks.push({ id: 'queue_config', ok: false, detail: error.message }); } }
  const notifier = path.join(args.root, 'scripts/loops/hermes-loop-notify.mjs');
  if (await present(notifier)) { const dry = await run(process.execPath, [notifier, 'Loop Engineering notification dry-run'], { cwd: args.root, env: { ...process.env, LOOP_NOTIFICATION_DRY_RUN: '1', LOOP_NOTIFICATION_SOURCE: JSON.stringify({ channel: 'telegram', target: 'telegram:loop-doctor-dry-run' }) } }); checks.push({ id: 'notification_dry_run', ok: dry.code === 0 && dry.stdout.includes('"dryRun":true'), detail: (dry.stdout || dry.stderr).trim().slice(0, 500) }); }
  const failed = checks.filter((check) => !check.ok); const report = { version: 1, platform: 'hermes', status: failed.length ? 'fail' : 'ok', readOnly: true, externalWrite: false, root: args.root, queue: args.queue, checks, failed: failed.map((check) => check.id) };
  console.log(args.json ? JSON.stringify(report, null, 2) : `Hermes Loop doctor: ${report.status}\nchecks: ${checks.length - failed.length}/${checks.length}\nfailed: ${report.failed.join(', ') || 'none'}`); if (failed.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
