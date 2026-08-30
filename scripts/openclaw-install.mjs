#!/usr/bin/env node
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), queue: 'agent-tasks', workerAgent: null, openclawBin: 'openclaw', systemctlBin: 'systemctl', dashboardListen: 'localhost', tailscaleBin: 'tailscale', language: 'auto', json: false, confirmInstall: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--queue') out.queue = argv[++i];
    else if (arg === '--worker-agent') out.workerAgent = argv[++i];
    else if (arg === '--openclaw-bin') out.openclawBin = argv[++i];
    else if (arg === '--systemctl-bin') out.systemctlBin = argv[++i];
    else if (arg === '--dashboard-listen') out.dashboardListen = argv[++i];
    else if (arg === '--tailscale-bin') out.tailscaleBin = argv[++i];
    else if (arg === '--language') out.language = argv[++i];
    else if (arg === '--confirm-install') out.confirmInstall = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['localhost', 'tailscale'].includes(out.dashboardListen)) throw new Error('--dashboard-listen must be localhost or tailscale.');
  return out;
}

function resolveLanguage(requested = 'auto', env = process.env) {
  if (!['auto', 'en', 'zh'].includes(requested)) throw new Error('--language must be auto, en, or zh.');
  if (requested !== 'auto') return requested;
  const locale = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').toLowerCase();
  return /(^|[_.-])zh(?:[_-]|\.|$)/.test(locale) || locale.startsWith('zh') ? 'zh' : 'en';
}

const text = (language, en, zh) => language === 'zh' ? zh : en;

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

async function resolveExecutable(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const resolved = path.resolve(command);
    if (!await exists(resolved)) throw new Error(`Executable not found: ${resolved}`);
    return resolved;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Executable not found on PATH: ${command}`);
}

function formatConfirmationSummary(summary, language) {
  if (language === 'zh') return [
    '安装确认',
    `  目标平台：${summary.targetPlatform}`,
    `  平台 CLI：${summary.platformCli}`,
    `  工作区：${summary.workspace}`,
    `  队列：${summary.queue}`,
    `  调度器：${summary.scheduler}`,
    `  通知目标：${summary.notificationTarget}`,
    `  允许写入：${summary.writesEnabled ? '是' : '否（仅生成计划）'}`
  ].join('\n');
  return [
    'Installation confirmation',
    `  target platform: ${summary.targetPlatform}`,
    `  platform CLI: ${summary.platformCli}`,
    `  workspace: ${summary.workspace}`,
    `  queue: ${summary.queue}`,
    `  scheduler: ${summary.scheduler}`,
    `  notification target: ${summary.notificationTarget}`,
    `  writes enabled: ${summary.writesEnabled ? 'yes' : 'no (plan only)'}`
  ].join('\n');
}

function dispatcherSource({ workerAgent, openclawBin, language }) {
  const promptLines = language === 'zh' ? [
    '你收到的是一个已经由 Loop Engineering 管理的任务。',
    '不要再次路由或入队，即使引用的用户请求中包含 loop 触发词。',
    '实施前先阅读任务合同、开发计划和验收计划。'
  ] : [
    'You are receiving an already loop-managed task.',
    'Do not route or enqueue this task again, even if its quoted request contains a loop trigger.',
    'Read the task contract, development plan, and acceptance plan before implementation.'
  ];
  const labels = language === 'zh' ? {
    taskId: '任务 ID', taskContract: '任务合同', devPlan: '开发计划', acceptancePlan: '验收计划',
    amendments: '实时补充要求', checkpoints: '检查点目录', missing: '未提供',
    reread: '写入每个检查点以及最终完成前，如果实时补充要求文件存在，请重新读取。所有已记录的补充要求都是任务合同和验收标准的一部分。',
    finish: '尽可能写入检查点，并包含最新已应用的 amendment_version。最终报告必须包含状态、证据、验证、阻塞和下一步。'
  } : {
    taskId: 'Task id', taskContract: 'Task contract', devPlan: 'Development plan', acceptancePlan: 'Acceptance plan',
    amendments: 'Live amendments', checkpoints: 'Checkpoints dir', missing: 'not provided',
    reread: 'Before writing each checkpoint and before final completion, reread the live amendment file if it exists. Treat every recorded amendment as part of the task contract and acceptance criteria.',
    finish: 'Write a checkpoint when possible. Include the latest amendment_version applied. Finish with status, evidence, verification, blockers, and next action.'
  };
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const task = JSON.parse(await readFile(process.env.LOOP_TASK_FILE, 'utf8'));
const sessionGeneration = Number.parseInt(process.env.LOOP_SESSION_GENERATION || '0', 10) || 0;
const prompt = [
  ${promptLines.map((line) => JSON.stringify(line)).join(',\n  ')},
  \`${labels.taskId}: \${task.id}\`,
  \`${labels.taskContract}: \${process.env.LOOP_TASK_CONTRACT_FILE || ${JSON.stringify(labels.missing)}}\`,
  \`${labels.devPlan}: \${process.env.LOOP_DEV_PLAN_FILE || ${JSON.stringify(labels.missing)}}\`,
  \`${labels.acceptancePlan}: \${process.env.LOOP_ACCEPTANCE_PLAN_FILE || ${JSON.stringify(labels.missing)}}\`,
  \`${labels.amendments}: \${process.env.LOOP_LATEST_AMENDMENT_FILE || ${JSON.stringify(labels.missing)}}\`,
  \`${labels.checkpoints}: \${process.env.LOOP_CHECKPOINTS_DIR || ${JSON.stringify(labels.missing)}}\`,
  '', task.body, '',
  ${JSON.stringify(labels.reread)},
  ${JSON.stringify(labels.finish)}
].join('\\n');
const child = spawn(${JSON.stringify(openclawBin)}, [
  'agent', '--agent', ${JSON.stringify(workerAgent)},
  '--session-key', \`agent:${workerAgent}:loop-task-\${task.id}-g\${sessionGeneration}\`,
  '--message', prompt, '--json', '--timeout', '1800'
], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
`;
}

function wrapperSource({ queue, loopBin, language }) {
  const missingSourceError = text(language, 'loop route requires conversation metadata', 'loop 路由需要会话来源元数据');
  const usage = text(language, 'Usage: node scripts/loops/openclaw-loop.mjs route --message "Use loop: task" [source metadata]', '用法：node scripts/loops/openclaw-loop.mjs route --message "走 loop：任务" [来源元数据]');
  const amendmentPattern = language === 'zh'
    ? '(?:继续(?:当前|这个)?\\s*loop|给(?:当前|这个)?\\s*loop\\s*(?:补充|增加|加)|补充当前\\s*loop)'
    : '(?:continue\\s+(?:the\\s+)?(?:current\\s+)?loop|amend\\s+(?:the\\s+)?(?:current\\s+)?loop|add\\s+(?:this\\s+)?amendment\\s+to\\s+(?:the\\s+)?(?:current\\s+)?loop)';
  const queueOnlyPattern = language === 'zh'
    ? '(?:只入队|只排队|暂不执行|不立即执行)'
    : '(?:queue\\s+(?:this|it)\\s+only|only\\s+queue\\s+(?:this|it)|enqueue\\s+(?:this|it)\\s+only|do\\s+not\\s+(?:run|execute)\\s+(?:this|it)\\s+(?:yet|now))';
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
  const optionValue = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? String(rest[index + 1] || '').trim() : '';
  };
  const requiredSource = ['--source-channel', '--source-target', '--source-account', '--source-message-id'];
  const missingSource = requiredSource.filter((name) => !optionValue(name));
  if (missingSource.length) {
    console.error(\`${missingSourceError}: \${missingSource.join(', ')}\`);
    process.exitCode = 2;
    process.exit();
  }
  const amendment = new RegExp(${JSON.stringify(amendmentPattern)}, 'i').test(message);
  const routeMode = amendment ? '--amend-active' : '--supersede-active';
  const routeCode = await run(['route-message', '--queue', ${JSON.stringify(queue)}, '--route', '--confirm-execute', routeMode, ...rest]);
  const queueOnly = new RegExp(${JSON.stringify(queueOnlyPattern)}, 'i').test(message);
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
  process.exitCode = tickCode;
} else {
  console.error(${JSON.stringify(usage)});
  process.exitCode = 1;
}
`;
}

function gateBridgeSource({ humanGateAdapter }) {
  return `#!/usr/bin/env node
import { handleChannelGateEvent, normalizeFeishuGateEvent } from ${JSON.stringify(humanGateAdapter)};
if (process.argv.includes('--self-test')) {
  let rejected = false;
  try { normalizeFeishuGateEvent({ event: {} }); } catch (error) { rejected = error?.message === 'feishu_signature_unverified'; }
  if (!rejected) throw new Error('feishu_signature_boundary_not_fail_closed');
  const ignored = await handleChannelGateEvent(process.env.LOOP_WORKSPACE_ROOT || process.cwd(), { kind: 'ordinary_message', text: 'approve the first one' });
  if (ignored.outcome !== 'ignored_untrusted_chat') throw new Error('ordinary_chat_not_fail_closed');
  process.stdout.write(JSON.stringify({ status: 'ok', externalWrite: false, signatureBoundary: 'fail_closed', ordinaryChat: 'ignored' }) + '\\n');
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (!chunks.length) throw new Error('gate_event_required_on_stdin');
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const channel = String(process.env.LOOP_GATE_CHANNEL || payload.channel || '').toLowerCase();
const event = channel === 'feishu'
  ? normalizeFeishuGateEvent(payload, { signatureVerified: process.env.LOOP_FEISHU_SIGNATURE_VERIFIED === '1' })
  : payload;
const result = await handleChannelGateEvent(process.env.LOOP_WORKSPACE_ROOT || process.cwd(), event);
process.stdout.write(JSON.stringify(result) + '\\n');
`;
}

function schedulerServiceSource({ root, queue, language }) {
  return `[Unit]\nDescription=${text(language, `Taskforce Loop Engineering scheduler for ${queue}`, `${queue} 的 Taskforce Loop Engineering 调度器`)}\nAfter=default.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${systemdEscapePath(root)}\nExecStart=${systemdEscapePath(process.execPath)} ${systemdEscapePath(path.join(root, 'scripts', 'loops', 'openclaw-loop.mjs'))} scheduler-tick --json\n`;
}

function schedulerTimerSource({ queue, language }) {
  return `[Unit]\nDescription=${text(language, `Wake Taskforce Loop Engineering scheduler for ${queue}`, `唤醒 ${queue} 的 Taskforce Loop Engineering 调度器`)}\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=1min\nAccuracySec=10s\nPersistent=true\nUnit=openclaw-loop-${queue}-scheduler.service\n\n[Install]\nWantedBy=timers.target\n`;
}

function notifierSource({ openclawBin, language }) {
  const missingMessage = text(language, 'loop notifier requires a message argument.', 'loop 通知器需要消息参数。');
  const invalidSource = text(language, 'loop notifier received invalid source metadata.', 'loop 通知器收到无效的来源元数据。');
  const unscoped = text(language, 'loop notifier requires source.channel and source.target; refusing an unscoped delivery.', 'loop 通知器需要 source.channel 和 source.target；拒绝无范围投递。');
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const message = process.argv.slice(2).join(' ').trim();
const rawSource = process.env.LOOP_HUMAN_INPUT_SOURCE || process.env.LOOP_NOTIFICATION_SOURCE || '';
if (!message) { console.error(${JSON.stringify(missingMessage)}); process.exit(2); }
let source;
try { source = JSON.parse(rawSource); } catch { console.error(${JSON.stringify(invalidSource)}); process.exit(2); }
if (!source || typeof source !== 'object' || !source.channel || !source.target) {
  console.error(${JSON.stringify(unscoped)});
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

function instructionsBlock({ queue, language }) {
  if (language === 'zh') return `\n<!-- loop-engineering:openclaw:start -->
## Loop Engineering 会话路由

- 仅路由明确要求使用 Loop 的请求。\`走 loop\` 表示入队并立即执行一次；只有 \`只入队\` 或 \`只排队\` 才不立即执行。
- \`用 loop engineering\`、\`丢进 Ironman loop\`、\`loop Ironman\` 和 \`task-runner\` 也属于明确的 Loop 请求。
- 从当前工作区运行 \`node scripts/loops/openclaw-loop.mjs route --message "<完整用户消息>"\`，并保留来源元数据。
- 会话来源任务必须使用标准包装器。缺少来源元数据时必须失败关闭，不能退回手工入队或直接运行队列。
- 人工门禁或终态只有在通知命令成功并写入通知记录后才算已送达。
- Dashboard 与聊天审批必须共用 Gate Command 和同一份门禁状态；聊天接入使用 \`scripts/loops/openclaw-loop-gate.mjs\`。
- 飞书回调必须先由可信传输层验签，再设置 \`LOOP_FEISHU_SIGNATURE_VERIFIED=1\` 调用 Gate bridge；未验签失败关闭。普通聊天、引用、转发和截图不能审批。
- 已由 Loop 管理的任务必须直接执行，不能再次路由。
- 状态查询只读。高风险外部动作、破坏性操作、生产变更、凭据操作和记忆迁移仍需单独确认。
- 队列：\`${queue}\`。
<!-- loop-engineering:openclaw:end -->\n`;
  return `\n<!-- loop-engineering:openclaw:start -->
## Loop Engineering conversation routing

- Route only explicit Loop Engineering requests. For example, \`Use Loop Engineering to fix this issue\` and \`Run this through Loop Engineering\` enqueue the request and immediately execute one tick.
- \`Queue this only; do not run it yet\` suppresses immediate execution. \`Continue the current loop with this amendment: ...\` amends the active task instead of replacing it.
- Treat explicit references to \`Loop Engineering\`, \`the loop\`, \`task-runner\`, or a named loop queue as Loop requests.
- Run \`node scripts/loops/openclaw-loop.mjs route --message "<full user message>"\` from this workspace and preserve source metadata when available.
- For conversation-originated work, the standard wrapper is mandatory. Missing source metadata must fail closed; never fall back to manual enqueue or direct run-queue.
- A human-gated or terminal state is not delivered until its notification command succeeds and writes a notification record.
- Dashboard and chat approvals must share the Gate Command core and one gate state; chat transports use \`scripts/loops/openclaw-loop-gate.mjs\`.
- A trusted transport must verify Feishu callbacks before setting \`LOOP_FEISHU_SIGNATURE_VERIFIED=1\`; unverified callbacks fail closed. Ordinary chat, quotes, forwards, and screenshots cannot approve.
- An already loop-managed task must be executed directly and never routed again.
- Status questions are read-only. High-risk external, destructive, production, credential, or memory migration actions remain separately gated.
- Queue: \`${queue}\`.
<!-- loop-engineering:openclaw:end -->\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.language = resolveLanguage(args.language);
  if (args.help) {
    console.log('Usage: loop-engineering-openclaw-install [--root workspace] [--queue agent-tasks] [--worker-agent agent-id] [--dashboard-listen localhost|tailscale] [--tailscale-bin tailscale] [--language auto|en|zh] [--openclaw-bin openclaw] [--systemctl-bin systemctl] [--confirm-install] [--force] [--json]');
    return;
  }
  safeId(args.queue, 'queue');
  if (args.workerAgent) safeId(args.workerAgent, 'worker agent');
  args.openclawBin = await resolveExecutable(args.openclawBin);
  const worker = await resolveWorkerAgent(args);
  args.workerAgent = worker.workerAgent;
  args.loopBin = new URL('../bin/loop-engineering.mjs', import.meta.url).pathname;
  args.humanGateAdapter = new URL('../lib/human-gate-channel-adapter.mjs', import.meta.url).href;
  const systemdUserDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const schedulerUnit = `openclaw-loop-${args.queue}-scheduler.service`;
  const schedulerTimer = `openclaw-loop-${args.queue}-scheduler.timer`;
  const files = {
    workspaceHealth: path.join(args.root, 'configs', 'loops', 'workspace-health.json'),
    queueConfig: path.join(args.root, 'configs', 'loops', 'queues', `${args.queue}.json`),
    dispatcher: path.join(args.root, 'scripts', 'loops', 'openclaw-loop-dispatch.mjs'),
    wrapper: path.join(args.root, 'scripts', 'loops', 'openclaw-loop.mjs'),
    notifier: path.join(args.root, 'scripts', 'loops', 'openclaw-loop-notify.mjs'),
    gateBridge: path.join(args.root, 'scripts', 'loops', 'openclaw-loop-gate.mjs'),
    manifest: path.join(args.root, 'runtime', 'loop-engineering-openclaw-install.json'),
    instructions: path.join(args.root, 'AGENTS.md'),
    schedulerService: path.join(systemdUserDir, schedulerUnit),
    schedulerTimer: path.join(systemdUserDir, schedulerTimer)
  };
  const conflicts = [];
  for (const [kind, file] of Object.entries(files)) if (!['instructions', 'workspaceHealth', 'manifest'].includes(kind) && await exists(file)) conflicts.push(path.relative(args.root, file));
  const dashboardDescription = args.dashboardListen === 'tailscale' ? 'read-only Tailnet address on port 4174 coupled to openclaw-gateway.service' : 'read-only http://127.0.0.1:4174/ coupled to openclaw-gateway.service';
  const confirmationSummary = { targetPlatform: 'OpenClaw', platformCli: args.openclawBin, workspace: args.root, queue: args.queue, scheduler: `systemd user timer ${schedulerTimer}`, dashboard: dashboardDescription, humanGate: 'Dashboard + source-bound chat Gate Command bridge', notificationTarget: text(args.language, 'source-bound at runtime (original OpenClaw conversation)', '运行时绑定到原始 OpenClaw 会话'), writesEnabled: args.confirmInstall };
  const report = { version: 1, platform: 'openclaw', language: args.language, status: args.confirmInstall ? 'installed' : 'plan_only', readOnly: !args.confirmInstall, root: args.root, queue: args.queue, workerAgent: args.workerAgent, workerSelection: worker.selection, availableAgents: worker.availableAgents, workerValidated: true, createsWorkerAgent: false, openclawBin: args.openclawBin, systemctlBin: args.systemctlBin, scheduler: { required: true, unit: schedulerUnit, timer: schedulerTimer }, dashboardAutostart: { required: true, listen: args.dashboardListen, address: args.dashboardListen === 'localhost' ? 'http://127.0.0.1:4174/' : null, gateway: 'openclaw-gateway.service' }, confirmationSummary, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.relative(args.root, file)])), conflicts };
  report.next = args.confirmInstall ? text(args.language, 'Run loop-engineering-openclaw-doctor, then route a harmless smoke task.', '运行 loop-engineering-openclaw-doctor，然后路由一个无害的冒烟任务。') : text(args.language, 'Review this plan, then rerun with --confirm-install.', '检查此计划，然后使用 --confirm-install 重新运行。');
  if (conflicts.length && !args.force && args.confirmInstall) throw new Error(`Refusing to overwrite: ${conflicts.join(', ')}. Use --force after review.`);
  if (!args.json) console.log(formatConfirmationSummary(confirmationSummary, args.language));
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
      language: args.language,
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
    const gateBridgeContent = gateBridgeSource(args);
    const schedulerServiceContent = schedulerServiceSource(args);
    const schedulerTimerContent = schedulerTimerSource(args);
    await writeFile(files.queueConfig, queueContent);
    await writeFile(files.dispatcher, dispatcherContent);
    await writeFile(files.wrapper, wrapperContent);
    await writeFile(files.notifier, notifierContent);
    await writeFile(files.gateBridge, gateBridgeContent);
    await mkdir(systemdUserDir, { recursive: true });
    await writeFile(files.schedulerService, schedulerServiceContent);
    await writeFile(files.schedulerTimer, schedulerTimerContent);
    const daemonReload = await run(args.systemctlBin, ['--user', 'daemon-reload'], { cwd: args.root });
    if (daemonReload.code !== 0) throw new Error(`Cannot reload user systemd units: ${(daemonReload.stderr || daemonReload.stdout).trim() || `exit ${daemonReload.code}`}`);
    const enableTimer = await run(args.systemctlBin, ['--user', 'enable', '--now', schedulerTimer], { cwd: args.root });
    if (enableTimer.code !== 0) throw new Error(`Cannot enable Loop scheduler timer ${schedulerTimer}: ${(enableTimer.stderr || enableTimer.stdout).trim() || `exit ${enableTimer.code}`}`);
    const dashboardInstaller = new URL('./dashboard-autostart-install.mjs', import.meta.url).pathname;
    const dashboardInstall = await run(process.execPath, [dashboardInstaller, '--root', args.root, '--listen', args.dashboardListen, '--tailscale-bin', args.tailscaleBin, '--systemctl-bin', args.systemctlBin, '--confirm-install', '--json'], { cwd: args.root });
    if (dashboardInstall.code !== 0) throw new Error(`Cannot install Dashboard gateway autostart: ${(dashboardInstall.stderr || dashboardInstall.stdout).trim()}`);
    const instructions = await exists(files.instructions) ? await readFile(files.instructions, 'utf8') : '';
    const managedInstructions = instructionsBlock(args);
    if (!instructions.includes('<!-- loop-engineering:openclaw:start -->')) await appendFile(files.instructions, managedInstructions);
    await mkdir(path.dirname(files.manifest), { recursive: true });
    await writeFile(files.manifest, `${JSON.stringify({
      version: 4, queue: args.queue, language: args.language, workerAgent: args.workerAgent, openclawBin: args.openclawBin, systemctlBin: args.systemctlBin, installedAt: new Date().toISOString(),
      managedFiles: [
        { path: path.relative(args.root, files.queueConfig), sha256: sha256(queueContent) },
        { path: path.relative(args.root, files.dispatcher), sha256: sha256(dispatcherContent) },
        { path: path.relative(args.root, files.wrapper), sha256: sha256(wrapperContent) },
        { path: path.relative(args.root, files.notifier), sha256: sha256(notifierContent) },
        { path: path.relative(args.root, files.gateBridge), sha256: sha256(gateBridgeContent) }
      ],
      managedUnits: [
        { path: files.schedulerService, unit: schedulerUnit, sha256: sha256(schedulerServiceContent) },
        { path: files.schedulerTimer, unit: schedulerTimer, sha256: sha256(schedulerTimerContent) }
      ],
      managedInstructions: { path: 'AGENTS.md', sha256: sha256(managedInstructions), content: managedInstructions },
      retainedOnUninstall: [`runtime/loops/${args.queue}`]
    }, null, 2)}\n`);
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : text(args.language, `OpenClaw integration: ${report.status}\nconflicts: ${report.conflicts.join(', ') || 'none'}\nnext: ${report.next}`, `OpenClaw 集成：${report.status}\n冲突：${report.conflicts.join(', ') || '无'}\n下一步：${report.next}`));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
