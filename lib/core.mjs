import { access, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function normalizeLoopId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid loop id: ${id}`);
  }
  return id;
}

export function goalStrategyFingerprint(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff ]/g, '')
    .trim();
}

export function normalizeGoalDecision(value = {}) {
  const raw = String(value.decision ?? value.verdict ?? '').toLowerCase();
  const aliases = {
    pass: 'goal_achieved',
    completed: 'goal_achieved',
    revise: 'change_strategy',
    retry: 'retry_same_strategy',
    blocked: 'change_strategy',
    human_input: 'waiting_for_human',
    needs_human_input: 'waiting_for_human',
    unreachable: 'goal_unreachable'
  };
  const decision = aliases[raw] ?? raw;
  const allowed = new Set([
    'goal_achieved',
    'retry_same_strategy',
    'change_strategy',
    'investigate',
    'waiting_for_human',
    'goal_unreachable'
  ]);
  return {
    decision: allowed.has(decision) ? decision : 'change_strategy',
    summary: String(value.summary ?? ''),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(String) : [],
    next_strategy: String(value.next_strategy ?? value.next_instruction ?? ''),
    human_question: String(value.human_question ?? ''),
    unreachable_reason: String(value.unreachable_reason ?? '')
  };
}

export function goalLoopTransition(decision, context = {}) {
  const normalized = normalizeGoalDecision(decision);
  const round = Number(context.round ?? 1);
  const maxRounds = Number(context.maxRounds ?? 1);
  if (normalized.decision === 'goal_achieved') return { status: 'completed', continue: false, terminal: true };
  if (normalized.decision === 'waiting_for_human') return { status: 'waiting_for_human', continue: false, terminal: false };
  if (normalized.decision === 'goal_unreachable') return { status: 'goal_unreachable', continue: false, terminal: true };
  if (round >= maxRounds) return { status: 'exploration_exhausted', continue: false, terminal: false };
  return {
    status: normalized.decision === 'retry_same_strategy' ? 'retry_pending' : normalized.decision === 'investigate' ? 'investigation_pending' : 'replan_pending',
    continue: true,
    terminal: false
  };
}

export function safeRelativePath(p, label = 'path') {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new Error(`Invalid ${label}: ${p}`);
  }
  const normalized = path.normalize(p);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe ${label}: ${p}`);
  }
  return normalized;
}

export async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function runtimeDirFor(root, id) {
  return path.join(root, 'runtime', 'loops', normalizeLoopId(id));
}

export function statePathFor(root, id) {
  return path.join(runtimeDirFor(root, id), 'state.json');
}

export function runsDirFor(root, id) {
  return path.join(runtimeDirFor(root, id), 'runs');
}

export async function loadSpec(root, configPath) {
  const file = path.resolve(root, configPath);
  const spec = await readJson(file);
  validateSpec(spec);
  return { spec, file };
}

export function validateSpec(spec) {
  normalizeLoopId(spec.id);
  if (typeof spec.goal !== 'string' || spec.goal.trim().length < 8) {
    throw new Error('Spec goal must be a meaningful string.');
  }
  if (!['L1', 'L2', 'L3'].includes(spec.level)) {
    throw new Error('Spec level must be L1, L2, or L3.');
  }
  if (!['report-only', 'assisted', 'unattended'].includes(spec.mode)) {
    throw new Error('Spec mode must be report-only, assisted, or unattended.');
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new Error('Spec checks must be a non-empty array.');
  }
  for (const check of spec.checks) validateCheck(check);
  if (spec.maxRuntimeMs !== undefined && !positiveInteger(spec.maxRuntimeMs)) {
    throw new Error('Spec maxRuntimeMs must be a positive integer.');
  }
  if (spec.breaker !== undefined) {
    const { maxConsecutiveFailures, sameFailureThreshold } = spec.breaker;
    if (maxConsecutiveFailures !== undefined && !positiveInteger(maxConsecutiveFailures)) {
      throw new Error('breaker.maxConsecutiveFailures must be a positive integer.');
    }
    if (sameFailureThreshold !== undefined && !positiveInteger(sameFailureThreshold)) {
      throw new Error('breaker.sameFailureThreshold must be a positive integer.');
    }
  }
}

function validateCheck(check) {
  if (typeof check.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(check.id)) {
    throw new Error(`Invalid check id: ${check.id}`);
  }
  if (!['command', 'files', 'json-value'].includes(check.type)) {
    throw new Error(`Unsupported check type for ${check.id}: ${check.type}`);
  }
  if (check.type === 'command') {
    if (typeof check.cmd !== 'string' || check.cmd.trim().length === 0) {
      throw new Error(`Command check ${check.id} needs cmd.`);
    }
    if (check.expectExitCode !== undefined && !Number.isInteger(check.expectExitCode)) {
      throw new Error(`Command check ${check.id} expectExitCode must be an integer.`);
    }
    if (check.timeoutMs !== undefined && !positiveInteger(check.timeoutMs)) {
      throw new Error(`Command check ${check.id} timeoutMs must be a positive integer.`);
    }
  }
  if (check.type === 'files') {
    if (!Array.isArray(check.paths) || check.paths.length === 0) {
      throw new Error(`Files check ${check.id} needs paths.`);
    }
    for (const p of check.paths) safeRelativePath(p, `check path for ${check.id}`);
  }
  if (check.type === 'json-value') {
    if (typeof check.file !== 'string' || check.file.length === 0 || check.file.includes('\0')) {
      throw new Error(`JSON value check ${check.id} needs file.`);
    }
    if (typeof check.pointer !== 'string' || (check.pointer !== '' && !check.pointer.startsWith('/'))) {
      throw new Error(`JSON value check ${check.id} pointer must be an RFC 6901 JSON pointer.`);
    }
    if (!Object.hasOwn(check, 'expected')) {
      throw new Error(`JSON value check ${check.id} needs expected.`);
    }
  }
}

function positiveInteger(n) {
  return Number.isInteger(n) && n > 0;
}

export async function loadState(root, spec) {
  const stateFile = statePathFor(root, spec.id);
  if (!(await exists(stateFile))) {
    return {
      version: 1,
      loopId: spec.id,
      goal: spec.goal,
      paused: false,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      runs: 0,
      consecutiveFailures: 0,
      lastOutcome: null,
      lastFailureSignature: null,
      sameFailureCount: 0,
      lastRunId: null,
      lastRunPath: null
    };
  }
  const state = await readJson(stateFile);
  if (state.version !== 1 || state.loopId !== spec.id) {
    throw new Error(`Invalid state file for loop ${spec.id}.`);
  }
  return state;
}

export async function runCheck(root, check) {
  const startedAt = new Date().toISOString();
  if (check.type === 'files') {
    const missing = [];
    const present = [];
    for (const rel of check.paths) {
      const safe = safeRelativePath(rel, `check path for ${check.id}`);
      const full = path.join(root, safe);
      if (await exists(full)) present.push(rel);
      else missing.push(rel);
    }
    return {
      id: check.id,
      type: check.type,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: missing.length === 0,
      present,
      missing
    };
  }

  if (check.type === 'json-value') {
    const file = path.isAbsolute(check.file)
      ? path.normalize(check.file)
      : path.join(root, safeRelativePath(check.file, `JSON check file for ${check.id}`));
    let actual;
    let readError = null;
    try {
      actual = jsonPointerGet(await readJson(file), check.pointer);
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    const equal = readError === null && JSON.stringify(actual) === JSON.stringify(check.expected);
    return {
      id: check.id,
      type: check.type,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: equal,
      file: path.isAbsolute(check.file) ? check.file : path.relative(root, file),
      pointer: check.pointer,
      expected: check.expected,
      actual: readError === null ? actual : null,
      drift: equal ? null : {
        kind: readError === null ? 'configuration_value_mismatch' : 'configuration_unreadable',
        expected: check.expected,
        actual: readError === null ? actual : null,
        readError,
        reviewHint: check.reviewHint ?? 'Review whether the observed value is an intended configuration change before editing either the config or the check.'
      }
    };
  }

  const timeoutMs = check.timeoutMs ?? 30000;
  const result = await runCommand(check.cmd, { cwd: root, timeoutMs });
  const expected = check.expectExitCode ?? 0;
  return {
    id: check.id,
    type: check.type,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: result.exitCode === expected,
    cmd: check.cmd,
    expectExitCode: expected,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  };
}

function jsonPointerGet(value, pointer) {
  if (pointer === '') return value;
  return pointer.slice(1).split('/').reduce((current, raw) => {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || current === undefined || !Object.hasOwn(Object(current), key)) {
      throw new Error(`JSON pointer not found: ${pointer}`);
    }
    return current[key];
  }, value);
}

export function runCommand(cmd, options = {}) {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    const child = spawn('/bin/sh', ['-lc', cmd], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let canceled = false;
    let killedProcessGroup = false;
    const timeoutMs = options.timeoutMs ?? 30000;
    const terminate = (signal) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          killedProcessGroup = true;
          return;
        } catch {
          // Fall back to the direct child below.
        }
      }
      child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 1000).unref();
    }, timeoutMs);
    let cancelCheckRunning = false;
    const cancelTimer = options.cancelFile ? setInterval(async () => {
      if (cancelCheckRunning || canceled) return;
      cancelCheckRunning = true;
      try {
        await access(options.cancelFile);
        canceled = true;
        terminate('SIGTERM');
        setTimeout(() => terminate('SIGKILL'), 1000).unref();
      } catch {
        // The cancellation marker does not exist yet.
      } finally {
        cancelCheckRunning = false;
      }
    }, options.cancelPollMs ?? 250) : null;
    cancelTimer?.unref();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        timedOut,
        canceled,
        cancelFile: canceled ? options.cancelFile : null,
        killedProcessGroup,
        stdout,
        stderr
      });
    });
  });
}

function trimOutput(value) {
  const max = 12000;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... <truncated ${value.length - max} chars>`;
}

function trimTail(value, max = 4000) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `... <truncated ${value.length - max} chars>\n${value.slice(-max)}`;
}

function createProgressRecorder(onProgress) {
  const events = [];
  return {
    events,
    emit(phase, status, message, details = {}) {
      const event = {
        at: new Date().toISOString(),
        phase,
        status,
        message,
        ...details
      };
      events.push(event);
      if (typeof onProgress === 'function') {
        try {
          onProgress(event);
        } catch {
          // Progress callbacks are observational and must not break task execution.
        }
      }
      return event;
    }
  };
}

const LIVE_PROGRESS_MILESTONES = new Set([
  'queue:activated',
  'queue:superseded',
  'planning:dev_plan',
  'preflight:passed',
  'preflight:failed',
  'preflight:skipped',
  'dispatch:running',
  'dispatch:heartbeat',
  'dispatch:passed',
  'dispatch:failed',
  'dispatch:needs_human_action',
  'worktree:ready',
  'worktree:failed',
  'verification:passed',
  'verification:failed',
  'acceptance:reviewed',
  'acceptance:checkpoint_update',
  'final-judge:ready_to_apply',
  'final-judge:ready_for_human_review',
  'final-judge:needs_revision',
  'final-judge:blocked',
  'final-judge:superseded'
]);

function liveProgressMessage(queue, task, event) {
  const phaseLabels = {
    queue: '任务启动',
    planning: '计划完成',
    preflight: '环境检查',
    dispatch: 'Worker 执行',
    worktree: '隔离工作区',
    verification: '自动验证',
    acceptance: '独立验收',
    'final-judge': '最终裁判'
  };
  return [
    `Loop 进度｜${phaseLabels[event.phase] ?? event.phase}`,
    `任务：${task.title}`,
    `状态：${event.status}`,
    `说明：${event.message}`,
    `task id：${task.id}`,
    `queue：${queue}`
  ].join('\n');
}

async function notifyLiveQueueProgress(root, queue, task, event, options = {}) {
  if (!options.progressNotifyCommand || !task?.source?.channel || !task?.source?.target) {
    return { outcome: 'not_configured' };
  }
  const key = `${event.phase}:${event.status}`;
  if (!LIVE_PROGRESS_MILESTONES.has(key)) return { outcome: 'not_a_milestone' };
  const detail = event.heartbeat ?? event.checkpointFile ?? event.attempt ?? event.commandIndex ?? event.checkpointId ?? '';
  const safeKey = sanitizeFileSegment(`${event.phase}-${event.status}-${detail}`);
  const ledgerDir = path.join(taskRuntimeDirFor(root, queue, task.id), 'progress_notifications');
  const ledgerFile = path.join(ledgerDir, `${safeKey}.json`);
  if (await exists(ledgerFile)) return { outcome: 'already_notified', file: path.relative(root, ledgerFile) };
  const message = liveProgressMessage(queue, task, event);
  const result = await runCommand(`${options.progressNotifyCommand} ${shellQuote(message)}`, {
    cwd: root,
    timeoutMs: options.progressNotifyTimeoutMs ?? 60 * 1000,
    env: {
      ...process.env,
      LOOP_NOTIFICATION_SOURCE: JSON.stringify(task.source),
      LOOP_PROGRESS_EVENT: JSON.stringify(event),
      LOOP_PROGRESS_TASK_ID: task.id,
      LOOP_PROGRESS_QUEUE: queue
    }
  });
  await writeJson(ledgerFile, {
    version: 1,
    taskId: task.id,
    queue,
    event,
    message,
    attemptedAt: new Date().toISOString(),
    outcome: result.exitCode === 0 ? 'sent' : 'failed',
    exitCode: result.exitCode,
    stderr: trimTail(result.stderr, 1000)
  });
  return { outcome: result.exitCode === 0 ? 'sent' : 'failed', file: path.relative(root, ledgerFile) };
}

export function failureSignature(results) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.map((r) => {
    if (r.type === 'files') return `${r.id}:missing:${r.missing.join(',')}`;
    if (r.type === 'json-value') return `${r.id}:drift:${normalizeVolatile(JSON.stringify(r.actual))}`;
    const firstErr = (r.stderr || r.stdout || '').split('\n').find((line) => line.trim()) || '';
    return `${r.id}:exit:${r.exitCode}:${normalizeVolatile(firstErr)}`;
  }).join('|');
}

export function loopRepairPlan(run) {
  const findings = (run?.checks ?? []).filter((check) => !check.ok).map((check) => {
    if (check.type === 'json-value') {
      return {
        checkId: check.id,
        kind: check.drift?.kind ?? 'configuration_drift',
        file: check.file,
        pointer: check.pointer,
        expected: check.expected,
        actual: check.actual,
        confidence: check.drift?.readError ? 'high' : 'medium',
        requiresHumanReview: true,
        suggestedNext: check.drift?.reviewHint
      };
    }
    return {
      checkId: check.id,
      kind: check.type === 'files' ? 'missing_files' : 'command_failure',
      requiresHumanReview: true,
      suggestedNext: 'Inspect the failed check evidence and update the system or check only after confirming the intended state.'
    };
  });
  return {
    version: 1,
    mode: 'loop_repair_plan',
    generatedAt: new Date().toISOString(),
    loopId: run?.loopId ?? null,
    sourceRun: run?.runPath ?? null,
    sourceOutcome: run?.outcome ?? null,
    status: findings.length === 0 ? 'no_repairs_needed' : 'review_required',
    readOnly: true,
    autoApply: false,
    findings
  };
}

function normalizeVolatile(text) {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<addr>')
    .replace(/:\d+(:\d+)?/g, ':#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function applyBreaker(spec, state, outcome, signature) {
  const breaker = spec.breaker ?? {};
  const maxConsecutiveFailures = breaker.maxConsecutiveFailures ?? 3;
  const sameFailureThreshold = breaker.sameFailureThreshold ?? 2;

  if (outcome !== 'failure') {
    return { escalated: false, trigger: 'ok', reason: 'Loop checks passed.' };
  }

  const nextConsecutive = (state.consecutiveFailures ?? 0) + 1;
  const nextSame = signature && signature === state.lastFailureSignature
    ? (state.sameFailureCount ?? 1) + 1
    : 1;

  if (nextConsecutive >= maxConsecutiveFailures) {
    return {
      escalated: true,
      trigger: 'consecutive-failures',
      reason: `Failure repeated for ${nextConsecutive} consecutive runs.`
    };
  }
  if (nextSame >= sameFailureThreshold) {
    return {
      escalated: true,
      trigger: 'same-failure',
      reason: `Same failure signature repeated ${nextSame} times.`
    };
  }
  return {
    escalated: false,
    trigger: 'failure-observed',
    reason: `Failure observed (${nextConsecutive}/${maxConsecutiveFailures} consecutive).`
  };
}

export function nextState(state, run) {
  const failure = run.outcome === 'failure';
  const sameFailureCount = failure && run.failureSignature === state.lastFailureSignature
    ? (state.sameFailureCount ?? 1) + 1
    : failure ? 1 : 0;
  return {
    ...state,
    updatedAt: run.finishedAt,
    runs: (state.runs ?? 0) + 1,
    consecutiveFailures: failure ? (state.consecutiveFailures ?? 0) + 1 : 0,
    lastOutcome: run.outcome,
    lastFailureSignature: run.failureSignature,
    sameFailureCount,
    lastRunId: run.runId,
    lastRunPath: run.runPath,
    lastBreaker: run.breaker
  };
}

export async function configFilesFromArgs(root, argv) {
  const configs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configs.push(argv[++i]);
  }
  if (configs.length > 0) return configs;
  const dir = path.join(root, 'configs', 'loops');
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join('configs', 'loops', f));
  } catch {
    return [];
  }
}

export async function latestRun(root, id) {
  const dir = runsDirFor(root, id);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const file = path.join(dir, files[files.length - 1]);
    return { file: path.relative(root, file), run: await readJson(file) };
  } catch {
    return null;
  }
}

export async function recentRuns(root, id, options = {}) {
  const limit = options.limit ?? 20;
  const dir = runsDirFor(root, id);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().slice(-limit);
    const runs = [];
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        runs.push({ file: path.relative(root, full), run: await readJson(full) });
      } catch (err) {
        runs.push({
          file: path.relative(root, full),
          readError: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return runs;
  } catch {
    return [];
  }
}

export async function summarizeLoopRuns(root, options = {}) {
  const ids = await targetRuntimeIds(root, options);
  const summaries = [];
  for (const id of ids) {
    const entries = await recentRuns(root, id, { limit: options.limit ?? 20 });
    const readable = entries.filter((entry) => entry.run && runMatchesTarget(entry.run, id, options));
    const counts = {};
    const durations = [];
    const failures = [];
    for (const entry of readable) {
      const run = entry.run;
      const status = run.status ?? run.outcome ?? 'unknown';
      counts[status] = (counts[status] ?? 0) + 1;
      const duration = Number.isFinite(run.durationMs)
        ? run.durationMs
        : Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? '');
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
      if (isFailureRun(run)) failures.push(failureSummary(entry.file, run));
    }
    summaries.push({
      id,
      inspectedRuns: entries.length,
      readableRuns: readable.length,
      unreadableRuns: entries.filter((entry) => entry.readError).length,
      skippedRuns: entries.filter((entry) => entry.run && !runMatchesTarget(entry.run, id, options)).length,
      counts,
      successRate: readable.length ? Number(((successCount(readable) / readable.length) * 100).toFixed(1)) : null,
      averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      latestRun: readable[readable.length - 1]?.file ?? null,
      latestStatus: readable[readable.length - 1]?.run?.status ?? readable[readable.length - 1]?.run?.outcome ?? null,
      recentFailures: failures.slice(-5).reverse()
    });
  }
  return summaries;
}

function runMatchesTarget(run, id, options) {
  if (options.queue) return run.queue === id || (!run.outcome && run.status && run.loopId === id);
  if (options.id) return run.loopId === id && Boolean(run.outcome);
  return true;
}

async function targetRuntimeIds(root, options) {
  if (options.id) return [normalizeLoopId(options.id)];
  if (options.queue) return [normalizeLoopId(options.queue)];
  const dir = path.join(root, 'runtime', 'loops');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function isFailureRun(run) {
  if (run.outcome) return run.outcome !== 'success' || run.breaker?.escalated;
  if (run.status) return !['completed', 'empty'].includes(run.status);
  return false;
}

function successCount(entries) {
  return entries.filter((entry) => {
    const run = entry.run;
    if (run.outcome) return run.outcome === 'success' && !run.breaker?.escalated;
    if (run.status) return ['completed', 'empty'].includes(run.status);
    return false;
  }).length;
}

function failureSummary(file, run) {
  const failedChecks = Array.isArray(run.checks)
    ? run.checks.filter((check) => !check.ok).map((check) => ({
      id: check.id,
      exitCode: check.exitCode ?? null,
      missing: check.missing ?? null
    }))
    : [];
  return {
    file,
    runId: run.runId ?? null,
    status: run.status ?? run.outcome ?? 'unknown',
    reason: run.failureSignature
      ?? run.runtimeError
      ?? run.breaker?.reason
      ?? run.verification?.find?.((item) => item.result?.exitCode !== 0)?.result?.stderr?.split('\n').find(Boolean)
      ?? run.dispatch?.stderr?.split('\n').find(Boolean)
      ?? null,
    failedChecks
  };
}

export async function doctorReport(root, options = {}) {
  const checks = [];
  const add = (id, level, ok, detail = null) => checks.push({ id, level, ok, detail });
  add('root-exists', 'fail', await exists(root), root);
  const configsDir = path.join(root, 'configs', 'loops');
  add('configs-dir', 'warn', await exists(configsDir), path.relative(root, configsDir));
  const runtimeDir = path.join(root, 'runtime', 'loops');
  add('runtime-dir', 'warn', await exists(runtimeDir), path.relative(root, runtimeDir));

  const loopConfigs = await configFilesFromArgs(root, []);
  add('loop-configs-found', 'warn', loopConfigs.length > 0, `${loopConfigs.length} loop config(s)`);
  for (const file of loopConfigs) {
    try {
      const { spec } = await loadSpec(root, file);
      const state = await loadState(root, spec);
      const latest = await latestMatchingRun(root, spec.id, (run) => run.loopId === spec.id);
      add(`loop:${spec.id}`, 'fail', state.version === 1 && state.loopId === spec.id, {
        config: file,
        level: spec.level,
        mode: spec.mode,
        checks: spec.checks.length,
        latestRun: latest?.file ?? null,
        latestOutcome: latest?.run?.outcome ?? null,
        consecutiveFailures: state.consecutiveFailures ?? 0,
        paused: Boolean(state.paused)
      });
      if (latest?.run && isFailureRun(latest.run)) {
        add(`loop:${spec.id}:latest`, 'warn', false, failureSummary(latest.file, latest.run));
      }
    } catch (err) {
      add(`loop-config:${file}`, 'fail', false, err instanceof Error ? err.message : String(err));
    }
  }

  const queueConfigs = await queueConfigFiles(root);
  add('queue-configs-found', 'warn', queueConfigs.length > 0, `${queueConfigs.length} queue config(s)`);
  for (const file of queueConfigs) {
    try {
      const config = await loadQueueConfig(root, file);
      const optionsForQueue = mergeQueueOptions(config, {});
      const status = await queueStatus(root, optionsForQueue.queue);
      add(`queue:${optionsForQueue.queue}`, 'fail', true, {
        config: file,
        dispatcher: optionsForQueue.dispatcher ?? null,
        preflightConfig: optionsForQueue.preflightConfig ?? null,
        status
      });
      if (status.locked) add(`queue:${optionsForQueue.queue}:lock`, 'warn', false, status.lockExpiresAt);
      if (status.active > 0) add(`queue:${optionsForQueue.queue}:active`, 'warn', false, `${status.active} active task(s)`);
      if (status.failed > 0) add(`queue:${optionsForQueue.queue}:failed`, 'warn', false, `${status.failed} failed task(s)`);
      if (optionsForQueue.worktree?.enabled) {
        const cleanup = await codeWorktreeCleanupPlan(root, optionsForQueue.queue, {
          config: optionsForQueue,
          limit: options.limit ?? 10
        });
        if (cleanup.missingWorktrees.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-missing`, 'warn', false, cleanup.missingWorktrees);
        }
        if (cleanup.orphanWorktrees.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-orphans`, 'warn', false, cleanup.orphanWorktrees);
        }
        if (cleanup.unexportedDirty.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-unexported`, 'warn', false, cleanup.unexportedDirty);
        }
        if (cleanup.rejectedPatches.length > 0) {
          add(`queue:${optionsForQueue.queue}:patch-rejected`, 'warn', false, cleanup.rejectedPatches);
        }
      }
    } catch (err) {
      add(`queue-config:${file}`, 'fail', false, err instanceof Error ? err.message : String(err));
    }
  }

  const summaries = await summarizeLoopRuns(root, { limit: options.limit ?? 10 });
  return {
    version: 1,
    root,
    generatedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok || check.level === 'warn'),
    failCount: checks.filter((check) => !check.ok && check.level === 'fail').length,
    warnCount: checks.filter((check) => !check.ok && check.level === 'warn').length,
    checks,
    summaries
  };
}

async function latestMatchingRun(root, id, predicate) {
  const entries = await recentRuns(root, id, { limit: 50 });
  for (const entry of entries.slice().reverse()) {
    if (entry.run && predicate(entry.run)) return entry;
  }
  return null;
}

async function queueConfigFiles(root) {
  const dir = path.join(root, 'configs', 'loops', 'queues');
  try {
    return (await readdir(dir))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => path.join('configs', 'loops', 'queues', file));
  } catch {
    return [];
  }
}

export async function initWorkspace(root, options = {}) {
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops');
  await mkdir(configsDir, { recursive: true });
  await mkdir(path.join(root, 'runtime', 'loops'), { recursive: true });
  const target = path.join(configsDir, `${options.template ?? 'workspace-health'}.json`);
  if (!(await exists(target)) || options.force) {
    await copyFile(path.join(templatesDir, 'workspace-health.json'), target);
  }
  return path.relative(root, target);
}

export async function initQueueConfig(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops', 'queues');
  await mkdir(configsDir, { recursive: true });
  await ensureQueueDirs(root, normalized);
  await initWorkspace(root, { force: false });
  const target = path.join(configsDir, `${normalized}.json`);
  if (!(await exists(target)) || options.force) {
    const template = await readJson(path.join(templatesDir, 'queue-runner.json'));
    await writeJson(target, {
      ...template,
      queue: normalized,
      dispatcher: template.dispatcher ?? 'node scripts/dispatch-task.mjs'
    });
  }
  return path.relative(root, target);
}

export async function initCodeQueueConfig(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops', 'queues');
  await mkdir(configsDir, { recursive: true });
  await ensureQueueDirs(root, normalized);
  await initWorkspace(root, { force: false });
  const target = path.join(configsDir, `${normalized}.json`);
  if (!(await exists(target)) || options.force) {
    const template = await readJson(path.join(templatesDir, 'code-worktree-queue.json'));
    await writeJson(target, {
      ...template,
      queue: normalized,
      worktree: {
        ...template.worktree,
        baseDir: path.join('runtime', 'loops', normalized, 'worktrees'),
        branchPrefix: `loop/${normalized}`
      }
    });
  }
  return path.relative(root, target);
}

export async function packageFileSizeSummary() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const s = await stat(full);
        files.push({ file: path.relative(PACKAGE_ROOT, full), bytes: s.size });
      }
    }
  }
  await walk(PACKAGE_ROOT);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function queueDirFor(root, queue) {
  return runtimeDirFor(root, queue);
}

export function queueSubdirFor(root, queue, subdir) {
  return path.join(queueDirFor(root, queue), subdir);
}

export async function ensureQueueDirs(root, queue) {
  normalizeLoopId(queue);
  await Promise.all(['inbox', 'active', 'done', 'failed', 'runs', 'canceled', 'tasks']
    .map((subdir) => mkdir(queueSubdirFor(root, queue, subdir), { recursive: true })));
}

export function taskIdForTitle(title, date = new Date()) {
  const slug = (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${isoStamp(date)}_${slug}`;
}

function normalizeProjectId(id) {
  return normalizeLoopId(id);
}

function projectRuntimeDirFor(root, project) {
  return path.join(root, 'runtime', 'loops', 'projects', normalizeProjectId(project));
}

function projectConfigPathFor(root, project) {
  return path.join(root, 'configs', 'loops', 'projects', `${normalizeProjectId(project)}.json`);
}

function projectLatestIntakePath(root, project) {
  return path.join(projectRuntimeDirFor(root, project), 'intake', 'latest.json');
}

function projectPlanMarkdownPath(root, project) {
  return path.join(projectRuntimeDirFor(root, project), 'plans', 'project-plan.md');
}

function projectInitialBacklogPath(root, project) {
  return path.join(projectRuntimeDirFor(root, project), 'backlog', 'initial.json');
}

const PROJECT_TYPE_ALIASES = {
  auto: 'auto',
  web: 'web_app',
  website: 'web_app',
  site: 'web_app',
  app: 'web_app',
  web_app: 'web_app',
  code: 'code_project',
  code_project: 'code_project',
  dev: 'code_project',
  research: 'research',
  report: 'research',
  content: 'content',
  docs: 'content',
  writing: 'content',
  ops: 'ops',
  growth: 'ops',
  operations: 'ops',
  qa: 'qa',
  test: 'qa',
  testing: 'qa',
  knowledge: 'knowledge_base',
  kb: 'knowledge_base',
  knowledge_base: 'knowledge_base',
  infra: 'infra_audit',
  audit: 'infra_audit',
  infra_audit: 'infra_audit',
  assistant: 'assistant_workflow',
  assistant_workflow: 'assistant_workflow'
};

const PROJECT_TEMPLATES = {
  web_app: {
    queueKind: 'code',
    deliverables: ['application code', 'README or run notes', 'local verification results'],
    acceptance: [
      'The project has a repeatable local check command.',
      'The primary user flow is implemented with desktop and mobile layouts considered.',
      'No push, publish, deploy, or external write is performed without human confirmation.'
    ],
    backlog: [
      ['Define project skeleton and checks', 'Create or verify the project structure and make the default check command runnable.'],
      ['Implement first usable screen', 'Build the first user-facing screen with loading, empty, and error states where applicable.'],
      ['Add core workflow', 'Implement the main workflow described by the project brief.'],
      ['Add verification coverage', 'Add or update focused tests, checks, or smoke validation for the implemented workflow.'],
      ['Write closeout notes', 'Document how to run, verify, and continue the project.']
    ]
  },
  code_project: {
    queueKind: 'code',
    deliverables: ['code changes', 'verification output', 'reviewable patch artifacts'],
    acceptance: [
      'Configured verification commands pass.',
      'Changes are isolated in code worktrees until explicitly applied.',
      'No commit, push, publish, or deploy is performed without human confirmation.'
    ],
    backlog: [
      ['Inspect project baseline', 'Identify the current structure, existing checks, and likely implementation boundaries.'],
      ['Implement first scoped change', 'Complete the smallest useful code change from the brief.'],
      ['Verify behavior', 'Run the project checks and record evidence.'],
      ['Prepare review bundle', 'Produce reviewable patch and closeout artifacts.']
    ]
  },
  research: {
    queueKind: 'standard',
    deliverables: ['research memo', 'source list', 'comparison or findings summary'],
    acceptance: [
      'Claims are backed by cited or locally recorded sources.',
      'Open questions and confidence levels are explicit.',
      'The final memo separates facts, interpretations, and recommendations.'
    ],
    backlog: [
      ['Frame research questions', 'Turn the brief into concrete questions, scope, and exclusions.'],
      ['Collect initial sources', 'Gather a first source set and record provenance.'],
      ['Cross-check findings', 'Compare sources and flag contradictions or weak evidence.'],
      ['Draft research memo', 'Write a concise memo with findings, risks, and next steps.']
    ]
  },
  content: {
    queueKind: 'standard',
    deliverables: ['outline', 'draft', 'revision notes', 'final copy'],
    acceptance: [
      'The output matches the intended audience and channel.',
      'The draft has a clear structure and a reviewed final version.',
      'Publishing or external posting remains human-gated.'
    ],
    backlog: [
      ['Define audience and angle', 'Clarify audience, channel, tone, and success criteria.'],
      ['Create outline', 'Produce a structured outline for review.'],
      ['Draft content', 'Write the first full draft from the outline.'],
      ['Revise and finalize', 'Edit for clarity, consistency, and completeness.']
    ]
  },
  ops: {
    queueKind: 'standard',
    deliverables: ['operation plan', 'action list', 'progress reports', 'results summary'],
    acceptance: [
      'Actions are traceable to an objective and expected outcome.',
      'External sends, public posts, and irreversible actions are human-gated.',
      'Each cycle reports what changed and what needs attention.'
    ],
    backlog: [
      ['Define operating objective', 'Clarify the target metric, audience, cadence, and constraints.'],
      ['Build action backlog', 'Create the first batch of low-risk operational tasks.'],
      ['Run first review cycle', 'Inspect available signals and recommend next actions.'],
      ['Summarize progress', 'Write an update with actions completed, blockers, and next cycle.']
    ]
  },
  qa: {
    queueKind: 'standard',
    deliverables: ['test plan', 'run reports', 'bug or repair backlog'],
    acceptance: [
      'The test scope and pass/fail criteria are explicit.',
      'Failures produce reproducible evidence and follow-up tasks.',
      'Destructive or production-impacting checks are gated.'
    ],
    backlog: [
      ['Define QA scope', 'List target surfaces, risks, and pass/fail criteria.'],
      ['Create smoke checklist', 'Write the first repeatable smoke or regression checklist.'],
      ['Run initial checks', 'Execute safe checks and record evidence.'],
      ['Prepare repair backlog', 'Turn failures into prioritized follow-up tasks.']
    ]
  },
  knowledge_base: {
    queueKind: 'standard',
    deliverables: ['organized knowledge base', 'index', 'dedupe notes'],
    acceptance: [
      'Each processed item has a destination or explicit skip reason.',
      'Duplicate or conflicting content is flagged.',
      'The resulting structure is navigable and documented.'
    ],
    backlog: [
      ['Inventory source material', 'List available files, notes, or records to process.'],
      ['Define taxonomy', 'Create categories and naming rules for the knowledge base.'],
      ['Process first batch', 'Organize a small first batch and record decisions.'],
      ['Write index', 'Create or update an index for what has been organized.']
    ]
  },
  infra_audit: {
    queueKind: 'standard',
    deliverables: ['audit report', 'risk list', 'gated repair plan'],
    acceptance: [
      'Audit steps are read-only unless explicitly approved.',
      'Findings include severity, evidence, and recommended remediation.',
      'Production changes require human confirmation.'
    ],
    backlog: [
      ['Define audit scope', 'Identify systems, checks, and forbidden actions.'],
      ['Run read-only baseline', 'Collect safe status and configuration evidence.'],
      ['Write risk report', 'Summarize findings by severity and confidence.'],
      ['Draft repair plan', 'Create a gated remediation checklist.']
    ]
  },
  assistant_workflow: {
    queueKind: 'standard',
    deliverables: ['workflow spec', 'recurring checklist', 'status reports'],
    acceptance: [
      'The workflow has clear triggers, cadence, and quiet conditions.',
      'External actions are gated unless separately approved.',
      'Reports are concise and only sent when useful.'
    ],
    backlog: [
      ['Define workflow trigger and cadence', 'Clarify when the assistant workflow should run and when it should stay quiet.'],
      ['Create checklist', 'Write the first repeatable checklist and output format.'],
      ['Run dry review', 'Execute a report-only pass and capture findings.'],
      ['Tune reporting', 'Adjust cadence, gates, and report content.']
    ]
  }
};

function normalizeProjectType(type, brief = '') {
  const raw = String(type ?? 'auto').trim().toLowerCase();
  const normalized = PROJECT_TYPE_ALIASES[raw] ?? raw;
  if (normalized !== 'auto') {
    if (!PROJECT_TEMPLATES[normalized]) throw new Error(`Unsupported project type: ${type}`);
    return normalized;
  }
  const text = brief.toLowerCase();
  if (/(website|web app|landing|homepage|frontend|page|site)/.test(text)) return 'web_app';
  if (/(code|repo|library|cli|api|bug|feature|develop|implement|fix)/.test(text)) return 'code_project';
  if (/(research|market|competitor|paper|analysis|survey)/.test(text)) return 'research';
  if (/(article|post|script|docs|copy|content|newsletter)/.test(text)) return 'content';
  if (/(growth|operation|campaign|community|funnel|activation)/.test(text)) return 'ops';
  if (/(qa|test|regression|smoke|quality|coverage)/.test(text)) return 'qa';
  if (/(knowledge|wiki|faq|archive|taxonomy|organize)/.test(text)) return 'knowledge_base';
  if (/(infra|audit|server|security|backup|permission|compliance)/.test(text)) return 'infra_audit';
  return 'code_project';
}

function projectQueueName(project, template) {
  return `${normalizeProjectId(project)}-${template.queueKind === 'code' ? 'dev' : 'tasks'}`;
}

function defaultCheckForProjectType(type) {
  if (type === 'web_app' || type === 'code_project') return 'npm test';
  return 'loop-engineering doctor --root .';
}

function buildProjectBacklog(project, brief, template) {
  return template.backlog.map(([title, task], index) => ({
    id: `task-${String(index + 1).padStart(2, '0')}`,
    title,
    task: [
      task,
      '',
      `Project: ${project}`,
      `Brief: ${brief}`,
      'Acceptance:',
      `- ${task}`,
      '- Respect the project action policy and human gates.',
      '- Record evidence, blockers, and next actions in loop artifacts.'
    ].join('\n'),
    acceptance: [
      task,
      'Evidence, blockers, and next actions are recorded.',
      'Human-gated actions are not performed without explicit confirmation.'
    ],
    status: 'planned'
  }));
}

function buildProjectSpec(options) {
  const project = normalizeProjectId(options.project ?? options.name);
  const brief = String(options.brief ?? '').trim();
  if (!brief) throw new Error('project-intake requires --brief.');
  const type = normalizeProjectType(options.type, brief);
  const template = PROJECT_TEMPLATES[type];
  const queue = options.queue ? normalizeLoopId(options.queue) : projectQueueName(project, template);
  const checks = Array.isArray(options.checks) && options.checks.length
    ? options.checks
    : [defaultCheckForProjectType(type)];
  const backlog = buildProjectBacklog(project, brief, template);
  return {
    schemaVersion: 1,
    project,
    brief,
    type,
    goal: options.goal ?? `Advance ${project} from the brief into verified deliverables.`,
    nonGoals: options.nonGoals ?? ['Do not push, publish, deploy, delete data, or perform external writes without human confirmation.'],
    deliverables: template.deliverables,
    acceptance: template.acceptance,
    riskGates: ['push', 'publish', 'deploy', 'external_message', 'delete_data', 'production_config', 'credential_change'],
    actionPolicy: {
      localReads: 'allowed',
      localEdits: template.queueKind === 'code' ? 'allowed_in_worktree' : 'allowed_for_artifacts',
      applyPatch: 'human_confirm',
      commit: 'human_confirm',
      push: 'human_confirm',
      publish: 'human_confirm',
      deploy: 'human_confirm',
      externalWrites: 'human_confirm',
      destructiveActions: 'human_confirm'
    },
    queues: [
      {
        queue,
        kind: template.queueKind,
        autostart: false,
        progressReport: true
      }
    ],
    checks,
    backlog,
    blockingQuestions: [],
    openQuestions: [],
    assumptions: [
      'Start with local artifacts and local verification.',
      'Use conservative defaults when the brief leaves implementation details open.',
      'Ask for confirmation before external, destructive, production, push, publish, or deploy actions.'
    ]
  };
}

function renderProjectPlanMarkdown(spec) {
  const queue = spec.queues[0];
  const lines = [
    `# Loop Project: ${spec.project}`,
    '',
    `- Type: ${spec.type}`,
    `- Queue: ${queue.queue} (${queue.kind})`,
    `- Brief: ${spec.brief}`,
    '',
    '## Goal',
    '',
    spec.goal,
    '',
    '## Deliverables',
    '',
    ...spec.deliverables.map((item) => `- ${item}`),
    '',
    '## Acceptance',
    '',
    ...spec.acceptance.map((item) => `- ${item}`),
    '',
    '## Risk Gates',
    '',
    ...spec.riskGates.map((item) => `- ${item}`),
    '',
    '## Checks',
    '',
    ...spec.checks.map((item) => `- ${item}`),
    '',
    '## Initial Backlog',
    '',
    ...spec.backlog.map((item) => `- ${item.id}: ${item.title}`),
    '',
    '## Assumptions',
    '',
    ...spec.assumptions.map((item) => `- ${item}`),
    ''
  ];
  return `${lines.join('\n')}`;
}

export async function projectIntake(root, options = {}) {
  const spec = buildProjectSpec(options);
  const runId = `${isoStamp()}_${spec.project}`;
  const intakeDir = path.join(projectRuntimeDirFor(root, spec.project), 'intake');
  const plansDir = path.join(projectRuntimeDirFor(root, spec.project), 'plans');
  const artifact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'deterministic_project_intake_v1',
    runId,
    status: spec.blockingQuestions.length ? 'needs_human_input' : 'ready_for_plan',
    project: spec
  };
  const intakeFile = path.join(intakeDir, `${runId}.json`);
  const latestFile = projectLatestIntakePath(root, spec.project);
  const planFile = path.join(plansDir, 'project-plan.md');
  await writeJson(intakeFile, artifact);
  await writeJson(latestFile, artifact);
  await mkdir(path.dirname(planFile), { recursive: true });
  await writeFile(planFile, renderProjectPlanMarkdown(spec));
  return {
    project: spec.project,
    type: spec.type,
    status: artifact.status,
    queue: spec.queues[0],
    backlogCount: spec.backlog.length,
    intakeFile: path.relative(root, intakeFile),
    latestIntakeFile: path.relative(root, latestFile),
    planFile: path.relative(root, planFile),
    spec
  };
}

function validateProjectSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Project spec must be an object.');
  if (spec.schemaVersion !== 1) throw new Error('Project spec schemaVersion must be 1.');
  normalizeProjectId(spec.project);
  if (!PROJECT_TEMPLATES[spec.type]) throw new Error(`Unsupported project type: ${spec.type}`);
  if (!Array.isArray(spec.queues) || spec.queues.length === 0) throw new Error('Project spec queues must be non-empty.');
  for (const queue of spec.queues) {
    normalizeLoopId(queue.queue);
    if (!['code', 'standard'].includes(queue.kind)) throw new Error(`Unsupported project queue kind: ${queue.kind}`);
  }
  if (!Array.isArray(spec.backlog) || spec.backlog.length === 0) throw new Error('Project spec backlog must be non-empty.');
}

export async function projectPlan(root, options = {}) {
  const project = normalizeProjectId(options.project ?? options.name);
  const latest = await readJson(projectLatestIntakePath(root, project));
  const spec = latest.project ?? latest;
  validateProjectSpec(spec);

  const configFile = projectConfigPathFor(root, project);
  if ((await exists(configFile)) && !options.force) {
    throw new Error(`Project config already exists: ${path.relative(root, configFile)}. Use --force to overwrite.`);
  }
  await writeJson(configFile, spec);

  const queueConfigs = [];
  for (const queue of spec.queues) {
    const file = queue.kind === 'code'
      ? await initCodeQueueConfig(root, queue.queue, { force: options.force })
      : await initQueueConfig(root, queue.queue, { force: options.force });
    const full = path.join(root, file);
    const queueConfig = await readJson(full);
    queueConfig.description = queue.kind === 'code'
      ? `Project queue for ${project}. Code tasks run in isolated git worktrees and remain human-gated for landing.`
      : `Project queue for ${project}. Tasks write local artifacts and remain human-gated for risky actions.`;
    queueConfig.scheduler = {
      ...(queueConfig.scheduler ?? {}),
      progressReport: {
        ...(queueConfig.scheduler?.progressReport ?? {}),
        enabled: queue.progressReport !== false
      }
    };
    if (Array.isArray(spec.checks) && spec.checks.length > 0 && queue.kind === 'code') {
      queueConfig.worktree = {
        ...(queueConfig.worktree ?? {}),
        verifyCommands: spec.checks
      };
    }
    await writeJson(full, queueConfig);
    queueConfigs.push(file);
  }

  const backlogFile = projectInitialBacklogPath(root, project);
  await writeJson(backlogFile, {
    version: 1,
    project,
    generatedAt: new Date().toISOString(),
    tasks: spec.backlog
  });
  const planFile = projectPlanMarkdownPath(root, project);
  await mkdir(path.dirname(planFile), { recursive: true });
  await writeFile(planFile, renderProjectPlanMarkdown(spec));

  return {
    project,
    type: spec.type,
    projectConfig: path.relative(root, configFile),
    queueConfigs,
    backlogFile: path.relative(root, backlogFile),
    planFile: path.relative(root, planFile),
    queueCount: spec.queues.length,
    backlogCount: spec.backlog.length,
    nextCommands: [
      `loop-engineering project-status --root ${root} --project ${project}`,
      `loop-engineering enqueue --root ${root} --queue ${spec.queues[0].queue} --title "${spec.backlog[0].title}" --task "..."`
    ]
  };
}

export async function projectStatus(root, options = {}) {
  const project = normalizeProjectId(options.project ?? options.name);
  const configFile = projectConfigPathFor(root, project);
  const spec = await readJson(configFile);
  validateProjectSpec(spec);
  const queues = [];
  for (const queue of spec.queues) {
    queues.push({
      ...queue,
      status: await queueStatus(root, queue.queue)
    });
  }
  let latestIntake = null;
  try {
    const intake = await readJson(projectLatestIntakePath(root, project));
    latestIntake = {
      status: intake.status ?? null,
      generatedAt: intake.generatedAt ?? null,
      file: path.relative(root, projectLatestIntakePath(root, project))
    };
  } catch {
    latestIntake = null;
  }
  const backlogFile = projectInitialBacklogPath(root, project);
  let backlog = null;
  try {
    const loaded = await readJson(backlogFile);
    backlog = {
      file: path.relative(root, backlogFile),
      count: Array.isArray(loaded.tasks) ? loaded.tasks.length : 0
    };
  } catch {
    backlog = null;
  }
  const totals = queues.reduce((acc, queue) => {
    for (const key of ['queued', 'active', 'done', 'failed', 'canceled', 'runs']) {
      acc[key] += queue.status[key] ?? 0;
    }
    if (queue.status.locked) acc.locked += 1;
    return acc;
  }, { queued: 0, active: 0, done: 0, failed: 0, canceled: 0, runs: 0, locked: 0 });
  const needsAttention = [];
  if (totals.failed > 0) needsAttention.push('failed_tasks_present');
  if (totals.active > 0) needsAttention.push('active_tasks_present');
  if (queues.some((queue) => queue.status.locked)) needsAttention.push('queue_locked');
  return {
    version: 1,
    project,
    type: spec.type,
    generatedAt: new Date().toISOString(),
    projectConfig: path.relative(root, configFile),
    goal: spec.goal,
    queues,
    totals,
    backlog,
    latestIntake,
    needsAttention,
    nextActions: needsAttention.length
      ? ['Inspect queue-status or code-task-status for the queue needing attention.']
      : ['Enqueue or run the next planned backlog task when ready.']
  };
}

export async function enqueueTask(root, options) {
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  let body = options.task ?? '';
  if (options.file) {
    body = await readFile(path.resolve(root, safeRelativePath(options.file, 'task file')), 'utf8');
  }
  if (typeof options.title !== 'string' || !options.title.trim()) {
    throw new Error('enqueue requires --title.');
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('enqueue requires --task or --file.');
  }

  const id = taskIdForTitle(options.title);
  const task = {
    version: 1,
    id,
    queue,
    title: options.title.trim(),
    body: body.trim(),
    status: 'queued',
    enqueuedAt: new Date().toISOString(),
    ...(options.riskAssessment ? { riskAssessment: options.riskAssessment } : {}),
    ...(options.supersedesTaskId ? { supersedesTaskId: options.supersedesTaskId } : {}),
    ...(options.supersedeReason ? { supersedeReason: options.supersedeReason } : {}),
    ...(taskSourceFromOptions(options) ? { source: taskSourceFromOptions(options) } : {})
  };
  const file = path.join(queueSubdirFor(root, queue, 'inbox'), `${id}.json`);
  await writeJson(file, task);
  return { task, file: path.relative(root, file) };
}

function taskSourceFromOptions(options = {}) {
  const source = {
    channel: options.sourceChannel ?? null,
    target: options.sourceTarget ?? null,
    account: options.sourceAccount ?? null,
    message_id: options.sourceMessageId ?? null,
    reply_to: options.sourceReplyTo ?? null
  };
  return Object.values(source).some(Boolean) ? source : null;
}

export function classifyLoopMessage(message) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('route-message requires --message.');
  const mentionsLoop = /(loop engineering|loop-engineering|task-runner|队列|queue|\bloop\b)/i.test(text);
  const statusIntent = mentionsLoop
    && /(查|看|检查|审计|状态|情况|进度|怎么样|为什么|失败|报错|健康|health|status|progress|audit|summar)/i.test(text);
  const executeIntent = /(走\s*loop|继续(?:当前|这个)?\s*loop|给(?:当前|这个)?\s*loop\s*(?:补充|增加|加)|用\s*loop.*(?:解决|执行|完成|处理|修复|绕过|避开|跳过|bypass|evade)|丢进.*loop|入队|enqueue|run[- ]?queue|立刻执行|立即执行)/i.test(text);
  const intent = executeIntent ? 'execute' : statusIntent ? 'status' : 'direct';
  return {
    intent,
    risk: 'model_assessed',
    enqueue: intent === 'execute',
    readOnly: intent === 'status'
  };
}

async function appendActiveTaskAmendment(root, queue, activeTask, options = {}) {
  const runtimeDir = taskRuntimeDirFor(root, queue, activeTask.id);
  const amendmentsDir = path.join(runtimeDir, 'amendments');
  await mkdir(amendmentsDir, { recursive: true });
  const existing = (await listJson(amendmentsDir)).filter((file) => /^\d{4}\.json$/.test(file));
  const sequence = existing.length + 1;
  const amendment = {
    version: 1,
    sequence,
    taskId: activeTask.id,
    queue,
    instruction: String(options.message).trim(),
    requestedAt: new Date().toISOString(),
    source: taskSourceFromOptions(options),
    status: 'active',
    semantics: 'continue_same_task'
  };
  const versionedFile = path.join(amendmentsDir, `${String(sequence).padStart(4, '0')}.json`);
  const latestFile = path.join(amendmentsDir, 'latest.json');
  await writeJson(versionedFile, amendment);
  await writeJson(latestFile, amendment);

  const planFiles = [
    ['task_contract.json', 'supplemental_requirements'],
    ['acceptance_plan.json', 'supplemental_checks'],
    ['dev_plan.json', 'supplemental_instructions']
  ];
  const updatedPlans = [];
  for (const [name, field] of planFiles) {
    const file = path.join(runtimeDir, name);
    if (!(await exists(file))) continue;
    const plan = await readJson(file);
    const ref = {
      sequence,
      instruction: amendment.instruction,
      requested_at: amendment.requestedAt,
      artifact: path.relative(root, versionedFile)
    };
    await writeJson(file, {
      ...plan,
      amendment_version: sequence,
      amendments: [...(Array.isArray(plan.amendments) ? plan.amendments : []), ref],
      [field]: [...(Array.isArray(plan[field]) ? plan[field] : []), amendment.instruction],
      updated_at: new Date().toISOString()
    });
    updatedPlans.push(path.relative(root, file));
  }
  await writeJson(path.join(queueSubdirFor(root, queue, 'active'), `${activeTask.id}.json`), {
    ...activeTask,
    amendmentCount: sequence,
    lastAmendmentAt: amendment.requestedAt,
    lastAmendmentFile: path.relative(root, versionedFile)
  });
  return {
    amendment,
    file: path.relative(root, versionedFile),
    latestFile: path.relative(root, latestFile),
    updatedPlans
  };
}

export async function routeLoopMessage(root, options = {}) {
  const classification = classifyLoopMessage(options.message);
  if (!options.route) return classification;
  if (classification.intent === 'status') {
    return {
      ...classification,
      action: 'summarize',
      summaries: await summarizeLoopRuns(root, {
        queue: options.queue,
        limit: options.limit ?? 20
      })
    };
  }
  if (classification.intent !== 'execute') {
    return {
      ...classification,
      action: 'handle_directly',
      reason: 'No explicit loop execution request.'
    };
  }
  if (!options.confirmExecute) {
    throw new Error('explicit loop execution requires --confirm-execute.');
  }
  if (!options.queue) throw new Error('route-message execution requires --queue.');
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  if (options.supersedeActive && options.amendActive) {
    throw new Error('--supersede-active and --amend-active are mutually exclusive.');
  }
  const activeFiles = (options.supersedeActive || options.amendActive) ? await listJson(queueSubdirFor(root, queue, 'active')) : [];
  const activeTask = activeFiles.length > 0
    ? await readJson(path.join(queueSubdirFor(root, queue, 'active'), activeFiles[0]))
    : null;
  if (options.amendActive) {
    if (!activeTask) throw new Error('No active loop task exists to amend.');
    const amended = await appendActiveTaskAmendment(root, queue, activeTask, options);
    return {
      ...classification,
      action: 'active_task_amended',
      taskId: activeTask.id,
      task: { ...activeTask, amendmentCount: amended.amendment.sequence },
      amendment: amended.amendment,
      amendmentFile: amended.file,
      latestAmendmentFile: amended.latestFile,
      updatedPlans: amended.updatedPlans
    };
  }
  if (activeTask) {
    const requestFile = path.join(taskRuntimeDirFor(root, queue, activeTask.id), 'supersede_request.json');
    await writeJson(requestFile, {
      version: 1,
      requestedAt: new Date().toISOString(),
      activeTaskId: activeTask.id,
      reason: String(options.message).trim(),
      status: 'requested'
    });
    for (const file of await listJson(queueSubdirFor(root, queue, 'inbox'))) {
      const full = path.join(queueSubdirFor(root, queue, 'inbox'), file);
      const queued = await readJson(full);
      if (queued.supersedesTaskId !== activeTask.id) continue;
      const canceledFile = path.join(queueSubdirFor(root, queue, 'canceled'), file);
      await writeJson(canceledFile, {
        ...queued,
        status: 'superseded_before_start',
        canceledAt: new Date().toISOString(),
        supersededByNewerRequest: true
      });
      await rm(full, { force: true });
    }
  }
  const title = options.title?.trim() || `Routed task: ${String(options.message).trim().slice(0, 80)}`;
  const task = [
    'This task was explicitly routed to Loop Engineering from a source conversation.',
    'Assess risk contextually in the planner and executor. The routing layer does not reject goals by topic or wording.',
    `User request: ${String(options.message).trim()}`
  ].join('\n\n');
  const enqueued = await enqueueTask(root, {
    ...options,
    title,
    task,
    riskAssessment: 'model_assessed',
    supersedesTaskId: activeTask?.id,
    supersedeReason: activeTask ? String(options.message).trim() : null
  });
  if (activeTask) {
    const requestFile = path.join(taskRuntimeDirFor(root, queue, activeTask.id), 'supersede_request.json');
    const request = await readJson(requestFile);
    await writeJson(requestFile, {
      ...request,
      replacementTaskId: enqueued.task.id,
      replacementTaskFile: enqueued.file
    });
  }
  return {
    ...classification,
    action: activeTask ? 'supersede_requested' : 'enqueued',
    ...(activeTask ? { supersededTaskId: activeTask.id } : {}),
    ...enqueued
  };
}

function terminalNotificationMessage(queue, task) {
  const needsReview = task.status === 'ready_for_human_review';
  const needsHuman = ['needs_human_input', 'blocked', 'ready_for_human_review'].includes(task.status);
  return [
    needsReview ? 'Loop task is ready for human acceptance'
      : needsHuman ? 'Loop task needs human input'
        : 'Loop task reached a terminal state',
    `task: ${task.title}`,
    `queue: ${queue}`,
    `status: ${task.status}`,
    ...(needsReview
      ? [`next: review the final judgement and record approve, request_changes, or reject for task ${task.id}.`]
      : needsHuman
        ? ['next: inspect the task final judgement and checkpoints, resolve the blocker, then explicitly continue or requeue.']
        : [])
  ].join('\n');
}

export async function notifyTerminalTasks(root, options = {}) {
  const queue = normalizeLoopId(options.queue);
  if (!options.notifyCommand && !options.dryRun) {
    throw new Error('queue-terminal-notify requires --notify-command unless --dry-run is used.');
  }
  await ensureQueueDirs(root, queue);
  const notificationDir = path.join(queueDirFor(root, queue), 'notifications');
  await mkdir(notificationDir, { recursive: true });
  const results = [];
  for (const subdir of ['done', 'failed', 'canceled']) {
    const dir = queueSubdirFor(root, queue, subdir);
    for (const file of await listJson(dir)) {
      const task = await readJson(path.join(dir, file));
      if (!task?.id || !task?.status) continue;
      if (!task?.source?.channel || !task?.source?.target) {
        results.push({
          taskId: task.id,
          status: task.status,
          outcome: 'failed',
          error: 'missing source.channel/source.target; refusing unscoped terminal delivery'
        });
        continue;
      }
      const key = `${safeTaskId(task.id)}.${normalizeLoopId(task.status)}.json`;
      const ledgerFile = path.join(notificationDir, key);
      if (await exists(ledgerFile)) {
        results.push({ taskId: task.id, status: task.status, outcome: 'already_notified', ledger: path.relative(root, ledgerFile) });
        continue;
      }
      const message = terminalNotificationMessage(queue, task);
      if (options.dryRun) {
        results.push({ taskId: task.id, status: task.status, outcome: 'dry_run', message, source: task.source });
        continue;
      }
      const result = await runCommand(`${options.notifyCommand} ${shellQuote(message)}`, {
        cwd: root,
        timeoutMs: options.timeoutMs ?? 60_000,
        env: {
          ...process.env,
          LOOP_NOTIFICATION_QUEUE: queue,
          LOOP_NOTIFICATION_TASK_ID: task.id,
          LOOP_NOTIFICATION_TASK_STATUS: task.status,
          LOOP_NOTIFICATION_MESSAGE: message,
          LOOP_NOTIFICATION_SOURCE: JSON.stringify(task.source)
        }
      });
      if (result.exitCode !== 0) {
        results.push({ taskId: task.id, status: task.status, outcome: 'failed', result: compactCommandResult(result) });
        continue;
      }
      const ledger = {
        version: 1,
        queue,
        task_id: task.id,
        task_status: task.status,
        source: task.source,
        notified_at: new Date().toISOString(),
        result: compactCommandResult(result)
      };
      await writeJson(ledgerFile, ledger);
      results.push({ taskId: task.id, status: task.status, outcome: 'sent', ledger: path.relative(root, ledgerFile) });
    }
  }
  return {
    queue,
    dryRun: Boolean(options.dryRun),
    inspected: results.length,
    sent: results.filter((item) => item.outcome === 'sent').length,
    failed: results.filter((item) => item.outcome === 'failed').length,
    results
  };
}

function humanInputMessage(queue, task, checkpoint, gateId) {
  const blockers = Array.isArray(checkpoint.blockers) ? checkpoint.blockers : [];
  const blockerText = blockers.length
    ? blockers.map((item) => typeof item === 'string' ? item : item?.human_action_required ?? item?.user_action ?? item?.description ?? item?.message ?? JSON.stringify(item))
    : [checkpoint.next_action ?? 'Human input is required before the task can continue.'];
  return [
    'Loop task is waiting for your input',
    `task: ${task.title}`,
    `queue: ${queue}`,
    `gate: ${gateId}`,
    ...blockerText.map((item) => `needed: ${item}`),
    `reply: LOOP ${gateId} <your input>`
  ].join('\n');
}

async function tasksById(root, queue) {
  const tasks = new Map();
  for (const subdir of ['inbox', 'active', 'done', 'failed', 'canceled']) {
    for (const file of await listJson(queueSubdirFor(root, queue, subdir))) {
      const task = await readJson(path.join(queueSubdirFor(root, queue, subdir), file));
      if (task?.id) tasks.set(task.id, { task, subdir });
    }
  }
  return tasks;
}

export async function notifyHumanInputRequests(root, options = {}) {
  const queue = normalizeLoopId(options.queue);
  if (!options.notifyCommand && !options.dryRun) {
    throw new Error('queue-human-input-notify requires --notify-command unless --dry-run is used.');
  }
  await ensureQueueDirs(root, queue);
  const tasks = await tasksById(root, queue);
  const gatesDir = path.join(queueDirFor(root, queue), 'human-input', 'gates');
  await mkdir(gatesDir, { recursive: true });
  const results = [];
  for (const [taskId, entry] of tasks) {
    if (!entry.task.source) continue;
    const checkpointsDir = path.join(taskRuntimeDirFor(root, queue, taskId), 'checkpoints');
    for (const file of await listJson(checkpointsDir)) {
      const checkpoint = await readJson(path.join(checkpointsDir, file));
      if (!['needs_human_input', 'blocked'].includes(checkpoint?.status)) continue;
      const checkpointId = checkpoint.checkpoint_id ?? path.basename(file, '.json');
      const gateId = `${taskId}:${checkpointId}`;
      const ledgerFile = path.join(gatesDir, `${safeTaskId(taskId)}.${normalizeLoopId(checkpointId)}.json`);
      if (await exists(ledgerFile)) {
        const gate = await readJson(ledgerFile);
        results.push({ taskId, checkpointId, gateId, outcome: gate.status === 'resolved' ? 'resolved' : 'already_notified', ledger: path.relative(root, ledgerFile) });
        continue;
      }
      const message = humanInputMessage(queue, entry.task, checkpoint, gateId);
      if (options.dryRun) {
        results.push({ taskId, checkpointId, gateId, outcome: 'dry_run', message, source: entry.task.source });
        continue;
      }
      const result = await runCommand(`${options.notifyCommand} ${shellQuote(message)}`, {
        cwd: root,
        timeoutMs: options.timeoutMs ?? 60_000,
        env: {
          ...process.env,
          LOOP_HUMAN_INPUT_QUEUE: queue,
          LOOP_HUMAN_INPUT_TASK_ID: taskId,
          LOOP_HUMAN_INPUT_CHECKPOINT_ID: checkpointId,
          LOOP_HUMAN_INPUT_GATE_ID: gateId,
          LOOP_HUMAN_INPUT_MESSAGE: message,
          LOOP_HUMAN_INPUT_SOURCE: JSON.stringify(entry.task.source)
        }
      });
      if (result.exitCode !== 0) {
        results.push({ taskId, checkpointId, gateId, outcome: 'failed', result: compactCommandResult(result) });
        continue;
      }
      await writeJson(ledgerFile, {
        version: 1,
        gate_id: gateId,
        queue,
        task_id: taskId,
        checkpoint_id: checkpointId,
        status: 'waiting_for_human',
        source: entry.task.source,
        request: message,
        requested_at: new Date().toISOString(),
        notification: compactCommandResult(result)
      });
      results.push({ taskId, checkpointId, gateId, outcome: 'sent', ledger: path.relative(root, ledgerFile) });
    }
  }
  return {
    queue,
    inspected: results.length,
    sent: results.filter((item) => item.outcome === 'sent').length,
    failed: results.filter((item) => item.outcome === 'failed').length,
    results
  };
}

export async function resolveHumanInput(root, options = {}) {
  const queue = normalizeLoopId(options.queue);
  if (!options.gateId || typeof options.input !== 'string' || !options.input.trim()) {
    throw new Error('queue-human-input-resolve requires --gate-id and --input.');
  }
  const separator = options.gateId.lastIndexOf(':');
  if (separator <= 0) throw new Error(`Invalid gate id: ${options.gateId}`);
  const taskId = options.gateId.slice(0, separator);
  const checkpointId = options.gateId.slice(separator + 1);
  normalizeLoopId(checkpointId);
  const ledgerFile = path.join(queueDirFor(root, queue), 'human-input', 'gates', `${safeTaskId(taskId)}.${checkpointId}.json`);
  if (!await exists(ledgerFile)) throw new Error(`Human-input gate not found: ${options.gateId}`);
  const gate = await readJson(ledgerFile);
  if (gate.status === 'resolved') return { gate, outcome: 'already_resolved', ledger: path.relative(root, ledgerFile) };
  const resolved = {
    ...gate,
    status: 'resolved',
    response: options.input.trim(),
    response_message_id: options.sourceMessageId ?? null,
    resolved_at: new Date().toISOString()
  };
  await writeJson(ledgerFile, resolved);
  const found = await findTaskFile(root, queue, taskId, ['failed', 'canceled']);
  let requeued = null;
  if (found) {
    const task = await readJson(found.file);
    const inboxFile = path.join(queueSubdirFor(root, queue, 'inbox'), path.basename(found.file));
    await writeJson(inboxFile, {
      ...task,
      status: 'queued',
      body: `${task.body}\n\nHuman input for gate ${options.gateId}:\n${options.input.trim()}`,
      humanInput: {
        gate_id: options.gateId,
        checkpoint_id: checkpointId,
        response: options.input.trim(),
        received_at: resolved.resolved_at
      },
      requeuedAt: resolved.resolved_at,
      requeuedFrom: found.subdir
    });
    await rm(found.file, { force: true });
    requeued = path.relative(root, inboxFile);
  }
  return { gate: resolved, outcome: requeued ? 'resolved_and_requeued' : 'resolved_pending_terminal', requeued };
}

export function taskRuntimeDirFor(root, queue, taskId) {
  return path.join(queueSubdirFor(root, normalizeLoopId(queue), 'tasks'), safeTaskId(taskId));
}

function safeTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
  return taskId;
}

function inferTaskRisk(task) {
  const text = `${task.title ?? ''}\n${task.body ?? ''}`.toLowerCase();
  const l3Hints = [
    'send',
    'publish',
    'deploy',
    'production',
    'prod',
    'credential',
    'secret',
    'token',
    'delete',
    'remove',
    'drop',
    'kill',
    'pkill',
    'killall',
    'rm -rf',
    'migration',
    'external',
    'su -c',
    'root shell',
    '发送',
    '发布',
    '部署',
    '生产',
    '凭证',
    '密钥',
    '删除',
    '杀进程',
    '清理进程',
    '迁移'
  ];
  const l3Matches = l3Hints.filter((hint) => text.includes(hint));
  if (l3Matches.length > 0) {
    return {
      level: 'L3',
      reasons: l3Matches.map((hint) => `matched high-risk action keyword: ${hint}`)
    };
  }
  const l2Hints = [
    'implement',
    'fix',
    'change',
    'edit',
    'patch',
    'code',
    'test',
    'refactor',
    'frida',
    'tcpdump',
    'adb',
    'mitmproxy',
    'hook',
    'spawn',
    'attach',
    'decrypt',
    'pcap',
    '抓包',
    '解密',
    '注入',
    '动态调试',
    '进程',
    '实现',
    '修复',
    '修改',
    '开发',
    '代码',
    '测试'
  ];
  const l2Matches = l2Hints.filter((hint) => text.includes(hint));
  if (l2Matches.length > 0) {
    return {
      level: 'L2',
      reasons: l2Matches.map((hint) => `matched gated local/process keyword: ${hint}`)
    };
  }
  return {
    level: 'L1',
    reasons: ['no high-risk or local mutation keywords matched']
  };
}

function inferRiskLevel(task) {
  return inferTaskRisk(task).level;
}

function defaultAllowedActions(riskLevel) {
  const base = ['read_files', 'inspect_state', 'write_local_artifacts'];
  if (riskLevel === 'L1') return base;
  return [...base, 'edit_local_files', 'run_tests', 'prepare_patch'];
}

function defaultBlockedActions(riskLevel) {
  const blocked = [
    'external_send_without_explicit_confirmation',
    'publish_without_explicit_confirmation',
    'destructive_commands_without_explicit_confirmation',
    'production_config_change_without_explicit_confirmation',
    'credential_change_without_explicit_confirmation',
    'memory_deletion_without_explicit_confirmation'
  ];
  if (['L2', 'L3'].includes(riskLevel)) {
    blocked.push(
      'same_turn_live_instrumentation_without_separate_human_approval',
      'frida_tcpdump_adb_or_mitmproxy_execution_without_separate_human_approval',
      'process_spawn_attach_kill_or_cleanup_without_separate_human_approval',
      'device_install_launch_input_or_root_shell_without_separate_human_approval'
    );
  }
  return blocked;
}

function buildTaskContract(queue, task, options = {}) {
  const inferredRisk = inferTaskRisk(task);
  const modelAssessed = task.riskAssessment === 'model_assessed';
  const riskLevel = options.riskLevel ?? (modelAssessed ? 'model_assessed' : inferredRisk.level);
  return {
    version: 1,
    task_id: task.id,
    queue,
    title: task.title,
    original_request: task.body,
    goal: task.body,
    deliverables: [
      'Structured run artifact',
      'Concise completion summary',
      'Verification evidence or blockers'
    ],
    constraints: {
      allowed_actions: defaultAllowedActions(riskLevel),
      blocked_actions: defaultBlockedActions(riskLevel),
      workspace: options.workspace ?? null
    },
    risk_level: riskLevel,
    risk_reasons: options.riskReasons ?? (modelAssessed
      ? ['risk is delegated to contextual planner and executor assessment']
      : inferredRisk.reasons),
    requires_human_gate: options.requiresHumanGate ?? (!modelAssessed && riskLevel !== 'L1'),
    acceptance_summary: 'The result must satisfy the original request, preserve stated constraints, and include verification evidence or explicit blockers.',
    historical_patterns: options.historicalPatterns ?? {
      generated_by: 'history_pattern_retriever_v1',
      error_library_matches: [],
      success_pattern_matches: [],
      guidance: []
    },
    created_at: new Date().toISOString()
  };
}

function tokenizePatternText(value) {
  return Array.from(new Set(String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 80)));
}

function patternScore(taskTokens, candidateText) {
  if (taskTokens.length === 0) return 0;
  const candidate = new Set(tokenizePatternText(candidateText));
  if (candidate.size === 0) return 0;
  const matched = taskTokens.filter((token) => candidate.has(token));
  return Number((matched.length / taskTokens.length).toFixed(3));
}

function patternOutcome(run) {
  const judgement = run.finalJudgement?.outcome ?? null;
  const status = run.status ?? run.outcome ?? 'unknown';
  if (['completed', 'success'].includes(status) && ['ready_to_apply', 'ready_for_human_review'].includes(judgement)) return 'success';
  if (['completed', 'success'].includes(status) && !judgement) return 'success';
  if (['needs_revision', 'blocked'].includes(judgement)) return 'error';
  if (!['completed', 'success', 'empty'].includes(status)) return 'error';
  return 'neutral';
}

function summarizePatternRun(entry, run, score, outcome) {
  return {
    score,
    outcome,
    task_id: run.taskId ?? null,
    run_id: run.runId ?? null,
    title: run.title ?? null,
    status: run.status ?? run.outcome ?? null,
    final_judgement: run.finalJudgement?.outcome ?? null,
    reasons: run.finalJudgement?.reasons ?? [],
    revision_request: run.revisionRequest?.path ?? null,
    run_path: entry.file
  };
}

async function retrieveHistoricalPatterns(root, queue, task, options = {}) {
  const limit = options.limit ?? 80;
  const taskTokens = tokenizePatternText(`${task.title ?? ''}\n${task.body ?? ''}`);
  const entries = await recentRuns(root, queue, { limit });
  const matches = [];
  for (const entry of entries) {
    const run = entry.run;
    if (!run || run.taskId === task.id || run.queue !== queue) continue;
    const score = patternScore(taskTokens, `${run.title ?? ''}\n${(run.finalJudgement?.reasons ?? []).join('\n')}\n${run.failureSignature ?? ''}`);
    if (score <= 0) continue;
    const outcome = patternOutcome(run);
    if (outcome === 'neutral') continue;
    matches.push(summarizePatternRun(entry, run, score, outcome));
  }
  const sorted = matches.sort((a, b) => b.score - a.score);
  const errors = sorted.filter((item) => item.outcome === 'error').slice(0, 5);
  const successes = sorted.filter((item) => item.outcome === 'success').slice(0, 5);
  const guidance = [];
  if (errors.length > 0) guidance.push('Review similar error-library matches before choosing a strategy.');
  if (successes.length > 0) guidance.push('Reuse relevant success-pattern tactics when they still fit the current task contract.');
  if (errors.some((item) => item.final_judgement === 'blocked')) guidance.push('Check known blockers before retrying or dispatching live work.');
  return {
    generated_by: 'history_pattern_retriever_v1',
    inspected_runs: entries.filter((entry) => entry.run?.queue === queue).length,
    error_library_matches: errors,
    success_pattern_matches: successes,
    guidance
  };
}

export async function writeTaskContract(root, queue, task, options = {}) {
  const dir = taskRuntimeDirFor(root, queue, task.id);
  const file = path.join(dir, 'task_contract.json');
  const historicalPatterns = await retrieveHistoricalPatterns(root, queue, task, options.history ?? {});
  const contract = buildTaskContract(queue, task, {
    ...options,
    workspace: options.workspace ?? root,
    historicalPatterns
  });
  await writeJson(file, contract);
  return {
    contract,
    file: path.relative(root, file)
  };
}

function inferAcceptanceSignals(contract) {
  const text = `${contract.title ?? ''}\n${contract.original_request ?? ''}`.toLowerCase();
  return {
    code: ['implement', 'fix', 'change', 'edit', 'patch', 'code', 'refactor', '实现', '修复', '修改', '开发', '代码'].some((hint) => text.includes(hint)),
    tests: ['test', 'verify', 'check', '验收', '验证', '测试', '检查'].some((hint) => text.includes(hint)),
    docs: ['doc', 'readme', 'design', 'architecture', '文档', '设计', '架构'].some((hint) => text.includes(hint)),
    external: contract.risk_level === 'L3'
  };
}

const DEFAULT_ACCEPTANCE_CRITICS = [
  {
    id: 'correctness',
    source: 'default',
    focus: 'Does the checkpoint demonstrate that the task goal was satisfied?',
    requiredEvidence: ['summary', 'verification'],
    failureStatus: 'revise',
    revisionHint: 'Make the result satisfy the task goal and record concrete proof in the next checkpoint.'
  },
  {
    id: 'safety',
    source: 'default',
    focus: 'Are gated or blocked actions still behind the human gate?',
    requiredEvidence: ['no_blockers'],
    failureStatus: 'blocked',
    revisionHint: 'Resolve or explicitly escalate blockers before any additional development attempt.'
  },
  {
    id: 'regression',
    source: 'default',
    focus: 'Is there evidence that adjacent behavior remains intact?',
    requiredEvidence: ['verification'],
    failureStatus: 'revise',
    revisionHint: 'Add a regression-oriented verification path for the behavior touched by this task.'
  },
  {
    id: 'domain',
    source: 'default',
    focus: 'Are domain assumptions, residual risks, and edge cases explicit?',
    requiredEvidence: ['risks_array'],
    failureStatus: 'revise',
    revisionHint: 'State residual risks, assumptions, and edge cases so acceptance can judge the domain fit.'
  }
];

const DEFAULT_EVIDENCE_REVISION_HINTS = {
  summary: 'Write a concise checkpoint summary that explains what changed and why it satisfies the task.',
  verification: 'Run or design a targeted verification command and record the command, outcome, and relevant output summary.',
  no_blockers: 'Resolve reported blockers, or mark the task blocked with the exact human, device, or external action required.',
  risks_array: 'Record a risks array, even when empty, with any assumptions or residual risks that remain.',
  status_ready: 'Only mark the checkpoint ready_for_acceptance after development and verification evidence are complete.',
  files_changed: 'Record changed files or generated artifacts so reviewers can trace the implementation.',
  manual_review: 'Carry the manual review checklist into the next checkpoint evidence or human handoff.',
  regression_checks: 'Add a regression check that covers adjacent behavior affected by this task.',
  edge_cases: 'Address or explicitly document the relevant edge cases from the acceptance plan.',
  blocked_actions: 'Carry forward blocked action constraints and avoid retrying gated actions without human approval.',
  risk_level: 'Preserve the task risk level and explain any risk changes in the next checkpoint.'
};

function normalizeAcceptanceCritics(configuredCritics = []) {
  const byId = new Map(DEFAULT_ACCEPTANCE_CRITICS.map((critic) => [critic.id, { ...critic }]));
  for (const configured of configuredCritics ?? []) {
    const existing = byId.get(configured.id) ?? {};
    byId.set(configured.id, {
      ...existing,
      id: configured.id,
      source: existing.source === 'default' ? 'configured_override' : 'configured',
      focus: configured.focus ?? existing.focus ?? `Configured critic ${configured.id}.`,
      requiredEvidence: configured.requiredEvidence ?? existing.requiredEvidence ?? ['summary'],
      failureStatus: configured.failureStatus ?? configured.minStatus ?? existing.failureStatus ?? 'revise',
      revisionHint: configured.revisionHint ?? existing.revisionHint,
      evidenceHints: configured.evidenceHints ?? existing.evidenceHints
    });
  }
  return Array.from(byId.values()).map((critic) => ({
    id: critic.id,
    source: critic.source,
    focus: critic.focus,
    requiredEvidence: critic.requiredEvidence,
    failureStatus: critic.failureStatus,
    ...(critic.revisionHint ? { revisionHint: critic.revisionHint } : {}),
    ...(critic.evidenceHints ? { evidenceHints: critic.evidenceHints } : {})
  }));
}

function buildAcceptancePlan(contract, options = {}) {
  const signals = inferAcceptanceSignals(contract);
  const functionalChecks = [
    'The delivered result satisfies the task contract goal.',
    'The implementation preserves all explicit constraints from the task contract.'
  ];
  if (signals.code) {
    functionalChecks.push('The changed behavior is exercised through a targeted verification path.');
  }
  if (signals.docs) {
    functionalChecks.push('The written design or documentation is internally consistent and matches the current implementation boundaries.');
  }

  const regressionChecks = [
    'Existing adjacent behavior remains unchanged unless the task contract explicitly allows it.'
  ];
  if (signals.code || signals.tests) {
    regressionChecks.push('Relevant existing tests or health checks still pass.');
  }

  const edgeCases = [
    'Empty or missing input',
    'Invalid configuration or unavailable dependency',
    'Repeated execution should not corrupt existing task state'
  ];
  if (signals.external) {
    edgeCases.push('External action is requested without explicit confirmation');
  }

  const negativeTests = [
    'Blocked actions from the task contract remain blocked without explicit confirmation.'
  ];
  if (signals.external) {
    negativeTests.push('No send, publish, deployment, deletion, credential change, production change, or migration is performed before a human gate.');
  }

  const manualReview = [
    'Review the run artifact summary for status, evidence, and blockers.',
    'Confirm the result did not expand scope beyond the task contract.'
  ];

  const automation = [];
  if (signals.code || signals.tests) {
    automation.push({
      command: 'npm test',
      reason: 'Run the repository test suite when available.'
    });
  }
  automation.push({
    command: 'loop-engineering doctor --root <workspace> --json',
    reason: 'Confirm loop workspace health after the task run.'
  });

  return {
    version: 1,
    task_id: contract.task_id,
    source_contract: 'task_contract.json',
    generated_by: 'deterministic_acceptance_planner_v1',
    risk_level: contract.risk_level,
    requires_human_gate: contract.requires_human_gate,
    functional_checks: functionalChecks,
    regression_checks: regressionChecks,
    edge_cases: edgeCases,
    negative_tests: negativeTests,
    manual_review: manualReview,
    automation,
    critic_profile: {
      generated_by: 'acceptance_critic_profile_v1',
      configured_count: (options.acceptanceCritics ?? []).length,
      critics: normalizeAcceptanceCritics(options.acceptanceCritics)
    },
    rubric: [
      {
        id: 'meets_goal',
        required: true,
        description: 'The result satisfies the task contract goal.'
      },
      {
        id: 'respects_constraints',
        required: true,
        description: 'Allowed and blocked actions match the task contract.'
      },
      {
        id: 'evidence_recorded',
        required: true,
        description: 'Verification evidence or explicit blockers are recorded in artifacts.'
      }
    ],
    created_at: new Date().toISOString()
  };
}

export async function writeAcceptancePlan(root, queue, task, taskContract, options = {}) {
  const dir = taskRuntimeDirFor(root, queue, task.id);
  const file = path.join(dir, 'acceptance_plan.json');
  const plan = buildAcceptancePlan(taskContract.contract, options);
  await writeJson(file, plan);
  return {
    plan,
    file: path.relative(root, file)
  };
}

function buildDevPlan(contract, acceptancePlan) {
  const firstCheckpointId = 'cp1';
  const gated = contract.requires_human_gate;
  return {
    version: 1,
    task_id: contract.task_id,
    source_contract: 'task_contract.json',
    source_acceptance_plan: 'acceptance_plan.json',
    generated_by: 'deterministic_dev_planner_v1',
    risk_level: contract.risk_level,
    requires_human_gate: contract.requires_human_gate,
    approach: gated
      ? 'Read the task contract and acceptance plan, produce bounded local artifacts and checkpoint evidence, and stop before any live instrumentation, process control, external action, or repeated human-blocked retry.'
      : 'Read the task contract and acceptance plan, make the smallest useful change, and record checkpoint evidence before claiming completion.',
    acceptance_alignment: {
      functional_checks: acceptancePlan.functional_checks.map((_, index) => `functional:${index + 1}`),
      regression_checks: acceptancePlan.regression_checks.map((_, index) => `regression:${index + 1}`),
      negative_tests: acceptancePlan.negative_tests.map((_, index) => `negative:${index + 1}`)
    },
    checkpoints: [
      {
        id: firstCheckpointId,
        goal: 'Produce the first complete development result for acceptance review.',
        required_evidence: [
          'Summary of files changed or artifacts created',
          'Verification commands run or explicit reason they could not run',
          ...(gated ? ['Any human/device/environment blocker that must be resolved before retry'] : []),
          'Known blockers and residual risks'
        ],
        output_file: `checkpoints/${firstCheckpointId}.json`
      }
    ],
    checkpoint_schema: {
      version: 1,
      task_id: contract.task_id,
      checkpoint_id: firstCheckpointId,
      status: 'ready_for_acceptance | blocked | needs_human_input',
      summary: 'What changed and why.',
      files_changed: [],
      verification: [],
      blockers: [],
      risks: [],
      next_action: 'acceptance_review'
    },
    created_at: new Date().toISOString()
  };
}

export async function writeDevPlan(root, queue, task, taskContract, acceptancePlan) {
  const dir = taskRuntimeDirFor(root, queue, task.id);
  const checkpointsDir = path.join(dir, 'checkpoints');
  const reviewsDir = path.join(dir, 'reviews');
  await mkdir(checkpointsDir, { recursive: true });
  await mkdir(reviewsDir, { recursive: true });
  const file = path.join(dir, 'dev_plan.json');
  const plan = buildDevPlan(taskContract.contract, acceptancePlan.plan);
  await writeJson(file, plan);
  return {
    plan,
    file: path.relative(root, file),
    checkpointsDir: path.relative(root, checkpointsDir),
    reviewsDir: path.relative(root, reviewsDir)
  };
}

async function checkpointSummary(root, devPlan) {
  if (!devPlan?.checkpointsDir) return null;
  const dir = path.join(root, devPlan.checkpointsDir);
  const files = await listJson(dir);
  return {
    dir: devPlan.checkpointsDir,
    count: files.length,
    files: files.map((file) => path.join(devPlan.checkpointsDir, file))
  };
}

function checkpointReviewStatus(checkpoint) {
  if (!checkpoint) return 'blocked';
  if (checkpoint.status === 'blocked' || checkpoint.status === 'needs_human_input') return 'blocked';
  if (Array.isArray(checkpoint.blockers) && checkpoint.blockers.length > 0) return 'revise';
  if (!Array.isArray(checkpoint.verification) || checkpoint.verification.length === 0) return 'revise';
  if (checkpoint.status !== 'ready_for_acceptance') return 'revise';
  return 'accepted';
}

function evidenceFinding(evidence, context) {
  const { checkpoint, hasVerification, hasBlockers, hasSummary, hasRisks, blockedActions, riskLevel, acceptancePlan } = context;
  if (evidence === 'summary') {
    return hasSummary
      ? { ok: true, finding: 'Checkpoint includes a development summary.' }
      : { ok: false, finding: 'Checkpoint summary is missing.' };
  }
  if (evidence === 'verification') {
    return hasVerification
      ? { ok: true, finding: 'Checkpoint includes verification evidence.' }
      : { ok: false, finding: 'Checkpoint verification evidence is missing.' };
  }
  if (evidence === 'no_blockers') {
    return hasBlockers
      ? { ok: false, blocked: true, finding: 'Checkpoint reports blockers that must be resolved before continuing.' }
      : { ok: true, finding: 'Checkpoint reports no blockers.' };
  }
  if (evidence === 'risks_array') {
    return hasRisks
      ? { ok: true, finding: 'Checkpoint records residual risks, even if empty.' }
      : { ok: false, finding: 'Checkpoint risks array is missing.' };
  }
  if (evidence === 'status_ready') {
    return checkpoint?.status === 'ready_for_acceptance'
      ? { ok: true, finding: 'Checkpoint is marked ready for acceptance.' }
      : { ok: false, finding: `Checkpoint status is ${checkpoint?.status ?? 'missing'}.` };
  }
  if (evidence === 'files_changed') {
    return Array.isArray(checkpoint?.files_changed) && checkpoint.files_changed.length > 0
      ? { ok: true, finding: 'Checkpoint records changed files or artifacts.' }
      : { ok: false, finding: 'Checkpoint files_changed array is missing or empty.' };
  }
  if (evidence === 'manual_review') {
    return (acceptancePlan.manual_review ?? []).length > 0
      ? { ok: true, finding: `Acceptance manual review checks: ${acceptancePlan.manual_review.length}.` }
      : { ok: false, finding: 'Acceptance plan has no manual review checks.' };
  }
  if (evidence === 'regression_checks') {
    return (acceptancePlan.regression_checks ?? []).length > 0
      ? { ok: true, finding: `Acceptance regression checks: ${acceptancePlan.regression_checks.length}.` }
      : { ok: false, finding: 'Acceptance plan has no regression checks.' };
  }
  if (evidence === 'edge_cases') {
    return (acceptancePlan.edge_cases ?? []).length > 0
      ? { ok: true, finding: `Acceptance edge cases: ${acceptancePlan.edge_cases.length}.` }
      : { ok: false, finding: 'Acceptance plan has no edge cases.' };
  }
  if (evidence === 'blocked_actions') {
    return blockedActions.length > 0
      ? { ok: true, finding: `Blocked action rules carried forward: ${blockedActions.length}.` }
      : { ok: false, finding: 'No blocked action rules are present in the task contract.' };
  }
  if (evidence === 'risk_level') {
    return { ok: true, finding: `Risk level is ${riskLevel}.` };
  }
  return {
    ok: false,
    finding: `Unknown required evidence key: ${evidence}.`
  };
}

function evaluateAcceptanceCritic(critic, context) {
  const findings = [];
  const evidenceResults = [];
  let failed = false;
  let blocked = false;
  for (const evidence of critic.requiredEvidence ?? []) {
    const result = evidenceFinding(evidence, context);
    findings.push(result.finding);
    if (!result.ok) failed = true;
    if (result.blocked) blocked = true;
    evidenceResults.push({
      evidence,
      ok: result.ok,
      blocked: result.blocked === true,
      finding: result.finding,
      revision_hint: critic.evidenceHints?.[evidence] ?? DEFAULT_EVIDENCE_REVISION_HINTS[evidence] ?? `Provide required evidence for ${evidence}.`
    });
  }
  const failureStatus = critic.failureStatus ?? 'revise';
  const status = context.missingCheckpoint ? 'blocked' : blocked || (failed && failureStatus === 'blocked') ? 'blocked' : failed ? 'revise' : 'accepted';
  const missingEvidence = evidenceResults.filter((result) => !result.ok).map((result) => result.evidence);
  return {
    critic: critic.id,
    status,
    source: critic.source ?? 'configured',
    focus: critic.focus,
    required_evidence: critic.requiredEvidence ?? [],
    missing_evidence: missingEvidence,
    evidence_results: evidenceResults,
    revision_hint: critic.revisionHint ?? null,
    next_development_goals: status === 'accepted' ? [] : [
      ...(critic.revisionHint ? [critic.revisionHint] : []),
      ...evidenceResults.filter((result) => !result.ok).map((result) => result.revision_hint)
    ],
    findings
  };
}

function buildCriticReviews(contract, acceptancePlan, checkpoint) {
  const missingCheckpoint = !checkpoint;
  const hasVerification = Array.isArray(checkpoint?.verification) && checkpoint.verification.length > 0;
  const hasBlockers = Array.isArray(checkpoint?.blockers) && checkpoint.blockers.length > 0;
  const hasSummary = typeof checkpoint?.summary === 'string' && checkpoint.summary.trim().length > 0;
  const hasRisks = Array.isArray(checkpoint?.risks);
  const blockedActions = contract.constraints?.blocked_actions ?? [];
  const riskLevel = contract.risk_level ?? 'L1';
  const criticProfile = acceptancePlan.critic_profile?.critics ?? normalizeAcceptanceCritics();
  const context = {
    checkpoint,
    missingCheckpoint,
    hasVerification,
    hasBlockers,
    hasSummary,
    hasRisks,
    blockedActions,
    riskLevel,
    acceptancePlan
  };
  return criticProfile.map((critic) => evaluateAcceptanceCritic(critic, context));
}

function aggregateCriticStatus(baseStatus, criticReviews) {
  if (baseStatus === 'blocked' || criticReviews.some((review) => review.status === 'blocked')) return 'blocked';
  if (baseStatus === 'revise' || criticReviews.some((review) => review.status === 'revise')) return 'revise';
  return 'accepted';
}

function buildCheckpointReview(contract, acceptancePlan, checkpoint) {
  const baseStatus = checkpointReviewStatus(checkpoint);
  const failed = [];
  const passed = [];
  const blocked = [];

  if (!checkpoint) {
    blocked.push('Checkpoint artifact is missing.');
  } else {
    if (checkpoint.status === 'ready_for_acceptance') passed.push('Checkpoint is marked ready for acceptance.');
    else failed.push({
      check: 'checkpoint_status',
      evidence: `Checkpoint status is ${checkpoint.status ?? 'missing'}.`,
      suggested_fix: 'Update the checkpoint after development is ready for acceptance, or mark blockers explicitly.'
    });

    if (Array.isArray(checkpoint.verification) && checkpoint.verification.length > 0) {
      passed.push('Checkpoint records verification evidence.');
    } else {
      failed.push({
        check: 'verification_evidence',
        evidence: 'Checkpoint verification array is missing or empty.',
        suggested_fix: 'Record verification commands, results, or an explicit reason verification could not run.'
      });
    }

    if (Array.isArray(checkpoint.blockers) && checkpoint.blockers.length > 0) {
      blocked.push(...checkpoint.blockers.map((item) => typeof item === 'string' ? item : JSON.stringify(item)));
    } else {
      passed.push('Checkpoint reports no blockers.');
    }
  }

  for (const item of acceptancePlan.rubric ?? []) {
    if (item.required) passed.push(`Rubric considered: ${item.id}`);
  }

  const criticReviews = buildCriticReviews(contract, acceptancePlan, checkpoint);
  const status = aggregateCriticStatus(baseStatus, criticReviews);
  for (const review of criticReviews) {
    if (review.status === 'accepted') passed.push(`Critic accepted: ${review.critic}`);
    if (review.status === 'revise') failed.push({
      check: `critic_${review.critic}`,
      evidence: review.findings.join(' '),
      suggested_fix: review.revision_hint ?? `Address the ${review.critic} critic findings before the next acceptance review.`,
      critic: review.critic,
      critic_source: review.source,
      critic_focus: review.focus,
      required_evidence: review.required_evidence,
      missing_evidence: review.missing_evidence,
      evidence_results: review.evidence_results,
      next_development_goals: review.next_development_goals
    });
    if (review.status === 'blocked') blocked.push({
      check: `critic_${review.critic}`,
      evidence: review.findings.join(' '),
      suggested_fix: review.revision_hint ?? `Resolve the ${review.critic} critic blocker before the next acceptance review.`,
      critic: review.critic,
      critic_source: review.source,
      critic_focus: review.focus,
      required_evidence: review.required_evidence,
      missing_evidence: review.missing_evidence,
      evidence_results: review.evidence_results,
      next_development_goals: review.next_development_goals
    });
  }

  return {
    version: 1,
    task_id: contract.task_id,
    checkpoint_id: checkpoint?.checkpoint_id ?? 'missing',
    generated_by: 'deterministic_acceptance_reviewer_v1',
    status,
    base_status: baseStatus,
    critic_reviews: criticReviews,
    passed,
    failed,
    blocked,
    next_action: status === 'accepted' ? 'final_judge' : status === 'blocked' ? 'human_or_external_input' : 'development_revision',
    acceptance_basis: {
      source_contract: 'task_contract.json',
      source_acceptance_plan: 'acceptance_plan.json',
      functional_checks: acceptancePlan.functional_checks.length,
      regression_checks: acceptancePlan.regression_checks.length,
      negative_tests: acceptancePlan.negative_tests.length,
      automation: acceptancePlan.automation.length
    },
    created_at: new Date().toISOString()
  };
}

function summarizeCriticReviews(reviews) {
  const byCritic = {};
  for (const reviewSummary of reviews) {
    for (const review of reviewSummary.critic_reviews ?? []) {
      const current = byCritic[review.critic] ?? { accepted: 0, revise: 0, blocked: 0 };
      current[review.status] = (current[review.status] ?? 0) + 1;
      byCritic[review.critic] = current;
    }
  }
  return byCritic;
}

export async function writeAcceptanceReviews(root, queue, task, taskContract, acceptancePlan, devPlan) {
  if (!devPlan?.reviewsDir || !devPlan?.checkpointsDir) return null;
  const checkpointFiles = await listJson(path.join(root, devPlan.checkpointsDir));
  const reviews = [];
  const reviewArtifacts = [];
  for (const file of checkpointFiles) {
    const checkpointFile = path.join(root, devPlan.checkpointsDir, file);
    const checkpoint = await readJson(checkpointFile);
    const review = buildCheckpointReview(taskContract.contract, acceptancePlan.plan, checkpoint);
    const reviewFile = path.join(root, devPlan.reviewsDir, `${checkpoint.checkpoint_id ?? path.basename(file, '.json')}.json`);
    await writeJson(reviewFile, review);
    reviews.push({
      checkpointId: review.checkpoint_id,
      status: review.status,
      file: path.relative(root, reviewFile)
    });
    reviewArtifacts.push(review);
  }
  return {
    dir: devPlan.reviewsDir,
    count: reviews.length,
    accepted: reviews.filter((item) => item.status === 'accepted').length,
    revise: reviews.filter((item) => item.status === 'revise').length,
    blocked: reviews.filter((item) => item.status === 'blocked').length,
    critic_summary: summarizeCriticReviews(reviewArtifacts),
    files: reviews.map((item) => item.file),
    reviews
  };
}

function buildFinalJudgement(contract, acceptancePlan, devPlan, checkpoints, acceptanceReviews, context = {}) {
  const reasons = [];
  const nextActions = [];
  const requiredCheckpoints = Array.isArray(devPlan?.checkpoints) ? devPlan.checkpoints.length : 0;
  const checkpointCount = checkpoints?.count ?? 0;
  const reviewCount = acceptanceReviews?.count ?? 0;
  const acceptedCount = acceptanceReviews?.accepted ?? 0;
  const reviseCount = acceptanceReviews?.revise ?? 0;
  const blockedCount = acceptanceReviews?.blocked ?? 0;
  const dispatchStatus = context.dispatchStatus ?? 'unknown';
  let outcome = 'needs_revision';

  if (dispatchStatus === 'blocked_preflight') {
    outcome = 'blocked';
    reasons.push('Preflight blocked the task before development dispatch.');
    nextActions.push('Resolve preflight findings and rerun the queue task.');
  } else if (dispatchStatus === 'needs_human_input') {
    outcome = 'blocked';
    reasons.push('Development dispatch reached a blocker that requires human action.');
    nextActions.push('Resolve the human/device/environment blocker before any retry.');
  } else if (['worktree_failed', 'runtime_error'].includes(dispatchStatus)) {
    outcome = 'blocked';
    reasons.push(`Task infrastructure failed with status ${dispatchStatus}.`);
    nextActions.push('Inspect the run artifact and fix the local runner or worktree blocker.');
  } else if (dispatchStatus === 'verify_failed') {
    outcome = 'needs_revision';
    reasons.push('Development dispatch completed, but configured verification failed.');
    nextActions.push('Revise the development result until configured verification passes.');
  } else if (dispatchStatus === 'failed') {
    outcome = 'needs_revision';
    reasons.push('Development dispatch failed.');
    nextActions.push('Inspect dispatcher output and rerun development.');
  } else if (checkpointCount === 0) {
    outcome = 'needs_revision';
    reasons.push('No development checkpoints were recorded.');
    nextActions.push('Write at least one checkpoint with summary, verification, blockers, and risks.');
  } else if (reviewCount === 0) {
    outcome = 'needs_revision';
    reasons.push('No acceptance reviews were recorded.');
    nextActions.push('Run acceptance review against the produced checkpoints.');
  } else if (blockedCount > 0) {
    outcome = 'blocked';
    reasons.push(`${blockedCount} acceptance review(s) are blocked.`);
    nextActions.push('Resolve blockers or request the required human/external input.');
  } else if (reviseCount > 0) {
    outcome = 'needs_revision';
    reasons.push(`${reviseCount} acceptance review(s) require development revision.`);
    nextActions.push('Revise development output using acceptance feedback, then produce a new checkpoint.');
  } else if (acceptedCount < Math.max(requiredCheckpoints, 1)) {
    outcome = 'needs_revision';
    reasons.push(`Accepted checkpoints (${acceptedCount}) do not cover required checkpoints (${Math.max(requiredCheckpoints, 1)}).`);
    nextActions.push('Complete and review the remaining planned checkpoints.');
  } else if (contract.requires_human_gate) {
    outcome = 'ready_for_human_review';
    reasons.push('All reviewed checkpoints are accepted, and the task contract requires a human gate.');
    nextActions.push('Present the artifacts to the human reviewer before apply/send/publish/destructive action.');
  } else {
    outcome = 'ready_to_apply';
    reasons.push('All reviewed checkpoints are accepted and no human gate is required by the task contract.');
    nextActions.push('Proceed with the configured local apply/report step if one exists.');
  }

  return {
    version: 1,
    task_id: contract.task_id,
    generated_by: 'deterministic_final_judge_v1',
    outcome,
    risk_level: contract.risk_level,
    requires_human_gate: contract.requires_human_gate,
    dispatch_status: dispatchStatus,
    reasons,
    next_actions: nextActions,
    sources: {
      task_contract: 'task_contract.json',
      acceptance_plan: 'acceptance_plan.json',
      dev_plan: 'dev_plan.json',
      checkpoints_dir: 'checkpoints/',
      reviews_dir: 'reviews/'
    },
    coverage: {
      planned_checkpoints: requiredCheckpoints,
      produced_checkpoints: checkpointCount,
      reviews: reviewCount,
      accepted: acceptedCount,
      revise: reviseCount,
      blocked: blockedCount,
      rubric_items: Array.isArray(acceptancePlan?.rubric) ? acceptancePlan.rubric.length : 0,
      automation_suggestions: Array.isArray(acceptancePlan?.automation) ? acceptancePlan.automation.length : 0
    },
    residual_risks: [
      ...(contract.requires_human_gate ? ['Human gate still required before external or high-risk action.'] : []),
      ...(context.verificationFailed ? ['Configured verification has failing commands.'] : [])
    ],
    created_at: new Date().toISOString()
  };
}

export async function writeFinalJudgement(root, queue, task, taskContract, acceptancePlan, devPlan, checkpoints, acceptanceReviews, context = {}) {
  if (!taskContract?.contract || !acceptancePlan?.plan || !devPlan?.plan) return null;
  const dir = taskRuntimeDirFor(root, queue, task.id);
  const file = path.join(dir, 'final_judgement.json');
  const judgement = buildFinalJudgement(
    taskContract.contract,
    acceptancePlan.plan,
    devPlan.plan,
    checkpoints,
    acceptanceReviews,
    context
  );
  await writeJson(file, judgement);
  return {
    judgement,
    file: path.relative(root, file)
  };
}

function queueStatusFromFinalJudgement(currentStatus, finalJudgement) {
  if (!finalJudgement?.judgement) return currentStatus;
  if (currentStatus !== 'completed') return currentStatus;
  const outcome = finalJudgement.judgement.outcome;
  if (outcome === 'ready_to_apply') return currentStatus;
  if (outcome === 'ready_for_human_review') return outcome;
  return outcome;
}

function revisionActionFromReview(review) {
  const actions = [];
  for (const item of review.failed ?? []) {
    actions.push({
      checkpoint_id: review.checkpoint_id,
      source: 'acceptance_review.failed',
      check: item.check ?? 'unknown',
      evidence: item.evidence ?? null,
      suggested_fix: item.suggested_fix ?? 'Revise the checkpoint until this acceptance check passes.',
      ...(item.critic ? { critic: item.critic } : {}),
      ...(item.critic_source ? { critic_source: item.critic_source } : {}),
      ...(item.critic_focus ? { critic_focus: item.critic_focus } : {}),
      ...(Array.isArray(item.required_evidence) ? { required_evidence: item.required_evidence } : {}),
      ...(Array.isArray(item.missing_evidence) ? { missing_evidence: item.missing_evidence } : {}),
      ...(Array.isArray(item.next_development_goals) ? { next_development_goals: item.next_development_goals } : {}),
      ...(Array.isArray(item.evidence_results) ? { evidence_results: item.evidence_results } : {})
    });
  }
  for (const item of review.blocked ?? []) {
    actions.push({
      checkpoint_id: review.checkpoint_id,
      source: 'acceptance_review.blocked',
      check: typeof item === 'object' && item !== null ? item.check ?? 'blocker' : 'blocker',
      evidence: typeof item === 'string' ? item : JSON.stringify(item),
      suggested_fix: typeof item === 'object' && item !== null
        ? item.suggested_fix ?? 'Resolve this blocker or request the required human/external input before the next checkpoint.'
        : 'Resolve this blocker or request the required human/external input before the next checkpoint.',
      ...(typeof item === 'object' && item !== null && item.critic ? { critic: item.critic } : {}),
      ...(typeof item === 'object' && item !== null && item.critic_source ? { critic_source: item.critic_source } : {}),
      ...(typeof item === 'object' && item !== null && item.critic_focus ? { critic_focus: item.critic_focus } : {}),
      ...(typeof item === 'object' && item !== null && Array.isArray(item.required_evidence) ? { required_evidence: item.required_evidence } : {}),
      ...(typeof item === 'object' && item !== null && Array.isArray(item.missing_evidence) ? { missing_evidence: item.missing_evidence } : {}),
      ...(typeof item === 'object' && item !== null && Array.isArray(item.next_development_goals) ? { next_development_goals: item.next_development_goals } : {}),
      ...(typeof item === 'object' && item !== null && Array.isArray(item.evidence_results) ? { evidence_results: item.evidence_results } : {})
    });
  }
  if (actions.length === 0 && review.status !== 'accepted') {
    actions.push({
      checkpoint_id: review.checkpoint_id,
      source: 'acceptance_review.status',
      check: 'review_status',
      evidence: `Review status is ${review.status ?? 'unknown'}.`,
      suggested_fix: 'Inspect the acceptance review and produce a revised checkpoint.'
    });
  }
  return actions;
}

async function buildRevisionRequest(root, contract, acceptancePlan, devPlan, finalJudgement, acceptanceReviews) {
  const actions = [];
  for (const file of acceptanceReviews?.files ?? []) {
    try {
      const review = await readJson(path.join(root, file));
      if (review.status !== 'accepted') actions.push(...revisionActionFromReview(review));
    } catch (err) {
      actions.push({
        checkpoint_id: 'unknown',
        source: 'acceptance_review.read_error',
        check: 'review_artifact_readable',
        evidence: `${file}: ${err instanceof Error ? err.message : String(err)}`,
        suggested_fix: 'Regenerate the acceptance review artifact before retrying development.'
      });
    }
  }

  if (actions.length === 0) {
    for (const reason of finalJudgement.judgement.reasons ?? []) {
      actions.push({
        checkpoint_id: null,
        source: 'final_judgement.reason',
        check: 'final_judgement',
        evidence: reason,
        suggested_fix: (finalJudgement.judgement.next_actions ?? [])[0] ?? 'Revise development output and produce a new checkpoint.'
      });
    }
  }

  return {
    version: 1,
    task_id: contract.task_id,
    generated_by: 'deterministic_revision_request_v1',
    source_final_judgement: 'final_judgement.json',
    source_acceptance_reviews: acceptanceReviews?.files ?? [],
    risk_level: contract.risk_level,
    requires_human_gate: contract.requires_human_gate,
    status: 'requested',
    summary: 'Development must revise the result and produce a new checkpoint for acceptance review.',
    revision_goals: actions,
    carry_forward: {
      acceptance_rubric: (acceptancePlan.rubric ?? []).map((item) => item.id),
      planned_checkpoint_ids: (devPlan.checkpoints ?? []).map((item) => item.id),
      blocked_actions: contract.constraints?.blocked_actions ?? []
    },
    next_checkpoint: {
      suggested_id: `cp${Math.max((acceptanceReviews?.count ?? 0) + 1, 2)}`,
      required_status: 'ready_for_acceptance',
      required_fields: ['summary', 'files_changed', 'verification', 'blockers', 'risks', 'next_action']
    },
    created_at: new Date().toISOString()
  };
}

export async function writeRevisionRequest(root, queue, task, taskContract, acceptancePlan, devPlan, finalJudgement, acceptanceReviews) {
  if (finalJudgement?.judgement?.outcome !== 'needs_revision') return null;
  if (!taskContract?.contract || !acceptancePlan?.plan || !devPlan?.plan) return null;
  const dir = taskRuntimeDirFor(root, queue, task.id);
  const file = path.join(dir, 'revision_request.json');
  const request = await buildRevisionRequest(root, taskContract.contract, acceptancePlan.plan, devPlan.plan, finalJudgement, acceptanceReviews);
  await writeJson(file, request);
  return {
    request,
    file: path.relative(root, file)
  };
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export async function queueStatus(root, queue) {
  normalizeLoopId(queue);
  await ensureQueueDirs(root, queue);
  const activeFiles = await listJson(queueSubdirFor(root, queue, 'active'));
  const lock = await readQueueLock(root, queue);
  return {
    queue,
    queued: (await listJson(queueSubdirFor(root, queue, 'inbox'))).length,
    active: activeFiles.length,
    done: (await listJson(queueSubdirFor(root, queue, 'done'))).length,
    failed: (await listJson(queueSubdirFor(root, queue, 'failed'))).length,
    canceled: (await listJson(queueSubdirFor(root, queue, 'canceled'))).length,
    runs: (await listJson(queueSubdirFor(root, queue, 'runs'))).length,
    locked: Boolean(lock && Date.parse(lock.expiresAt) > Date.now()),
    lockExpiresAt: lock?.expiresAt ?? null
  };
}

const DEFAULT_QUEUE_SCHEDULER = {
  initialIntervalMs: 10 * 60 * 1000,
  minIntervalMs: 60 * 1000,
  maxIntervalMs: 4 * 60 * 60 * 1000,
  speedupFactor: 0.5,
  backoffFactor: 2,
  idleBackoffFactor: 2,
  humanGateBackoffFactor: 3,
  longRunHeadroomFactor: 1.25,
  jitterMs: 0
};

const DEFAULT_QUEUE_PROGRESS_REPORT = {
  enabled: true,
  minIntervalMs: 30 * 60 * 1000,
  idleIntervalMs: 4 * 60 * 60 * 1000,
  notifyOnFailure: true,
  notifyOnHumanGate: true,
  notifyOnCompletion: true,
  notifyOnStatusChange: true,
  notifyWhenNotDue: false
};

function parseScheduleDurationMs(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive duration.`);
    return Math.round(value);
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`${label} must be a positive duration.`);
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${label} must be a positive duration.`);
  const unit = match[2] ?? 'ms';
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return Math.round(amount * multipliers[unit]);
}

function parseOptionalFactor(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function normalizeSchedulerPolicy(input = {}) {
  const source = input ?? {};
  const policy = {
    ...DEFAULT_QUEUE_SCHEDULER,
    ...source
  };
  policy.initialIntervalMs = parseScheduleDurationMs(
    source.initialIntervalMs ?? source.initialInterval ?? DEFAULT_QUEUE_SCHEDULER.initialIntervalMs,
    'scheduler.initialInterval'
  );
  policy.minIntervalMs = parseScheduleDurationMs(
    source.minIntervalMs ?? source.minInterval ?? DEFAULT_QUEUE_SCHEDULER.minIntervalMs,
    'scheduler.minInterval'
  );
  policy.maxIntervalMs = parseScheduleDurationMs(
    source.maxIntervalMs ?? source.maxInterval ?? DEFAULT_QUEUE_SCHEDULER.maxIntervalMs,
    'scheduler.maxInterval'
  );
  policy.jitterMs = source.jitterMs ?? source.jitter ?? DEFAULT_QUEUE_SCHEDULER.jitterMs;
  policy.jitterMs = policy.jitterMs === 0 ? 0 : parseScheduleDurationMs(policy.jitterMs, 'scheduler.jitter');
  for (const key of ['speedupFactor', 'backoffFactor', 'idleBackoffFactor', 'humanGateBackoffFactor', 'longRunHeadroomFactor']) {
    policy[key] = parseOptionalFactor(policy[key], `scheduler.${key}`);
  }
  if (policy.minIntervalMs > policy.maxIntervalMs) {
    throw new Error('scheduler.minInterval must be less than or equal to scheduler.maxInterval.');
  }
  policy.initialIntervalMs = clamp(policy.initialIntervalMs, policy.minIntervalMs, policy.maxIntervalMs);
  delete policy.progressReport;
  return policy;
}

function parseOptionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function normalizeProgressReportPolicy(input = {}) {
  const source = input ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('scheduler.progressReport must be an object.');
  }
  const policy = {
    ...DEFAULT_QUEUE_PROGRESS_REPORT,
    ...source
  };
  policy.minIntervalMs = parseScheduleDurationMs(
    source.minIntervalMs ?? source.minInterval ?? DEFAULT_QUEUE_PROGRESS_REPORT.minIntervalMs,
    'scheduler.progressReport.minInterval'
  );
  policy.idleIntervalMs = parseScheduleDurationMs(
    source.idleIntervalMs ?? source.idleInterval ?? DEFAULT_QUEUE_PROGRESS_REPORT.idleIntervalMs,
    'scheduler.progressReport.idleInterval'
  );
  for (const key of ['enabled', 'notifyOnFailure', 'notifyOnHumanGate', 'notifyOnCompletion', 'notifyOnStatusChange', 'notifyWhenNotDue']) {
    policy[key] = parseOptionalBoolean(policy[key], `scheduler.progressReport.${key}`) ?? policy[key];
  }
  return policy;
}

function validateQueueSchedulerConfig(scheduler) {
  if (typeof scheduler !== 'object' || scheduler === null || Array.isArray(scheduler)) {
    throw new Error('queue config scheduler must be an object.');
  }
  normalizeSchedulerPolicy(scheduler);
  if (scheduler.progressReport !== undefined) normalizeProgressReportPolicy(scheduler.progressReport);
}

function queueSchedulerStatePath(root, queue) {
  return path.join(queueDirFor(root, queue), 'scheduler', 'state.json');
}

function queueProgressStatePath(root, queue) {
  return path.join(queueDirFor(root, queue), 'progress', 'latest.json');
}

async function readQueueSchedulerState(root, queue) {
  try {
    return await readJson(queueSchedulerStatePath(root, queue));
  } catch {
    return null;
  }
}

async function readQueueProgressState(root, queue) {
  try {
    return await readJson(queueProgressStatePath(root, queue));
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function runDurationMs(run) {
  if (!run) return null;
  if (Number.isFinite(run.durationMs) && run.durationMs >= 0) return run.durationMs;
  const duration = Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? '');
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function queueSchedulerOutcomeGroup(status) {
  if (status === 'completed') return 'success';
  if (status === 'empty') return 'idle';
  if (status === 'locked') return 'locked';
  if (['needs_human_input', 'ready_for_human_review', 'blocked', 'blocked_preflight'].includes(status)) return 'human_gate';
  if (['needs_revision', 'failed', 'verify_failed', 'worktree_failed', 'runtime_error'].includes(status)) return 'failure';
  return 'unknown';
}

function updateSchedulerCounters(previous, group) {
  const counters = previous?.counters ?? {};
  return {
    consecutiveSuccesses: group === 'success' ? (counters.consecutiveSuccesses ?? 0) + 1 : 0,
    consecutiveFailures: group === 'failure' ? (counters.consecutiveFailures ?? 0) + 1 : 0,
    consecutiveIdle: group === 'idle' ? (counters.consecutiveIdle ?? 0) + 1 : 0,
    consecutiveHumanGates: group === 'human_gate' ? (counters.consecutiveHumanGates ?? 0) + 1 : 0,
    consecutiveLocked: group === 'locked' ? (counters.consecutiveLocked ?? 0) + 1 : 0
  };
}

function applyJitter(intervalMs, jitterMs) {
  if (!jitterMs) return intervalMs;
  const offset = Math.round((Math.random() * 2 - 1) * jitterMs);
  return intervalMs + offset;
}

function computeQueueSchedulerInterval(previous, policy, observed) {
  const previousInterval = Number.isFinite(previous?.currentIntervalMs)
    ? previous.currentIntervalMs
    : policy.initialIntervalMs;
  const group = queueSchedulerOutcomeGroup(observed.status);
  let next = previousInterval;
  const reasons = [];

  if (group === 'success' && observed.statusAfter.queued > 0) {
    next = previousInterval * policy.speedupFactor;
    reasons.push('queued_work_after_success_speedup');
  } else if (group === 'idle') {
    next = previousInterval * policy.idleBackoffFactor;
    reasons.push('empty_queue_idle_backoff');
  } else if (group === 'human_gate') {
    next = previousInterval * policy.humanGateBackoffFactor;
    reasons.push('human_gate_backoff');
  } else if (group === 'failure') {
    next = previousInterval * policy.backoffFactor;
    reasons.push('failure_backoff');
  } else if (group === 'locked') {
    next = Math.max(previousInterval, policy.minIntervalMs);
    reasons.push('queue_locked_hold_interval');
  } else if (observed.statusAfter.queued > 0) {
    next = Math.min(previousInterval, policy.initialIntervalMs);
    reasons.push('queued_work_keep_warm');
  } else {
    next = previousInterval;
    reasons.push('steady_interval');
  }

  if (observed.statusAfter.active > 0 || observed.statusAfter.locked) {
    next = Math.max(next, policy.initialIntervalMs);
    reasons.push('active_or_locked_queue_guard');
  }

  if (observed.durationMs !== null) {
    const durationFloor = observed.durationMs * policy.longRunHeadroomFactor;
    if (durationFloor > next) {
      next = durationFloor;
      reasons.push('long_run_headroom');
    }
  }

  const bounded = clamp(applyJitter(next, policy.jitterMs), policy.minIntervalMs, policy.maxIntervalMs);
  return {
    intervalMs: bounded,
    group,
    reasons
  };
}

function summarizeQueueCounts(status) {
  return `queued=${status.queued}, active=${status.active}, failed=${status.failed}, done=${status.done}`;
}

function buildQueueProgressMessage(report) {
  const lines = [];
  const run = report.observed.runPath ? ` run=${report.observed.runPath}` : '';
  const task = report.observed.taskId ? ` task=${report.observed.taskId}` : '';
  lines.push(`Loop progress: ${report.queue} ${report.status}${task}${run}`);
  lines.push(`Outcome: ${report.outcomeGroup}; next run ${report.nextRunAt}; interval ${report.currentIntervalMs}ms`);
  lines.push(`Before: ${summarizeQueueCounts(report.statusBefore)}`);
  lines.push(`After: ${summarizeQueueCounts(report.statusAfter)}`);
  if (report.reasonSummary) lines.push(`Reason: ${report.reasonSummary}`);
  if (report.attention.length > 0) lines.push(`Needs attention: ${report.attention.join(', ')}`);
  return lines.join('\n');
}

function decideQueueProgressNotification(previousProgress, policy, observed, schedulerDecision, nowMs) {
  const lastReportedAtMs = Date.parse(previousProgress?.lastReportedAt ?? '');
  const elapsedMs = Number.isFinite(lastReportedAtMs) ? nowMs - lastReportedAtMs : Number.POSITIVE_INFINITY;
  const attention = [];
  const reasons = [];
  const statusChanged = previousProgress?.lastStatus && previousProgress.lastStatus !== observed.status;

  if (schedulerDecision.group === 'failure') attention.push('failure');
  if (schedulerDecision.group === 'human_gate') attention.push('human_gate');
  if (observed.statusAfter.failed > (observed.statusBefore.failed ?? 0)) attention.push('failed_count_increased');
  if (observed.statusAfter.queued === 0 && observed.statusBefore.queued > 0 && observed.statusAfter.active === 0) attention.push('queue_drained');

  if (!policy.enabled) reasons.push('progress_report_disabled');
  if (!observed.executed && !policy.notifyWhenNotDue) reasons.push('not_executed');
  if (schedulerDecision.group === 'failure' && policy.notifyOnFailure) reasons.push('failure_immediate');
  if (schedulerDecision.group === 'human_gate' && policy.notifyOnHumanGate) reasons.push('human_gate_immediate');
  if (statusChanged && policy.notifyOnStatusChange) reasons.push('status_changed');
  if (observed.statusAfter.queued === 0 && observed.statusBefore.queued > 0 && policy.notifyOnCompletion) reasons.push('queue_drained');
  if (elapsedMs >= policy.minIntervalMs && observed.executed) reasons.push('periodic_interval_elapsed');
  if (schedulerDecision.group === 'idle' && elapsedMs >= policy.idleIntervalMs && policy.notifyWhenNotDue) reasons.push('idle_interval_elapsed');

  const shouldNotify = policy.enabled && reasons.some((reason) => !['progress_report_disabled', 'not_executed'].includes(reason));
  return {
    shouldNotify,
    reasons,
    attention,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null
  };
}

export async function queueSchedulerTick(root, options) {
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  const schedulerConfig = {
    ...(options.scheduler ?? {}),
    ...(options.initialIntervalMs !== undefined ? { initialIntervalMs: options.initialIntervalMs } : {}),
    ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
    ...(options.maxIntervalMs !== undefined ? { maxIntervalMs: options.maxIntervalMs } : {}),
    ...(options.jitterMs !== undefined ? { jitterMs: options.jitterMs } : {})
  };
  const policy = normalizeSchedulerPolicy(schedulerConfig);
  const progressPolicy = normalizeProgressReportPolicy({
    ...(options.scheduler?.progressReport ?? {}),
    ...(options.progressReportEnabled !== undefined ? { enabled: options.progressReportEnabled } : {}),
    ...(options.progressReportIntervalMs !== undefined ? { minIntervalMs: options.progressReportIntervalMs } : {}),
    ...(options.progressReportIdleIntervalMs !== undefined ? { idleIntervalMs: options.progressReportIdleIntervalMs } : {}),
    ...(options.progressReportNotifyWhenNotDue !== undefined ? { notifyWhenNotDue: options.progressReportNotifyWhenNotDue } : {})
  });
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const previous = await readQueueSchedulerState(root, queue);
  const previousProgress = await readQueueProgressState(root, queue);
  const statusBefore = await queueStatus(root, queue);
  const due = !previous?.nextRunAt || Date.parse(previous.nextRunAt) <= nowMs || Boolean(options.forceDue);
  let runResult = null;
  let executed = false;
  let status = due ? 'due' : 'not_due';

  if (due && !options.planOnly) {
    runResult = await runQueueOnce(root, options);
    executed = true;
    status = runResult.status;
  } else if (due && options.planOnly) {
    status = statusBefore.queued > 0 ? 'planned_due' : 'empty';
  }

  const statusAfter = await queueStatus(root, queue);
  const run = runResult?.run ?? null;
  const observed = {
    status,
    executed,
    due,
    durationMs: runDurationMs(run),
    statusBefore,
    statusAfter,
    runPath: runResult?.runPath ?? null,
    taskId: runResult?.run?.taskId ?? null
  };
  const decision = computeQueueSchedulerInterval(previous, policy, observed);
  const counters = updateSchedulerCounters(previous, decision.group);
  const nextRunAt = new Date(nowMs + decision.intervalMs).toISOString();
  const progressNotification = decideQueueProgressNotification(previousProgress, progressPolicy, observed, decision, nowMs);
  const progressReport = {
    version: 1,
    queue,
    generatedAt: now,
    status,
    outcomeGroup: decision.group,
    currentIntervalMs: decision.intervalMs,
    nextRunAt,
    statusBefore,
    statusAfter,
    observed,
    reasons: progressNotification.reasons,
    reasonSummary: decision.reasons.join(', ') || 'steady_interval',
    attention: progressNotification.attention,
    shouldNotify: progressNotification.shouldNotify,
    lastReportedAt: progressNotification.shouldNotify ? now : previousProgress?.lastReportedAt ?? null,
    previousStatus: previousProgress?.lastStatus ?? null,
    lastStatus: status
  };
  progressReport.message = buildQueueProgressMessage(progressReport);
  const state = {
    version: 1,
    queue,
    generatedAt: now,
    policy,
    currentIntervalMs: decision.intervalMs,
    nextRunAt,
    previousNextRunAt: previous?.nextRunAt ?? null,
    due,
    executed,
    lastStatus: status,
    lastOutcomeGroup: decision.group,
    counters,
    observed,
    decision: {
      intervalMs: decision.intervalMs,
      reasons: decision.reasons
    },
    progressReport: {
      enabled: progressPolicy.enabled,
      shouldNotify: progressReport.shouldNotify,
      lastReportedAt: progressReport.lastReportedAt,
      path: path.relative(root, queueProgressStatePath(root, queue))
    },
    lastRun: runResult ? {
      status: runResult.status,
      exitCode: runResult.exitCode,
      runPath: runResult.runPath ?? null,
      taskPath: runResult.taskPath ?? null
    } : null
  };
  await writeJson(queueSchedulerStatePath(root, queue), state);
  await writeJson(queueProgressStatePath(root, queue), progressReport);
  if (progressReport.shouldNotify && options.progressNotifyCommand) {
    await runCommand(`${options.progressNotifyCommand} ${shellQuote(progressReport.message)}`, {
      cwd: root,
      timeoutMs: 60 * 1000
    });
  }
  return {
    queue,
    due,
    executed,
    status,
    nextRunAt,
    currentIntervalMs: decision.intervalMs,
    outcomeGroup: decision.group,
    reasons: decision.reasons,
    statePath: path.relative(root, queueSchedulerStatePath(root, queue)),
    progressReport,
    progressReportPath: path.relative(root, queueProgressStatePath(root, queue)),
    statusBefore,
    statusAfter,
    run: runResult
  };
}

export async function loadQueueConfig(root, configPath) {
  if (!configPath) return {};
  const file = path.resolve(root, safeRelativePath(configPath, 'queue config'));
  const config = await readJson(file);
  if (config.queue !== undefined) normalizeLoopId(config.queue);
  if (config.preflightConfig !== undefined) safeRelativePath(config.preflightConfig, 'preflight config');
  if (config.timeoutMs !== undefined && !positiveInteger(config.timeoutMs)) {
    throw new Error('queue config timeoutMs must be a positive integer.');
  }
  if (config.leaseMs !== undefined && !positiveInteger(config.leaseMs)) {
    throw new Error('queue config leaseMs must be a positive integer.');
  }
  if (config.staleActiveMs !== undefined && !positiveInteger(config.staleActiveMs)) {
    throw new Error('queue config staleActiveMs must be a positive integer.');
  }
  if (config.retry !== undefined) validateRetryConfig(config.retry);
  if (config.revisionPolicy !== undefined) validateRevisionPolicyConfig(config.revisionPolicy);
  if (config.acceptanceCritics !== undefined) validateAcceptanceCriticsConfig(config.acceptanceCritics);
  if (config.scheduler !== undefined) validateQueueSchedulerConfig(config.scheduler);
  if (config.dispatcher !== undefined && typeof config.dispatcher !== 'string') {
    throw new Error('queue config dispatcher must be a string.');
  }
  if (config.notifyCommand !== undefined && typeof config.notifyCommand !== 'string') {
    throw new Error('queue config notifyCommand must be a string.');
  }
  if (config.worktree !== undefined) validateWorktreeConfig(config.worktree);
  return { ...config, configPath };
}

function validateWorktreeConfig(worktree) {
  if (typeof worktree !== 'object' || worktree === null || Array.isArray(worktree)) {
    throw new Error('queue config worktree must be an object.');
  }
  if (worktree.enabled !== undefined && typeof worktree.enabled !== 'boolean') {
    throw new Error('worktree.enabled must be a boolean.');
  }
  if (worktree.baseDir !== undefined) safeRelativePath(worktree.baseDir, 'worktree baseDir');
  if (worktree.branchPrefix !== undefined && (typeof worktree.branchPrefix !== 'string' || !worktree.branchPrefix.trim())) {
    throw new Error('worktree.branchPrefix must be a non-empty string.');
  }
  if (worktree.keepOnSuccess !== undefined && typeof worktree.keepOnSuccess !== 'boolean') {
    throw new Error('worktree.keepOnSuccess must be a boolean.');
  }
  if (worktree.verifyCommands !== undefined) {
    if (!Array.isArray(worktree.verifyCommands) || worktree.verifyCommands.some((cmd) => typeof cmd !== 'string' || !cmd.trim())) {
      throw new Error('worktree.verifyCommands must be an array of non-empty strings.');
    }
  }
}

function validateRetryConfig(retry) {
  if (retry.maxAttempts !== undefined && !positiveInteger(retry.maxAttempts)) {
    throw new Error('retry.maxAttempts must be a positive integer.');
  }
  if (retry.retryDelayMs !== undefined && (!Number.isInteger(retry.retryDelayMs) || retry.retryDelayMs < 0)) {
    throw new Error('retry.retryDelayMs must be a non-negative integer.');
  }
  if (retry.retryExitCodes !== undefined) {
    if (!Array.isArray(retry.retryExitCodes) || retry.retryExitCodes.some((code) => !Number.isInteger(code))) {
      throw new Error('retry.retryExitCodes must be an array of integers.');
    }
  }
  if (retry.requiresHumanActionPatterns !== undefined) {
    if (!Array.isArray(retry.requiresHumanActionPatterns) || retry.requiresHumanActionPatterns.some((pattern) => typeof pattern !== 'string' || !pattern.trim())) {
      throw new Error('retry.requiresHumanActionPatterns must be an array of non-empty strings.');
    }
  }
}

function validateRevisionPolicyConfig(policy) {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new Error('queue config revisionPolicy must be an object.');
  }
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') {
    throw new Error('revisionPolicy.enabled must be a boolean.');
  }
  if (policy.maxRevisionRounds !== undefined && !positiveInteger(policy.maxRevisionRounds)) {
    throw new Error('revisionPolicy.maxRevisionRounds must be a positive integer.');
  }
  if (policy.sameFailureThreshold !== undefined && !positiveInteger(policy.sameFailureThreshold)) {
    throw new Error('revisionPolicy.sameFailureThreshold must be a positive integer.');
  }
  if (policy.requireStrategyChange !== undefined && typeof policy.requireStrategyChange !== 'boolean') {
    throw new Error('revisionPolicy.requireStrategyChange must be a boolean.');
  }
  if (policy.strategyChangeFailureThreshold !== undefined && !positiveInteger(policy.strategyChangeFailureThreshold)) {
    throw new Error('revisionPolicy.strategyChangeFailureThreshold must be a positive integer.');
  }
}

function validateAcceptanceCriticsConfig(critics) {
  if (!Array.isArray(critics)) {
    throw new Error('queue config acceptanceCritics must be an array.');
  }
  if (critics.length > 20) {
    throw new Error('queue config acceptanceCritics must contain at most 20 critics.');
  }
  for (const critic of critics) {
    if (typeof critic !== 'object' || critic === null || Array.isArray(critic)) {
      throw new Error('acceptanceCritics entries must be objects.');
    }
    if (typeof critic.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(critic.id)) {
      throw new Error('acceptanceCritics[].id must be a stable identifier.');
    }
    if (critic.focus !== undefined && (typeof critic.focus !== 'string' || !critic.focus.trim())) {
      throw new Error('acceptanceCritics[].focus must be a non-empty string.');
    }
    if (critic.revisionHint !== undefined && (typeof critic.revisionHint !== 'string' || !critic.revisionHint.trim())) {
      throw new Error('acceptanceCritics[].revisionHint must be a non-empty string.');
    }
    if (critic.evidenceHints !== undefined) {
      if (typeof critic.evidenceHints !== 'object' || critic.evidenceHints === null || Array.isArray(critic.evidenceHints)) {
        throw new Error('acceptanceCritics[].evidenceHints must be an object.');
      }
      for (const [key, value] of Object.entries(critic.evidenceHints)) {
        if (!key.trim() || typeof value !== 'string' || !value.trim()) {
          throw new Error('acceptanceCritics[].evidenceHints values must be non-empty strings.');
        }
      }
    }
    if (critic.requiredEvidence !== undefined) {
      if (!Array.isArray(critic.requiredEvidence) || critic.requiredEvidence.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error('acceptanceCritics[].requiredEvidence must be an array of non-empty strings.');
      }
    }
    if (critic.failureStatus !== undefined && !['revise', 'blocked'].includes(critic.failureStatus)) {
      throw new Error('acceptanceCritics[].failureStatus must be revise or blocked.');
    }
    if (critic.minStatus !== undefined && !['revise', 'blocked'].includes(critic.minStatus)) {
      throw new Error('acceptanceCritics[].minStatus must be revise or blocked.');
    }
  }
}

export function mergeQueueOptions(config, options) {
  const merged = {
    ...config,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  };
  if (!merged.queue) throw new Error('queue command requires --queue or config.queue.');
  merged.queue = normalizeLoopId(merged.queue);
  return merged;
}

async function readQueueLock(root, queue) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  try {
    return await readJson(lockFile);
  } catch {
    return null;
  }
}

async function acquireQueueLock(root, queue, leaseMs) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  const now = Date.now();
  const existing = await readQueueLock(root, queue);
  if (existing && Date.parse(existing.expiresAt) > now) {
    return { acquired: false, lock: existing };
  }
  if (existing) await rm(lockFile, { force: true });
  const lock = {
    version: 1,
    queue,
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString()
  };
  let handle = null;
  try {
    handle = await open(lockFile, 'wx');
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
    return { acquired: true, lock };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { acquired: false, lock: await readQueueLock(root, queue) };
    }
    throw err;
  } finally {
    if (handle) await handle.close();
  }
}

async function releaseQueueLock(root, queue, lock) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  const current = await readQueueLock(root, queue);
  if (current?.pid === lock.pid && current?.acquiredAt === lock.acquiredAt) {
    await rm(lockFile, { force: true });
  }
}

async function nextQueuedTaskFile(root, queue) {
  const files = await listJson(queueSubdirFor(root, queue, 'inbox'));
  if (files.length === 0) return null;
  return path.join(queueSubdirFor(root, queue, 'inbox'), files[0]);
}

async function findTaskFile(root, queue, taskId, subdirs = ['inbox', 'active', 'failed', 'done', 'canceled']) {
  const wanted = taskId.endsWith('.json') ? taskId : `${taskId}.json`;
  for (const subdir of subdirs) {
    const file = path.join(queueSubdirFor(root, queue, subdir), wanted);
    if (await exists(file)) return { file, subdir };
  }
  return null;
}

export async function queuePeek(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const limit = options.limit ?? 5;
  const files = await listJson(queueSubdirFor(root, normalized, 'inbox'));
  const tasks = [];
  for (const file of files.slice(0, limit)) {
    const full = path.join(queueSubdirFor(root, normalized, 'inbox'), file);
    const task = await readJson(full);
    tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      attempts: task.attempts ?? 0,
      enqueuedAt: task.enqueuedAt,
      file: path.relative(root, full)
    });
  }
  return { queue: normalized, tasks };
}

export async function queueCancel(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const found = await findTaskFile(root, normalized, taskId, options.includeActive ? ['inbox', 'active'] : ['inbox']);
  if (!found) throw new Error(`Task not found in cancelable state: ${taskId}`);
  const task = await readJson(found.file);
  const canceledFile = path.join(queueSubdirFor(root, normalized, 'canceled'), path.basename(found.file));
  await writeJson(canceledFile, {
    ...task,
    status: 'canceled',
    canceledAt: new Date().toISOString(),
    canceledFrom: found.subdir,
    cancelReason: options.reason ?? null
  });
  await rm(found.file, { force: true });
  return { queue: normalized, taskId: task.id, from: found.subdir, file: path.relative(root, canceledFile) };
}

export async function queueRequeue(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const found = await findTaskFile(root, normalized, taskId, options.from ? [options.from] : ['failed', 'active', 'canceled']);
  if (!found) throw new Error(`Task not found in requeueable state: ${taskId}`);
  const task = await readJson(found.file);
  const inboxFile = path.join(queueSubdirFor(root, normalized, 'inbox'), path.basename(found.file));
  await writeJson(inboxFile, {
    ...task,
    status: 'queued',
    requeuedAt: new Date().toISOString(),
    requeuedFrom: found.subdir
  });
  await rm(found.file, { force: true });
  return { queue: normalized, taskId: task.id, from: found.subdir, file: path.relative(root, inboxFile) };
}

function renderRevisionTaskBody(task, run, revisionRequest) {
  const lines = [];
  lines.push('Revision round for a loop-managed task.');
  lines.push('');
  lines.push(`Original task id: ${task.id}`);
  lines.push(`Original title: ${task.title}`);
  lines.push(`Source run: ${task.runPath ?? run.runPath ?? 'unknown'}`);
  lines.push(`Revision request: ${run.revisionRequest?.path ?? 'unknown'}`);
  lines.push(`Final judgement: ${run.finalJudgement?.outcome ?? 'unknown'}`);
  lines.push('');
  lines.push('Original task body:');
  lines.push(task.body ?? '');
  lines.push('');
  lines.push('Revision goals:');
  for (const goal of revisionRequest.revision_goals ?? []) {
    lines.push(`- checkpoint=${goal.checkpoint_id ?? 'none'} check=${goal.check ?? 'unknown'}`);
    if (goal.critic) lines.push(`  critic: ${goal.critic}`);
    if (goal.critic_focus) lines.push(`  focus: ${goal.critic_focus}`);
    if (Array.isArray(goal.missing_evidence) && goal.missing_evidence.length > 0) {
      lines.push(`  missing_evidence: ${goal.missing_evidence.join(', ')}`);
    }
    if (goal.evidence) lines.push(`  evidence: ${goal.evidence}`);
    if (goal.suggested_fix) lines.push(`  suggested_fix: ${goal.suggested_fix}`);
    if (Array.isArray(goal.next_development_goals) && goal.next_development_goals.length > 0) {
      lines.push('  next_development_goals:');
      for (const nextGoal of goal.next_development_goals) lines.push(`  - ${nextGoal}`);
    }
  }
  lines.push('');
  lines.push('Next checkpoint requirements:');
  lines.push(`- suggested_id: ${revisionRequest.next_checkpoint?.suggested_id ?? 'cp_next'}`);
  lines.push(`- required_status: ${revisionRequest.next_checkpoint?.required_status ?? 'ready_for_acceptance'}`);
  lines.push(`- required_fields: ${(revisionRequest.next_checkpoint?.required_fields ?? []).join(', ')}`);
  lines.push('');
  lines.push('Carry forward the task contract, acceptance plan, blocked actions, and human gate constraints from the previous round.');
  lines.push('');
  lines.push('Anti-loop requirements:');
  lines.push('- Do not repeat the same failed approach unchanged.');
  lines.push('- State what new evidence, diagnosis, implementation tactic, or verification step makes this round different.');
  lines.push('- If no meaningful strategy change is available, stop and mark the task blocked for human judgement.');
  return lines.join('\n').trim();
}

function appendRevisionStrategy(body, strategy) {
  if (strategy === undefined || strategy === null) return String(body ?? '').trim();
  const text = String(strategy).trim();
  if (!text) throw new Error('Revision strategy must be a non-empty string.');
  const strategyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [
    String(body ?? '').trim(),
    '',
    'Changed strategy:',
    ...strategyLines.map((line) => `strategy: ${line}`)
  ].join('\n').trim();
}

const DEFAULT_REVISION_POLICY = {
  enabled: true,
  maxRevisionRounds: 3,
  sameFailureThreshold: 2,
  requireStrategyChange: true,
  strategyChangeFailureThreshold: 2
};

function resolveRevisionPolicy(options = {}) {
  return {
    ...DEFAULT_REVISION_POLICY,
    ...(options.revisionPolicy ?? {})
  };
}

function compactRevisionText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function revisionRequestSignature(request) {
  const goals = request?.revision_goals ?? [];
  if (!Array.isArray(goals) || goals.length === 0) return null;
  return goals.map((goal) => [
    compactRevisionText(goal.source),
    compactRevisionText(goal.check),
    compactRevisionText(goal.evidence),
    compactRevisionText(goal.suggested_fix)
  ].join('|')).sort().join('\n');
}

const STRATEGY_DIFF_STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'into',
  'until',
  'before',
  'after',
  'next',
  'task',
  'body',
  'round',
  'revision',
  'checkpoint',
  'required',
  'evidence',
  'suggested',
  'unknown',
  'development',
  'acceptance',
  'review',
  'status',
  'ready',
  'none'
]);

const STRATEGY_SIGNAL_PATTERNS = [
  /\bchanged?\s+strategy\b/i,
  /\bnew\s+(?:evidence|diagnosis|implementation|tactic|verification|approach|artifact)\b/i,
  /\bstrategy\s*:/i,
  /\bapproach\s*:/i,
  /\bdiagnosis\s*:/i,
  /\btactic\s*:/i,
  /\bverification\s*:/i,
  /\bdifferent\b/i,
  /\binstead of\b/i,
  /策略/,
  /差异/,
  /新的/,
  /不同/
];

const GENERATED_REVISION_BODY_LINES = new Set([
  'Revision round for a loop-managed task.',
  'Original task body:',
  'Revision goals:',
  'Next checkpoint requirements:',
  'Carry forward the task contract, acceptance plan, blocked actions, and human gate constraints from the previous round.',
  'Anti-loop requirements:',
  '- Do not repeat the same failed approach unchanged.',
  '- State what new evidence, diagnosis, implementation tactic, or verification step makes this round different.',
  '- If no meaningful strategy change is available, stop and mark the task blocked for human judgement.'
]);

function uniqueStrings(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function goalSummary(goal) {
  const parts = [
    goal.critic ? `critic=${goal.critic}` : null,
    goal.check ? `check=${goal.check}` : null,
    Array.isArray(goal.missing_evidence) && goal.missing_evidence.length > 0
      ? `missing=${goal.missing_evidence.join(',')}`
      : null
  ].filter(Boolean);
  return parts.join(' ') || goal.suggested_fix || goal.evidence || 'revision goal';
}

function goalTextForDiff(goal) {
  return [
    goal.check,
    goal.critic,
    goal.critic_focus,
    goal.evidence,
    goal.suggested_fix,
    ...(goal.missing_evidence ?? []),
    ...(goal.next_development_goals ?? [])
  ].filter(Boolean).join('\n');
}

function strategyKeywords(value, limit = 12) {
  return uniqueStrings(tokenizePatternText(value)
    .filter((token) => token.length >= 3 && !STRATEGY_DIFF_STOPWORDS.has(token)), limit);
}

function lineHasStrategySignal(line) {
  return STRATEGY_SIGNAL_PATTERNS.some((pattern) => pattern.test(line));
}

function extractStrategySignalLines(body) {
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !GENERATED_REVISION_BODY_LINES.has(line));
  return uniqueStrings(lines.filter(lineHasStrategySignal), 12);
}

function buildRevisionStrategyDiff(task, run, revisionRequest, body) {
  const bodyText = String(body ?? '');
  const bodyTokens = new Set(tokenizePatternText(bodyText));
  const strategySignalLines = extractStrategySignalLines(bodyText);
  const explicitStrategy = strategySignalLines.length > 0;
  const previousTargets = (revisionRequest.revision_goals ?? []).map((goal, index) => {
    const keywords = strategyKeywords(goalTextForDiff(goal));
    return {
      index,
      checkpoint_id: goal.checkpoint_id ?? null,
      check: goal.check ?? null,
      critic: goal.critic ?? null,
      missing_evidence: goal.missing_evidence ?? [],
      keywords,
      summary: goalSummary(goal)
    };
  });
  const targetDeltas = previousTargets.map((target) => {
    const matchedKeywords = target.keywords.filter((keyword) => bodyTokens.has(keyword));
    const hasTargetCoverage = target.keywords.length === 0 || matchedKeywords.length > 0;
    const hasGoalSpecificStrategy = strategySignalLines.some((line) => {
      const lineTokens = new Set(tokenizePatternText(line));
      return target.keywords.some((keyword) => lineTokens.has(keyword));
    });
    return {
      target_index: target.index,
      checkpoint_id: target.checkpoint_id,
      check: target.check,
      critic: target.critic,
      carried_forward: hasTargetCoverage,
      matched_keywords: matchedKeywords,
      changed_strategy_detected: hasGoalSpecificStrategy,
      assessment: hasGoalSpecificStrategy
        ? 'strategy_changed'
        : hasTargetCoverage
          ? 'target_carried_forward_strategy_needed'
          : 'target_not_visible_in_next_body'
    };
  });
  const uncoveredTargets = targetDeltas.filter((item) => !item.carried_forward);
  const needsStrategy = targetDeltas.filter((item) => !item.changed_strategy_detected);
  const recommendations = [
    ...(uncoveredTargets.length > 0 ? ['Bring every failed revision target into the next task body before dispatch.'] : []),
    ...(needsStrategy.length > 0 ? ['Add a concrete changed strategy line for each carried-forward target: new diagnosis, tactic, evidence source, or verification step.'] : [])
  ];
  return {
    generated_by: 'revision_strategy_diff_v1',
    source_task_id: task.id,
    source_run: task.runPath ?? run.runPath ?? null,
    revision_request: run.revisionRequest?.path ?? null,
    next_task_body_mode: body === (task.body ?? '') ? 'source_body' : 'generated_or_override',
    previous_failure_targets: previousTargets,
    next_task_body: {
      line_count: bodyText.split(/\r?\n/).filter((line) => line.trim()).length,
      explicit_strategy_lines: strategySignalLines,
      has_explicit_strategy_signal: explicitStrategy
    },
    target_deltas: targetDeltas,
    summary: {
      total_targets: previousTargets.length,
      carried_forward_targets: targetDeltas.filter((item) => item.carried_forward).length,
      targets_with_changed_strategy: targetDeltas.filter((item) => item.changed_strategy_detected).length,
      targets_needing_strategy_detail: needsStrategy.length,
      uncovered_targets: uncoveredTargets.length
    },
    recommendations
  };
}

async function revisionSignatureForAttempt(root, attempt) {
  const rel = attempt?.run?.revisionRequest?.path;
  if (!rel) return null;
  try {
    return revisionRequestSignature(await readJson(path.join(root, safeRelativePath(rel, 'lineage revision request path'))));
  } catch {
    return null;
  }
}

function revisionStrategyNeedsDetail(diff) {
  return (diff?.summary?.targets_needing_strategy_detail ?? 0) > 0
    || (diff?.summary?.uncovered_targets ?? 0) > 0;
}

async function assessRevisionPolicy(root, queue, task, revisionRequest, revisionStrategyDiff, policy, options = {}) {
  const nextRound = (task.revisionRound ?? 0) + 1;
  const guard = {
    enabled: policy.enabled !== false,
    maxRevisionRounds: policy.maxRevisionRounds ?? null,
    sameFailureThreshold: policy.sameFailureThreshold ?? null,
    requireStrategyChange: policy.requireStrategyChange !== false,
    strategyChangeFailureThreshold: policy.strategyChangeFailureThreshold ?? null,
    nextRound,
    allowed: true,
    bypassed: Boolean(options.force),
    repeatedFailureSignatureCount: 0,
    repeatedMissingStrategyCount: 0,
    reasons: [],
    strategyChangeRequired: policy.requireStrategyChange !== false,
    strategyChangeSummary: revisionStrategyDiff?.summary ?? null
  };

  if (!guard.enabled) return guard;

  let lineage = null;
  const getLineage = async () => {
    lineage ??= await queueLineage(root, queue, task.id);
    return lineage;
  };

  if (policy.maxRevisionRounds && nextRound > policy.maxRevisionRounds) {
    guard.allowed = false;
    guard.reasons.push(`revision round ${nextRound} exceeds maxRevisionRounds ${policy.maxRevisionRounds}`);
  }

  const currentSignature = revisionRequestSignature(revisionRequest);
  if (currentSignature && policy.sameFailureThreshold) {
    const lineageForSignature = await getLineage();
    let contiguous = 1;
    const previousAttempts = lineageForSignature.attempts
      .filter((attempt) => attempt.taskId !== task.id)
      .sort((a, b) => (b.revisionRound ?? 0) - (a.revisionRound ?? 0));
    for (const attempt of previousAttempts) {
      const signature = await revisionSignatureForAttempt(root, attempt);
      if (signature !== currentSignature) break;
      contiguous += 1;
    }
    guard.repeatedFailureSignatureCount = contiguous;
    if (contiguous >= policy.sameFailureThreshold) {
      guard.allowed = false;
      guard.reasons.push(`same revision failure signature repeated ${contiguous} time(s)`);
    }
  }

  const strategyThreshold = policy.strategyChangeFailureThreshold ?? policy.sameFailureThreshold ?? 2;
  if (policy.requireStrategyChange !== false && revisionStrategyNeedsDetail(revisionStrategyDiff) && strategyThreshold) {
    let contiguous = 1;
    if ((task.revisionRound ?? 0) > 0 && revisionStrategyNeedsDetail(task.revisionStrategyDiff)) {
      contiguous += 1;
    }
    const lineageForStrategy = await getLineage();
    const olderAttempts = lineageForStrategy.attempts
      .filter((attempt) => attempt.taskId !== task.id && (attempt.revisionRound ?? 0) < (task.revisionRound ?? 0))
      .sort((a, b) => (b.revisionRound ?? 0) - (a.revisionRound ?? 0));
    for (const attempt of olderAttempts) {
      if (!revisionStrategyNeedsDetail(attempt.revisionStrategyDiff)) break;
      contiguous += 1;
    }
    guard.repeatedMissingStrategyCount = contiguous;
    if (contiguous >= strategyThreshold) {
      guard.allowed = false;
      guard.reasons.push(`changed strategy missing for ${contiguous} consecutive revision task(s)`);
    }
  } else if (policy.requireStrategyChange !== false) {
    guard.repeatedMissingStrategyCount = 0;
  }

  if (!guard.allowed && options.force) {
    guard.allowed = true;
    guard.reasons.push('guard bypassed by --force');
  }
  return guard;
}

const HUMAN_DECISIONS = new Set(['approve', 'request_changes', 'reject']);

function normalizeHumanDecision(decision) {
  if (typeof decision !== 'string' || !HUMAN_DECISIONS.has(decision)) {
    throw new Error('Human decision must be approve, request_changes, or reject.');
  }
  return decision;
}

async function latestHumanDecision(root, queue, taskId) {
  const file = path.join(taskRuntimeDirFor(root, queue, taskId), 'human_review_decision.json');
  if (!(await exists(file))) return null;
  return {
    file: path.relative(root, file),
    decision: await readJson(file)
  };
}

function buildHumanRevisionRequest(task, decision, lineage) {
  const latestAttempt = lineage.attempts[lineage.attempts.length - 1] ?? null;
  const nextRound = (latestAttempt?.revisionRound ?? task.revisionRound ?? 0) + 1;
  const nextCheckpoint = `cp${Math.max(nextRound + 1, 2)}`;
  return {
    version: 1,
    task_id: task.id,
    generated_by: 'human_gate_revision_request_v1',
    source_human_review_decision: 'human_review_decision.json',
    status: 'requested',
    summary: 'Human reviewer requested changes before approval.',
    revision_goals: [
      {
        checkpoint_id: latestAttempt?.revisionNextCheckpoint ?? latestAttempt?.run?.revisionRequest?.nextCheckpoint ?? null,
        source: 'human_review_decision',
        check: 'human_requested_changes',
        evidence: decision.comment ?? decision.reason ?? 'Human reviewer requested changes.',
        suggested_fix: decision.comment ?? decision.reason ?? 'Revise the output according to the human review decision.'
      }
    ],
    carry_forward: {
      root_task_id: lineage.rootTaskId,
      current_path: lineage.currentPath,
      previous_attempts: lineage.totalKnownAttempts
    },
    next_checkpoint: {
      suggested_id: nextCheckpoint,
      required_status: 'ready_for_acceptance',
      required_fields: ['summary', 'files_changed', 'verification', 'blockers', 'risks', 'next_action']
    },
    created_at: decision.created_at
  };
}

export async function queueHumanDecision(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const found = await findTaskFile(root, normalized, taskId);
  if (!found) throw new Error(`Task not found for human decision: ${taskId}`);
  const task = await readJson(found.file);
  const decision = normalizeHumanDecision(options.decision);
  const lineage = await queueLineage(root, normalized, task.id);
  const latestAttempt = lineage.attempts[lineage.attempts.length - 1] ?? null;
  const latestOutcome = latestAttempt?.run?.finalJudgement?.outcome ?? null;
  if (decision === 'approve' && !['ready_for_human_review', 'ready_to_apply'].includes(latestOutcome) && !options.force) {
    throw new Error(`Cannot approve latest outcome ${latestOutcome ?? 'missing'} without --force.`);
  }
  const dir = taskRuntimeDirFor(root, normalized, task.id);
  const file = path.join(dir, 'human_review_decision.json');
  if ((await exists(file)) && !options.force) {
    throw new Error(`Human review decision already exists: ${path.relative(root, file)}. Use --force to overwrite.`);
  }
  const artifact = {
    version: 1,
    task_id: task.id,
    queue: normalized,
    generated_by: 'human_gate_decision_v1',
    decision,
    comment: options.comment ?? options.reason ?? null,
    reviewer: options.reviewer ?? 'human',
    task_state: {
      location: found.subdir,
      status: task.status ?? null,
      file: path.relative(root, found.file)
    },
    lineage: {
      rootTaskId: lineage.rootTaskId,
      requestedTaskId: lineage.requestedTaskId,
      currentPath: lineage.currentPath,
      totalKnownAttempts: lineage.totalKnownAttempts,
      latestOutcome
    },
    effects: {
      approved: decision === 'approve',
      requestChanges: decision === 'request_changes',
      rejected: decision === 'reject',
      externalWrite: false,
      autoApply: false
    },
    created_at: new Date().toISOString()
  };
  await writeJson(file, artifact);

  let transitionedTask = null;
  if (decision === 'approve' && found.subdir !== 'done') {
    const completedAt = artifact.created_at;
    transitionedTask = {
      ...task,
      status: 'completed',
      humanApprovedAt: completedAt,
      humanReviewDecision: path.relative(root, file)
    };
    const completedFile = path.join(queueSubdirFor(root, normalized, 'done'), path.basename(found.file));
    await writeJson(completedFile, transitionedTask);
    await rm(found.file, { force: true });
    artifact.effects.queueTransition = {
      from: found.subdir,
      to: 'done',
      status: 'completed',
      file: path.relative(root, completedFile)
    };
    await writeJson(file, artifact);
  }

  let revisionRequest = null;
  if (decision === 'request_changes') {
    const revisionFile = path.join(dir, 'human_revision_request.json');
    const request = buildHumanRevisionRequest(task, artifact, lineage);
    await writeJson(revisionFile, request);
    revisionRequest = {
      path: path.relative(root, revisionFile),
      request
    };
  }

  let revisionNext = null;
  if (options.enqueueRevision) {
    if (decision !== 'request_changes') throw new Error('--enqueue-revision requires --decision request_changes.');
    revisionNext = await queueRevisionNext(root, normalized, task.id, {
      title: options.title,
      task: options.task,
      strategy: options.strategy,
      force: options.force
    });
  }

  return {
    queue: normalized,
    taskId: task.id,
    decision,
    decisionFile: path.relative(root, file),
    revisionRequestFile: revisionRequest?.path ?? null,
    revisionNext,
    transitionedTask,
    artifact
  };
}

export async function queueRevisionPlan(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  const found = await findTaskFile(root, normalized, taskId, ['failed', 'done']);
  if (!found) throw new Error(`Task not found for revision: ${taskId}`);
  const task = await readJson(found.file);
  if (!task.runPath) throw new Error(`Task has no runPath for revision: ${task.id}`);
  const run = await readJson(path.join(root, safeRelativePath(task.runPath, 'task runPath')));
  const humanDecision = await latestHumanDecision(root, normalized, task.id);
  const humanRevisionPath = humanDecision?.decision?.decision === 'request_changes'
    ? path.join(taskRuntimeDirFor(root, normalized, task.id), 'human_revision_request.json')
    : null;
  const canUseHumanRevision = humanRevisionPath && await exists(humanRevisionPath);
  if (run.finalJudgement?.outcome !== 'needs_revision' && !canUseHumanRevision) {
    throw new Error(`Task final judgement is not needs_revision and no human request_changes revision exists: ${run.finalJudgement?.outcome ?? 'missing'}`);
  }
  const revisionRequestPath = canUseHumanRevision ? path.relative(root, humanRevisionPath) : run.revisionRequest?.path;
  if (!revisionRequestPath) {
    throw new Error(`Task has no revision request: ${task.id}`);
  }
  const revisionRequest = await readJson(path.join(root, safeRelativePath(revisionRequestPath, 'revision request path')));
  const revisionPolicy = resolveRevisionPolicy(options);
  const title = options.title ?? `${task.title} revision ${revisionRequest.next_checkpoint?.suggested_id ?? 'next'}`;
  const body = appendRevisionStrategy(options.task ?? renderRevisionTaskBody(task, run, revisionRequest), options.strategy);
  const revisionStrategyDiff = buildRevisionStrategyDiff(task, run, revisionRequest, body);
  const revisionGuard = await assessRevisionPolicy(root, normalized, task, revisionRequest, revisionStrategyDiff, revisionPolicy, options);
  const plannedTask = {
    title,
    body,
    revisionOf: task.id,
    revisionSourceRun: task.runPath,
    revisionRequestPath,
    revisionNextCheckpoint: revisionRequest.next_checkpoint?.suggested_id ?? null,
    revisionGoals: (revisionRequest.revision_goals ?? []).length,
    revisionRound: (task.revisionRound ?? 0) + 1,
    revisionStrategy: options.strategy ? String(options.strategy).trim() : null,
    revisionStrategyDiff,
    revisionPolicyGuard: revisionGuard
  };
  return {
    queue: normalized,
    generatedAt: new Date().toISOString(),
    sourceTaskId: task.id,
    sourceTaskFile: path.relative(root, found.file),
    sourceRun: task.runPath,
    revisionRequest: revisionRequestPath,
    revisionSource: canUseHumanRevision ? 'human' : 'acceptance',
    canEnqueue: revisionGuard.allowed,
    revisionPolicyGuard: revisionGuard,
    revisionStrategyDiff,
    plannedTask
  };
}

export async function queueRevisionNext(root, queue, taskId, options = {}) {
  const plan = await queueRevisionPlan(root, queue, taskId, options);
  if (!plan.revisionPolicyGuard.allowed) {
    throw new Error(`Revision guard blocked next round for ${taskId}: ${plan.revisionPolicyGuard.reasons.join('; ')}`);
  }
  const enqueued = await enqueueTask(root, {
    queue: plan.queue,
    title: plan.plannedTask.title,
    task: plan.plannedTask.body
  });
  const nextTask = {
    ...enqueued.task,
    revisionOf: plan.plannedTask.revisionOf,
    revisionSourceRun: plan.plannedTask.revisionSourceRun,
    revisionRequestPath: plan.plannedTask.revisionRequestPath,
    revisionNextCheckpoint: plan.plannedTask.revisionNextCheckpoint,
    revisionGoals: plan.plannedTask.revisionGoals,
    revisionRound: plan.plannedTask.revisionRound,
    revisionStrategy: plan.plannedTask.revisionStrategy,
    revisionStrategyDiff: plan.revisionStrategyDiff,
    revisionPolicyGuard: plan.revisionPolicyGuard
  };
  await writeJson(path.join(root, enqueued.file), nextTask);
  return {
    queue: plan.queue,
    sourceTaskId: plan.sourceTaskId,
    sourceTaskFile: plan.sourceTaskFile,
    sourceRun: plan.sourceRun,
    revisionRequest: plan.revisionRequest,
    revisionSource: plan.revisionSource,
    revisionPolicyGuard: plan.revisionPolicyGuard,
    revisionStrategyDiff: plan.revisionStrategyDiff,
    nextTask,
    file: enqueued.file
  };
}

export async function queueRevisionApplyPlan(root, planPath, options = {}) {
  const planFile = path.resolve(root, safeRelativePath(planPath, 'revision plan'));
  const plan = await readJson(planFile);
  if (!plan || typeof plan !== 'object') throw new Error('Revision plan must be a JSON object.');
  if (typeof plan.queue !== 'string' || !plan.queue.trim()) throw new Error('Revision plan is missing queue.');
  if (!plan.plannedTask || typeof plan.plannedTask !== 'object') throw new Error('Revision plan is missing plannedTask.');
  if (typeof plan.plannedTask.title !== 'string' || !plan.plannedTask.title.trim()) throw new Error('Revision plan plannedTask is missing title.');
  if (typeof plan.plannedTask.body !== 'string' || !plan.plannedTask.body.trim()) throw new Error('Revision plan plannedTask is missing body.');

  const normalized = normalizeLoopId(plan.queue);
  if (options.queue !== undefined && normalizeLoopId(options.queue) !== normalized) {
    throw new Error(`Revision plan queue ${normalized} does not match requested queue ${normalizeLoopId(options.queue)}.`);
  }

  const allowedByPlan = plan.canEnqueue !== false && plan.revisionPolicyGuard?.allowed !== false;
  if (!allowedByPlan && !options.force) {
    const reasons = plan.revisionPolicyGuard?.reasons?.join('; ') || 'plan canEnqueue=false';
    throw new Error(`Revision plan is blocked for ${plan.sourceTaskId ?? 'unknown source task'}: ${reasons}. Use --force to override.`);
  }

  const enqueued = await enqueueTask(root, {
    queue: normalized,
    title: plan.plannedTask.title,
    task: plan.plannedTask.body
  });
  const guard = plan.revisionPolicyGuard ?? plan.plannedTask.revisionPolicyGuard ?? null;
  const nextTask = {
    ...enqueued.task,
    revisionOf: plan.plannedTask.revisionOf ?? plan.sourceTaskId ?? null,
    revisionSourceRun: plan.plannedTask.revisionSourceRun ?? plan.sourceRun ?? null,
    revisionRequestPath: plan.plannedTask.revisionRequestPath ?? plan.revisionRequest ?? null,
    revisionNextCheckpoint: plan.plannedTask.revisionNextCheckpoint ?? null,
    revisionGoals: plan.plannedTask.revisionGoals ?? 0,
    revisionRound: plan.plannedTask.revisionRound ?? null,
    revisionStrategy: plan.plannedTask.revisionStrategy ?? null,
    revisionStrategyDiff: plan.revisionStrategyDiff ?? plan.plannedTask.revisionStrategyDiff ?? null,
    revisionPolicyGuard: allowedByPlan
      ? guard
      : {
        ...(guard ?? {}),
        bypassed: true,
        allowed: true,
        reasons: [...(guard?.reasons ?? []), 'guard bypassed by --force while applying saved plan']
      },
    revisionPlanPath: path.relative(root, planFile)
  };
  await writeJson(path.join(root, enqueued.file), nextTask);
  return {
    queue: normalized,
    sourceTaskId: plan.sourceTaskId ?? nextTask.revisionOf,
    sourceTaskFile: plan.sourceTaskFile ?? null,
    sourceRun: plan.sourceRun ?? nextTask.revisionSourceRun,
    revisionRequest: plan.revisionRequest ?? nextTask.revisionRequestPath,
    revisionSource: plan.revisionSource ?? null,
    revisionPolicyGuard: nextTask.revisionPolicyGuard,
    revisionStrategyDiff: nextTask.revisionStrategyDiff,
    revisionPlan: path.relative(root, planFile),
    nextTask,
    file: enqueued.file
  };
}

function classifyRevisionPlanAction(plan) {
  if (!plan.readable) {
    return {
      recommendedAction: 'review_unreadable',
      needsAction: true,
      actionReason: 'plan JSON could not be read'
    };
  }
  if (plan.applied) {
    return {
      recommendedAction: 'ignore_applied',
      needsAction: false,
      actionReason: 'plan has already been applied'
    };
  }
  if (!plan.queueMatches) {
    return {
      recommendedAction: 'review_queue_mismatch',
      needsAction: true,
      actionReason: 'plan queue does not match the reviewed queue'
    };
  }
  if (!plan.canEnqueue || !plan.guardAllowed) {
    return {
      recommendedAction: 'review_blocked',
      needsAction: true,
      actionReason: 'revision guard blocks automatic enqueue'
    };
  }
  if (plan.stale) {
    return {
      recommendedAction: 'apply_or_refresh_stale',
      needsAction: true,
      actionReason: 'plan is enqueueable but older than the stale threshold'
    };
  }
  return {
    recommendedAction: 'apply_ready',
    needsAction: true,
    actionReason: 'plan is enqueueable and has not been applied'
  };
}

async function loadRevisionApplyReportIndex(root, reportPath, expectedQueue) {
  if (!reportPath) return null;
  const reportFile = path.resolve(root, safeRelativePath(reportPath, 'revision apply report'));
  const report = await readJson(reportFile);
  if (!report || typeof report !== 'object') throw new Error('Revision apply report must be a JSON object.');
  if (typeof report.queue !== 'string' || !report.queue.trim()) throw new Error('Revision apply report is missing queue.');
  if (report.queue !== expectedQueue) {
    throw new Error(`Revision apply report queue ${report.queue} does not match reviewed queue ${expectedQueue}.`);
  }
  if (!Array.isArray(report.applied)) throw new Error('Revision apply report is missing applied array.');
  if (!Array.isArray(report.skipped)) throw new Error('Revision apply report is missing skipped array.');

  const rel = path.relative(root, reportFile);
  const byPlan = new Map();
  const add = (plan, entry) => {
    if (!plan) return;
    if (!byPlan.has(plan)) byPlan.set(plan, []);
    byPlan.get(plan).push(entry);
  };
  for (const item of report.applied) {
    add(item.plan, {
      report: rel,
      generatedAt: report.generatedAt ?? null,
      status: 'applied',
      action: item.action ?? null,
      sourceTaskId: item.sourceTaskId ?? null,
      nextTaskId: item.nextTaskId ?? null,
      file: item.file ?? null,
      reason: null
    });
  }
  for (const item of report.skipped) {
    add(item.plan, {
      report: rel,
      generatedAt: report.generatedAt ?? null,
      status: 'skipped',
      action: item.action ?? null,
      sourceTaskId: null,
      nextTaskId: null,
      file: null,
      reason: item.reason ?? null
    });
  }
  return {
    file: rel,
    generatedAt: report.generatedAt ?? null,
    queue: report.queue,
    actions: Array.isArray(report.actions) ? report.actions : [],
    reviewedPlans: report.reviewedPlans ?? null,
    appliedCount: report.appliedCount ?? report.applied.length,
    skippedCount: report.skippedCount ?? report.skipped.length,
    byPlan
  };
}

export async function queueRevisionReview(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const defaultDir = path.join('runtime', 'loops', normalized, 'revision-plans');
  const plansDirRel = safeRelativePath(options.dir ?? defaultDir, 'revision plans dir');
  const plansDir = path.resolve(root, plansDirRel);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && options.staleAfterMs >= 0
    ? options.staleAfterMs
    : null;
  const applyReportIndex = await loadRevisionApplyReportIndex(root, options.appliedReport, normalized);
  const appliedByPlan = new Map();
  for (const entry of await listQueueTasks(root, normalized)) {
    const rel = entry.task.revisionPlanPath;
    if (!rel) continue;
    if (!appliedByPlan.has(rel)) appliedByPlan.set(rel, []);
    appliedByPlan.get(rel).push({
      taskId: entry.task.id,
      title: entry.task.title,
      status: entry.task.status,
      subdir: entry.subdir,
      file: entry.file,
      enqueuedAt: entry.task.enqueuedAt ?? null
    });
  }

  const files = [];
  for (const file of await listJson(plansDir)) {
    const full = path.join(plansDir, file);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(full)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    files.push({ file, full, rel: path.relative(root, full), mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));

  const plans = [];
  for (const item of files) {
    let plan;
    try {
      plan = await readJson(item.full);
    } catch (error) {
      const planAgeMs = item.mtimeMs > 0 ? Math.max(0, nowMs - item.mtimeMs) : null;
      const reviewPlan = {
        file: item.rel,
        readable: false,
        error: error.message,
        generatedAt: null,
        fileModifiedAt: item.mtimeMs > 0 ? new Date(item.mtimeMs).toISOString() : null,
        planAgeMs,
        stale: Boolean(staleAfterMs !== null && planAgeMs !== null && planAgeMs >= staleAfterMs),
        applied: false,
        appliedCount: 0,
        appliedTasks: [],
        applyReportEntries: applyReportIndex?.byPlan.get(item.rel) ?? []
      };
      plans.push({
        ...reviewPlan,
        ...classifyRevisionPlanAction(reviewPlan)
      });
      continue;
    }
    const appliedTasks = appliedByPlan.get(item.rel) ?? [];
    const summary = plan.revisionStrategyDiff?.summary ?? plan.plannedTask?.revisionStrategyDiff?.summary ?? null;
    const generatedAt = typeof plan.generatedAt === 'string' ? plan.generatedAt : null;
    const generatedAtMs = generatedAt ? Date.parse(generatedAt) : NaN;
    const planTimeMs = Number.isFinite(generatedAtMs) ? generatedAtMs : item.mtimeMs;
    const planAgeMs = Number.isFinite(planTimeMs) && planTimeMs > 0 ? Math.max(0, nowMs - planTimeMs) : null;
    const reviewPlan = {
      file: item.rel,
      readable: true,
      queue: plan.queue ?? null,
      queueMatches: plan.queue === normalized,
      generatedAt,
      fileModifiedAt: item.mtimeMs > 0 ? new Date(item.mtimeMs).toISOString() : null,
      planAgeMs,
      sourceTaskId: plan.sourceTaskId ?? plan.plannedTask?.revisionOf ?? null,
      title: plan.plannedTask?.title ?? null,
      canEnqueue: plan.canEnqueue !== false,
      guardAllowed: plan.revisionPolicyGuard?.allowed !== false,
      guardReasons: plan.revisionPolicyGuard?.reasons ?? [],
      revisionRound: plan.plannedTask?.revisionRound ?? null,
      revisionRequest: plan.revisionRequest ?? plan.plannedTask?.revisionRequestPath ?? null,
      strategyDiffSummary: summary,
      applied: appliedTasks.length > 0,
      appliedCount: appliedTasks.length,
      appliedTasks,
      applyReportEntries: applyReportIndex?.byPlan.get(item.rel) ?? []
    };
    reviewPlan.stale = Boolean(!reviewPlan.applied && staleAfterMs !== null && planAgeMs !== null && planAgeMs >= staleAfterMs);
    plans.push({
      ...reviewPlan,
      ...classifyRevisionPlanAction(reviewPlan)
    });
  }

  const filteredPlans = options.needsAction
    ? plans.filter((plan) => plan.needsAction)
    : plans;
  const limit = options.limit && Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  const visiblePlans = limit ? filteredPlans.slice(0, limit) : filteredPlans;
  return {
    queue: normalized,
    generatedAt: new Date(nowMs).toISOString(),
    plansDir: path.relative(root, plansDir),
    filters: {
      needsAction: Boolean(options.needsAction),
      staleAfterMs,
      appliedReport: applyReportIndex ? applyReportIndex.file : null
    },
    appliedReport: applyReportIndex ? {
      file: applyReportIndex.file,
      generatedAt: applyReportIndex.generatedAt,
      queue: applyReportIndex.queue,
      actions: applyReportIndex.actions,
      reviewedPlans: applyReportIndex.reviewedPlans,
      appliedCount: applyReportIndex.appliedCount,
      skippedCount: applyReportIndex.skippedCount
    } : null,
    totalPlanFiles: plans.length,
    matchedPlans: filteredPlans.length,
    shownPlans: visiblePlans.length,
    appliedPlans: plans.filter((plan) => plan.applied).length,
    unappliedPlans: plans.filter((plan) => !plan.applied).length,
    blockedPlans: plans.filter((plan) => plan.readable && (!plan.canEnqueue || !plan.guardAllowed)).length,
    stalePlans: plans.filter((plan) => plan.stale).length,
    needsActionPlans: plans.filter((plan) => plan.needsAction).length,
    unreadablePlans: plans.filter((plan) => !plan.readable).length,
    applyReportMatchedPlans: plans.filter((plan) => plan.applyReportEntries.length > 0).length,
    applyReportAppliedPlans: plans.filter((plan) => plan.applyReportEntries.some((entry) => entry.status === 'applied')).length,
    applyReportSkippedPlans: plans.filter((plan) => plan.applyReportEntries.some((entry) => entry.status === 'skipped')).length,
    plans: visiblePlans
  };
}

const TASK_STATE_DIRS = ['inbox', 'active', 'failed', 'done', 'canceled'];

async function listQueueTasks(root, queue) {
  const tasks = [];
  for (const subdir of TASK_STATE_DIRS) {
    const dir = queueSubdirFor(root, queue, subdir);
    for (const file of await listJson(dir)) {
      const full = path.join(dir, file);
      const task = await readJson(full);
      tasks.push({
        task,
        file: path.relative(root, full),
        subdir
      });
    }
  }
  return tasks;
}

function sortLineageTasks(a, b) {
  const roundA = a.task.revisionRound ?? 0;
  const roundB = b.task.revisionRound ?? 0;
  if (roundA !== roundB) return roundA - roundB;
  const timeA = Date.parse(a.task.enqueuedAt ?? a.task.startedAt ?? a.task.finishedAt ?? '') || 0;
  const timeB = Date.parse(b.task.enqueuedAt ?? b.task.startedAt ?? b.task.finishedAt ?? '') || 0;
  if (timeA !== timeB) return timeA - timeB;
  return String(a.task.id).localeCompare(String(b.task.id));
}

async function summarizeLineageRun(root, task, currentRun = null) {
  const rel = task.runPath;
  if (!rel) return null;
  let run = currentRun;
  if (!run) {
    try {
      run = await readJson(path.join(root, safeRelativePath(rel, 'lineage run path')));
    } catch {
      return {
        path: rel,
        readable: false
      };
    }
  }
  return {
    path: rel,
    readable: true,
    runId: run.runId ?? null,
    status: run.status ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    checkpoints: run.checkpoints ? {
      count: run.checkpoints.count ?? 0,
      files: run.checkpoints.files ?? []
    } : null,
    acceptanceReviews: run.acceptanceReviews ? {
      count: run.acceptanceReviews.count ?? 0,
      accepted: run.acceptanceReviews.accepted ?? 0,
      revise: run.acceptanceReviews.revise ?? 0,
      blocked: run.acceptanceReviews.blocked ?? 0,
      files: run.acceptanceReviews.files ?? []
    } : null,
    finalJudgement: run.finalJudgement ? {
      outcome: run.finalJudgement.outcome ?? null,
      requiresHumanGate: run.finalJudgement.requiresHumanGate ?? null,
      reasons: run.finalJudgement.reasons ?? [],
      nextActions: run.finalJudgement.nextActions ?? []
    } : null,
    revisionRequest: run.revisionRequest ? {
      path: run.revisionRequest.path ?? null,
      status: run.revisionRequest.status ?? null,
      goals: run.revisionRequest.goals ?? 0,
      nextCheckpoint: run.revisionRequest.nextCheckpoint ?? null
    } : null
  };
}

async function summarizeLineageTask(root, entry, currentRun = null) {
  const task = entry.task;
  return {
    taskId: task.id,
    title: task.title ?? null,
    status: task.status ?? null,
    location: entry.subdir,
    file: entry.file,
    revisionOf: task.revisionOf ?? null,
    revisionRound: task.revisionRound ?? 0,
    revisionSourceRun: task.revisionSourceRun ?? null,
    revisionRequestPath: task.revisionRequestPath ?? null,
    revisionNextCheckpoint: task.revisionNextCheckpoint ?? null,
    revisionGoals: task.revisionGoals ?? 0,
    revisionStrategyDiff: task.revisionStrategyDiff ?? null,
    enqueuedAt: task.enqueuedAt ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    attempts: task.attempts ?? 0,
    run: await summarizeLineageRun(root, task, currentRun)
  };
}

function lineageRootFor(taskById, taskId) {
  let current = taskById.get(taskId);
  if (!current) return null;
  const seen = new Set();
  while (current?.task?.revisionOf && taskById.has(current.task.revisionOf) && !seen.has(current.task.id)) {
    seen.add(current.task.id);
    current = taskById.get(current.task.revisionOf);
  }
  return current;
}

function lineagePathToTask(taskById, taskId) {
  const pathEntries = [];
  let current = taskById.get(taskId);
  const seen = new Set();
  while (current && !seen.has(current.task.id)) {
    pathEntries.push(current);
    seen.add(current.task.id);
    current = current.task.revisionOf ? taskById.get(current.task.revisionOf) : null;
  }
  return pathEntries.reverse();
}

function lineageDescendants(rootEntry, childrenByParent) {
  const result = [];
  const stack = [rootEntry];
  const seen = new Set();
  while (stack.length > 0) {
    const entry = stack.shift();
    if (!entry || seen.has(entry.task.id)) continue;
    seen.add(entry.task.id);
    result.push(entry);
    const children = [...(childrenByParent.get(entry.task.id) ?? [])].sort(sortLineageTasks);
    stack.push(...children);
  }
  return result;
}

export async function queueLineage(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const tasks = await listQueueTasks(root, normalized);
  const taskById = new Map(tasks.map((entry) => [entry.task.id, entry]));
  const requested = taskById.get(taskId);
  if (!requested) throw new Error(`Task not found for lineage: ${taskId}`);

  const rootEntry = lineageRootFor(taskById, requested.task.id);
  const childrenByParent = new Map();
  for (const entry of tasks) {
    const parent = entry.task.revisionOf;
    if (!parent) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(entry);
  }

  const lineageEntries = lineageDescendants(rootEntry, childrenByParent).sort(sortLineageTasks);
  const currentRun = options.currentRun ?? null;
  const attempts = [];
  for (const entry of lineageEntries) {
    attempts.push(await summarizeLineageTask(
      root,
      entry,
      currentRun && entry.task.id === currentRun.taskId ? currentRun : null
    ));
  }
  const currentPath = lineagePathToTask(taskById, requested.task.id);
  return {
    queue: normalized,
    requestedTaskId: requested.task.id,
    rootTaskId: rootEntry?.task?.id ?? requested.task.id,
    revisionRound: requested.task.revisionRound ?? 0,
    totalKnownAttempts: attempts.length,
    currentPath: currentPath.map((entry) => entry.task.id),
    edges: lineageEntries
      .filter((entry) => entry.task.revisionOf)
      .map((entry) => ({
        from: entry.task.revisionOf,
        to: entry.task.id,
        revisionRound: entry.task.revisionRound ?? 0,
        nextCheckpoint: entry.task.revisionNextCheckpoint ?? null
      })),
    attempts
  };
}

async function readRelativeJson(root, rel, label) {
  if (!rel) return null;
  try {
    return await readJson(path.join(root, safeRelativePath(rel, label)));
  } catch {
    return null;
  }
}

async function hydrateLineageAttempt(root, attempt) {
  const checkpoints = [];
  for (const file of attempt.run?.checkpoints?.files ?? []) {
    const checkpoint = await readRelativeJson(root, file, 'lineage checkpoint path');
    checkpoints.push({
      file,
      checkpointId: checkpoint?.checkpoint_id ?? checkpoint?.id ?? null,
      status: checkpoint?.status ?? null,
      summary: checkpoint?.summary ?? null,
      filesChanged: checkpoint?.files_changed ?? checkpoint?.filesChanged ?? [],
      verification: checkpoint?.verification ?? [],
      blockers: checkpoint?.blockers ?? [],
      risks: checkpoint?.risks ?? [],
      nextAction: checkpoint?.next_action ?? checkpoint?.nextAction ?? null
    });
  }

  const reviews = [];
  for (const file of attempt.run?.acceptanceReviews?.files ?? []) {
    const review = await readRelativeJson(root, file, 'lineage review path');
    reviews.push({
      file,
      checkpointId: review?.checkpoint_id ?? review?.checkpointId ?? null,
      status: review?.status ?? null,
      summary: review?.summary ?? null,
      failedChecks: review?.failed_checks ?? review?.failedChecks ?? [],
      evidence: review?.evidence ?? [],
      suggestedFix: review?.suggested_fix ?? review?.suggestedFix ?? null,
      nextAction: review?.next_action ?? review?.nextAction ?? null
    });
  }

  const revisionRequest = await readRelativeJson(root, attempt.run?.revisionRequest?.path, 'lineage revision request path');
  return {
    ...attempt,
    details: {
      checkpoints,
      reviews,
      revisionRequest: revisionRequest ? {
        path: attempt.run?.revisionRequest?.path ?? null,
        status: revisionRequest.status ?? null,
        goals: (revisionRequest.revision_goals ?? []).map((goal) => ({
          checkpointId: goal.checkpoint_id ?? null,
          check: goal.check ?? null,
          critic: goal.critic ?? null,
          criticFocus: goal.critic_focus ?? null,
          missingEvidence: goal.missing_evidence ?? [],
          nextDevelopmentGoals: goal.next_development_goals ?? [],
          evidence: goal.evidence ?? null,
          suggestedFix: goal.suggested_fix ?? null
        })),
        nextCheckpoint: revisionRequest.next_checkpoint ?? null
      } : null
    }
  };
}

function formatList(values, fallback = 'none') {
  const list = Array.isArray(values) ? values.filter((v) => v !== null && v !== undefined && String(v).trim()) : [];
  if (list.length === 0) return fallback;
  return list.map((v) => `\`${String(v)}\``).join(', ');
}

function formatPlainList(values, fallback = 'none') {
  const list = Array.isArray(values) ? values.filter((v) => v !== null && v !== undefined && String(v).trim()) : [];
  return list.length === 0 ? fallback : list.map(String).join('; ');
}

function lineageBundleVerdict(lineage) {
  const latest = lineage.attempts[lineage.attempts.length - 1];
  const outcome = latest?.run?.finalJudgement?.outcome ?? null;
  if (outcome === 'ready_for_human_review') return 'Ready for human review.';
  if (outcome === 'ready_to_apply') return 'Ready to apply.';
  if (outcome === 'needs_revision') return 'Needs another revision round.';
  if (outcome === 'blocked') return 'Blocked before acceptance.';
  return 'No final acceptance verdict yet.';
}

function renderLineageBundleMarkdown(bundle) {
  const lines = [];
  lines.push(`# Loop Lineage Review: ${bundle.rootTaskId}`);
  lines.push('');
  lines.push(`- Queue: \`${bundle.queue}\``);
  lines.push(`- Requested task: \`${bundle.requestedTaskId}\``);
  lines.push(`- Root task: \`${bundle.rootTaskId}\``);
  lines.push(`- Attempts: ${bundle.totalKnownAttempts}`);
  lines.push(`- Current path: ${bundle.currentPath.map((id) => `\`${id}\``).join(' -> ')}`);
  lines.push(`- Verdict: ${bundle.verdict}`);
  lines.push(`- Generated: ${bundle.generatedAt}`);
  lines.push('');

  if (bundle.edges.length > 0) {
    lines.push('## Revision Edges');
    lines.push('');
    for (const edge of bundle.edges) {
      lines.push(`- \`${edge.from}\` -> \`${edge.to}\` (round ${edge.revisionRound}, next checkpoint: \`${edge.nextCheckpoint ?? 'none'}\`)`);
    }
    lines.push('');
  }

  lines.push('## Attempts');
  lines.push('');
  for (const attempt of bundle.attempts) {
    const outcome = attempt.run?.finalJudgement?.outcome ?? 'no final judgement';
    lines.push(`### Round ${attempt.revisionRound}: ${attempt.title ?? attempt.taskId}`);
    lines.push('');
    lines.push(`- Task: \`${attempt.taskId}\``);
    lines.push(`- State: \`${attempt.location}/${attempt.status ?? 'unknown'}\``);
    lines.push(`- Run: ${attempt.run?.path ? `\`${attempt.run.path}\`` : 'none'}`);
    lines.push(`- Final judgement: \`${outcome}\``);
    if (attempt.revisionStrategyDiff) {
      const diff = attempt.revisionStrategyDiff;
      lines.push(`- Strategy diff: carried ${diff.summary?.carried_forward_targets ?? 0}/${diff.summary?.total_targets ?? 0}, changed ${diff.summary?.targets_with_changed_strategy ?? 0}/${diff.summary?.total_targets ?? 0}, needs detail ${diff.summary?.targets_needing_strategy_detail ?? 0}`);
      if (diff.next_task_body?.explicit_strategy_lines?.length) {
        lines.push(`- Strategy signals: ${formatPlainList(diff.next_task_body.explicit_strategy_lines)}`);
      }
      if (diff.recommendations?.length) {
        lines.push(`- Strategy recommendations: ${formatPlainList(diff.recommendations)}`);
      }
    }
    if (attempt.run?.finalJudgement?.reasons?.length) {
      lines.push(`- Why: ${formatPlainList(attempt.run.finalJudgement.reasons)}`);
    }
    if (attempt.run?.finalJudgement?.nextActions?.length) {
      lines.push(`- Next action: ${formatPlainList(attempt.run.finalJudgement.nextActions)}`);
    }
    lines.push('');

    lines.push('Checkpoint output:');
    if (attempt.details.checkpoints.length === 0) {
      lines.push('- none');
    } else {
      for (const cp of attempt.details.checkpoints) {
        lines.push(`- \`${cp.checkpointId ?? 'checkpoint'}\` ${cp.status ?? 'unknown'}: ${cp.summary ?? 'no summary'}`);
        lines.push(`  - Files changed: ${formatList(cp.filesChanged)}`);
        lines.push(`  - Verification: ${formatPlainList(cp.verification)}`);
        if (cp.blockers.length > 0) lines.push(`  - Blockers: ${formatPlainList(cp.blockers)}`);
        if (cp.risks.length > 0) lines.push(`  - Risks: ${formatPlainList(cp.risks)}`);
      }
    }
    lines.push('');

    lines.push('Acceptance review:');
    if (attempt.details.reviews.length === 0) {
      lines.push('- none');
    } else {
      for (const review of attempt.details.reviews) {
        lines.push(`- \`${review.checkpointId ?? 'checkpoint'}\` -> \`${review.status ?? 'unknown'}\`: ${review.summary ?? 'no summary'}`);
        if (review.failedChecks.length > 0) lines.push(`  - Failed checks: ${formatPlainList(review.failedChecks)}`);
        if (review.evidence.length > 0) lines.push(`  - Evidence: ${formatPlainList(review.evidence)}`);
        if (review.suggestedFix) lines.push(`  - Suggested fix: ${review.suggestedFix}`);
        if (review.nextAction) lines.push(`  - Next action: ${review.nextAction}`);
      }
    }
    lines.push('');

    if (attempt.details.revisionRequest) {
      lines.push('Revision request:');
      lines.push(`- File: \`${attempt.details.revisionRequest.path}\``);
      lines.push(`- Next checkpoint: \`${attempt.details.revisionRequest.nextCheckpoint?.suggested_id ?? 'none'}\``);
      for (const goal of attempt.details.revisionRequest.goals) {
        lines.push(`- Goal: ${goal.check ?? 'unknown'} for \`${goal.checkpointId ?? 'unknown'}\``);
        if (goal.critic) lines.push(`  - Critic: \`${goal.critic}\``);
        if (goal.criticFocus) lines.push(`  - Focus: ${goal.criticFocus}`);
        if (goal.missingEvidence.length > 0) lines.push(`  - Missing evidence: ${formatPlainList(goal.missingEvidence)}`);
        if (goal.evidence) lines.push(`  - Evidence: ${goal.evidence}`);
        if (goal.suggestedFix) lines.push(`  - Suggested fix: ${goal.suggestedFix}`);
        if (goal.nextDevelopmentGoals.length > 0) {
          lines.push('  - Next development goals:');
          for (const nextGoal of goal.nextDevelopmentGoals) lines.push(`    - ${nextGoal}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Human Review Checklist');
  lines.push('');
  lines.push('- Confirm the latest final judgement matches the checkpoint evidence.');
  lines.push('- Inspect files changed in the latest accepted checkpoint.');
  lines.push('- If the verdict is `needs_revision`, enqueue the next round with `queue-revision-next`.');
  lines.push('- If the verdict is `ready_for_human_review`, decide whether to approve, apply, or request another round.');
  lines.push('');
  return lines.join('\n');
}

function resolveLineageBundleOutputPath(root, queue, lineage, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'lineage bundle output'));
  }
  const fileBase = `${sanitizeFileSegment(lineage.rootTaskId ?? lineage.requestedTaskId ?? 'lineage')}.md`;
  return path.join(queueSubdirFor(root, queue, 'lineage-bundles'), fileBase);
}

export async function queueLineageBundle(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  const lineage = await queueLineage(root, normalized, taskId);
  const attempts = [];
  for (const attempt of lineage.attempts) {
    attempts.push(await hydrateLineageAttempt(root, attempt));
  }
  const bundle = {
    version: 1,
    generatedAt: new Date().toISOString(),
    ...lineage,
    attempts,
    verdict: lineageBundleVerdict({ ...lineage, attempts })
  };
  const markdown = renderLineageBundleMarkdown(bundle);
  const outputFile = resolveLineageBundleOutputPath(root, normalized, lineage, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Lineage bundle already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, markdown);
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, bundle);
  return {
    ...bundle,
    bundleFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile),
    markdown
  };
}

function codeWorktreeSummary(entry) {
  const run = entry.run;
  const verifyResults = Array.isArray(run.verification)
    ? run.verification.map((item) => ({
      cmd: item.cmd,
      exitCode: item.result?.exitCode ?? null,
      timedOut: item.result?.timedOut ?? false
    }))
    : [];
  return {
    file: entry.file,
    runId: run.runId ?? null,
    queue: run.queue ?? null,
    taskId: run.taskId ?? null,
    title: run.title ?? null,
    status: run.status ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    taskPath: run.taskPath ?? null,
    worktree: run.worktree ? {
      path: run.worktree.path ?? null,
      branch: run.worktree.branch ?? null,
      head: run.worktree.head ?? null,
      dirty: Boolean(run.worktree.inspection?.dirty),
      setupExitCode: run.worktree.setup?.exitCode ?? null,
      statusShort: run.worktree.inspection?.status?.stdout ?? '',
      diffStat: run.worktree.inspection?.diffStat ?? '',
      diffNameStatus: run.worktree.inspection?.diffNameStatus ?? '',
      untracked: run.worktree.inspection?.untracked ?? ''
    } : null,
    verification: verifyResults,
    verifyOk: verifyResults.every((item) => item.exitCode === 0)
  };
}

export async function codeWorktreeList(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const entries = (await recentRuns(root, normalized, { limit }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree);
  return {
    queue: normalized,
    inspectedRuns: entries.length,
    worktrees: entries.map(codeWorktreeSummary).reverse()
  };
}

export async function codeWorktreeInspect(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const found = await findCodeWorktreeRun(root, normalized, options);
  return {
    ...codeWorktreeSummary(found),
    raw: found.run
  };
}

export async function codeWorktreeDiff(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const found = await findCodeWorktreeRun(root, normalized, options);
  const summary = codeWorktreeSummary(found);
  const worktreePath = resolveWorktreePath(root, found.run.worktree?.path);
  if (!(await exists(worktreePath))) {
    throw new Error(`Worktree path no longer exists: ${summary.worktree?.path ?? 'unknown'}`);
  }
  const [diffStat, diffNameStatus, patch, untracked] = await Promise.all([
    runCommand('git diff --stat HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git diff --name-status HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git diff --binary HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git ls-files --others --exclude-standard', { cwd: worktreePath, timeoutMs: 30000 })
  ]);
  for (const [label, result] of Object.entries({ diffStat, diffNameStatus, patch, untracked })) {
    if (result.exitCode !== 0) {
      throw new Error(`Unable to read worktree ${label}: ${trimTail(result.stderr || result.stdout, 1200)}`);
    }
  }
  return {
    ...summary,
    worktreePath,
    diffStat: trimTail(diffStat.stdout, 12000),
    diffNameStatus: trimTail(diffNameStatus.stdout, 12000),
    untracked: trimTail(untracked.stdout, 12000),
    patch: trimTail(patch.stdout, 60000)
  };
}

export async function codeWorktreeExport(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const diff = await codeWorktreeDiff(root, normalized, options);
  const patchFile = resolvePatchOutputPath(root, normalized, diff, options.output);
  if ((await exists(patchFile)) && !options.force) {
    throw new Error(`Patch export already exists: ${path.relative(root, patchFile)}. Use --force to overwrite.`);
  }
  const manifestFile = `${patchFile}.json`;
  const header = [
    `# loop-engineering patch export`,
    `# queue: ${normalized}`,
    `# task: ${diff.taskId ?? 'unknown'}`,
    `# run: ${diff.runId ?? 'unknown'}`,
    `# branch: ${diff.worktree?.branch ?? 'unknown'}`,
    `# worktree: ${diff.worktree?.path ?? 'unknown'}`,
    `# exportedAt: ${new Date().toISOString()}`,
    ''
  ].join('\n');
  const patchBody = diff.patch || '';
  const untrackedBlock = diff.untracked
    ? `\n# Untracked files from worktree:\n${diff.untracked.split('\n').filter(Boolean).map((line) => `#   ${line}`).join('\n')}\n`
    : '';
  const patchContent = `${header}${patchBody}${untrackedBlock}`;
  await mkdir(path.dirname(patchFile), { recursive: true });
  await writeFile(patchFile, patchContent);
  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    queue: normalized,
    taskId: diff.taskId,
    runId: diff.runId,
    title: diff.title,
    status: diff.status,
    sourceRunFile: diff.file,
    worktree: diff.worktree,
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(patchContent),
    diffStat: diff.diffStat,
    diffNameStatus: diff.diffNameStatus,
    untracked: diff.untracked
  };
  await writeJson(manifestFile, manifest);
  return {
    ...manifest,
    manifestFile: path.relative(root, manifestFile)
  };
}

export async function codePatchVerify(root, options = {}) {
  if (!options.patch) throw new Error('code-patch-verify requires --patch.');
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      diffFiles,
      applyCheck: null
    };
  }

  const applyCheck = await runPatchApplyCheck(root, patch, options.timeoutMs ?? 60000);
  return {
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(rawPatch),
    normalizedPatchBytes: Buffer.byteLength(patch),
    status: applyCheck.exitCode === 0 ? 'applies' : 'rejected',
    ok: applyCheck.exitCode === 0,
    diffFiles,
    applyCheck: compactCommandResult(applyCheck)
  };
}

export async function codePatchApplyPlan(root, options = {}) {
  if (!options.patch) throw new Error('code-patch-apply-plan requires --patch.');
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  const affectedPaths = affectedPathsFromDiffFiles(diffFiles);
  const affectedStatus = affectedPaths.length > 0
    ? await gitStatusForPaths(root, affectedPaths, options.timeoutMs ?? 60000)
    : { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  const dirtyAffected = Boolean(affectedStatus.stdout.trim());
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      canApply: false,
      diffFiles,
      affectedPaths,
      dirtyAffected,
      affectedStatus: compactCommandResult(affectedStatus),
      applyCheck: null
    };
  }

  const applyCheck = await runPatchApplyCheck(root, patch, options.timeoutMs ?? 60000);
  const checkOk = applyCheck.exitCode === 0;
  const canApply = checkOk && (!dirtyAffected || Boolean(options.allowDirty));
  const status = checkOk
    ? dirtyAffected && !options.allowDirty ? 'dirty_affected_files' : 'ready'
    : 'rejected';
  return {
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(rawPatch),
    normalizedPatchBytes: Buffer.byteLength(patch),
    status,
    ok: canApply,
    canApply,
    allowDirty: Boolean(options.allowDirty),
    diffFiles,
    affectedPaths,
    dirtyAffected,
    affectedStatus: compactCommandResult(affectedStatus),
    applyCheck: compactCommandResult(applyCheck)
  };
}

export async function codePatchApply(root, options = {}) {
  if (!options.confirmApply) {
    throw new Error('code-patch-apply requires --confirm-apply.');
  }
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      applied: false,
      diffFiles
    };
  }

  const plan = await codePatchApplyPlan(root, {
    patch: options.patch,
    timeoutMs: options.timeoutMs,
    allowDirty: options.allowDirty
  });
  if (!plan.canApply) {
    return {
      ...plan,
      applied: false,
      status: `not_applied_${plan.status}`
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'loop-engineering-patch-'));
  const tempPatch = path.join(tempDir, 'review.patch');
  try {
    await writeFile(tempPatch, patch);
    const apply = await runCommand(`git apply --binary ${shellQuote(tempPatch)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 60000
    });
    return {
      ...plan,
      status: apply.exitCode === 0 ? 'applied' : 'apply_failed',
      ok: apply.exitCode === 0,
      applied: apply.exitCode === 0,
      appliedAt: apply.exitCode === 0 ? new Date().toISOString() : null,
      apply: compactCommandResult(apply)
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function codeReviewBundle(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const generatedAt = new Date().toISOString();
  const errors = [];
  let diff = null;
  try {
    diff = await codeWorktreeDiff(root, normalized, options);
  } catch (err) {
    errors.push({
      step: 'code-worktree-diff',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  let patchManifest = null;
  let patchVerify = null;
  let applyPlan = null;
  if (patchExists) {
    const manifestFile = `${patchFile}.json`;
    if (await exists(manifestFile)) {
      try {
        patchManifest = await readJson(manifestFile);
      } catch (err) {
        errors.push({
          step: 'read-patch-manifest',
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    try {
      patchVerify = await codePatchVerify(root, { patch: patchRel, timeoutMs: options.timeoutMs });
    } catch (err) {
      errors.push({
        step: 'code-patch-verify',
        message: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
    } catch (err) {
      errors.push({
        step: 'code-patch-apply-plan',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const bundle = {
    version: 1,
    generatedAt,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    status: inspected.status,
    sourceRunFile: inspected.file,
    taskPath: inspected.taskPath,
    worktree: inspected.worktree,
    verification: inspected.verification,
    verifyOk: inspected.verifyOk,
    diff: diff ? {
      diffStat: diff.diffStat,
      diffNameStatus: diff.diffNameStatus,
      untracked: diff.untracked,
      patch: options.includePatch === false ? null : diff.patch
    } : null,
    patchExport: {
      patchFile: patchRel,
      exists: patchExists,
      manifest: patchManifest
    },
    patchVerify,
    applyPlan,
    errors
  };
  const markdown = renderCodeReviewBundleMarkdown(bundle);
  const outputFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Review bundle already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, markdown);
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, bundle);
  return {
    ...bundle,
    reviewFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile),
    markdown
  };
}

export async function codeTaskCloseout(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const closedAt = new Date().toISOString();
  const errors = [];

  let worktreeFullPath = null;
  let worktreeExists = false;
  try {
    worktreeFullPath = resolveWorktreePath(root, inspected.worktree?.path);
    worktreeExists = await exists(worktreeFullPath);
  } catch (err) {
    errors.push({
      step: 'resolve-worktree',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  let diff = null;
  if (worktreeExists) {
    try {
      diff = await codeWorktreeDiff(root, normalized, options);
    } catch (err) {
      errors.push({
        step: 'code-worktree-diff',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  const patchManifestFile = `${patchFile}.json`;
  const patchManifestExists = await exists(patchManifestFile);
  let patchManifest = null;
  let patchVerify = null;
  let applyPlan = null;
  if (patchManifestExists) {
    try {
      patchManifest = await readJson(patchManifestFile);
    } catch (err) {
      errors.push({
        step: 'read-patch-manifest',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (patchExists) {
    try {
      patchVerify = await codePatchVerify(root, { patch: patchRel, timeoutMs: options.timeoutMs });
    } catch (err) {
      patchVerify = {
        status: 'error',
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
    } catch (err) {
      applyPlan = {
        status: 'error',
        ok: false,
        canApply: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewJsonFile = `${reviewFile}.json`;
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(reviewJsonFile);
  let reviewJson = null;
  if (reviewJsonExists) {
    try {
      reviewJson = await readJson(reviewJsonFile);
    } catch (err) {
      errors.push({
        step: 'read-review-json',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  let cleanupPlan = null;
  let cleanupItem = null;
  try {
    cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(options.limit ?? 50, 100)
    });
    cleanupItem = cleanupPlan.worktrees.find((item) => {
      if (inspected.taskId && item.taskId === inspected.taskId) return true;
      if (inspected.runId && item.runId === inspected.runId) return true;
      return false;
    }) ?? null;
  } catch (err) {
    errors.push({
      step: 'code-worktree-cleanup-plan',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const actions = closeoutActions({
    inspected,
    worktreeExists,
    patchExists,
    patchVerify,
    reviewExists,
    reviewJsonExists,
    cleanupItem
  });
  const closeoutStatus = closeoutStatusFor({
    errors,
    actions,
    worktreeExists,
    patchExists,
    patchVerify,
    reviewExists,
    reviewJsonExists,
    cleanupItem
  });
  const closeout = {
    version: 1,
    closedAt,
    closeoutStatus,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    status: inspected.status,
    sourceRunFile: inspected.file,
    taskPath: inspected.taskPath,
    worktree: inspected.worktree,
    worktreeState: {
      path: inspected.worktree?.path ?? null,
      exists: worktreeExists,
      dirty: Boolean(inspected.worktree?.dirty),
      currentDiffStat: diff?.diffStat ?? null,
      currentDiffNameStatus: diff?.diffNameStatus ?? null,
      currentUntracked: diff?.untracked ?? null
    },
    verification: inspected.verification,
    verifyOk: inspected.verifyOk,
    patchExport: {
      patchFile: patchRel,
      exists: patchExists,
      manifestFile: path.relative(root, patchManifestFile),
      manifestExists: patchManifestExists,
      manifest: patchManifest
    },
    patchVerify,
    applyPlan,
    review: {
      reviewFile: reviewRel,
      exists: reviewExists,
      jsonFile: path.relative(root, reviewJsonFile),
      jsonExists: reviewJsonExists,
      json: reviewJson
    },
    cleanup: {
      recommendation: cleanupItem?.recommendation ?? null,
      exists: cleanupItem?.exists ?? worktreeExists,
      patchStatus: cleanupItem?.patchVerify?.status ?? null,
      commands: cleanupItem?.recommendedCommands ?? [],
      skippedReason: cleanupItem ? null : 'not_found_in_cleanup_plan'
    },
    actions,
    errors
  };

  const markdown = renderCodeTaskCloseoutMarkdown(closeout);
  const outputFile = resolveCloseoutOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Closeout artifact already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, markdown);
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, closeout);
  return {
    ...closeout,
    closeoutFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile),
    markdown
  };
}

export async function codeTaskAutoflow(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const until = normalizeAutoflowUntil(options.until ?? 'review');
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const startedAt = new Date().toISOString();
  const idOptions = {
    taskId: options.taskId,
    runId: options.runId,
    limit: options.limit
  };
  const steps = [];
  const errors = [];

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchManifestRel = path.relative(root, `${patchFile}.json`);
  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewJsonRel = path.relative(root, `${reviewFile}.json`);
  const closeoutFile = resolveCloseoutOutputPath(root, normalized, inspected, options.closeout);
  const closeoutRel = path.relative(root, closeoutFile);
  const closeoutJsonRel = path.relative(root, `${closeoutFile}.json`);

  let patchExport = null;
  let patchVerify = null;
  let applyPlan = null;
  let review = null;
  let closeout = null;

  if (stageAtLeast(until, 'export')) {
    try {
      if ((await exists(patchFile)) && (await exists(`${patchFile}.json`)) && !options.force) {
        patchExport = {
          status: 'skipped_exists',
          patchFile: patchRel,
          manifestFile: patchManifestRel
        };
      } else {
        patchExport = await codeWorktreeExport(root, normalized, {
          ...idOptions,
          output: options.patch,
          force: options.force
        });
      }
      steps.push({
        name: 'export',
        status: patchExport.status ?? 'created',
        artifact: patchExport.patchFile,
        sidecar: patchExport.manifestFile
      });
    } catch (err) {
      errors.push(stepError('export', err));
      steps.push({ name: 'export', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'verify') && await exists(patchFile)) {
    try {
      patchVerify = await codePatchVerify(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs
      });
      steps.push({
        name: 'verify',
        status: patchVerify.status,
        ok: patchVerify.ok,
        artifact: patchVerify.patchFile
      });
    } catch (err) {
      errors.push(stepError('verify', err));
      steps.push({ name: 'verify', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'plan') && await exists(patchFile)) {
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
      steps.push({
        name: 'apply-plan',
        status: applyPlan.status,
        ok: applyPlan.ok,
        canApply: applyPlan.canApply,
        artifact: applyPlan.patchFile
      });
    } catch (err) {
      errors.push(stepError('apply-plan', err));
      steps.push({ name: 'apply-plan', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'review')) {
    try {
      if ((await exists(reviewFile)) && (await exists(`${reviewFile}.json`)) && !options.force) {
        review = {
          status: 'skipped_exists',
          reviewFile: reviewRel,
          jsonFile: reviewJsonRel
        };
      } else {
        review = await codeReviewBundle(root, normalized, {
          ...idOptions,
          output: options.review,
          force: options.force,
          timeoutMs: options.timeoutMs,
          allowDirty: options.allowDirty
        });
      }
      steps.push({
        name: 'review',
        status: review.status ?? 'created',
        artifact: review.reviewFile,
        sidecar: review.jsonFile
      });
    } catch (err) {
      errors.push(stepError('review', err));
      steps.push({ name: 'review', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'closeout')) {
    try {
      if ((await exists(closeoutFile)) && (await exists(`${closeoutFile}.json`)) && !options.force) {
        closeout = {
          closeoutStatus: 'skipped_exists',
          closeoutFile: closeoutRel,
          jsonFile: closeoutJsonRel
        };
      } else {
        closeout = await codeTaskCloseout(root, normalized, {
          ...idOptions,
          config: options.config,
          output: options.closeout,
          force: options.force,
          timeoutMs: options.timeoutMs,
          allowDirty: options.allowDirty
        });
      }
      steps.push({
        name: 'closeout',
        status: closeout.closeoutStatus ?? closeout.status ?? 'created',
        artifact: closeout.closeoutFile,
        sidecar: closeout.jsonFile
      });
    } catch (err) {
      errors.push(stepError('closeout', err));
      steps.push({ name: 'closeout', status: 'error' });
    }
  }

  return {
    version: 1,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    sourceRunFile: inspected.file,
    startedAt,
    finishedAt: new Date().toISOString(),
    until,
    ok: errors.length === 0,
    status: errors.length === 0 ? 'completed' : 'needs_attention',
    safety: {
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    },
    artifacts: {
      patchFile: patchRel,
      patchManifestFile: patchManifestRel,
      reviewFile: reviewRel,
      reviewJsonFile: reviewJsonRel,
      closeoutFile: closeoutRel,
      closeoutJsonFile: closeoutJsonRel
    },
    patchExport,
    patchVerify,
    applyPlan,
    review: review ? stripLargeMarkdown(review) : null,
    closeout: closeout ? stripLargeMarkdown(closeout) : null,
    steps,
    errors
  };
}

export async function codeTaskFinish(root, queue, options = {}) {
  if (!options.confirmApply) {
    throw new Error('code-task-finish requires --confirm-apply.');
  }
  if (!options.confirmCleanup) {
    throw new Error('code-task-finish requires --confirm-cleanup.');
  }
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const startedAt = new Date().toISOString();
  const errors = [];
  const steps = [];

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  const patchManifestExists = await exists(`${patchFile}.json`);
  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(`${reviewFile}.json`);
  const closeoutFile = resolveCloseoutOutputPath(root, normalized, inspected, options.closeout);
  const closeoutRel = path.relative(root, closeoutFile);
  const closeoutExists = await exists(closeoutFile);
  const closeoutJsonExists = await exists(`${closeoutFile}.json`);

  if (!patchExists) errors.push({ step: 'gate', message: `Default patch export is missing: ${patchRel}` });
  if (!patchManifestExists) errors.push({ step: 'gate', message: `Default patch manifest is missing: ${patchRel}.json` });
  if (!reviewExists || !reviewJsonExists) errors.push({ step: 'gate', message: `Review bundle is incomplete: ${reviewRel}` });
  if (!closeoutExists || !closeoutJsonExists) errors.push({ step: 'gate', message: `Closeout artifact is incomplete: ${closeoutRel}` });

  let applyPlan = null;
  if (patchExists) {
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
      steps.push({
        name: 'apply-plan',
        status: applyPlan.status,
        ok: applyPlan.ok,
        canApply: applyPlan.canApply
      });
      if (!applyPlan.canApply) {
        errors.push({ step: 'apply-plan', message: `Patch is not ready to apply: ${applyPlan.status}` });
      }
    } catch (err) {
      errors.push(stepError('apply-plan', err));
      steps.push({ name: 'apply-plan', status: 'error' });
    }
  }

  let cleanupItem = null;
  let cleanupGateResult = null;
  try {
    const cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(options.limit ?? 50, 100)
    });
    cleanupItem = cleanupPlan.worktrees.find((item) => {
      if (inspected.taskId && item.taskId === inspected.taskId) return true;
      if (inspected.runId && item.runId === inspected.runId) return true;
      return false;
    }) ?? null;
    if (!cleanupItem) {
      errors.push({ step: 'cleanup-gate', message: 'Task was not found in cleanup plan.' });
      cleanupGateResult = { ok: false, reason: 'not_found_in_cleanup_plan' };
    } else {
      cleanupGateResult = await cleanupGate(root, normalized, cleanupItem);
      steps.push({
        name: 'cleanup-gate',
        status: cleanupGateResult.ok ? 'ready' : 'blocked',
        ok: cleanupGateResult.ok,
        reason: cleanupGateResult.reason
      });
      if (!cleanupGateResult.ok) {
        errors.push({ step: 'cleanup-gate', message: cleanupGateResult.reason });
      }
    }
  } catch (err) {
    errors.push(stepError('cleanup-gate', err));
    steps.push({ name: 'cleanup-gate', status: 'error' });
  }

  let patchApply = null;
  let cleanup = null;
  if (errors.length === 0) {
    patchApply = await codePatchApply(root, {
      patch: patchRel,
      timeoutMs: options.timeoutMs,
      allowDirty: options.allowDirty,
      confirmApply: true
    });
    steps.push({
      name: 'apply',
      status: patchApply.status,
      ok: patchApply.ok,
      applied: patchApply.applied
    });
    if (!patchApply.applied) {
      errors.push({ step: 'apply', message: `Patch was not applied: ${patchApply.status}` });
    }
  }

  if (errors.length === 0 && cleanupItem) {
    const full = resolveWorktreePath(root, cleanupItem.worktree.path);
    const forceFlag = cleanupItem.worktree?.dirty ? ' --force' : '';
    const remove = await runCommand(`git worktree remove${forceFlag} ${shellQuote(full)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 120000
    });
    cleanup = {
      worktree: cleanupItem.worktree?.path ?? null,
      branch: cleanupItem.worktree?.branch ?? null,
      recommendation: cleanupItem.recommendation,
      removed: remove.exitCode === 0,
      remove: compactCommandResult(remove)
    };
    steps.push({
      name: 'cleanup',
      status: cleanup.removed ? 'removed' : 'remove_failed',
      ok: cleanup.removed
    });
    if (!cleanup.removed) {
      errors.push({ step: 'cleanup', message: 'git worktree remove failed' });
    }
  }

  const finish = {
    version: 1,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    sourceRunFile: inspected.file,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: errors.length === 0 ? 'finished' : 'needs_attention',
    ok: errors.length === 0,
    artifacts: {
      patchFile: patchRel,
      patchManifestFile: `${patchRel}.json`,
      reviewFile: reviewRel,
      reviewJsonFile: `${reviewRel}.json`,
      closeoutFile: closeoutRel,
      closeoutJsonFile: `${closeoutRel}.json`
    },
    gates: {
      patchExists,
      patchManifestExists,
      reviewExists,
      reviewJsonExists,
      closeoutExists,
      closeoutJsonExists,
      applyPlan,
      cleanupGate: cleanupGateResult
    },
    patchApply,
    cleanup,
    steps,
    errors,
    safety: {
      requiredConfirmApply: true,
      requiredConfirmCleanup: true,
      appliedPatch: Boolean(patchApply?.applied),
      cleanedWorktree: Boolean(cleanup?.removed),
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false,
      deletedBranch: false
    }
  };

  const outputFile = resolveFinishOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Finish artifact already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, renderCodeTaskFinishMarkdown(finish));
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, finish);
  return {
    ...finish,
    finishFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile)
  };
}

export async function codeTaskRun(root, queue, options = {}) {
  if (!options.confirmApply) {
    throw new Error('code-task-run requires --confirm-apply.');
  }
  if (!options.confirmCleanup) {
    throw new Error('code-task-run requires --confirm-cleanup.');
  }
  const normalized = normalizeLoopId(queue);
  const startedAt = new Date().toISOString();
  const errors = [];
  const steps = [];
  const progress = createProgressRecorder(options.onProgress);
  progress.emit('code-task-run', 'starting', `Starting code task run for queue ${normalized}`, {
    queue: normalized,
    title: options.title ?? null
  });

  const enqueued = await enqueueTask(root, {
    queue: normalized,
    title: options.title,
    task: options.task,
    file: options.file
  });
  const taskId = enqueued.task.id;
  progress.emit('enqueue', 'queued', `Queued task ${taskId}`, {
    taskId,
    artifact: enqueued.file
  });
  steps.push({
    name: 'enqueue',
    status: 'queued',
    ok: true,
    artifact: enqueued.file
  });

  let queueRun = null;
  try {
    queueRun = await runQueueOnce(root, {
      ...options.config,
      queue: normalized,
      timeoutMs: options.timeoutMs ?? options.config?.timeoutMs,
      leaseMs: options.config?.leaseMs,
      staleActiveMs: options.config?.staleActiveMs,
      retry: options.config?.retry,
      dispatcher: options.config?.dispatcher,
      preflightConfig: options.config?.preflightConfig,
      notifyCommand: options.config?.notifyCommand,
      worktree: options.config?.worktree,
      onProgress: (event) => progress.emit(event.phase, event.status, event.message, {
        ...event,
        source: 'run-queue'
      })
    });
    steps.push({
      name: 'run-queue',
      status: queueRun.status,
      ok: queueRun.processed && queueRun.status === 'completed',
      artifact: queueRun.runPath ?? null
    });
    if (!queueRun.processed || queueRun.status !== 'completed') {
      errors.push({
        step: 'run-queue',
        message: `Queue run did not complete successfully: ${queueRun.status}`
      });
    }
  } catch (err) {
    errors.push(stepError('run-queue', err));
    steps.push({ name: 'run-queue', status: 'error', ok: false });
  }

  let autoflow = null;
  if (errors.length === 0) {
    try {
      progress.emit('autoflow', 'running', `Preparing review artifacts for task ${taskId}`, {
        taskId,
        until: 'closeout'
      });
      autoflow = await codeTaskAutoflow(root, normalized, {
        config: options.config,
        taskId,
        until: 'closeout',
        force: options.force,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
      steps.push({
        name: 'autoflow',
        status: autoflow.status,
        ok: autoflow.ok,
        artifacts: autoflow.artifacts
      });
      if (!autoflow.ok) {
        errors.push({ step: 'autoflow', message: `Autoflow did not complete successfully: ${autoflow.status}` });
      }
      progress.emit('autoflow', autoflow.ok ? 'passed' : 'failed', `Autoflow finished ${autoflow.status}`, {
        taskId,
        status: autoflow.status,
        artifacts: autoflow.artifacts
      });
    } catch (err) {
      errors.push(stepError('autoflow', err));
      steps.push({ name: 'autoflow', status: 'error', ok: false });
      progress.emit('autoflow', 'failed', err instanceof Error ? err.message : String(err), {
        taskId
      });
    }
  }

  let finish = null;
  if (errors.length === 0) {
    try {
      progress.emit('finish', 'running', `Applying reviewed patch and cleaning task ${taskId}`, {
        taskId
      });
      finish = await codeTaskFinish(root, normalized, {
        config: options.config,
        taskId,
        force: options.force,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty,
        confirmApply: true,
        confirmCleanup: true
      });
      steps.push({
        name: 'finish',
        status: finish.status,
        ok: finish.ok,
        artifact: finish.finishFile
      });
      if (!finish.ok) {
        errors.push({ step: 'finish', message: `Finish did not complete successfully: ${finish.status}` });
      }
      progress.emit('finish', finish.ok ? 'passed' : 'failed', `Finish completed ${finish.status}`, {
        taskId,
        status: finish.status,
        artifact: finish.finishFile
      });
    } catch (err) {
      errors.push(stepError('finish', err));
      steps.push({ name: 'finish', status: 'error', ok: false });
      progress.emit('finish', 'failed', err instanceof Error ? err.message : String(err), {
        taskId
      });
    }
  }

  const verifyCommands = options.config?.worktree?.verifyCommands ?? [];
  const finalVerification = {
    status: 'skipped',
    ok: true,
    cwd: root,
    commands: []
  };
  if (errors.length === 0 && verifyCommands.length > 0) {
    finalVerification.status = 'running';
    finalVerification.commands = await runVerifyCommands(
      verifyCommands,
      root,
      options.timeoutMs ?? options.config?.timeoutMs,
      progress,
      'final-verification'
    );
    finalVerification.ok = finalVerification.commands.every((entry) => entry.result.exitCode === 0);
    finalVerification.status = finalVerification.ok ? 'passed' : 'failed';
    steps.push({
      name: 'final-verification',
      status: finalVerification.status,
      ok: finalVerification.ok
    });
    if (!finalVerification.ok) {
      errors.push({ step: 'final-verification', message: 'At least one root verification command failed after finish.' });
    }
  } else if (errors.length === 0) {
    progress.emit('final-verification', 'skipped', 'No final verification commands configured', {
      commandCount: 0
    });
    steps.push({
      name: 'final-verification',
      status: 'skipped_no_verify_commands',
      ok: true
    });
  }

  progress.emit('code-task-run', errors.length === 0 ? 'passed' : 'failed', `Code task run ${errors.length === 0 ? 'completed' : 'needs attention'}`, {
    queue: normalized,
    taskId,
    errors: errors.length
  });

  return {
    version: 1,
    queue: normalized,
    taskId,
    title: enqueued.task.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: errors.length === 0 ? 'completed' : 'needs_attention',
    ok: errors.length === 0,
    enqueue: enqueued,
    queueRun: queueRun ? {
      processed: queueRun.processed,
      status: queueRun.status,
      exitCode: queueRun.exitCode,
      taskPath: queueRun.taskPath ?? null,
      runPath: queueRun.runPath ?? null
    } : null,
    autoflow,
    finish: finish ? {
      status: finish.status,
      ok: finish.ok,
      finishFile: finish.finishFile,
      jsonFile: finish.jsonFile,
      patchApplied: Boolean(finish.patchApply?.applied),
      worktreeCleaned: Boolean(finish.cleanup?.removed)
    } : null,
    finalVerification,
    steps,
    errors,
    progress: progress.events,
    safety: {
      requiredConfirmApply: true,
      requiredConfirmCleanup: true,
      appliedPatch: Boolean(finish?.patchApply?.applied),
      cleanedWorktree: Boolean(finish?.cleanup?.removed),
      changedQueueState: true,
      stagedCommittedPushedOrMerged: false,
      deletedBranch: false
    }
  };
}

export async function codeTaskAutoflowBatch(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  if (options.patch || options.review || options.closeout) {
    throw new Error('code-task-autoflow --all-actionable does not support custom output paths.');
  }
  const until = normalizeAutoflowUntil(options.until ?? 'review');
  const status = await codeTaskStatus(root, normalized, {
    config: options.config,
    limit: options.limit ?? 20
  });
  const candidates = status.tasks.filter((task) => taskAutoflowActionable(task, until));
  const results = [];
  for (const task of candidates) {
    try {
      results.push(await codeTaskAutoflow(root, normalized, {
        config: options.config,
        taskId: task.taskId,
        runId: task.taskId ? undefined : task.runId,
        limit: options.lookupLimit,
        until,
        force: options.force,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      }));
    } catch (err) {
      results.push({
        version: 1,
        queue: normalized,
        taskId: task.taskId,
        runId: task.runId,
        title: task.title,
        until,
        ok: false,
        status: 'needs_attention',
        steps: [],
        errors: [stepError('autoflow', err)]
      });
    }
  }
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    until,
    inspectedTasks: status.tasks.length,
    candidateTasks: candidates.length,
    ok: results.every((result) => result.ok),
    status: results.every((result) => result.ok) ? 'completed' : 'needs_attention',
    counts,
    safety: {
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    },
    skipped: status.tasks
      .filter((task) => !candidates.includes(task))
      .map((task) => ({
        taskId: task.taskId,
        runId: task.runId,
        overallStatus: task.overallStatus,
        reason: 'not_actionable_for_autoflow'
      })),
    results
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function countBy(items, fn) {
  const counts = {};
  for (const item of items) {
    const key = fn(item) ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function metricsRecommendation(metrics) {
  const recommendations = [];
  const failureRate = metrics.inspected_runs > 0 ? metrics.failed_runs / metrics.inspected_runs : 0;
  if (failureRate >= 0.25) {
    recommendations.push('Failure rate is high; inspect common failure signatures and add preflight or acceptance checks before dispatch.');
  }
  if ((metrics.final_judgement_counts.needs_revision ?? 0) > 0) {
    recommendations.push('Revision demand is present; consider stronger task-specific rubrics or multi-critic acceptance before final judgement.');
  }
  if ((metrics.final_judgement_counts.blocked ?? 0) > 0 || metrics.human_gate.blocked_or_required > 0) {
    recommendations.push('Human gates or blockers are recurring; make blocker patterns explicit in retry.requiresHumanActionPatterns.');
  }
  if (metrics.duration_ms.p95 !== null && metrics.duration_ms.p95 > 10 * 60 * 1000) {
    recommendations.push('P95 duration is high; consider splitting the task, parallelizing independent checks, or narrowing verification commands.');
  }
  if (recommendations.length === 0) {
    recommendations.push('No obvious workflow optimization pressure found in the inspected window.');
  }
  return recommendations;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hasRetryHumanPatterns(config) {
  return Array.isArray(config.retry?.requiresHumanActionPatterns) && config.retry.requiresHumanActionPatterns.length > 0;
}

function hasConfiguredAcceptanceCritics(config) {
  return Array.isArray(config.acceptanceCritics) && config.acceptanceCritics.length > 0;
}

function stripQueueConfigRuntimeFields(config) {
  const copy = cloneJson(config) ?? {};
  delete copy.configPath;
  return copy;
}

function defaultHumanActionPatternsFromMetrics(metrics) {
  const signatures = metrics.common_failure_signatures.map((item) => item.signature).join('\n').toLowerCase();
  const patterns = [];
  if (/permission|authorize|approval|confirm|user restricted|install_failed_user_restricted/.test(signatures)) {
    patterns.push('permission denied', 'authorization required', 'INSTALL_FAILED_USER_RESTRICTED');
  }
  if (/credential|token|login|oauth|secret/.test(signatures)) {
    patterns.push('credential required', 'login required', 'token expired', 'oauth required');
  }
  if (/production|deploy|publish|external/.test(signatures)) {
    patterns.push('production change requires approval', 'external write requires confirmation');
  }
  if (patterns.length === 0) {
    patterns.push('requires human action', 'manual approval required', 'permission prompt');
  }
  return Array.from(new Set(patterns));
}

function buildWorkflowTuningActions(metrics, config) {
  const actions = [];
  const overlay = {};
  const failureRate = metrics.inspected_runs > 0 ? metrics.failed_runs / metrics.inspected_runs : 0;
  const revisionCount = metrics.final_judgement_counts.needs_revision ?? 0;
  const blockedCount = metrics.final_judgement_counts.blocked ?? 0;

  if (config.revisionPolicy === undefined) {
    overlay.revisionPolicy = {
      enabled: true,
      maxRevisionRounds: 3,
      sameFailureThreshold: 2,
      requireStrategyChange: true,
      strategyChangeFailureThreshold: 2
    };
    actions.push({
      id: 'add_revision_policy',
      priority: 'high',
      category: 'planning_loop',
      reason: 'Queue has no explicit revisionPolicy; repeated revision rounds need a stop rule.',
      recommendation: 'Add a conservative revisionPolicy with max rounds, same-failure threshold, and required strategy change.',
      config_overlay: { revisionPolicy: overlay.revisionPolicy },
      requires_human_review: true
    });
  }

  if ((blockedCount > 0 || metrics.human_gate.blocked_or_required > 0) && !hasRetryHumanPatterns(config)) {
    overlay.retry = {
      ...(cloneJson(config.retry) ?? {}),
      requiresHumanActionPatterns: defaultHumanActionPatternsFromMetrics(metrics)
    };
    actions.push({
      id: 'add_human_action_blocker_patterns',
      priority: 'high',
      category: 'safety_loop',
      reason: 'Recent runs reached blocked or human-review outcomes, but retry.requiresHumanActionPatterns is not explicit.',
      recommendation: 'Add blocker patterns so permission prompts and approval waits stop instead of retrying.',
      config_overlay: { retry: overlay.retry },
      requires_human_review: true
    });
  }

  if (failureRate >= 0.25) {
    actions.push({
      id: 'harden_preflight_or_acceptance',
      priority: 'medium',
      category: 'quality_loop',
      reason: `Failure rate is ${Math.round(failureRate * 100)}% in the inspected window.`,
      recommendation: 'Inspect common failure signatures and add task-specific preflight checks or acceptance rubric items before dispatch.',
      evidence: metrics.common_failure_signatures.slice(0, 5),
      requires_human_review: true
    });
  }

  if (revisionCount > 0) {
    if (!hasConfiguredAcceptanceCritics(config)) {
      overlay.acceptanceCritics = [
        {
          id: 'artifact_traceability',
          focus: 'Tasks that need revision must leave enough evidence for review, replay, and handoff.',
          requiredEvidence: ['summary', 'verification', 'files_changed'],
          failureStatus: 'revise'
        }
      ];
    }
    actions.push({
      id: 'strengthen_critics_for_revision_pressure',
      priority: 'medium',
      category: 'quality_loop',
      reason: `${revisionCount} recent final judgement(s) requested revision.`,
      recommendation: 'Add domain-specific rubric language or model/tool-backed critics for tasks that pass generic checks but miss intent.',
      config_overlay: overlay.acceptanceCritics ? { acceptanceCritics: overlay.acceptanceCritics } : undefined,
      requires_human_review: true
    });
  }

  if (metrics.duration_ms.p95 !== null && metrics.duration_ms.p95 > 10 * 60 * 1000) {
    actions.push({
      id: 'reduce_or_parallelize_slow_steps',
      priority: 'medium',
      category: 'system_optimization_loop',
      reason: `P95 run duration is ${metrics.duration_ms.p95}ms.`,
      recommendation: 'Split broad tasks, parallelize independent verification commands, or narrow slow checks into targeted acceptance gates.',
      requires_human_review: true
    });
  }

  if (actions.length === 0) {
    actions.push({
      id: 'keep_current_workflow',
      priority: 'low',
      category: 'system_optimization_loop',
      reason: 'No strong optimization pressure was found in the inspected window.',
      recommendation: 'Keep the current queue configuration and rerun metrics after more tasks complete.',
      requires_human_review: false
    });
  }

  return { actions, overlay };
}

export async function workflowMetrics(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 100;
  const entries = (await recentRuns(root, normalized, { limit }))
    .filter((entry) => entry.run?.queue === normalized || entry.run?.loopId === normalized);
  const runs = entries.map((entry) => entry.run);
  const durations = runs
    .map((run) => Number.isFinite(run.durationMs)
      ? run.durationMs
      : Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? ''))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const failedRuns = runs.filter((run) => isFailureRun(run));
  const finalJudgements = runs.map((run) => run.finalJudgement?.outcome).filter(Boolean);
  const revisionRequests = runs.filter((run) => run.revisionRequest).length;
  const verificationCommands = runs.flatMap((run) => run.verification ?? []);
  const verificationFailures = verificationCommands.filter((item) => item.result?.exitCode !== 0).length;
  const progressPhaseCounts = {};
  for (const run of runs) {
    for (const event of run.progress ?? []) {
      progressPhaseCounts[event.phase] = (progressPhaseCounts[event.phase] ?? 0) + 1;
    }
  }
  const metrics = {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    inspected_runs: runs.length,
    failed_runs: failedRuns.length,
    status_counts: countBy(runs, (run) => run.status ?? run.outcome),
    final_judgement_counts: countBy(finalJudgements, (item) => item),
    duration_ms: {
      average: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length ? Math.max(...durations) : null
    },
    verification: {
      commands: verificationCommands.length,
      failures: verificationFailures
    },
    revision: {
      requests: revisionRequests,
      runs_with_revision_round: runs.filter((run) => Number.isInteger(run.revisionRound) && run.revisionRound > 0).length
    },
    human_gate: {
      required: runs.filter((run) => run.finalJudgement?.requiresHumanGate === true || run.taskContract?.requiresHumanGate === true).length,
      blocked_or_required: runs.filter((run) => ['ready_for_human_review', 'blocked'].includes(run.finalJudgement?.outcome)).length
    },
    common_failure_signatures: Object.entries(countBy(failedRuns, (run) => run.failureSignature ?? run.dispatchFailureClassification?.reason ?? run.finalJudgement?.reasons?.[0] ?? run.status ?? run.outcome))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([signature, count]) => ({ signature, count })),
    progress_phase_counts: progressPhaseCounts,
    recommendations: []
  };
  metrics.recommendations = metricsRecommendation(metrics);
  return metrics;
}

export async function workflowTuningPlan(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const loadedConfig = options.config ? cloneJson(options.config) : {};
  const config = stripQueueConfigRuntimeFields(loadedConfig);
  const metrics = await workflowMetrics(root, normalized, { limit: options.limit ?? 100 });
  const { actions, overlay } = buildWorkflowTuningActions(metrics, config);
  const proposedConfig = {
    ...cloneJson(config),
    ...overlay
  };
  if (overlay.retry && config.retry) {
    proposedConfig.retry = {
      ...cloneJson(config.retry),
      ...overlay.retry
    };
  }
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    mode: 'read_only_plan',
    config_path: loadedConfig.configPath ?? null,
    inspected_runs: metrics.inspected_runs,
    metrics,
    actions,
    config_overlay: overlay,
    proposed_config: proposedConfig,
    apply_instructions: [
      'Review this plan and the cited run artifacts before editing queue configuration.',
      'Apply only the config_overlay fields that match the operator decision.',
      'Run loop-engineering doctor and workflow-metrics again after changing configuration.'
    ]
  };
}

export async function codeTaskStatus(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const entries = (await recentRuns(root, normalized, { limit: Math.max(limit, 100) }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree)
    .reverse()
    .filter((entry) => {
      if (options.runId && entry.run.runId !== options.runId) return false;
      if (options.taskId && entry.run.taskId !== options.taskId) return false;
      return true;
    })
    .slice(0, limit);

  let cleanupPlan = null;
  let cleanupError = null;
  try {
    cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(limit, 100)
    });
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : String(err);
  }

  const tasks = [];
  for (const entry of entries) {
    const summary = codeWorktreeSummary(entry);
    const cleanupItem = cleanupPlan?.worktrees.find((item) => {
      if (summary.taskId && item.taskId === summary.taskId) return true;
      if (summary.runId && item.runId === summary.runId) return true;
      return false;
    }) ?? null;
    tasks.push(await codeTaskLedgerItem(root, normalized, summary, cleanupItem));
  }

  const counts = {};
  for (const task of tasks) counts[task.overallStatus] = (counts[task.overallStatus] ?? 0) + 1;
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    inspectedRuns: entries.length,
    cleanupPlanError: cleanupError,
    counts,
    tasks
  };
}

export async function codeTaskDashboard(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const [queueSummary, taskStatus, cleanupPlan] = await Promise.all([
    queueStatus(root, normalized),
    codeTaskStatus(root, normalized, {
      config: options.config,
      limit
    }),
    codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(limit, 50)
    })
  ]);

  const buckets = {
    needsPatchExport: [],
    needsReview: [],
    needsCloseout: [],
    readyToFinish: [],
    needsCleanup: [],
    blocked: [],
    ready: [],
    closed: [],
    landed: []
  };
  const actionCounts = {
    patchExport: 0,
    reviewBundle: 0,
    closeout: 0,
    finish: 0,
    cleanup: 0,
    manualReview: 0
  };

  for (const task of taskStatus.tasks) {
    const compact = compactDashboardTask(task);
    if (task.overallStatus === 'needs_patch_export') buckets.needsPatchExport.push(compact);
    else if (task.overallStatus === 'needs_review') buckets.needsReview.push(compact);
    else if (task.overallStatus === 'needs_closeout') buckets.needsCloseout.push(compact);
    else if (task.overallStatus === 'ready_to_finish') buckets.readyToFinish.push(compact);
    else if (task.overallStatus === 'needs_cleanup') buckets.needsCleanup.push(compact);
    else if (String(task.overallStatus ?? '').startsWith('blocked_')) buckets.blocked.push(compact);
    else if (task.overallStatus === 'landed') buckets.landed.push(compact);
    else if (task.overallStatus === 'closed') buckets.closed.push(compact);
    else buckets.ready.push(compact);

    for (const action of task.nextActions ?? []) {
      if (action.includes('code-worktree-export')) actionCounts.patchExport += 1;
      else if (action.includes('code-review-bundle')) actionCounts.reviewBundle += 1;
      else if (action.includes('code-task-closeout')) actionCounts.closeout += 1;
      else if (action.includes('code-task-finish')) actionCounts.finish += 1;
      else if (action.includes('code-worktree-cleanup')) actionCounts.cleanup += 1;
      else actionCounts.manualReview += 1;
    }
  }

  const priority = [
    ...buckets.blocked,
    ...buckets.needsPatchExport,
    ...buckets.needsReview,
    ...buckets.needsCloseout,
    ...buckets.readyToFinish,
    ...buckets.needsCleanup
  ];
  const recommendedCommands = [];
  if (buckets.needsPatchExport.length > 0 || buckets.needsReview.length > 0) {
    recommendedCommands.push(`loop-engineering code-task-autoflow --queue ${normalized} --all-actionable`);
  }
  if (buckets.needsCloseout.length > 0) {
    recommendedCommands.push(`loop-engineering code-task-autoflow --queue ${normalized} --all-actionable --until closeout`);
  }
  if (buckets.readyToFinish.length > 0) {
    recommendedCommands.push('Review ready_to_finish tasks individually, then run code-task-finish with --confirm-apply --confirm-cleanup for one task at a time.');
  }
  if (buckets.needsCleanup.length > 0 || cleanupPlan.orphanWorktrees.length > 0) {
    recommendedCommands.push(`loop-engineering code-worktree-cleanup-plan --queue ${normalized}`);
  }

  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    queueSummary,
    taskSummary: {
      inspectedRuns: taskStatus.inspectedRuns,
      counts: taskStatus.counts,
      cleanupPlanError: taskStatus.cleanupPlanError
    },
    actionCounts,
    cleanupSummary: {
      cleanupCandidates: cleanupPlan.cleanupCandidates.length,
      unexportedDirty: cleanupPlan.unexportedDirty.length,
      rejectedPatches: cleanupPlan.rejectedPatches.length,
      missingWorktrees: cleanupPlan.missingWorktrees.length,
      orphanWorktrees: cleanupPlan.orphanWorktrees.length
    },
    buckets,
    priority,
    recommendedCommands,
    safety: {
      readOnly: true,
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    }
  };
}

export async function codeWorktreeCleanupPlan(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 50;
  const allEntries = (await recentRuns(root, normalized, { limit: Math.max(limit, 1000) }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree)
    .reverse();
  const entries = allEntries.slice(0, limit);
  const worktrees = [];
  const referencedRelPaths = new Set();
  for (const entry of allEntries) {
    try {
      referencedRelPaths.add(path.relative(root, resolveWorktreePath(root, entry.run.worktree?.path)));
    } catch {
      // Unsafe recorded paths are reported on inspected entries; they should not
      // suppress orphan detection for real directories.
    }
  }
  for (const entry of entries) {
    const summary = codeWorktreeSummary(entry);
    const recordedPath = entry.run.worktree?.path ?? null;
    const item = {
      file: entry.file,
      runId: summary.runId,
      taskId: summary.taskId,
      title: summary.title,
      status: summary.status,
      finishedAt: summary.finishedAt,
      worktree: summary.worktree,
      exists: false,
      pathSafe: false,
      exportedPatchFile: null,
      exportedManifestFile: null,
      patchVerify: null,
      recommendation: 'inspect',
      recommendedCommands: []
    };
    try {
      const full = resolveWorktreePath(root, recordedPath);
      const rel = path.relative(root, full);
      item.pathSafe = true;
      item.exists = await exists(full);
    } catch (err) {
      item.recommendation = 'unsafe_path';
      item.pathError = err instanceof Error ? err.message : String(err);
      worktrees.push(item);
      continue;
    }

    const patchFile = resolvePatchOutputPath(root, normalized, summary, null);
    const manifestFile = `${patchFile}.json`;
    if (await exists(patchFile)) item.exportedPatchFile = path.relative(root, patchFile);
    if (await exists(manifestFile)) item.exportedManifestFile = path.relative(root, manifestFile);
    if (item.exportedPatchFile) {
      try {
        item.patchVerify = await codePatchVerify(root, { patch: item.exportedPatchFile });
      } catch (err) {
        item.patchVerify = {
          status: 'error',
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    if (!item.exists) {
      item.recommendation = 'missing_worktree';
    } else if (summary.worktree?.dirty && !item.exportedPatchFile) {
      item.recommendation = 'export_before_cleanup';
      item.recommendedCommands.push(`loop-engineering code-worktree-export --root ${shellQuote(root)} --queue ${normalized} --task-id ${summary.taskId}`);
    } else if (summary.worktree?.dirty && item.patchVerify?.ok) {
      item.recommendation = 'review_then_cleanup';
      item.recommendedCommands.push(`git -C ${shellQuote(root)} worktree remove --force ${shellQuote(resolveWorktreePath(root, recordedPath))}`);
    } else if (summary.worktree?.dirty && item.patchVerify && !item.patchVerify.ok) {
      item.recommendation = 'patch_rejected_review_worktree';
    } else {
      item.recommendation = 'cleanup_candidate';
      item.recommendedCommands.push(`git -C ${shellQuote(root)} worktree remove ${shellQuote(resolveWorktreePath(root, recordedPath))}`);
    }
    worktrees.push(item);
  }

  const orphanWorktrees = await listOrphanWorktrees(root, normalized, options.config, referencedRelPaths);
  const missingWorktrees = worktrees
    .filter((item) => item.recommendation === 'missing_worktree')
    .map(compactCleanupItem);
  const unexportedDirty = worktrees
    .filter((item) => item.recommendation === 'export_before_cleanup')
    .map(compactCleanupItem);
  const rejectedPatches = worktrees
    .filter((item) => item.recommendation === 'patch_rejected_review_worktree')
    .map(compactCleanupItem);
  const cleanupCandidates = worktrees
    .filter((item) => ['cleanup_candidate', 'review_then_cleanup'].includes(item.recommendation))
    .map(compactCleanupItem);
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    inspectedRuns: entries.length,
    cleanupCandidates,
    missingWorktrees,
    unexportedDirty,
    rejectedPatches,
    orphanWorktrees,
    worktrees
  };
}

function compactDashboardTask(task) {
  return {
    taskId: task.taskId,
    runId: task.runId,
    title: task.title,
    overallStatus: task.overallStatus,
    taskState: task.taskState,
    finishedAt: task.finishedAt,
    verifyOk: task.verifyOk,
    worktree: {
      exists: task.worktree?.exists ?? false,
      dirty: task.worktree?.dirty ?? false,
      path: task.worktree?.path ?? null
    },
    patch: {
      exists: task.patch?.exists ?? false,
      verifyStatus: task.patch?.verifyStatus ?? null
    },
    review: {
      exists: task.review?.exists ?? false
    },
    closeout: {
      exists: task.closeout?.exists ?? false,
      status: task.closeout?.status ?? null
    },
    finish: {
      exists: task.finish?.exists ?? false,
      status: task.finish?.status ?? null
    },
    cleanup: {
      recommendation: task.cleanup?.recommendation ?? null
    },
    nextActions: task.nextActions ?? []
  };
}

export async function codeWorktreeCleanup(root, queue, options = {}) {
  if (!options.confirmCleanup) {
    throw new Error('code-worktree-cleanup requires --confirm-cleanup.');
  }
  const normalized = normalizeLoopId(queue);
  const plan = await codeWorktreeCleanupPlan(root, normalized, options);
  const removedWorktrees = [];
  const removedOrphans = [];
  const skipped = [];

  for (const item of plan.worktrees) {
    const gate = await cleanupGate(root, normalized, item);
    if (!gate.ok) {
      skipped.push({
        taskId: item.taskId,
        runId: item.runId,
        worktree: item.worktree?.path ?? null,
        recommendation: item.recommendation,
        reason: gate.reason
      });
      continue;
    }
    const full = resolveWorktreePath(root, item.worktree.path);
    const forceFlag = item.worktree?.dirty ? ' --force' : '';
    const remove = await runCommand(`git worktree remove${forceFlag} ${shellQuote(full)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 120000
    });
    const removed = remove.exitCode === 0;
    if (!removed) {
      skipped.push({
        taskId: item.taskId,
        runId: item.runId,
        worktree: item.worktree?.path ?? null,
        recommendation: item.recommendation,
        reason: 'git_worktree_remove_failed',
        remove: compactCommandResult(remove)
      });
      continue;
    }
    removedWorktrees.push({
      taskId: item.taskId,
      runId: item.runId,
      worktree: item.worktree?.path ?? null,
      branch: item.worktree?.branch ?? null,
      recommendation: item.recommendation,
      remove: compactCommandResult(remove)
    });
  }

  if (options.includeOrphans) {
    for (const orphan of plan.orphanWorktrees) {
      const full = path.join(root, safeRelativePath(orphan.path, 'orphan worktree path'));
      const remove = await runCommand(`git worktree remove ${shellQuote(full)}`, {
        cwd: root,
        timeoutMs: options.timeoutMs ?? 120000
      });
      if (remove.exitCode === 0) {
        removedOrphans.push({
          path: orphan.path,
          remove: compactCommandResult(remove)
        });
      } else {
        skipped.push({
          path: orphan.path,
          recommendation: 'orphan_worktree',
          reason: 'git_worktree_remove_failed',
          remove: compactCommandResult(remove)
        });
      }
    }
  } else {
    for (const orphan of plan.orphanWorktrees) {
      skipped.push({
        path: orphan.path,
        recommendation: 'orphan_worktree',
        reason: 'include_orphans_not_set'
      });
    }
  }

  const failedSkips = skipped.filter((item) => item.reason === 'git_worktree_remove_failed');
  return {
    version: 1,
    queue: normalized,
    cleanedAt: new Date().toISOString(),
    status: failedSkips.length > 0 ? 'partial' : 'completed',
    ok: failedSkips.length === 0,
    planGeneratedAt: plan.generatedAt,
    removedWorktrees,
    removedOrphans,
    skipped
  };
}

async function cleanupGate(root, queue, item) {
  if (!['cleanup_candidate', 'review_then_cleanup'].includes(item.recommendation)) {
    return { ok: false, reason: `not_cleanup_candidate:${item.recommendation}` };
  }
  if (!item.exists) return { ok: false, reason: 'worktree_missing' };
  if (!item.pathSafe) return { ok: false, reason: 'unsafe_worktree_path' };
  if (!item.worktree?.path) return { ok: false, reason: 'missing_worktree_path' };
  if (item.worktree?.dirty) {
    if (!item.exportedPatchFile) return { ok: false, reason: 'dirty_without_exported_patch' };
    if (!item.patchVerify?.ok) return { ok: false, reason: 'dirty_patch_not_verified' };
    const reviewFile = resolveReviewBundleOutputPath(root, queue, item, null);
    if (!(await exists(reviewFile))) return { ok: false, reason: 'dirty_without_review_bundle' };
    const reviewJson = `${reviewFile}.json`;
    if (!(await exists(reviewJson))) return { ok: false, reason: 'dirty_without_review_json' };
  }
  return { ok: true, reason: null };
}

function compactCleanupItem(item) {
  return {
    taskId: item.taskId,
    runId: item.runId,
    status: item.status,
    worktree: item.worktree?.path ?? null,
    exportedPatchFile: item.exportedPatchFile,
    patchStatus: item.patchVerify?.status ?? null,
    recommendation: item.recommendation,
    commands: item.recommendedCommands
  };
}

async function listOrphanWorktrees(root, queue, config = {}, referencedRelPaths = new Set()) {
  const baseRel = safeRelativePath(config.worktree?.baseDir ?? path.join('runtime', 'loops', queue, 'worktrees'), 'worktree baseDir');
  const baseDir = path.join(root, baseRel);
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const orphans = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(baseDir, entry.name);
      const rel = path.relative(root, full);
      if (!referencedRelPaths.has(rel)) {
        orphans.push({
          path: rel,
          command: `git -C ${shellQuote(root)} worktree remove ${shellQuote(full)}`
        });
      }
    }
    return orphans;
  } catch {
    return [];
  }
}

function extractGitPatch(rawPatch) {
  const lines = rawPatch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('diff --git '));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '# Untracked files from worktree:') {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join('\n').trimEnd()}\n`;
}

async function loadNormalizedPatch(root, patch) {
  const patchFile = path.resolve(root, safeRelativePath(patch, 'patch file'));
  if (!(await exists(patchFile))) {
    throw new Error(`Patch file does not exist: ${path.relative(root, patchFile)}`);
  }
  const rawPatch = await readFile(patchFile, 'utf8');
  const normalizedPatch = extractGitPatch(rawPatch);
  return {
    patchFile,
    rawPatch,
    patch: normalizedPatch,
    diffFiles: diffFilesFromPatch(normalizedPatch)
  };
}

async function runPatchApplyCheck(root, patch, timeoutMs) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'loop-engineering-patch-'));
  const tempPatch = path.join(tempDir, 'review.patch');
  try {
    await writeFile(tempPatch, patch);
    return await runCommand(`git apply --check --binary ${shellQuote(tempPatch)}`, {
      cwd: root,
      timeoutMs
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function diffFilesFromPatch(patch) {
  const files = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.push({ oldPath: match[1], newPath: match[2] });
  }
  return files;
}

function affectedPathsFromDiffFiles(diffFiles) {
  const paths = new Set();
  for (const file of diffFiles) {
    for (const candidate of [file.oldPath, file.newPath]) {
      if (!candidate || candidate === '/dev/null') continue;
      paths.add(candidate);
    }
  }
  return [...paths].sort();
}

async function gitStatusForPaths(root, paths, timeoutMs) {
  const args = paths.map((p) => safeRelativePath(p, 'patch path')).map(shellQuote).join(' ');
  return runCommand(`git status --short -- ${args}`, {
    cwd: root,
    timeoutMs
  });
}

function resolvePatchOutputPath(root, queue, diff, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'patch output'));
  }
  const fileBase = `${sanitizeFileSegment(diff.taskId ?? diff.runId ?? 'worktree')}.patch`;
  return path.join(queueSubdirFor(root, queue, 'patches'), fileBase);
}

function resolveReviewBundleOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'review output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'reviews'), fileBase);
}

function resolveCloseoutOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'closeout output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'closeouts'), fileBase);
}

function resolveFinishOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'finish output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'finishes'), fileBase);
}

function renderCodeReviewBundleMarkdown(bundle) {
  const lines = [];
  lines.push(`# Loop Code Review: ${bundle.title ?? bundle.taskId ?? bundle.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${bundle.queue}\``);
  lines.push(`- Task: \`${bundle.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${bundle.runId ?? 'unknown'}\``);
  lines.push(`- Status: \`${bundle.status ?? 'unknown'}\``);
  lines.push(`- Generated: \`${bundle.generatedAt}\``);
  lines.push(`- Source run: \`${bundle.sourceRunFile ?? 'unknown'}\``);
  if (bundle.taskPath) lines.push(`- Task artifact: \`${bundle.taskPath}\``);
  lines.push('');

  lines.push('## Worktree');
  if (bundle.worktree) {
    lines.push(`- Branch: \`${bundle.worktree.branch ?? 'unknown'}\``);
    lines.push(`- Path: \`${bundle.worktree.path ?? 'unknown'}\``);
    lines.push(`- Dirty: \`${bundle.worktree.dirty ? 'yes' : 'no'}\``);
    if (bundle.worktree.head) lines.push(`- Head: \`${bundle.worktree.head}\``);
  } else {
    lines.push('- None recorded.');
  }
  lines.push('');

  lines.push('## Verification');
  lines.push(`- Overall: \`${bundle.verifyOk ? 'ok' : 'failed'}\``);
  if (bundle.verification?.length) {
    for (const item of bundle.verification) {
      lines.push(`- \`${item.cmd}\`: exit \`${item.exitCode}\`${item.timedOut ? ' (timed out)' : ''}`);
    }
  } else {
    lines.push('- No verification commands recorded.');
  }
  lines.push('');

  lines.push('## Patch Export');
  lines.push(`- Patch file: \`${bundle.patchExport.patchFile}\``);
  lines.push(`- Exists: \`${bundle.patchExport.exists ? 'yes' : 'no'}\``);
  if (bundle.patchVerify) {
    lines.push(`- Verify: \`${bundle.patchVerify.status}\` ok=\`${bundle.patchVerify.ok ? 'yes' : 'no'}\``);
  }
  if (bundle.applyPlan) {
    lines.push(`- Apply plan: \`${bundle.applyPlan.status}\` canApply=\`${bundle.applyPlan.canApply ? 'yes' : 'no'}\``);
    if (bundle.applyPlan.dirtyAffected) {
      lines.push('');
      lines.push('Dirty affected files:');
      lines.push('');
      lines.push('```text');
      lines.push(trimTail(bundle.applyPlan.affectedStatus?.stdout ?? '', 4000).trimEnd());
      lines.push('```');
    }
  }
  lines.push('');

  lines.push('## Diff Summary');
  if (bundle.diff?.diffStat) {
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.diffStat.trimEnd());
    lines.push('```');
  } else {
    lines.push('- No diff stat recorded.');
  }
  if (bundle.diff?.diffNameStatus) {
    lines.push('');
    lines.push('Changed files:');
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.diffNameStatus.trimEnd());
    lines.push('```');
  }
  if (bundle.diff?.untracked) {
    lines.push('');
    lines.push('Untracked files:');
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.untracked.trimEnd());
    lines.push('```');
  }
  lines.push('');

  if (bundle.errors.length > 0) {
    lines.push('## Collection Errors');
    for (const error of bundle.errors) {
      lines.push(`- \`${error.step}\`: ${error.message}`);
    }
    lines.push('');
  }

  if (bundle.diff?.patch) {
    lines.push('## Patch');
    lines.push('');
    lines.push('```diff');
    lines.push(bundle.diff.patch.trimEnd());
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function closeoutActions({ inspected, worktreeExists, patchExists, patchVerify, reviewExists, reviewJsonExists, cleanupItem }) {
  const actions = [];
  const dirty = Boolean(inspected.worktree?.dirty);
  if (dirty && !patchExists) {
    actions.push(`Export patch: loop-engineering code-worktree-export --queue ${inspected.queue} --task-id ${inspected.taskId}`);
  }
  if (patchExists && patchVerify && !patchVerify.ok) {
    actions.push('Review rejected patch before applying or cleaning up.');
  }
  if (patchExists && (!reviewExists || !reviewJsonExists)) {
    actions.push(`Generate review bundle: loop-engineering code-review-bundle --queue ${inspected.queue} --task-id ${inspected.taskId}`);
  }
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupItem?.recommendation)) {
    actions.push(`Clean worktree: loop-engineering code-worktree-cleanup --queue ${inspected.queue} --task-id ${inspected.taskId} --confirm-cleanup`);
  }
  if (worktreeExists && cleanupItem?.recommendation === 'export_before_cleanup') {
    actions.push('Export and review the worktree before cleanup.');
  }
  if (worktreeExists && cleanupItem?.recommendation === 'patch_rejected_review_worktree') {
    actions.push('Resolve rejected patch or inspect the worktree manually before cleanup.');
  }
  return actions;
}

function closeoutStatusFor({ errors, actions, worktreeExists, patchExists, patchVerify, reviewExists, reviewJsonExists, cleanupItem }) {
  if (errors.length > 0) return 'needs_attention';
  if (patchExists && patchVerify && !patchVerify.ok) return 'blocked_patch_rejected';
  if (patchExists && (!reviewExists || !reviewJsonExists)) return 'needs_review';
  if (cleanupItem?.recommendation === 'export_before_cleanup') return 'needs_patch_export';
  if (cleanupItem?.recommendation === 'patch_rejected_review_worktree') return 'blocked_patch_rejected';
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupItem?.recommendation)) return 'needs_cleanup';
  if (!worktreeExists || cleanupItem?.recommendation === 'missing_worktree') return actions.length === 0 ? 'closed' : 'closed_with_notes';
  return actions.length === 0 ? 'ready' : 'needs_attention';
}

const AUTOFLOW_STAGES = ['export', 'verify', 'plan', 'review', 'closeout'];

function normalizeAutoflowUntil(value) {
  const normalized = String(value ?? 'review').trim().toLowerCase();
  if (!AUTOFLOW_STAGES.includes(normalized)) {
    throw new Error(`Unsupported autoflow stage: ${value}. Expected one of: ${AUTOFLOW_STAGES.join(', ')}.`);
  }
  return normalized;
}

function stageAtLeast(until, stage) {
  return AUTOFLOW_STAGES.indexOf(until) >= AUTOFLOW_STAGES.indexOf(stage);
}

function stepError(step, err) {
  return {
    step,
    message: err instanceof Error ? err.message : String(err)
  };
}

function stripLargeMarkdown(value) {
  if (!value || typeof value !== 'object') return value;
  const { markdown: _markdown, ...rest } = value;
  return rest;
}

function taskAutoflowActionable(task, until) {
  if (['blocked_patch_rejected', 'closed'].includes(task.overallStatus)) return false;
  const actions = Array.isArray(task.nextActions) ? task.nextActions : [];
  if (actions.some((action) => action.includes('code-worktree-export'))) return true;
  if (actions.some((action) => action.includes('code-review-bundle'))) return true;
  if (stageAtLeast(until, 'closeout') && actions.some((action) => action.includes('code-task-closeout'))) return true;
  return false;
}

async function codeTaskLedgerItem(root, queue, summary, cleanupItem) {
  const taskInfo = summary.taskId
    ? await taskStateFor(root, queue, summary.taskId)
    : { state: null, file: null };
  const patchFile = resolvePatchOutputPath(root, queue, summary, null);
  const patchRel = path.relative(root, patchFile);
  const patchManifestFile = `${patchFile}.json`;
  const patchExists = await exists(patchFile);
  const patchManifestExists = await exists(patchManifestFile);
  const reviewFile = resolveReviewBundleOutputPath(root, queue, summary, null);
  const reviewJsonFile = `${reviewFile}.json`;
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(reviewJsonFile);
  const closeoutFile = resolveCloseoutOutputPath(root, queue, summary, null);
  const closeoutJsonFile = `${closeoutFile}.json`;
  const closeoutExists = await exists(closeoutFile);
  const closeoutJsonExists = await exists(closeoutJsonFile);
  let closeoutJson = null;
  if (closeoutJsonExists) {
    try {
      closeoutJson = await readJson(closeoutJsonFile);
    } catch {
      closeoutJson = { closeoutStatus: 'unreadable' };
    }
  }
  const finishFile = resolveFinishOutputPath(root, queue, summary, null);
  const finishJsonFile = `${finishFile}.json`;
  const finishExists = await exists(finishFile);
  const finishJsonExists = await exists(finishJsonFile);
  let finishJson = null;
  if (finishJsonExists) {
    try {
      finishJson = await readJson(finishJsonFile);
    } catch {
      finishJson = { status: 'unreadable', ok: false };
    }
  }

  const worktreeExists = cleanupItem?.exists ?? await recordedWorktreeExists(root, summary.worktree?.path);
  const patchVerifyStatus = cleanupItem?.patchVerify?.status ?? closeoutJson?.patchVerify?.status ?? null;
  const patchVerifyOk = cleanupItem?.patchVerify?.ok ?? closeoutJson?.patchVerify?.ok ?? null;
  const cleanupRecommendation = cleanupItem?.recommendation ?? (worktreeExists ? 'inspect' : 'missing_worktree');
  const closeoutStatus = closeoutJson?.closeoutStatus ?? null;
  const finishStatus = finishJson?.status ?? null;
  const finishOk = finishJson?.ok ?? null;
  const nextActions = statusNextActions({
    queue,
    summary,
    finishExists,
    finishStatus,
    finishOk,
    worktreeExists,
    patchExists,
    patchVerifyOk,
    reviewExists,
    reviewJsonExists,
    closeoutExists,
    closeoutStatus,
    cleanupRecommendation
  });
  const overallStatus = codeTaskOverallStatus({
    finishExists,
    finishStatus,
    finishOk,
    worktreeExists,
    patchExists,
    patchVerifyOk,
    reviewExists,
    reviewJsonExists,
    closeoutExists,
    closeoutStatus,
    cleanupRecommendation
  });

  return {
    taskId: summary.taskId,
    runId: summary.runId,
    title: summary.title,
    runStatus: summary.status,
    taskState: taskInfo.state,
    taskFile: taskInfo.file,
    sourceRunFile: summary.file,
    finishedAt: summary.finishedAt,
    verifyOk: summary.verifyOk,
    worktree: {
      path: summary.worktree?.path ?? null,
      branch: summary.worktree?.branch ?? null,
      dirty: Boolean(summary.worktree?.dirty),
      exists: Boolean(worktreeExists)
    },
    patch: {
      patchFile: patchRel,
      exists: patchExists,
      manifestFile: path.relative(root, patchManifestFile),
      manifestExists: patchManifestExists,
      verifyStatus: patchVerifyStatus,
      verifyOk: patchVerifyOk
    },
    review: {
      reviewFile: path.relative(root, reviewFile),
      exists: reviewExists,
      jsonFile: path.relative(root, reviewJsonFile),
      jsonExists: reviewJsonExists
    },
    closeout: {
      closeoutFile: path.relative(root, closeoutFile),
      exists: closeoutExists,
      jsonFile: path.relative(root, closeoutJsonFile),
      jsonExists: closeoutJsonExists,
      status: closeoutStatus
    },
    finish: {
      finishFile: path.relative(root, finishFile),
      exists: finishExists,
      jsonFile: path.relative(root, finishJsonFile),
      jsonExists: finishJsonExists,
      status: finishStatus,
      ok: finishOk,
      finishedAt: finishJson?.finishedAt ?? null,
      patchApplied: finishJson?.patchApply?.applied ?? null,
      worktreeCleaned: finishJson?.cleanup?.removed ?? null
    },
    cleanup: {
      recommendation: cleanupRecommendation,
      patchStatus: cleanupItem?.patchVerify?.status ?? null
    },
    overallStatus,
    nextActions
  };
}

async function taskStateFor(root, queue, taskId) {
  const found = await findTaskFile(root, queue, taskId);
  if (!found) return { state: null, file: null };
  return {
    state: found.subdir,
    file: path.relative(root, found.file)
  };
}

async function recordedWorktreeExists(root, recordedPath) {
  try {
    return await exists(resolveWorktreePath(root, recordedPath));
  } catch {
    return false;
  }
}

function codeTaskOverallStatus({ finishExists, finishStatus, finishOk, worktreeExists, patchExists, patchVerifyOk, reviewExists, reviewJsonExists, closeoutExists, closeoutStatus, cleanupRecommendation }) {
  if (finishExists && finishOk === true && finishStatus === 'finished') return 'landed';
  if (finishExists && finishOk === false) return 'blocked_finish_attention';
  if (closeoutStatus === 'closed') return 'closed';
  if (closeoutStatus === 'blocked_patch_rejected') return 'blocked_patch_rejected';
  if (patchExists && patchVerifyOk === false) return 'blocked_patch_rejected';
  if (cleanupRecommendation === 'patch_rejected_review_worktree') return 'blocked_patch_rejected';
  if (cleanupRecommendation === 'export_before_cleanup') return 'needs_patch_export';
  if (patchExists && (!reviewExists || !reviewJsonExists)) return 'needs_review';
  if (patchExists && reviewExists && reviewJsonExists && closeoutExists && worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) return 'ready_to_finish';
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) return 'needs_cleanup';
  if (!closeoutExists) return 'needs_closeout';
  if (!worktreeExists) return closeoutStatus ?? 'closed_with_notes';
  return closeoutStatus ?? 'ready';
}

function statusNextActions({ queue, summary, finishExists, finishStatus, finishOk, worktreeExists, patchExists, patchVerifyOk, reviewExists, reviewJsonExists, closeoutExists, closeoutStatus, cleanupRecommendation }) {
  const id = summary.taskId ? `--task-id ${summary.taskId}` : `--run-id ${summary.runId}`;
  const actions = [];
  if (finishExists && finishOk === true && finishStatus === 'finished') return actions;
  if (finishExists && finishOk === false) {
    actions.push('Inspect the finish artifact; previous finish attempt needs attention.');
    return actions;
  }
  if (cleanupRecommendation === 'export_before_cleanup') {
    actions.push(`loop-engineering code-worktree-export --queue ${queue} ${id}`);
  }
  if (patchExists && patchVerifyOk === false) {
    actions.push('Inspect the worktree or exported patch; current patch verification is rejected.');
  }
  if (patchExists && (!reviewExists || !reviewJsonExists)) {
    actions.push(`loop-engineering code-review-bundle --queue ${queue} ${id}`);
  }
  const canFinish = patchExists && reviewExists && reviewJsonExists && closeoutExists && worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation);
  if (!closeoutExists) {
    actions.push(`loop-engineering code-task-closeout --queue ${queue} ${id}`);
  } else if (!canFinish && closeoutStatus !== 'closed') {
    const force = closeoutExists ? ' --force' : '';
    actions.push(`loop-engineering code-task-closeout --queue ${queue} ${id}${force}`);
  }
  if (canFinish) {
    actions.push(`loop-engineering code-task-finish --queue ${queue} ${id} --confirm-apply --confirm-cleanup`);
    return actions;
  }
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) {
    actions.push(`loop-engineering code-worktree-cleanup --queue ${queue} --confirm-cleanup`);
  }
  return actions;
}

function renderCodeTaskCloseoutMarkdown(closeout) {
  const lines = [];
  lines.push(`# Loop Code Task Closeout: ${closeout.title ?? closeout.taskId ?? closeout.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${closeout.queue}\``);
  lines.push(`- Task: \`${closeout.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${closeout.runId ?? 'unknown'}\``);
  lines.push(`- Task status: \`${closeout.status ?? 'unknown'}\``);
  lines.push(`- Closeout status: \`${closeout.closeoutStatus}\``);
  lines.push(`- Closed at: \`${closeout.closedAt}\``);
  lines.push(`- Source run: \`${closeout.sourceRunFile ?? 'unknown'}\``);
  lines.push('');

  lines.push('## State');
  lines.push(`- Worktree: \`${closeout.worktreeState.exists ? 'exists' : 'missing'}\` ${closeout.worktreeState.path ? `\`${closeout.worktreeState.path}\`` : ''}`.trimEnd());
  lines.push(`- Recorded dirty: \`${closeout.worktreeState.dirty ? 'yes' : 'no'}\``);
  lines.push(`- Verification: \`${closeout.verifyOk ? 'ok' : 'failed'}\``);
  lines.push(`- Patch export: \`${closeout.patchExport.exists ? 'exists' : 'missing'}\` \`${closeout.patchExport.patchFile}\``);
  lines.push(`- Patch verify: \`${closeout.patchVerify?.status ?? 'not_run'}\``);
  lines.push(`- Apply plan: \`${closeout.applyPlan?.status ?? 'not_run'}\``);
  lines.push(`- Review bundle: \`${closeout.review.exists ? 'exists' : 'missing'}\` \`${closeout.review.reviewFile}\``);
  lines.push(`- Cleanup recommendation: \`${closeout.cleanup.recommendation ?? 'unknown'}\``);
  lines.push('');

  if (closeout.actions.length > 0) {
    lines.push('## Next Actions');
    for (const action of closeout.actions) lines.push(`- ${action}`);
    lines.push('');
  }

  if (closeout.worktreeState.currentDiffStat) {
    lines.push('## Current Diff Stat');
    lines.push('');
    lines.push('```text');
    lines.push(closeout.worktreeState.currentDiffStat.trimEnd());
    lines.push('```');
    lines.push('');
  }

  if (closeout.errors.length > 0) {
    lines.push('## Errors');
    for (const error of closeout.errors) lines.push(`- \`${error.step}\`: ${error.message}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderCodeTaskFinishMarkdown(finish) {
  const lines = [];
  lines.push(`# Loop Code Task Finish: ${finish.title ?? finish.taskId ?? finish.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${finish.queue}\``);
  lines.push(`- Task: \`${finish.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${finish.runId ?? 'unknown'}\``);
  lines.push(`- Status: \`${finish.status}\``);
  lines.push(`- Started: \`${finish.startedAt}\``);
  lines.push(`- Finished: \`${finish.finishedAt}\``);
  lines.push(`- Source run: \`${finish.sourceRunFile ?? 'unknown'}\``);
  lines.push('');

  lines.push('## Gates');
  lines.push(`- Patch export: \`${finish.gates.patchExists && finish.gates.patchManifestExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.patchFile}\``);
  lines.push(`- Review bundle: \`${finish.gates.reviewExists && finish.gates.reviewJsonExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.reviewFile}\``);
  lines.push(`- Closeout: \`${finish.gates.closeoutExists && finish.gates.closeoutJsonExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.closeoutFile}\``);
  lines.push(`- Apply plan: \`${finish.gates.applyPlan?.status ?? 'not_run'}\``);
  lines.push(`- Cleanup gate: \`${finish.gates.cleanupGate?.ok ? 'ready' : finish.gates.cleanupGate?.reason ?? 'not_run'}\``);
  lines.push('');

  lines.push('## Actions');
  lines.push(`- Patch applied: \`${finish.patchApply?.applied ? 'yes' : 'no'}\``);
  lines.push(`- Worktree cleaned: \`${finish.cleanup?.removed ? 'yes' : 'no'}\``);
  if (finish.cleanup?.worktree) lines.push(`- Worktree: \`${finish.cleanup.worktree}\``);
  if (finish.cleanup?.branch) lines.push(`- Branch retained: \`${finish.cleanup.branch}\``);
  lines.push('');

  if (finish.steps.length > 0) {
    lines.push('## Steps');
    for (const step of finish.steps) {
      const detail = step.reason ? ` (${step.reason})` : '';
      lines.push(`- \`${step.name}\`: \`${step.status}\`${detail}`);
    }
    lines.push('');
  }

  if (finish.errors.length > 0) {
    lines.push('## Errors');
    for (const error of finish.errors) lines.push(`- \`${error.step}\`: ${error.message}`);
    lines.push('');
  }

  lines.push('## Safety');
  lines.push('- Required `--confirm-apply` and `--confirm-cleanup`.');
  lines.push('- Did not stage, commit, push, merge, delete branches, or change queue state.');
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

function sanitizeFileSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'worktree';
}

async function findCodeWorktreeRun(root, queue, options = {}) {
  const entries = (await recentRuns(root, queue, { limit: options.limit ?? 100 }))
    .filter((entry) => entry.run?.queue === queue && entry.run?.worktree)
    .reverse();
  const found = entries.find((entry) => {
    if (options.runId && entry.run.runId === options.runId) return true;
    if (options.taskId && entry.run.taskId === options.taskId) return true;
    return !options.runId && !options.taskId;
  });
  if (!found) {
    const target = options.runId ? `run ${options.runId}` : options.taskId ? `task ${options.taskId}` : 'latest worktree run';
    throw new Error(`No code worktree artifact found for ${target}.`);
  }
  return found;
}

function resolveWorktreePath(root, recordedPath) {
  if (typeof recordedPath !== 'string' || !recordedPath.trim()) {
    throw new Error('Code worktree artifact is missing worktree.path.');
  }
  const full = path.isAbsolute(recordedPath)
    ? path.resolve(recordedPath)
    : path.resolve(root, safeRelativePath(recordedPath, 'worktree path'));
  const rel = path.relative(root, full);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Unsafe worktree path outside root: ${recordedPath}`);
  }
  return full;
}

async function recoverStaleActive(root, queue, staleActiveMs) {
  if (!staleActiveMs) return [];
  const dir = queueSubdirFor(root, queue, 'active');
  const files = await listJson(dir);
  const recovered = [];
  const now = Date.now();
  for (const file of files) {
    const full = path.join(dir, file);
    const s = await stat(full);
    if (now - s.mtimeMs < staleActiveMs) continue;
    const task = await readJson(full);
    const failedFile = path.join(queueSubdirFor(root, queue, 'failed'), file);
    await writeJson(failedFile, {
      ...task,
      status: 'stale_active',
      failedAt: new Date().toISOString(),
      staleActiveMs
    });
    await rm(full, { force: true });
    recovered.push({ taskId: task.id, file: path.relative(root, failedFile) });
  }
  return recovered;
}

function compactCommandResult(result) {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    canceled: Boolean(result.canceled),
    cancelFile: result.cancelFile ?? null,
    killedProcessGroup: Boolean(result.killedProcessGroup),
    stdout: trimTail(result.stdout),
    stderr: trimTail(result.stderr)
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildQueueEnv(root, queue, task, taskFile, runId, extra = {}) {
  return {
    ...process.env,
    LOOP_QUEUE_ID: queue,
    LOOP_TASK_ID: task.id,
    LOOP_TASK_TITLE: task.title,
    LOOP_TASK_BODY: task.body,
    LOOP_TASK_FILE: taskFile,
    LOOP_TASK_FILE_REL: path.relative(root, taskFile),
    LOOP_RUN_ID: runId,
    ...extra
  };
}

const DEFAULT_REQUIRES_HUMAN_ACTION_PATTERNS = [
  'INSTALL_FAILED_USER_RESTRICTED',
  'device unauthorized',
  'unauthorized',
  'offline',
  'more than one device',
  'no devices/emulators found',
  'Permission denied',
  'Operation not permitted',
  'user restricted',
  'requires human',
  'needs human',
  '需要人工',
  '需要用户确认',
  '等待人工',
  '权限未开',
  '用户取消',
  '用户限制'
];

function dispatchFailureClassification(result, retry = {}) {
  if (!result || result.exitCode === 0) {
    return {
      category: 'ok',
      requiresHumanAction: false,
      matchedPattern: null
    };
  }
  if (result.timedOut) {
    return {
      category: 'timeout',
      requiresHumanAction: false,
      matchedPattern: null
    };
  }
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.toLowerCase();
  const patterns = retry.requiresHumanActionPatterns ?? DEFAULT_REQUIRES_HUMAN_ACTION_PATTERNS;
  const matched = patterns.find((pattern) => output.includes(pattern.toLowerCase()));
  if (matched) {
    return {
      category: 'requires_human_action',
      requiresHumanAction: true,
      matchedPattern: matched
    };
  }
  return {
    category: 'retryable_failure',
    requiresHumanAction: false,
    matchedPattern: null
  };
}

function shouldRetryDispatch(result, retry, attempt) {
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (attempt >= maxAttempts) return false;
  if (!result || result.exitCode === 0) return false;
  if (result.canceled) return false;
  if (dispatchFailureClassification(result, retry).requiresHumanAction) return false;
  const retryExitCodes = retry?.retryExitCodes;
  return !retryExitCodes || retryExitCodes.includes(result.exitCode);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskPlanningEnv(root, taskContract, acceptancePlan, devPlan) {
  const env = {};
  if (taskContract?.file) {
    env.LOOP_TASK_CONTRACT_FILE = path.join(root, taskContract.file);
    env.LOOP_TASK_CONTRACT_FILE_REL = taskContract.file;
    const runtimeDir = taskRuntimeDirFor(root, taskContract.contract.queue, taskContract.contract.task_id);
    const runtimeDirRel = path.relative(root, runtimeDir);
    env.LOOP_TASK_RUNTIME_DIR = runtimeDir;
    env.LOOP_TASK_RUNTIME_DIR_REL = runtimeDirRel;
    env.LOOP_HUMAN_REVIEW_DECISION_FILE = path.join(runtimeDir, 'human_review_decision.json');
    env.LOOP_HUMAN_REVIEW_DECISION_FILE_REL = path.join(runtimeDirRel, 'human_review_decision.json');
    env.LOOP_HUMAN_REVISION_REQUEST_FILE = path.join(runtimeDir, 'human_revision_request.json');
    env.LOOP_HUMAN_REVISION_REQUEST_FILE_REL = path.join(runtimeDirRel, 'human_revision_request.json');
    env.LOOP_AMENDMENTS_DIR = path.join(runtimeDir, 'amendments');
    env.LOOP_AMENDMENTS_DIR_REL = path.join(runtimeDirRel, 'amendments');
    env.LOOP_LATEST_AMENDMENT_FILE = path.join(runtimeDir, 'amendments', 'latest.json');
    env.LOOP_LATEST_AMENDMENT_FILE_REL = path.join(runtimeDirRel, 'amendments', 'latest.json');
  }
  if (acceptancePlan?.file) {
    env.LOOP_ACCEPTANCE_PLAN_FILE = path.join(root, acceptancePlan.file);
    env.LOOP_ACCEPTANCE_PLAN_FILE_REL = acceptancePlan.file;
  }
  if (devPlan?.file) {
    env.LOOP_DEV_PLAN_FILE = path.join(root, devPlan.file);
    env.LOOP_DEV_PLAN_FILE_REL = devPlan.file;
  }
  if (devPlan?.checkpointsDir) {
    env.LOOP_CHECKPOINTS_DIR = path.join(root, devPlan.checkpointsDir);
    env.LOOP_CHECKPOINTS_DIR_REL = devPlan.checkpointsDir;
  }
  if (devPlan?.reviewsDir) {
    env.LOOP_REVIEWS_DIR = path.join(root, devPlan.reviewsDir);
    env.LOOP_REVIEWS_DIR_REL = devPlan.reviewsDir;
  }
  return env;
}

async function runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs, runContext = {}) {
  const attempts = [];
  const retry = options.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? 1;
  const retryDelayMs = retry.retryDelayMs ?? 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    runContext.progress?.emit('dispatch', 'running', `Running dispatcher attempt ${attempt}/${maxAttempts}`, {
      attempt,
      maxAttempts,
      dispatcher: options.dispatcher
    });
    const startedAt = new Date().toISOString();
    const heartbeatMs = options.progressHeartbeatMs ?? 5 * 60 * 1000;
    const checkpointPollMs = options.checkpointPollMs ?? 2000;
    let heartbeat = 0;
    let checkpointPollRunning = false;
    const knownCheckpoints = new Set();
    const heartbeatTimer = heartbeatMs > 0 ? setInterval(() => {
      heartbeat += 1;
      runContext.progress?.emit('dispatch', 'heartbeat', `Worker is still running (attempt ${attempt})`, {
        attempt,
        heartbeat,
        elapsedMs: Date.now() - Date.parse(startedAt)
      });
    }, heartbeatMs) : null;
    const checkpointsDir = runContext.env?.LOOP_CHECKPOINTS_DIR;
    const checkpointTimer = checkpointsDir && checkpointPollMs > 0 ? setInterval(async () => {
      if (checkpointPollRunning) return;
      checkpointPollRunning = true;
      try {
        for (const checkpointFile of await listJson(checkpointsDir)) {
          if (knownCheckpoints.has(checkpointFile)) continue;
          let checkpoint = null;
          try { checkpoint = await readJson(path.join(checkpointsDir, checkpointFile)); } catch { /* wait for the next valid checkpoint */ }
          if (!checkpoint) continue;
          knownCheckpoints.add(checkpointFile);
          runContext.progress?.emit('acceptance', 'checkpoint_update', checkpoint?.summary || `Worker wrote checkpoint ${checkpointFile}`, {
            attempt,
            checkpointFile,
            checkpointId: checkpoint?.checkpoint_id ?? null,
            checkpointStatus: checkpoint?.status ?? null,
            amendmentVersion: checkpoint?.amendment_version ?? null
          });
        }
      } finally {
        checkpointPollRunning = false;
      }
    }, checkpointPollMs) : null;
    let result;
    try {
      result = await runCommand(options.dispatcher, {
        cwd: runContext.cwd ?? root,
        env: {
          ...buildQueueEnv(root, queue, task, activeFile, runId, runContext.env ?? {}),
          LOOP_ATTEMPT: String(attempt),
          LOOP_MAX_ATTEMPTS: String(maxAttempts)
        },
        timeoutMs,
        cancelFile: path.join(taskRuntimeDirFor(root, queue, task.id), 'supersede_request.json')
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (checkpointTimer) clearInterval(checkpointTimer);
    }
    const failureClassification = dispatchFailureClassification(result, retry);
    attempts.push({
      attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
      failureClassification
    });
    const dispatchStatus = result.exitCode === 0
      ? 'passed'
      : failureClassification.requiresHumanAction ? 'needs_human_action' : 'failed';
    runContext.progress?.emit('dispatch', dispatchStatus, `Dispatcher attempt ${attempt} exited ${result.exitCode}`, {
      attempt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      failureCategory: failureClassification.category,
      matchedPattern: failureClassification.matchedPattern
    });
    if (!shouldRetryDispatch(result, retry, attempt)) break;
    runContext.progress?.emit('dispatch', 'retry_wait', `Waiting ${retryDelayMs}ms before retry`, {
      attempt,
      retryDelayMs
    });
    await delay(retryDelayMs);
  }
  return attempts;
}

function worktreeEnabled(options) {
  return Boolean(options.worktree?.enabled);
}

function sanitizeBranchSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'task';
}

async function prepareWorktree(root, queue, task, runId, config = {}) {
  const baseRel = safeRelativePath(config.baseDir ?? path.join('runtime', 'loops', queue, 'worktrees'), 'worktree baseDir');
  const baseDir = path.join(root, baseRel);
  await mkdir(baseDir, { recursive: true });
  const shortTask = sanitizeBranchSegment(task.id).replace(/\//g, '-');
  const worktreeDir = path.join(baseDir, shortTask);
  const prefix = sanitizeBranchSegment(config.branchPrefix ?? `loop/${queue}`);
  const branch = `${prefix}/${shortTask}`;
  const add = await runCommand(`git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreeDir)} HEAD`, {
    cwd: root,
    timeoutMs: config.setupTimeoutMs ?? 120000
  });
  const head = add.exitCode === 0
    ? await runCommand('git rev-parse HEAD', { cwd: worktreeDir, timeoutMs: 30000 })
    : null;
  return {
    enabled: true,
    path: worktreeDir,
    pathRel: path.relative(root, worktreeDir),
    branch,
    setup: compactCommandResult(add),
    head: head?.exitCode === 0 ? head.stdout.trim() : null,
    runId
  };
}

async function inspectWorktree(worktree) {
  if (!worktree?.path || worktree.setup?.exitCode !== 0) return null;
  const status = await runCommand('git status --short', { cwd: worktree.path, timeoutMs: 30000 });
  const diffStat = await runCommand('git diff --stat', { cwd: worktree.path, timeoutMs: 30000 });
  const diffNameStatus = await runCommand('git diff --name-status', { cwd: worktree.path, timeoutMs: 30000 });
  const untracked = await runCommand('git ls-files --others --exclude-standard', { cwd: worktree.path, timeoutMs: 30000 });
  return {
    status: compactCommandResult(status),
    diffStat: trimTail(diffStat.stdout, 4000),
    diffNameStatus: trimTail(diffNameStatus.stdout, 4000),
    untracked: trimTail(untracked.stdout, 4000),
    dirty: Boolean(status.stdout.trim())
  };
}

async function runVerifyCommands(commands, cwd, timeoutMs, progress = null, phase = 'verification') {
  const results = [];
  const list = commands ?? [];
  for (let index = 0; index < list.length; index++) {
    const cmd = list[index];
    progress?.emit(phase, 'running', `Running verification ${index + 1}/${list.length}`, {
      commandIndex: index + 1,
      commandCount: list.length,
      cmd
    });
    const startedAt = new Date().toISOString();
    const result = await runCommand(cmd, { cwd, timeoutMs });
    results.push({
      cmd,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: compactCommandResult(result)
    });
    progress?.emit(phase, result.exitCode === 0 ? 'passed' : 'failed', `Verification ${index + 1}/${list.length} exited ${result.exitCode}`, {
      commandIndex: index + 1,
      commandCount: list.length,
      cmd,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    });
    if (result.exitCode !== 0) break;
  }
  return results;
}

async function runPreflight(root, config, timeoutMs) {
  if (!config) return null;
  const cli = path.join(PACKAGE_ROOT, 'bin', 'loop-engineering.mjs');
  return runCommand(`${shellQuote(process.execPath)} ${shellQuote(cli)} run --config ${shellQuote(config)} --root ${shellQuote(root)} --json`, {
    cwd: root,
    timeoutMs
  });
}

export async function runQueueOnce(root, options) {
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  let progressTask = null;
  const liveProgressNotifications = [];
  let liveProgressChain = Promise.resolve();
  const progress = createProgressRecorder((event) => {
    if (typeof options.onProgress === 'function') options.onProgress(event);
    if (progressTask && options.progressNotifyCommand) {
      liveProgressChain = liveProgressChain.then(() =>
        notifyLiveQueueProgress(root, queue, progressTask, event, options).catch((err) => ({
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err)
        }))
      );
      liveProgressNotifications.push(liveProgressChain);
    }
  });
  if (!options.dispatcher || typeof options.dispatcher !== 'string') {
    throw new Error('run-queue requires --dispatcher.');
  }
  const leaseMs = options.leaseMs ?? options.timeoutMs ?? 30 * 60 * 1000;
  progress.emit('queue', 'locking', `Acquiring queue lock for ${queue}`, {
    queue,
    leaseMs
  });
  const lockResult = await acquireQueueLock(root, queue, leaseMs);
  if (!lockResult.acquired) {
    progress.emit('queue', 'locked', `Queue ${queue} is already locked`, {
      queue,
      expiresAt: lockResult.lock?.expiresAt ?? null
    });
    return {
      processed: false,
      queue,
      status: 'locked',
      exitCode: 2,
      lock: lockResult.lock ?? null,
      progress: progress.events
    };
  }

  try {
    const staleRecovered = await recoverStaleActive(root, queue, options.staleActiveMs);
    if (staleRecovered.length > 0) {
      progress.emit('queue', 'recovered', `Recovered ${staleRecovered.length} stale active task(s)`, {
        queue,
        count: staleRecovered.length
      });
    }
    const inboxFile = await nextQueuedTaskFile(root, queue);
    if (!inboxFile) {
      progress.emit('queue', 'empty', `Queue ${queue} has no queued tasks`, {
        queue
      });
      return {
        processed: false,
        queue,
        status: 'empty',
        exitCode: 0,
        staleRecovered,
        progress: progress.events
      };
    }

    const task = await readJson(inboxFile);
    progressTask = task;
    const activeFile = path.join(queueSubdirFor(root, queue, 'active'), path.basename(inboxFile));
    await rename(inboxFile, activeFile);
    progress.emit('queue', 'activated', `Activated task ${task.id}: ${task.title}`, {
      queue,
      taskId: task.id,
      title: task.title,
      taskPath: path.relative(root, activeFile)
    });

    const startedAt = new Date().toISOString();
    const runId = `${isoStamp()}_${task.id}`;
    const runPath = path.join(queueSubdirFor(root, queue, 'runs'), `${runId}.json`);
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    let finalStatus = 'unknown';
    let destination = queueSubdirFor(root, queue, 'failed');
    let exitCode = 1;
    let preflight = null;
    let dispatch = null;
    let dispatchAttempts = [];
    let worktree = null;
    let worktreeInspection = null;
    let verification = [];
    let taskContract = null;
    let acceptancePlan = null;
    let devPlan = null;
    let checkpoints = null;
    let acceptanceReviews = null;
    let finalJudgement = null;
    let revisionRequest = null;

    try {
      taskContract = await writeTaskContract(root, queue, task, {
        riskLevel: options.riskLevel,
        riskReasons: options.riskReasons,
        requiresHumanGate: options.requiresHumanGate
      });
      progress.emit('planning', 'task_contract', `Wrote task contract (${taskContract.contract.risk_level})`, {
        taskId: task.id,
        artifact: taskContract.file,
        riskLevel: taskContract.contract.risk_level,
        requiresHumanGate: taskContract.contract.requires_human_gate
      });
      acceptancePlan = await writeAcceptancePlan(root, queue, task, taskContract, {
        acceptanceCritics: options.acceptanceCritics
      });
      progress.emit('planning', 'acceptance_plan', 'Wrote acceptance plan', {
        taskId: task.id,
        artifact: acceptancePlan.file,
        critics: acceptancePlan.plan.critic_profile?.critics?.length ?? 0,
        automationChecks: acceptancePlan.plan.automation.length,
        manualChecks: acceptancePlan.plan.manual_review.length
      });
      devPlan = await writeDevPlan(root, queue, task, taskContract, acceptancePlan);
      progress.emit('planning', 'dev_plan', 'Wrote development plan', {
        taskId: task.id,
        artifact: devPlan.file,
        checkpointsDir: devPlan.checkpointsDir,
        plannedCheckpoints: devPlan.plan.checkpoints.length
      });
      if (options.preflightConfig) {
        progress.emit('preflight', 'running', `Running preflight ${options.preflightConfig}`, {
          config: options.preflightConfig
        });
      }
      preflight = await runPreflight(root, options.preflightConfig, Math.min(timeoutMs, 3 * 60 * 1000));
      if (preflight) {
        progress.emit('preflight', preflight.exitCode === 0 ? 'passed' : 'failed', `Preflight exited ${preflight.exitCode}`, {
          exitCode: preflight.exitCode,
          timedOut: preflight.timedOut
        });
      } else {
        progress.emit('preflight', 'skipped', 'No preflight configured');
      }
      const supersedeFile = path.join(taskRuntimeDirFor(root, queue, task.id), 'supersede_request.json');
      if (await exists(supersedeFile)) {
        finalStatus = 'superseded';
        progress.emit('queue', 'superseded', 'A newer loop request replaced this task at a safe checkpoint', {
          taskId: task.id,
          artifact: path.relative(root, supersedeFile)
        });
      } else if (preflight && preflight.exitCode !== 0) {
        finalStatus = 'blocked_preflight';
        exitCode = 2;
      } else {
        const runContext = {
          env: taskPlanningEnv(root, taskContract, acceptancePlan, devPlan),
          progress
        };
        if (finalStatus === 'unknown' && worktreeEnabled(options)) {
          progress.emit('worktree', 'creating', 'Creating task worktree', {
            taskId: task.id
          });
          worktree = await prepareWorktree(root, queue, task, runId, options.worktree);
          if (worktree.setup.exitCode !== 0) {
            finalStatus = 'worktree_failed';
            exitCode = 1;
            progress.emit('worktree', 'failed', 'Worktree setup failed', {
              taskId: task.id,
              exitCode: worktree.setup.exitCode
            });
          } else {
            progress.emit('worktree', 'ready', `Prepared worktree ${worktree.pathRel}`, {
              taskId: task.id,
              path: worktree.pathRel,
              branch: worktree.branch
            });
            runContext.cwd = worktree.path;
            runContext.env = {
              ...runContext.env,
              LOOP_ROOT: root,
              LOOP_WORKTREE_PATH: worktree.path,
              LOOP_WORKTREE_PATH_REL: worktree.pathRel,
              LOOP_WORKTREE_BRANCH: worktree.branch
            };
          }
        }
        if (finalStatus === 'unknown' && await exists(supersedeFile)) {
          finalStatus = 'superseded';
        }
        if (finalStatus === 'unknown') {
          dispatchAttempts = await runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs, runContext);
          dispatch = dispatchAttempts[dispatchAttempts.length - 1]?.result ?? null;
          const dispatchClassification = dispatchAttempts[dispatchAttempts.length - 1]?.failureClassification ?? null;
          if (dispatch?.canceled) {
            finalStatus = 'superseded';
          } else if (dispatch?.exitCode === 0 && worktreeEnabled(options)) {
            verification = await runVerifyCommands(options.worktree?.verifyCommands ?? [], worktree.path, timeoutMs, progress);
            const verifyOk = verification.every((entry) => entry.result.exitCode === 0);
            finalStatus = verifyOk ? 'completed' : 'verify_failed';
          } else {
            finalStatus = dispatch?.exitCode === 0
              ? 'completed'
              : dispatchClassification?.requiresHumanAction ? 'needs_human_input' : 'failed';
          }
        }
        worktreeInspection = await inspectWorktree(worktree);
        if (worktreeInspection) {
          progress.emit('worktree', worktreeInspection.dirty ? 'dirty' : 'clean', `Inspected worktree (${worktreeInspection.dirty ? 'changes present' : 'no changes'})`, {
            taskId: task.id,
            dirty: worktreeInspection.dirty
          });
        }
      }
      checkpoints = await checkpointSummary(root, devPlan);
      progress.emit('acceptance', 'checkpoint_summary', `Collected ${checkpoints.count} checkpoint(s)`, {
        taskId: task.id,
        count: checkpoints.count,
        files: checkpoints.files
      });
      if (finalStatus === 'superseded') {
        const requestFile = path.join(taskRuntimeDirFor(root, queue, task.id), 'supersede_request.json');
        const request = await readJson(requestFile);
        acceptanceReviews = { count: 0, accepted: 0, revise: 0, blocked: 0, reviews: [] };
        const judgementFile = path.join(taskRuntimeDirFor(root, queue, task.id), 'final_judgement.json');
        const judgement = {
          version: 1,
          task_id: task.id,
          outcome: 'superseded',
          requires_human_gate: false,
          reasons: ['A newer loop request replaced this active task.'],
          next_actions: [`Continue with replacement task ${request.replacementTaskId ?? 'recorded in supersede_request.json'}.`],
          supersede_request: path.relative(root, requestFile),
          replacement_task_id: request.replacementTaskId ?? null
        };
        await writeJson(judgementFile, judgement);
        finalJudgement = { judgement, file: path.relative(root, judgementFile) };
      } else {
        acceptanceReviews = await writeAcceptanceReviews(root, queue, task, taskContract, acceptancePlan, devPlan);
      }
      progress.emit('acceptance', 'reviewed', `Acceptance reviewed ${acceptanceReviews.count} checkpoint(s)`, {
        taskId: task.id,
        count: acceptanceReviews.count,
        accepted: acceptanceReviews.accepted,
        revise: acceptanceReviews.revise,
        blocked: acceptanceReviews.blocked
      });
      if (!finalJudgement) finalJudgement = await writeFinalJudgement(root, queue, task, taskContract, acceptancePlan, devPlan, checkpoints, acceptanceReviews, {
        dispatchStatus: finalStatus,
        verificationFailed: verification.some((entry) => entry.result.exitCode !== 0)
      });
      progress.emit('final-judge', finalJudgement.judgement.outcome, `Final judgement: ${finalJudgement.judgement.outcome}`, {
        taskId: task.id,
        artifact: finalJudgement.file,
        requiresHumanGate: finalJudgement.judgement.requires_human_gate
      });
      revisionRequest = finalStatus === 'superseded' ? null : await writeRevisionRequest(root, queue, task, taskContract, acceptancePlan, devPlan, finalJudgement, acceptanceReviews);
      if (revisionRequest) {
        progress.emit('revision', 'requested', `Revision request created with ${revisionRequest.request.revision_goals.length} goal(s)`, {
          taskId: task.id,
          artifact: revisionRequest.file,
          goals: revisionRequest.request.revision_goals.length,
          nextCheckpoint: revisionRequest.request.next_checkpoint?.suggested_id ?? null
        });
      }
      if (finalStatus !== 'superseded') finalStatus = queueStatusFromFinalJudgement(finalStatus, finalJudgement);
    } catch (err) {
      finalStatus = 'runtime_error';
      exitCode = 1;
      progress.emit('runtime', 'failed', err instanceof Error ? err.message : String(err), {
        taskId: task.id
      });
      dispatch = {
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: err instanceof Error ? err.stack || err.message : String(err)
      };
    }

    if (!checkpoints) checkpoints = await checkpointSummary(root, devPlan);
    if (!acceptanceReviews) acceptanceReviews = await writeAcceptanceReviews(root, queue, task, taskContract, acceptancePlan, devPlan);
    if (!finalJudgement) {
      finalJudgement = await writeFinalJudgement(root, queue, task, taskContract, acceptancePlan, devPlan, checkpoints, acceptanceReviews, {
        dispatchStatus: finalStatus,
        verificationFailed: verification.some((entry) => entry.result.exitCode !== 0)
      });
      finalStatus = queueStatusFromFinalJudgement(finalStatus, finalJudgement);
    }
    if (!revisionRequest) {
      revisionRequest = await writeRevisionRequest(root, queue, task, taskContract, acceptancePlan, devPlan, finalJudgement, acceptanceReviews);
    }

    destination = finalStatus === 'completed'
      ? queueSubdirFor(root, queue, 'done')
      : finalStatus === 'superseded' ? queueSubdirFor(root, queue, 'canceled')
      : queueSubdirFor(root, queue, 'failed');
    exitCode = ['completed', 'superseded'].includes(finalStatus) ? 0 : 1;

    const finishedAt = new Date().toISOString();
    progress.emit('queue', finalStatus === 'completed' ? 'completed' : 'needs_attention', `Task finished with status ${finalStatus}`, {
      queue,
      taskId: task.id,
      status: finalStatus
    });
    const completedTask = {
      ...task,
      status: finalStatus,
      startedAt,
      finishedAt,
      attempts: (task.attempts ?? 0) + Math.max(dispatchAttempts.length, dispatch ? 1 : 0),
      runPath: path.relative(root, runPath)
    };
    const completedFile = path.join(destination, path.basename(activeFile));
    await writeJson(completedFile, completedTask);
    await rm(activeFile, { force: true });

    const run = {
      version: 2,
      runId,
      queue,
      taskId: task.id,
      title: task.title,
      startedAt,
      finishedAt,
      status: finalStatus,
      retry: options.retry ?? null,
      taskContract: taskContract ? {
        path: taskContract.file,
        riskLevel: taskContract.contract.risk_level,
        requiresHumanGate: taskContract.contract.requires_human_gate
      } : null,
      acceptancePlan: acceptancePlan ? {
        path: acceptancePlan.file,
        generatedBy: acceptancePlan.plan.generated_by,
        checks: {
          functional: acceptancePlan.plan.functional_checks.length,
          regression: acceptancePlan.plan.regression_checks.length,
          edgeCases: acceptancePlan.plan.edge_cases.length,
          negative: acceptancePlan.plan.negative_tests.length,
          manual: acceptancePlan.plan.manual_review.length,
          automation: acceptancePlan.plan.automation.length
        }
      } : null,
      devPlan: devPlan ? {
        path: devPlan.file,
        generatedBy: devPlan.plan.generated_by,
        checkpointsDir: devPlan.checkpointsDir,
        reviewsDir: devPlan.reviewsDir,
        plannedCheckpoints: devPlan.plan.checkpoints.length
      } : null,
      checkpoints,
      acceptanceReviews,
      finalJudgement: finalJudgement ? {
        path: finalJudgement.file,
        generatedBy: finalJudgement.judgement.generated_by,
        outcome: finalJudgement.judgement.outcome,
        requiresHumanGate: finalJudgement.judgement.requires_human_gate,
        reasons: finalJudgement.judgement.reasons,
        nextActions: finalJudgement.judgement.next_actions
      } : null,
      revisionRequest: revisionRequest ? {
        path: revisionRequest.file,
        generatedBy: revisionRequest.request.generated_by,
        status: revisionRequest.request.status,
        goals: revisionRequest.request.revision_goals.length,
        nextCheckpoint: revisionRequest.request.next_checkpoint?.suggested_id ?? null
      } : null,
      dispatchAttempts: dispatchAttempts.map((attempt) => ({
        attempt: attempt.attempt,
        failureClassification: attempt.failureClassification ?? null,
        result: compactCommandResult(attempt.result)
      })),
      dispatchFailureClassification: dispatchAttempts[dispatchAttempts.length - 1]?.failureClassification ?? null,
      preflight: preflight ? compactCommandResult(preflight) : null,
      dispatch: dispatch ? compactCommandResult(dispatch) : null,
      worktree: worktree ? {
        enabled: true,
        path: worktree.pathRel,
        branch: worktree.branch,
        head: worktree.head,
        setup: worktree.setup,
        inspection: worktreeInspection
      } : null,
      verification,
      staleRecovered,
      progress: progress.events,
      taskPath: path.relative(root, completedFile),
      runPath: path.relative(root, runPath)
    };
    await writeJson(runPath, run);
    try {
      run.lineage = await queueLineage(root, queue, task.id, { currentRun: run });
    } catch (err) {
      run.lineage = {
        error: err instanceof Error ? err.message : String(err)
      };
    }
    await writeJson(runPath, run);

    if (options.notifyCommand) {
      const detail = dispatch?.stdout || dispatch?.stderr || preflight?.stdout || preflight?.stderr || '';
      const message = [
        `Loop queue task ${finalStatus}: ${task.title}`,
        `queue: ${queue}`,
        `run: ${run.runPath}`,
        trimTail(detail, 1200)
      ].filter(Boolean).join('\n');
      await runCommand(`${options.notifyCommand} ${shellQuote(message)}`, {
        cwd: root,
        timeoutMs: 60 * 1000
      });
    }

    const progressNotifications = await Promise.all(liveProgressNotifications);
    return {
      processed: true,
      queue,
      status: finalStatus,
      exitCode,
      taskPath: path.relative(root, completedFile),
      runPath: path.relative(root, runPath),
      run,
      progress: progress.events,
      progressNotifications
    };
  } finally {
    await releaseQueueLock(root, queue, lockResult.lock);
  }
}

export async function runQueueDrain(root, options) {
  const queue = normalizeLoopId(options.queue);
  const maxTasks = options.maxTasks ?? 100;
  if (!Number.isInteger(maxTasks) || maxTasks <= 0) {
    throw new Error('run-queue-drain maxTasks must be a positive integer.');
  }

  const runs = [];
  let stopReason = 'max_tasks';
  for (let index = 0; index < maxTasks; index += 1) {
    const result = await runQueueOnce(root, options);
    if (result.status === 'locked') {
      stopReason = 'locked';
      return {
        queue,
        processed: runs.length,
        status: runs.length > 0 ? 'partial' : 'locked',
        stopReason,
        maxTasks,
        remaining: (await queueStatus(root, queue)).queued,
        exitCode: runs.some((run) => run.exitCode !== 0) ? 1 : 0,
        lock: result.lock ?? null,
        runs
      };
    }
    if (!result.processed) {
      stopReason = 'empty';
      break;
    }
    runs.push(result);
  }

  const status = await queueStatus(root, queue);
  if (status.queued === 0) stopReason = 'empty';
  return {
    queue,
    processed: runs.length,
    status: stopReason === 'empty' ? 'drained' : 'partial',
    stopReason,
    maxTasks,
    remaining: status.queued,
    exitCode: runs.some((run) => run.exitCode !== 0) ? 1 : 0,
    runs
  };
}
