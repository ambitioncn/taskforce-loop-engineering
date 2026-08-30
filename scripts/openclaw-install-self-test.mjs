#!/usr/bin/env node
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'loop openclaw 安装-'));
const deliveryCapture = path.join(root, 'delivery.json');
const mockOpenClaw = path.join(root, 'mock-openclaw.mjs');
const mockSystemctl = path.join(root, 'mock-systemctl.mjs');
const systemctlCapture = path.join(root, 'systemctl-calls.jsonl');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.SYSTEMCTL_CAPTURE = systemctlCapture;
await writeFile(mockOpenClaw, `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('OpenClaw mock 1.0');
else if (args[0] === 'agents' && args[1] === 'list') console.log(JSON.stringify([{ id: 'builder' }]));
else {
  if (args[0] === 'agent' && process.env.LOOP_CHECKPOINTS_DIR) {
    const dir = path.resolve(process.cwd(), process.env.LOOP_CHECKPOINTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'cp1.json'), JSON.stringify({ version: 1, task_id: process.env.LOOP_TASK_ID, checkpoint_id: 'cp1', status: 'ready_for_acceptance', summary: 'Read-only smoke completed.', files_changed: [], verification: [{ command: 'mock smoke', outcome: 'passed' }], blockers: [], risks: [], next_action: 'acceptance_review' }));
  }
  if (process.env.DELIVERY_CAPTURE) await writeFile(process.env.DELIVERY_CAPTURE, JSON.stringify(args));
  console.log(JSON.stringify({ ok: true, dryRun: args.includes('--dry-run') }));
}
`);
await chmod(mockOpenClaw, 0o755);
await writeFile(mockSystemctl, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
if (process.env.SYSTEMCTL_CAPTURE) await appendFile(process.env.SYSTEMCTL_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
await chmod(mockSystemctl, 0o755);
const installer = new URL('./openclaw-install.mjs', import.meta.url).pathname;
function run(args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installer, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const installBase = ['--root', root, '--queue', 'test-tasks', '--openclaw-bin', mockOpenClaw, '--systemctl-bin', mockSystemctl];
const plan = await run([...installBase, '--json']);
const planReport = JSON.parse(plan.stdout);
if (plan.code !== 0 || planReport.language !== 'en' || planReport.status !== 'plan_only' || planReport.platform !== 'openclaw' || planReport.workerAgent !== 'builder' || planReport.workerSelection !== 'only_available' || !planReport.workerValidated || planReport.createsWorkerAgent || planReport.confirmationSummary?.targetPlatform !== 'OpenClaw' || planReport.confirmationSummary?.writesEnabled !== false || !path.isAbsolute(planReport.confirmationSummary?.platformCli || '') || !planReport.confirmationSummary?.notificationTarget.includes('OpenClaw') || planReport.dashboardAutostart?.gateway !== 'openclaw-gateway.service') throw new Error(`plan failed: ${plan.stderr}`);
const zhPlan = await run([...installBase, '--language', 'zh']);
if (zhPlan.code !== 0 || !zhPlan.stdout.includes('安装确认') || !zhPlan.stdout.includes('目标平台：OpenClaw') || !zhPlan.stdout.includes('允许写入：否（仅生成计划）')) throw new Error('explicit Chinese installation summary missing');
const autoZhPlan = await run([...installBase, '--json'], { ...process.env, LC_ALL: 'zh_CN.UTF-8', LANG: 'C' });
if (autoZhPlan.code !== 0 || JSON.parse(autoZhPlan.stdout).language !== 'zh') throw new Error('Chinese locale was not auto-detected');
const explicitEnglishPlan = await run([...installBase, '--language', 'en', '--json'], { ...process.env, LC_ALL: 'zh_CN.UTF-8' });
if (explicitEnglishPlan.code !== 0 || JSON.parse(explicitEnglishPlan.stdout).language !== 'en') throw new Error('explicit English did not override locale');
const humanPlan = await run(installBase);
if (humanPlan.code !== 0 || !humanPlan.stdout.includes('Installation confirmation') || !humanPlan.stdout.includes('target platform: OpenClaw') || !humanPlan.stdout.includes('writes enabled: no (plan only)')) throw new Error('human-readable OpenClaw confirmation summary missing');
const missingWorker = await run([...installBase, '--worker-agent', 'missing', '--json']);
if (missingWorker.code === 0 || !missingWorker.stderr.includes('does not exist')) throw new Error('installer accepted a missing worker agent');
const install = await run([...installBase, '--worker-agent', 'builder', '--confirm-install', '--json']);
if (install.code !== 0 || JSON.parse(install.stdout).status !== 'installed') throw new Error(`install failed: ${install.stderr}`);
const queue = JSON.parse(await readFile(path.join(root, 'configs/loops/queues/test-tasks.json'), 'utf8'));
if (queue.dispatcher !== 'node scripts/loops/openclaw-loop-dispatch.mjs') throw new Error('dispatcher was not installed');
if (queue.language !== 'en') throw new Error('resolved installation language was not persisted');
if (queue.scheduler?.required !== true || queue.scheduler?.heartbeatMaxAgeMs !== 300000) throw new Error('required scheduler heartbeat was not installed');
const dispatcher = await readFile(path.join(root, 'scripts/loops/openclaw-loop-dispatch.mjs'), 'utf8');
if (!dispatcher.includes('already loop-managed') || !dispatcher.includes("'--agent', \"builder\"") || !dispatcher.includes('LOOP_LATEST_AMENDMENT_FILE') || !dispatcher.includes('LOOP_SESSION_GENERATION') || !dispatcher.includes('-g${sessionGeneration}')) throw new Error('worker, recursion guard, amendment polling, or session generation missing');
if (queue.retry?.runtimeRecoveryMaxAttempts !== 2 || queue.retry?.sessionMaxTicks !== 10) throw new Error('bounded runtime recovery policy was not installed');
const instructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
if (!instructions.includes('Use Loop Engineering to fix this issue') || !instructions.includes('Queue this only; do not run it yet') || /走 loop|只入队|只排队/.test(instructions)) throw new Error('English conversation instructions are missing or contain Chinese routing examples');
const wrapper = await readFile(path.join(root, 'scripts/loops/openclaw-loop.mjs'), 'utf8');
if (!wrapper.includes('--supersede-active') || !wrapper.includes('--amend-active') || !wrapper.includes('--progress-notify-command') || !wrapper.includes('runWhenUnlocked') || wrapper.includes("run-queue-drain', '--config'") || wrapper.includes("spawn('loop-engineering'") || !wrapper.includes('queue-human-input-notify') || !wrapper.includes('queue-terminal-notify') || !wrapper.includes('queue-scheduler-tick') || !wrapper.includes('queue') || !wrapper.includes('continue') || /只入队|只排队|继续当前/.test(wrapper) || !wrapper.includes('requiredSource') || !wrapper.includes('--source-message-id')) throw new Error('supersede/amend routing, source fail-closed policy, localization, absolute CLI, scheduler, live progress, async notification, or queue-only routing missing');
if (!wrapper.includes('process.exitCode = tickCode;') || wrapper.includes('process.exitCode = tickCode || humanNotifyCode || terminalNotifyCode;')) throw new Error('scheduler health still depends on notification delivery');
const missingSourceRoute = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/loops/openclaw-loop.mjs'), 'route', '--message', '用 loop engineering 对齐系统'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stderr }));
});
if (missingSourceRoute.code !== 2 || !missingSourceRoute.stderr.includes('requires conversation metadata')) throw new Error('installed wrapper did not fail closed without source routing');
const serviceFile = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/openclaw-loop-test-tasks-scheduler.service');
const timerFile = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/openclaw-loop-test-tasks-scheduler.timer');
const dashboardServiceFile = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/loop-engineering-dashboard.service');
const dashboardDropIn = path.join(process.env.XDG_CONFIG_HOME, 'systemd/user/openclaw-gateway.service.d/loop-engineering-dashboard.conf');
const service = await readFile(serviceFile, 'utf8');
const timer = await readFile(timerFile, 'utf8');
if (!service.includes('scheduler-tick') || !timer.includes('OnUnitActiveSec=1min')) throw new Error('scheduler systemd units were not installed');
if (!(await readFile(dashboardServiceFile, 'utf8')).includes('dashboard-serve') || !(await readFile(dashboardDropIn, 'utf8')).includes('Wants=loop-engineering-dashboard.service')) throw new Error('OpenClaw installer did not install Dashboard gateway autostart');
if (service.includes('WorkingDirectory="') || service.includes('ExecStart="') || !service.includes('\\x20') || !service.includes('\\xe5\\xae\\x89\\xe8\\xa3\\x85')) throw new Error('scheduler service paths were not encoded with systemd path escapes');
const systemdVerify = await new Promise((resolve) => {
  const child = spawn('systemd-analyze', ['verify', serviceFile, timerFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (systemdVerify.code !== 0) throw new Error(`systemd rejected generated scheduler units: ${systemdVerify.stderr || systemdVerify.stdout}`);
const installSystemctlCalls = await readFile(systemctlCapture, 'utf8');
if (!installSystemctlCalls.includes('["--user","enable","--now","openclaw-loop-test-tasks-scheduler.timer"]')) throw new Error('scheduler timer was not enabled');
const schedulerTick = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/loops/openclaw-loop.mjs'), 'scheduler-tick', '--force-due', '--plan-only'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (schedulerTick.code !== 0) throw new Error(`installed scheduler tick failed: ${schedulerTick.stderr || schedulerTick.stdout}`);
const schedulerState = JSON.parse(await readFile(path.join(root, 'runtime/loops/test-tasks/scheduler/state.json'), 'utf8'));
if (!schedulerState.generatedAt || !schedulerState.nextRunAt) throw new Error('installed scheduler tick did not persist its heartbeat and cadence');
const notifier = await readFile(path.join(root, 'scripts/loops/openclaw-loop-notify.mjs'), 'utf8');
const gateBridge = await readFile(path.join(root, 'scripts/loops/openclaw-loop-gate.mjs'), 'utf8');
if (!gateBridge.includes('feishu_signature_unverified') || !gateBridge.includes('ignored_untrusted_chat') || !gateBridge.includes('handleChannelGateEvent')) throw new Error('installed Human Gate bridge is incomplete');
if (!notifier.includes("'message', 'send'") || !notifier.includes('source.channel') || !notifier.includes('source.target')) throw new Error('channel-neutral notifier missing');
const delivery = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/loops/openclaw-loop-notify.mjs'), 'async result'], {
    cwd: root,
    env: { ...process.env, DELIVERY_CAPTURE: deliveryCapture, LOOP_NOTIFICATION_SOURCE: JSON.stringify({ channel: 'slack', target: 'channel:C123', account: 'work', reply_to: 'M456' }) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stderr }));
});
if (delivery.code !== 0) throw new Error(`notifier delivery failed: ${delivery.stderr}`);
const deliveredArgs = JSON.parse(await readFile(deliveryCapture, 'utf8'));
for (const expected of ['message', 'send', '--channel', 'slack', '--target', 'channel:C123', '--account', 'work', '--reply-to', 'M456', 'async result']) {
  if (!deliveredArgs.includes(expected)) throw new Error(`notifier did not forward ${expected}`);
}
const doctor = new URL('./openclaw-doctor.mjs', import.meta.url).pathname;
const doctorResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [doctor, '--root', root, '--queue', 'test-tasks', '--worker-agent', 'builder', '--openclaw-bin', mockOpenClaw, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (doctorResult.code !== 0) throw new Error(`doctor failed: ${doctorResult.stderr}`);
const doctorReport = JSON.parse(doctorResult.stdout);
if (doctorReport.status !== 'ok' || doctorReport.externalWrite !== false || !doctorReport.checks.some((check) => check.id === 'notification_dry_run' && check.ok) || !doctorReport.checks.some((check) => check.id === 'human_gate_bridge_self_test' && check.ok)) throw new Error('doctor did not complete safe notification and Human Gate self-tests');
const smoke = new URL('./openclaw-smoke.mjs', import.meta.url).pathname;
const smokeSource = await readFile(smoke, 'utf8');
if (!smokeSource.includes('Do not change user or project files, configuration, credentials, or external state.')
  || !smokeSource.includes('Writing the required Loop checkpoint and verification evidence under')
  || !smokeSource.includes('is allowed and required; do not write anywhere else.')
  || !smokeSource.includes('path.relative(args.root, smokeRuntime)')) {
  throw new Error('OpenClaw smoke permission boundary or checkpoint requirement is missing');
}
const loopBin = new URL('../bin/loop-engineering.mjs', import.meta.url).pathname;
const smokeResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [smoke, '--root', root, '--queue', 'test-tasks', '--worker-agent', 'builder', '--openclaw-bin', mockOpenClaw, '--loop-bin', loopBin, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (smokeResult.code !== 0) throw new Error(`smoke failed: ${smokeResult.stderr}`);
const smokeReport = JSON.parse(smokeResult.stdout);
if (smokeReport.status !== 'ok' || smokeReport.externalWrite !== false || !smokeReport.steps.every((step) => step.ok)) throw new Error('end-to-end smoke did not pass safely');
try { await readFile(path.join(root, `configs/loops/queues/${smokeReport.smokeQueue}.json`)); throw new Error('smoke config was not cleaned'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
try { await readFile(path.join(root, `runtime/loops/${smokeReport.smokeQueue}/state.json`)); throw new Error('smoke runtime was not cleaned'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const generated of ['scripts/loops/openclaw-loop-dispatch.mjs', 'scripts/loops/openclaw-loop.mjs', 'scripts/loops/openclaw-loop-notify.mjs', 'scripts/loops/openclaw-loop-gate.mjs']) {
  const syntax = await run(['--help']);
  if (syntax.code !== 0) throw new Error(`installer help failed while checking ${generated}`);
  const check = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', path.join(root, generated)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  if (check.code !== 0) throw new Error(`generated script syntax failed: ${generated}: ${check.stderr}`);
}
const conflict = await run([...installBase, '--worker-agent', 'builder', '--confirm-install', '--json']);
if (conflict.code === 0) throw new Error('installer overwrote existing files without --force');
const manager = new URL('./openclaw-manage.mjs', import.meta.url).pathname;
async function manage(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [manager, '--root', root, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
await writeFile(path.join(root, 'scripts/loops/openclaw-loop.mjs'), `${wrapper}\n// local edit\n`);
const modifiedPlan = await manage(['--action', 'uninstall-plan']);
if (modifiedPlan.code !== 0 || JSON.parse(modifiedPlan.stdout).status !== 'review_required') throw new Error('modified managed file was not detected');
const refusedUninstall = await manage(['--action', 'uninstall', '--confirm-uninstall']);
if (refusedUninstall.code === 0) throw new Error('uninstall removed modified managed content');
await writeFile(path.join(root, 'scripts/loops/openclaw-loop.mjs'), wrapper);
const upgradePlan = await manage(['--action', 'upgrade-plan']);
if (upgradePlan.code !== 0 || JSON.parse(upgradePlan.stdout).status !== 'ready') throw new Error(`upgrade plan failed: ${upgradePlan.stderr}`);
const upgrade = await manage(['--action', 'upgrade', '--confirm-upgrade']);
if (upgrade.code !== 0 || JSON.parse(upgrade.stdout).status !== 'upgraded') throw new Error(`upgrade failed: ${upgrade.stderr}`);
const uninstallPlan = await manage(['--action', 'uninstall-plan']);
if (uninstallPlan.code !== 0 || JSON.parse(uninstallPlan.stdout).status !== 'ready') throw new Error(`uninstall plan failed: ${uninstallPlan.stderr}`);
const uninstall = await manage(['--action', 'uninstall', '--confirm-uninstall']);
if (uninstall.code !== 0 || JSON.parse(uninstall.stdout).status !== 'uninstalled') throw new Error(`uninstall failed: ${uninstall.stderr}`);
if (!await readFile(path.join(root, 'runtime/loops/test-tasks/state.json'), 'utf8').catch(() => 'retained')) throw new Error('unexpected runtime cleanup result');
if (await readFile(path.join(root, 'scripts/loops/openclaw-loop.mjs'), 'utf8').then(() => true).catch(() => false)) throw new Error('managed wrapper survived uninstall');
if (await readFile(serviceFile, 'utf8').then(() => true).catch(() => false) || await readFile(timerFile, 'utf8').then(() => true).catch(() => false)) throw new Error('managed scheduler units survived uninstall');
const finalSystemctlCalls = await readFile(systemctlCapture, 'utf8');
if (!finalSystemctlCalls.includes('["--user","disable","--now","openclaw-loop-test-tasks-scheduler.timer"]')) throw new Error('scheduler timer was not disabled during uninstall');
const zhInstall = await run([...installBase, '--worker-agent', 'builder', '--language', 'zh', '--confirm-install', '--json']);
if (zhInstall.code !== 0 || JSON.parse(zhInstall.stdout).language !== 'zh') throw new Error(`Chinese installation failed: ${zhInstall.stderr}`);
const zhQueue = JSON.parse(await readFile(path.join(root, 'configs/loops/queues/test-tasks.json'), 'utf8'));
const zhInstructions = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
const zhDispatcher = await readFile(path.join(root, 'scripts/loops/openclaw-loop-dispatch.mjs'), 'utf8');
const zhNotifier = await readFile(path.join(root, 'scripts/loops/openclaw-loop-notify.mjs'), 'utf8');
if (zhQueue.language !== 'zh' || !zhInstructions.includes('Loop Engineering 会话路由') || !zhDispatcher.includes('已经由 Loop Engineering 管理') || !zhNotifier.includes('通知器需要消息参数')) throw new Error('Chinese installation did not localize generated configuration and runtime files');
console.log('openclaw installer self-test passed');
