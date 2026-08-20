#!/usr/bin/env node
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'loop hermes 安装-'));
const mockHermes = path.join(root, 'mock-hermes.mjs'); const mockSystemctl = path.join(root, 'mock-systemctl.mjs'); const systemctlCapture = path.join(root, 'systemctl.jsonl'); const sendCapture = path.join(root, 'send.json');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg'); process.env.SYSTEMCTL_CAPTURE = systemctlCapture;
await writeFile(path.join(root, 'AGENTS.md'), '# Test workspace\n');
await writeFile(mockHermes, `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('Hermes Agent v0.20.0');
else if (args[0] === 'send' && args.includes('--help')) console.log('hermes send --to TARGET MESSAGE');
else if (args[0] === 'send') { if (process.env.HERMES_SEND_CAPTURE) await writeFile(process.env.HERMES_SEND_CAPTURE, JSON.stringify(args)); console.log('sent'); }
else if (args.includes('-z')) {
  if (process.env.LOOP_CHECKPOINTS_DIR) { const dir = path.resolve(process.cwd(), process.env.LOOP_CHECKPOINTS_DIR); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'cp1.json'), JSON.stringify({ version: 1, task_id: process.env.LOOP_TASK_ID, checkpoint_id: 'cp1', status: 'ready_for_acceptance', summary: 'Hermes read-only smoke completed.', files_changed: [], verification: [{ command: 'mock hermes smoke', outcome: 'passed' }], blockers: [], risks: [], next_action: 'acceptance_review' })); }
  console.log('SMOKE_OK');
} else process.exitCode = 2;
`); await chmod(mockHermes, 0o755);
await writeFile(mockSystemctl, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
if (process.env.SYSTEMCTL_CAPTURE) await appendFile(process.env.SYSTEMCTL_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`); await chmod(mockSystemctl, 0o755);
function run(command, args, options = {}) { return new Promise((resolve) => { const child = spawn(command, args, { cwd: options.cwd || root, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('close', (code) => resolve({ code, stdout, stderr })); }); }
const installer = new URL('./hermes-install.mjs', import.meta.url).pathname; const doctor = new URL('./hermes-doctor.mjs', import.meta.url).pathname; const smoke = new URL('./hermes-smoke.mjs', import.meta.url).pathname; const loopBin = new URL('../bin/loop-engineering.mjs', import.meta.url).pathname;
const base = ['--root', root, '--queue', 'hermes-tasks', '--hermes-bin', mockHermes, '--systemctl-bin', mockSystemctl];
const plan = await run(process.execPath, [installer, ...base, '--json']); const planReport = JSON.parse(plan.stdout); if (plan.code !== 0 || planReport.status !== 'plan_only' || planReport.confirmationSummary?.targetPlatform !== 'Hermes' || planReport.confirmationSummary?.writesEnabled !== false || !path.isAbsolute(planReport.confirmationSummary?.platformCli || '') || !planReport.confirmationSummary?.notificationTarget.includes('Hermes')) throw new Error(`Hermes install plan failed: ${plan.stderr}`);
const humanPlan = await run(process.execPath, [installer, ...base]); if (humanPlan.code !== 0 || !humanPlan.stdout.includes('Installation confirmation') || !humanPlan.stdout.includes('target platform: Hermes') || !humanPlan.stdout.includes('writes enabled: no (plan only)')) throw new Error('human-readable Hermes confirmation summary missing');
const install = await run(process.execPath, [installer, ...base, '--confirm-install', '--json']); if (install.code !== 0 || JSON.parse(install.stdout).status !== 'installed') throw new Error(`Hermes install failed: ${install.stderr}`);
const queue = JSON.parse(await readFile(path.join(root, 'configs/loops/queues/hermes-tasks.json'), 'utf8')); if (queue.dispatcher !== 'node scripts/loops/hermes-loop-dispatch.mjs' || queue.scheduler?.required !== true) throw new Error('Hermes queue wiring missing');
const instructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8'); if (!instructions.includes('Use Loop Engineering to fix this issue') || !instructions.includes('Queue this only; do not run it yet') || /走 loop|只入队|只排队/.test(instructions)) throw new Error('Hermes English conversation instructions are missing or contain Chinese routing examples');
const wrapper = await readFile(path.join(root, 'scripts/loops/hermes-loop.mjs'), 'utf8'); if (!wrapper.includes('queue') || !wrapper.includes('continue') || /只入队|只排队|继续当前/.test(wrapper)) throw new Error('Hermes English wrapper routing was not fully localized');
if (!wrapper.includes('process.exitCode = tickCode;') || wrapper.includes('process.exitCode = tickCode || humanCode || terminalCode;')) throw new Error('Hermes scheduler health still depends on notification delivery');
const dispatcher = await readFile(path.join(root, 'scripts/loops/hermes-loop-dispatch.mjs'), 'utf8'); if (!dispatcher.includes("'-z', prompt")) throw new Error('Hermes one-shot dispatcher missing');
const notifier = path.join(root, 'scripts/loops/hermes-loop-notify.mjs'); const notify = await run(process.execPath, [notifier, 'hello from loop'], { env: { ...process.env, HERMES_SEND_CAPTURE: sendCapture, LOOP_NOTIFICATION_SOURCE: JSON.stringify({ channel: 'telegram', target: 'telegram:12345' }) } }); if (notify.code !== 0) throw new Error(`Hermes notifier failed: ${notify.stderr}`);
const sent = JSON.parse(await readFile(sendCapture, 'utf8')); if (!sent.includes('telegram:12345') || !sent.includes('hello from loop')) throw new Error('Hermes notifier did not preserve delivery target/message');
const serviceFile = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/hermes-loop-hermes-tasks-scheduler.service'); const timerFile = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/hermes-loop-hermes-tasks-scheduler.timer'); const service = await readFile(serviceFile, 'utf8'); if (service.includes('WorkingDirectory="') || !service.includes('\\x20') || !service.includes('\\xe5\\xae\\x89\\xe8\\xa3\\x85')) throw new Error('Hermes systemd paths were not escaped');
const verify = await run('systemd-analyze', ['verify', serviceFile, timerFile]); if (verify.code !== 0) throw new Error(`Hermes systemd units invalid: ${verify.stderr || verify.stdout}`);
const doctorResult = await run(process.execPath, [doctor, '--root', root, '--queue', 'hermes-tasks', '--hermes-bin', mockHermes, '--json']); if (doctorResult.code !== 0 || JSON.parse(doctorResult.stdout).status !== 'ok') throw new Error(`Hermes doctor failed: ${doctorResult.stderr || doctorResult.stdout}`);
const smokeResult = await run(process.execPath, [smoke, '--root', root, '--queue', 'hermes-tasks', '--hermes-bin', mockHermes, '--loop-bin', loopBin, '--json']); if (smokeResult.code !== 0 || JSON.parse(smokeResult.stdout).status !== 'ok') throw new Error(`Hermes smoke failed: ${smokeResult.stderr || smokeResult.stdout}`);
const calls = await readFile(systemctlCapture, 'utf8'); if (!calls.includes('["--user","enable","--now","hermes-loop-hermes-tasks-scheduler.timer"]')) throw new Error('Hermes scheduler timer was not enabled');
console.log('hermes installer self-test passed');
