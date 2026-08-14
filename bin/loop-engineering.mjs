#!/usr/bin/env node
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyBreaker,
  codeWorktreeDiff,
  codeWorktreeCleanup,
  codeWorktreeCleanupPlan,
  codeWorktreeExport,
  codeWorktreeInspect,
  codeWorktreeList,
  codePatchApply,
  codePatchApplyPlan,
  codePatchVerify,
  codeReviewBundle,
  codeTaskAutoflow,
  codeTaskAutoflowBatch,
  codeTaskCloseout,
  codeTaskDashboard,
  codeTaskFinish,
  codeTaskRun,
  codeTaskStatus,
  classifyLoopMessage,
  configFilesFromArgs,
  doctorReport,
  initCodeQueueConfig,
  failureSignature,
  initWorkspace,
  initQueueConfig,
  isoStamp,
  latestRun,
  loopRepairPlan,
  loadQueueConfig,
  loadSpec,
  loadState,
  mergeQueueOptions,
  nextState,
  notifyTerminalTasks,
  refreshTaskAcceptance,
  notifyHumanInputRequests,
  parkQueueTask,
  resumeParkedTask,
  resolveHumanInput,
  enqueueTask,
  projectIntake,
  projectPlan,
  projectStatus,
  queueCancel,
  queueHumanDecision,
  queueLineage,
  queueLineageBundle,
  queuePeek,
  queueRevisionApplyPlan,
  queueRevisionPlan,
  queueRevisionNext,
  queueRevisionReview,
  queueRequeue,
  queueSchedulerTick,
  queueSubdirFor,
  queueStatus,
  tickParkedTasks,
  routeLoopMessage,
  summarizeLoopRuns,
  runCheck,
  runQueueDrain,
  runQueueOnce,
  runsDirFor,
  safeRelativePath,
  statePathFor,
  workflowMetrics,
  workflowTuningPlan,
  writeJson
} from '../lib/core.mjs';
import {
  claimAction,
  inspectAction,
  reconcileAction,
  releaseAction,
  reserveAction,
  settleAction
} from '../lib/action-reservations.mjs';
import {
  claimTodo,
  createTodo,
  decideHandoff,
  handoffTodo,
  importLegacyTodos,
  inspectTodo,
  listTodos,
  recoverTodos,
  registerAgent,
  releaseTodo,
  renewTodo
} from '../lib/todo-control-plane.mjs';
import {
  buildOperatorProjection,
  createDashboardServer,
  dashboardHealth,
  exportDashboard,
  filterProjection
} from '../lib/operator-dashboard.mjs';

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--queue') args.queue = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--brief') args.brief = argv[++i];
    else if (a === '--goal') args.goal = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--message') args.message = argv[++i];
    else if (a === '--strategy') args.strategy = argv[++i];
    else if (a === '--strategy-file') args.strategyFile = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--dispatcher') args.dispatcher = argv[++i];
    else if (a === '--preflight-config') args.preflightConfig = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === '--lease-ms') args.leaseMs = Number.parseInt(argv[++i], 10);
    else if (a === '--stale-active-ms') args.staleActiveMs = Number.parseInt(argv[++i], 10);
    else if (a === '--initial-interval') args.initialIntervalMs = argv[++i];
    else if (a === '--min-interval') args.minIntervalMs = argv[++i];
    else if (a === '--max-interval') args.maxIntervalMs = argv[++i];
    else if (a === '--jitter') args.jitterMs = argv[++i];
    else if (a === '--progress-report-interval') args.progressReportIntervalMs = argv[++i];
    else if (a === '--progress-report-idle-interval') args.progressReportIdleIntervalMs = argv[++i];
    else if (a === '--max-attempts') args.maxAttempts = Number.parseInt(argv[++i], 10);
    else if (a === '--max-tasks') args.maxTasks = Number.parseInt(argv[++i], 10);
    else if (a === '--retry-delay-ms') args.retryDelayMs = Number.parseInt(argv[++i], 10);
    else if (a === '--retry-exit-codes') args.retryExitCodes = argv[++i].split(',').filter(Boolean).map((v) => Number.parseInt(v, 10));
    else if (a === '--check') {
      if (!args.checks) args.checks = [];
      args.checks.push(argv[++i]);
    }
    else if (a === '--task-id') args.taskId = argv[++i];
    else if (a === '--todo-id') args.todoId = argv[++i];
    else if (a === '--agent-id') args.agentId = argv[++i];
    else if (a === '--target-agent-id') args.targetAgentId = argv[++i];
    else if (a === '--handoff-id') args.handoffId = argv[++i];
    else if (a === '--todo-json') args.todoJson = argv[++i];
    else if (a === '--agent-json') args.agentJson = argv[++i];
    else if (a === '--state') args.todoState = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--output-dir') {
      const next = argv[i + 1];
      args.outputDir = !next || next.startsWith('--') ? true : argv[++i];
    }
    else if (a === '--patch-output') args.patchOutput = argv[++i];
    else if (a === '--review-output') args.reviewOutput = argv[++i];
    else if (a === '--closeout-output') args.closeoutOutput = argv[++i];
    else if (a === '--review') args.review = argv[++i];
    else if (a === '--patch') args.patch = argv[++i];
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--from-review') args.fromReview = argv[++i];
    else if (a === '--applied-report') args.appliedReport = argv[++i];
    else if (a === '--apply-report') args.applyReport = argv[++i];
    else if (a === '--repair-plan') args.repairPlan = argv[++i];
    else if (a === '--bootstrap-dir') args.bootstrapDir = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--baseline-output') args.baselineOutput = argv[++i];
    else if (a === '--drift-report') args.driftReport = argv[++i];
    else if (a === '--drift-severity') args.driftSeverity = argv[++i];
    else if (a === '--drift-summary-format') args.driftSummaryFormat = argv[++i];
    else if (a === '--drift-allow') args.driftAllow = argv[++i];
    else if (a === '--drift-allow-file') args.driftAllowFile = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--workflow') args.workflow = argv[++i];
    else if (a === '--readme') args.readme = argv[++i];
    else if (a === '--section-title') args.sectionTitle = argv[++i];
    else if (a === '--expires-at') args.expiresAt = argv[++i];
    else if (a === '--ttl') args.ttl = argv[++i];
    else if (a === '--action') args.action = argv[++i];
    else if (a === '--plans-dir') args.plansDir = argv[++i];
    else if (a === '--stale-after') args.staleAfter = argv[++i];
    else if (a === '--until') args.until = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--wait-kind') args.waitKind = argv[++i];
    else if (a === '--wait-id') args.waitId = argv[++i];
    else if (a === '--execution-key') args.executionKey = argv[++i];
    else if (a === '--idempotency-key') args.idempotencyKey = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--authorization-scope') args.authorizationScope = argv[++i];
    else if (a === '--request-json') args.requestJson = argv[++i];
    else if (a === '--fencing-token') args.fencingToken = Number.parseInt(argv[++i], 10);
    else if (a === '--completed') args.completed = true;
    else if (a === '--outcome') args.outcome = argv[++i];
    else if (a === '--evidence') args.evidence = argv[++i];
    else if (a === '--recovery-signal') args.recoverySignal = argv[++i];
    else if (a === '--now') args.now = argv[++i];
    else if (a === '--reminder-interval-ms') args.reminderIntervalMs = Number.parseInt(argv[++i], 10);
    else if (a === '--escalation-interval-ms') args.escalationIntervalMs = Number.parseInt(argv[++i], 10);
    else if (a === '--wait-timeout-ms') args.waitTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === '--max-reminders') args.maxReminders = Number.parseInt(argv[++i], 10);
    else if (a === '--decision') args.decision = argv[++i];
    else if (a === '--comment') args.comment = argv[++i];
    else if (a === '--reviewer') args.reviewer = argv[++i];
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (a === '--query') args.query = argv[++i];
    else if (a === '--max-age-seconds') args.maxAgeSeconds = Number.parseInt(argv[++i], 10);
    else if (a === '--notify-command') args.notifyCommand = argv[++i];
    else if (a === '--gate-id') args.gateId = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--secret-input') args.secretInput = true;
    else if (a === '--non-secret-input') args.nonSecretInput = true;
    else if (a === '--source-channel') args.sourceChannel = argv[++i];
    else if (a === '--source-target') args.sourceTarget = argv[++i];
    else if (a === '--source-account') args.sourceAccount = argv[++i];
    else if (a === '--source-message-id') args.sourceMessageId = argv[++i];
    else if (a === '--source-reply-to') args.sourceReplyTo = argv[++i];
    else if (a === '--progress-notify-command') args.progressNotifyCommand = argv[++i];
    else if (a === '--include-active') args.includeActive = true;
    else if (a === '--plan-only') args.planOnly = true;
    else if (a === '--force-due') args.forceDue = true;
    else if (a === '--progress-report') args.progressReportEnabled = true;
    else if (a === '--no-progress-report') args.progressReportEnabled = false;
    else if (a === '--progress-report-when-not-due') args.progressReportNotifyWhenNotDue = true;
    else if (a === '--fail-on-run-failure') args.failOnRunFailure = true;
    else if (a === '--all-actionable') args.allActionable = true;
    else if (a === '--needs-action') args.needsAction = true;
    else if (a === '--verify-current') args.verifyCurrent = true;
    else if (a === '--fail-on-drift') args.failOnDrift = true;
    else if (a === '--drift-summary-append-github-step') args.driftSummaryAppendGithubStep = true;
    else if (a === '--drift-github-annotations') args.driftGithubAnnotations = true;
    else if (a === '--no-github-step-summary') args.noGithubStepSummary = true;
    else if (a === '--no-github-annotations') args.noGithubAnnotations = true;
    else if (a === '--enqueue-revision') args.enqueueRevision = true;
    else if (a === '--confirm-apply') args.confirmApply = true;
    else if (a === '--confirm-cleanup') args.confirmCleanup = true;
    else if (a === '--confirm-execute') args.confirmExecute = true;
    else if (a === '--route') args.route = true;
    else if (a === '--supersede-active') args.supersedeActive = true;
    else if (a === '--amend-active') args.amendActive = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verified') args.verified = true;
    else if (a === '--allow-dirty') args.allowDirty = true;
    else if (a === '--include-orphans') args.includeOrphans = true;
    else if (a === '--allow-non-loopback') args.allowNonLoopback = true;
    else if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printProgressEvent(event) {
  const prefix = `[${event.phase}] ${event.status}`;
  const detail = event.message ? ` - ${event.message}` : '';
  console.error(`${prefix}${detail}`);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function formatRevisionPlanList(items) {
  return (items ?? []).length ? items.join('; ') : 'none';
}

function parseDurationMs(value, label = 'duration') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}: ${value}`);
    return value;
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`Invalid ${label}: ${value}`);
  const amount = Number.parseFloat(match[1]);
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

function formatDurationApprox(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  const units = [
    ['d', 24 * 60 * 60 * 1000],
    ['h', 60 * 60 * 1000],
    ['m', 60 * 1000],
    ['s', 1000]
  ];
  for (const [unit, size] of units) {
    if (ms >= size) return `${Math.round(ms / size)}${unit}`;
  }
  return `${ms}ms`;
}

function parseCsvSet(value, fallback = []) {
  const items = value === undefined || value === null || value === ''
    ? fallback
    : String(value).split(',');
  return new Set(items.map((item) => item.trim()).filter(Boolean));
}

function sanitizeRevisionPlanFileSegment(value) {
  return (String(value ?? 'revision-plan')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)) || 'revision-plan';
}

function renderRevisionPlanMarkdown(plan) {
  const guardReasons = plan.revisionPolicyGuard?.reasons ?? [];
  const summary = plan.revisionStrategyDiff?.summary ?? null;
  const recommendations = plan.revisionStrategyDiff?.recommendations ?? [];
  const lines = [];
  lines.push(`# Revision Plan: ${plan.plannedTask.title}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Queue: \`${plan.queue}\``);
  lines.push(`- Source task: \`${plan.sourceTaskId}\``);
  lines.push(`- Source run: \`${plan.sourceRun}\``);
  lines.push(`- Revision request: \`${plan.revisionRequest}\``);
  lines.push(`- Revision source: \`${plan.revisionSource}\``);
  lines.push(`- Can enqueue: ${plan.canEnqueue ? 'yes' : 'no'}`);
  lines.push(`- Revision round: ${plan.plannedTask.revisionRound}`);
  lines.push(`- Guard reasons: ${formatRevisionPlanList(guardReasons)}`);
  lines.push('');
  if (summary) {
    lines.push('## Strategy Diff');
    lines.push('');
    lines.push(`- Total targets: ${summary.total_targets}`);
    lines.push(`- Carried forward targets: ${summary.carried_forward_targets}`);
    lines.push(`- Targets with changed strategy: ${summary.targets_with_changed_strategy}`);
    lines.push(`- Targets needing strategy detail: ${summary.targets_needing_strategy_detail}`);
    if (recommendations.length) {
      lines.push('');
      lines.push('## Recommendations');
      lines.push('');
      for (const item of recommendations) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  if (plan.plannedTask.revisionStrategy) {
    lines.push('## Changed Strategy');
    lines.push('');
    lines.push('```text');
    lines.push(plan.plannedTask.revisionStrategy);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Planned Task Body');
  lines.push('');
  lines.push('```text');
  lines.push(plan.plannedTask.body);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionPlanOutput(root, plan, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision plan output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision plan output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const ext = path.extname(outputFile).toLowerCase();
  if (ext === '.json') {
    await writeJson(outputFile, plan);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  if (ext === '.md') {
    await writeFile(outputFile, renderRevisionPlanMarkdown(plan));
    return { file: path.relative(root, outputFile), format: 'markdown' };
  }
  throw new Error('Revision plan --output must end with .json or .md.');
}

async function writeRevisionPlanOutputDir(root, plan, outputDir, options = {}) {
  if (!outputDir) return null;
  const dirRel = outputDir === true
    ? path.join('runtime', 'loops', plan.queue, 'revision-plans')
    : outputDir;
  const outputDirPath = path.resolve(root, safeRelativePath(dirRel, 'revision plan output dir'));
  const fileBase = sanitizeRevisionPlanFileSegment(plan.sourceTaskId ?? plan.plannedTask?.revisionOf ?? plan.plannedTask?.title);
  const jsonFile = path.join(outputDirPath, `${fileBase}.json`);
  const markdownFile = path.join(outputDirPath, `${fileBase}.md`);
  const existing = [];
  if (await fileExists(jsonFile)) existing.push(jsonFile);
  if (await fileExists(markdownFile)) existing.push(markdownFile);
  if (existing.length > 0 && !options.force) {
    throw new Error(`Revision plan output already exists: ${existing.map((file) => path.relative(root, file)).join(', ')}. Use --force to overwrite.`);
  }
  await mkdir(outputDirPath, { recursive: true });
  await writeJson(jsonFile, plan);
  await writeFile(markdownFile, renderRevisionPlanMarkdown(plan));
  return {
    dir: path.relative(root, outputDirPath),
    files: [
      { file: path.relative(root, jsonFile), format: 'json' },
      { file: path.relative(root, markdownFile), format: 'markdown' }
    ]
  };
}

function renderRevisionReviewMarkdown(review) {
  const lines = [];
  lines.push(`# Revision Review Action List: ${review.queue}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Generated: ${review.generatedAt}`);
  lines.push(`- Plans dir: \`${review.plansDir}\``);
  lines.push(`- Total plan files: ${review.totalPlanFiles}`);
  lines.push(`- Shown plans: ${review.shownPlans}`);
  lines.push(`- Matched plans: ${review.matchedPlans}`);
  lines.push(`- Needs action: ${review.needsActionPlans}`);
  lines.push(`- Applied: ${review.appliedPlans}`);
  lines.push(`- Unapplied: ${review.unappliedPlans}`);
  lines.push(`- Blocked: ${review.blockedPlans}`);
  lines.push(`- Stale: ${review.stalePlans}`);
  lines.push(`- Unreadable: ${review.unreadablePlans}`);
  lines.push(`- Apply report matched: ${review.applyReportMatchedPlans ?? 0}`);
  lines.push(`- Apply report applied: ${review.applyReportAppliedPlans ?? 0}`);
  lines.push(`- Apply report skipped: ${review.applyReportSkippedPlans ?? 0}`);
  lines.push(`- Filter needs action: ${review.filters.needsAction ? 'yes' : 'no'}`);
  lines.push(`- Stale threshold: ${review.filters.staleAfterMs === null ? 'none' : formatDurationApprox(review.filters.staleAfterMs)}`);
  lines.push(`- Applied report: ${review.appliedReport ? `\`${review.appliedReport.file}\`` : 'none'}`);
  if (review.appliedReport) {
    lines.push(`- Applied report generated: ${review.appliedReport.generatedAt ?? 'unknown'}`);
    lines.push(`- Applied report result: applied ${review.appliedReport.appliedCount}, skipped ${review.appliedReport.skippedCount}`);
  }
  lines.push('');
  lines.push('## Plans');
  lines.push('');
  if (review.plans.length === 0) {
    lines.push('No plans matched this review.');
    lines.push('');
    return lines.join('\n');
  }
  for (const plan of review.plans) {
    const age = plan.planAgeMs === null ? 'n/a' : formatDurationApprox(plan.planAgeMs);
    lines.push(`### ${plan.recommendedAction}: ${plan.sourceTaskId ?? plan.file}`);
    lines.push('');
    lines.push(`- File: \`${plan.file}\``);
    lines.push(`- Needs action: ${plan.needsAction ? 'yes' : 'no'}`);
    lines.push(`- Reason: ${plan.actionReason}`);
    lines.push(`- Stale: ${plan.stale ? 'yes' : 'no'}`);
    lines.push(`- Age: ${age}`);
    if (!plan.readable) {
      lines.push(`- Error: ${plan.error}`);
      lines.push('');
      continue;
    }
    lines.push(`- Title: ${plan.title ?? 'n/a'}`);
    lines.push(`- Queue: ${plan.queue ?? 'unknown'}${plan.queueMatches ? '' : ' (mismatch)'}`);
    lines.push(`- Can enqueue: ${plan.canEnqueue ? 'yes' : 'no'}`);
    lines.push(`- Guard allowed: ${plan.guardAllowed ? 'yes' : 'no'}`);
    lines.push(`- Guard reasons: ${formatRevisionPlanList(plan.guardReasons)}`);
    lines.push(`- Revision round: ${plan.revisionRound ?? 'n/a'}`);
    lines.push(`- Revision request: ${plan.revisionRequest ? `\`${plan.revisionRequest}\`` : 'none'}`);
    if (plan.strategyDiffSummary) {
      const s = plan.strategyDiffSummary;
      lines.push(`- Strategy diff: carried ${s.carried_forward_targets}/${s.total_targets}, changed ${s.targets_with_changed_strategy}/${s.total_targets}, needs detail ${s.targets_needing_strategy_detail}`);
    }
    const applyReportEntries = plan.applyReportEntries ?? [];
    if (applyReportEntries.length > 0) {
      lines.push(`- Apply report entries: ${applyReportEntries.map((entry) => {
        if (entry.status === 'applied') return `${entry.status}:${entry.nextTaskId ?? 'unknown'}`;
        return `${entry.status}:${entry.reason ?? 'unknown'}`;
      }).join(', ')}`);
    }
    if (plan.appliedTasks.length > 0) {
      lines.push(`- Applied tasks: ${plan.appliedTasks.map((task) => `${task.taskId}(${task.subdir})`).join(', ')}`);
    } else if (plan.recommendedAction === 'apply_ready' || plan.recommendedAction === 'apply_or_refresh_stale') {
      lines.push(`- Suggested command: \`loop-engineering queue-revision-apply-plan --queue ${review.queue} --plan ${plan.file}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function writeRevisionReviewOutput(root, review, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision review output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision review output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const ext = path.extname(outputFile).toLowerCase();
  if (ext === '.json') {
    await writeJson(outputFile, review);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  if (ext === '.md') {
    await writeFile(outputFile, renderRevisionReviewMarkdown(review));
    return { file: path.relative(root, outputFile), format: 'markdown' };
  }
  throw new Error('Revision review --output must end with .json or .md.');
}

function renderRevisionApplyReportMarkdown(report) {
  const lines = [];
  lines.push(`# Revision Apply Report: ${report.queue}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Review: \`${report.review}\``);
  lines.push(`- Actions: ${report.actions.join(', ')}`);
  lines.push(`- Reviewed plans: ${report.reviewedPlans}`);
  lines.push(`- Applied: ${report.appliedCount}`);
  lines.push(`- Skipped: ${report.skippedCount}`);
  lines.push('');
  lines.push('## Applied');
  lines.push('');
  if (report.applied.length === 0) {
    lines.push('No plans were applied.');
  } else {
    for (const item of report.applied) {
      lines.push(`- \`${item.plan}\` -> \`${item.nextTaskId}\` (${item.file})`);
      lines.push(`  - Source task: \`${item.sourceTaskId ?? 'unknown'}\``);
      lines.push(`  - Action: ${item.action}`);
    }
  }
  lines.push('');
  lines.push('## Skipped');
  lines.push('');
  if (report.skipped.length === 0) {
    lines.push('No plans were skipped.');
  } else {
    for (const item of report.skipped) {
      lines.push(`- \`${item.plan ?? 'unknown'}\`: ${item.reason}`);
      if (item.action) lines.push(`  - Action: ${item.action}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionApplyReportOutput(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision apply report output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision apply report output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const info = { file: path.relative(root, outputFile), format: null };
  const ext = path.extname(outputFile).toLowerCase();
  if (ext === '.json') {
    info.format = 'json';
    await writeJson(outputFile, { ...report, output: info });
    return info;
  }
  if (ext === '.md') {
    info.format = 'markdown';
    await writeFile(outputFile, renderRevisionApplyReportMarkdown({ ...report, output: info }));
    return info;
  }
  throw new Error('Revision apply report --output must end with .json or .md.');
}

async function readWorkspaceJson(root, rel, label) {
  const file = path.resolve(root, safeRelativePath(rel, label));
  return {
    file: path.relative(root, file),
    data: JSON.parse(await readFile(file, 'utf8'))
  };
}

async function readWorkspaceJsonMaybe(root, rel, label) {
  if (!rel) return { file: null, readable: false, data: null, error: 'missing path' };
  const file = path.resolve(root, safeRelativePath(rel, label));
  try {
    return {
      file: path.relative(root, file),
      readable: true,
      data: JSON.parse(await readFile(file, 'utf8')),
      error: null
    };
  } catch (error) {
    return {
      file: path.relative(root, file),
      readable: false,
      data: null,
      error: error.message
    };
  }
}

function summarizeAuditPlan(planArtifact, reviewPlan) {
  const plan = planArtifact.data;
  const summary = plan?.revisionStrategyDiff?.summary ?? plan?.plannedTask?.revisionStrategyDiff?.summary ?? reviewPlan?.strategyDiffSummary ?? null;
  return {
    file: planArtifact.file,
    readable: planArtifact.readable,
    error: planArtifact.error,
    queue: plan?.queue ?? reviewPlan?.queue ?? null,
    generatedAt: plan?.generatedAt ?? reviewPlan?.generatedAt ?? null,
    sourceTaskId: plan?.sourceTaskId ?? plan?.plannedTask?.revisionOf ?? reviewPlan?.sourceTaskId ?? null,
    title: plan?.plannedTask?.title ?? reviewPlan?.title ?? null,
    revisionRequest: plan?.revisionRequest ?? plan?.plannedTask?.revisionRequestPath ?? reviewPlan?.revisionRequest ?? null,
    canEnqueue: plan?.canEnqueue ?? reviewPlan?.canEnqueue ?? null,
    guardAllowed: plan?.revisionPolicyGuard?.allowed ?? reviewPlan?.guardAllowed ?? null,
    guardReasons: plan?.revisionPolicyGuard?.reasons ?? reviewPlan?.guardReasons ?? [],
    revisionRound: plan?.plannedTask?.revisionRound ?? reviewPlan?.revisionRound ?? null,
    strategyDiffSummary: summary
  };
}

function summarizeAuditTask(taskArtifact, expectedPlan) {
  const task = taskArtifact.data;
  return {
    file: taskArtifact.file,
    readable: taskArtifact.readable,
    error: taskArtifact.error,
    taskId: task?.id ?? null,
    title: task?.title ?? null,
    status: task?.status ?? null,
    revisionOf: task?.revisionOf ?? null,
    revisionPlanPath: task?.revisionPlanPath ?? null,
    enqueuedAt: task?.enqueuedAt ?? null,
    pointsToPlan: task?.revisionPlanPath === expectedPlan
  };
}

const AUDIT_TASK_STATE_DIRS = ['inbox', 'active', 'failed', 'done', 'canceled'];

async function listJsonFilesMaybe(dir) {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function findCurrentAuditTask(root, queue, taskId, expectedPlan) {
  if (!taskId) {
    return {
      enabled: true,
      found: false,
      taskId: null,
      location: null,
      file: null,
      status: null,
      readable: false,
      error: 'missing task id',
      revisionPlanPath: null,
      pointsToPlan: false
    };
  }
  const matches = [];
  for (const location of AUDIT_TASK_STATE_DIRS) {
    const dir = queueSubdirFor(root, queue, location);
    for (const fileName of await listJsonFilesMaybe(dir)) {
      const rel = path.relative(root, path.join(dir, fileName));
      const artifact = await readWorkspaceJsonMaybe(root, rel, 'current revision task');
      if (!artifact.readable) continue;
      if (artifact.data?.id !== taskId) continue;
      matches.push({
        enabled: true,
        found: true,
        taskId,
        location,
        file: rel,
        status: artifact.data.status ?? null,
        readable: true,
        error: null,
        revisionOf: artifact.data.revisionOf ?? null,
        revisionPlanPath: artifact.data.revisionPlanPath ?? null,
        pointsToPlan: artifact.data.revisionPlanPath === expectedPlan
      });
    }
  }
  if (matches.length === 0) {
    return {
      enabled: true,
      found: false,
      taskId,
      location: null,
      file: null,
      status: null,
      readable: false,
      error: 'task not found in current queue state',
      revisionOf: null,
      revisionPlanPath: null,
      pointsToPlan: false
    };
  }
  return {
    ...matches[0],
    duplicateMatches: matches.length > 1 ? matches.slice(1).map((item) => ({
      location: item.location,
      file: item.file,
      status: item.status,
      revisionOf: item.revisionOf,
      revisionPlanPath: item.revisionPlanPath,
      pointsToPlan: item.pointsToPlan
    })) : []
  };
}

function countCurrentLocations(chain) {
  const counts = {};
  for (const item of chain) {
    const location = item.currentTask?.location;
    if (!location) continue;
    counts[location] = (counts[location] ?? 0) + 1;
  }
  return counts;
}

function buildRevisionAuditDriftFindings(chain, options = {}) {
  const findings = [];
  const add = (type, severity, item, detail) => {
    findings.push({
      type,
      severity,
      plan: item?.plan ?? null,
      status: item?.status ?? null,
      nextTaskId: item?.reportEntry?.nextTaskId ?? null,
      detail
    });
  };
  for (const item of chain.chain) {
    if (!item.consistency.planInReview) {
      add('plan_not_in_review', 'error', item, 'apply report references a plan that is not present in the review artifact');
    }
    if (!item.consistency.planReadable) {
      add('plan_unreadable', 'error', item, item.planArtifact?.error ?? 'plan JSON could not be read');
    }
    if (!item.consistency.queueMatches) {
      add('queue_mismatch', 'error', item, `plan queue ${item.planArtifact?.queue ?? 'unknown'} does not match audit queue ${chain.queue}`);
    }
    if (item.status === 'applied' && item.consistency.taskReadable === false && !options.verifyCurrent) {
      add('result_task_unreadable', 'warning', item, item.resultTask?.error ?? 'result task JSON could not be read at the apply-report path');
    }
    if (item.status === 'applied' && item.consistency.taskReadable === true && item.consistency.taskPointsToPlan === false) {
      add('result_task_plan_mismatch', 'error', item, 'result task revisionPlanPath does not point to the audited plan');
    }
    if (item.status === 'applied' && item.consistency.sourceTaskMatches === false) {
      add('source_task_mismatch', 'error', item, 'result task revisionOf does not match the apply-report source task');
    }
    if (options.verifyCurrent && item.status === 'applied' && item.consistency.currentSourceTaskMatches === false) {
      add('current_source_task_mismatch', 'error', item, 'current task revisionOf does not match the apply-report source task');
    }
    if (options.verifyCurrent && item.status === 'applied' && item.consistency.currentTaskFound === false) {
      add('current_task_missing', 'error', item, item.currentTask?.error ?? 'current queue scan did not find the result task');
    }
    if (options.verifyCurrent && item.status === 'applied' && item.consistency.currentTaskFound === true && item.consistency.currentTaskPointsToPlan === false) {
      add('current_task_plan_mismatch', 'error', item, 'current task revisionPlanPath does not point to the audited plan');
    }
    if (options.verifyCurrent && item.currentTask?.duplicateMatches?.length > 0) {
      add('current_task_duplicate', 'error', item, `current queue scan found ${item.currentTask.duplicateMatches.length + 1} tasks with the same id`);
    }
  }
  for (const plan of chain.unreportedReviewPlans) {
    if (plan.needsAction) {
      findings.push({
        type: 'unreported_actionable_review_plan',
        severity: 'warning',
        plan: plan.file,
        status: null,
        nextTaskId: null,
        detail: plan.actionReason ?? 'review plan did not appear in the apply report'
      });
    }
  }
  return findings;
}

function normalizeRevisionAuditDriftSeverity(value) {
  if (value === undefined || value === null || value === '') return 'error';
  const severity = String(value).trim().toLowerCase();
  if (severity === 'error' || severity === 'warning') return severity;
  throw new Error(`Invalid drift severity: ${value}. Expected error or warning.`);
}

function normalizeRevisionAuditDriftSummaryFormat(value) {
  if (value === undefined || value === null || value === '') return 'default';
  const format = String(value).trim().toLowerCase();
  if (format === 'default' || format === 'github') return format;
  throw new Error(`Invalid drift summary format: ${value}. Expected default or github.`);
}

function revisionAuditDriftFails(findings, severity) {
  if (severity === 'warning') return findings.some((finding) => finding.severity === 'error' || finding.severity === 'warning');
  return findings.some((finding) => finding.severity === 'error');
}

async function applyRevisionAuditDriftBaseline(root, chain, baselinePath) {
  if (!baselinePath) return null;
  const artifact = await readWorkspaceJson(root, baselinePath, 'revision drift baseline');
  const baseline = artifact.data;
  if (!baseline || typeof baseline !== 'object') throw new Error('Revision drift baseline must be a JSON object.');
  const baselineQueue = typeof baseline.queue === 'string' ? baseline.queue : null;
  if (baselineQueue && baselineQueue !== chain.queue) {
    throw new Error(`Revision drift baseline queue ${baselineQueue} does not match current queue ${chain.queue}.`);
  }
  const baselineFindings = Array.isArray(baseline.drift?.findings)
    ? baseline.drift.findings
    : (Array.isArray(baseline.findings) ? baseline.findings : null);
  if (!baselineFindings) {
    throw new Error('Revision drift baseline must contain drift.findings[] or findings[].');
  }
  const baselineKeys = new Set(baselineFindings.map(revisionAuditDriftFindingKey));
  const findings = chain.drift.findings.map((finding) => {
    const key = revisionAuditDriftFindingKey(finding);
    return {
      ...finding,
      baselineKnown: baselineKeys.has(key),
      baselineKey: key
    };
  });
  const newFindings = findings.filter((finding) => !finding.baselineKnown);
  const newBlockingFindings = newFindings.filter((finding) => !finding.allowed);
  chain.drift = {
    ...chain.drift,
    findings,
    failed: revisionAuditDriftFails(newBlockingFindings, chain.drift.failSeverity),
    baseline: {
      file: artifact.file,
      queue: baselineQueue,
      generatedAt: baseline.generatedAt ?? null,
      findingCount: baselineFindings.length,
      knownCount: findings.filter((finding) => finding.baselineKnown).length,
      newCount: newFindings.length
    },
    baselineKnownCount: findings.filter((finding) => finding.baselineKnown).length,
    newCount: newFindings.length,
    newErrorCount: newFindings.filter((finding) => finding.severity === 'error').length,
    newWarningCount: newFindings.filter((finding) => finding.severity === 'warning').length,
    newBlockingErrorCount: newBlockingFindings.filter((finding) => finding.severity === 'error').length,
    newBlockingWarningCount: newBlockingFindings.filter((finding) => finding.severity === 'warning').length
  };
  return chain.drift.baseline;
}

function revisionAuditDriftFindingKey(finding) {
  return [
    finding?.severity ?? '',
    finding?.type ?? '',
    finding?.plan ?? '',
    finding?.nextTaskId ?? ''
  ].join('\x1f');
}

function normalizeRevisionAuditBaselineFindings(source, file) {
  const findings = Array.isArray(source?.drift?.findings)
    ? source.drift.findings
    : (Array.isArray(source?.findings) ? source.findings : null);
  if (!findings) {
    throw new Error(`Revision drift baseline source ${file} must contain drift.findings[] or findings[].`);
  }
  return findings.map((finding) => ({
    severity: finding?.severity ?? null,
    type: finding?.type ?? null,
    plan: finding?.plan ?? null,
    nextTaskId: finding?.nextTaskId ?? null,
    status: finding?.status ?? null,
    detail: finding?.detail ?? null,
    allowed: Boolean(finding?.allowed),
    allow: finding?.allow ?? null,
    sourceBaselineKnown: Boolean(finding?.baselineKnown),
    baselineKey: revisionAuditDriftFindingKey(finding)
  }));
}

function buildRevisionCiBaselineArtifact(sourceArtifact) {
  const source = sourceArtifact.data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Revision drift baseline source ${sourceArtifact.file} must be a JSON object.`);
  }
  const queue = typeof source.queue === 'string' ? source.queue : null;
  if (!queue) {
    throw new Error(`Revision drift baseline source ${sourceArtifact.file} must include queue.`);
  }
  const findings = normalizeRevisionAuditBaselineFindings(source, sourceArtifact.file);
  return {
    mode: 'revision_drift_baseline',
    generatedAt: new Date().toISOString(),
    queue,
    source: {
      file: sourceArtifact.file,
      mode: source.mode ?? null,
      generatedAt: source.generatedAt ?? null,
      verification: source.verification ?? null,
      review: source.review ?? null,
      applyReport: source.applyReport ?? null
    },
    totals: {
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      allowed: findings.filter((finding) => finding.allowed).length,
      sourceBaselineKnown: findings.filter((finding) => finding.sourceBaselineKnown).length
    },
    drift: {
      findings
    },
    findings
  };
}

async function writeRevisionCiBaselineArtifact(root, artifact, output, options = {}) {
  if (!output) throw new Error('queue-revision-ci-baseline-update requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision drift baseline output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision drift baseline output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  if (path.extname(outputFile).toLowerCase() !== '.json') {
    throw new Error('queue-revision-ci-baseline-update --output must end with .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const info = {
    file: path.relative(root, outputFile),
    format: 'json'
  };
  await writeJson(outputFile, { ...artifact, output: info });
  return info;
}

function normalizeRevisionAuditDriftAllow(value) {
  return [...parseCsvSet(value)].sort();
}

function parseRevisionAuditDriftAllowFileEntries(data, file) {
  const rawEntries = Array.isArray(data)
    ? data
    : data?.allowed ?? data?.allow ?? data?.entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`Revision audit drift allow file ${file} must be an array or an object with allowed[].`);
  }
  const now = Date.now();
  return rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} must be an object.`);
    }
    const type = String(entry.type ?? '').trim();
    const reason = String(entry.reason ?? '').trim();
    const owner = String(entry.owner ?? '').trim();
    const expiresAt = String(entry.expiresAt ?? '').trim();
    if (!type) throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} is missing type.`);
    if (!reason) throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} is missing reason.`);
    if (!owner) throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} is missing owner.`);
    if (!expiresAt) throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} is missing expiresAt.`);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error(`Revision audit drift allow entry ${index + 1} in ${file} has invalid expiresAt: ${expiresAt}`);
    }
    const expired = expiresAtMs <= now;
    return {
      type,
      source: 'file',
      file,
      reason,
      owner,
      expiresAt,
      active: !expired,
      expired
    };
  });
}

async function loadRevisionAuditDriftAllowPolicy(root, options = {}) {
  const entries = normalizeRevisionAuditDriftAllow(options.driftAllow).map((type) => ({
    type,
    source: 'cli',
    file: null,
    reason: null,
    owner: null,
    expiresAt: null,
    active: true,
    expired: false
  }));
  let file = null;
  if (options.driftAllowFile) {
    const artifact = await readWorkspaceJson(root, options.driftAllowFile, 'revision audit drift allow file');
    file = artifact.file;
    entries.push(...parseRevisionAuditDriftAllowFileEntries(artifact.data, artifact.file));
  }
  const activeTypes = [...new Set(entries.filter((entry) => entry.active).map((entry) => entry.type))].sort();
  return {
    file,
    activeTypes,
    entries
  };
}

async function buildRevisionAuditChain(root, reviewPath, applyReportPath, options = {}) {
  const reviewArtifact = await readWorkspaceJson(root, reviewPath, 'revision review');
  const reportArtifact = await readWorkspaceJson(root, applyReportPath, 'revision apply report');
  const review = reviewArtifact.data;
  const report = reportArtifact.data;
  if (!review || typeof review !== 'object') throw new Error('Revision review must be a JSON object.');
  if (!report || typeof report !== 'object') throw new Error('Revision apply report must be a JSON object.');
  if (typeof review.queue !== 'string' || !review.queue.trim()) throw new Error('Revision review is missing queue.');
  if (typeof report.queue !== 'string' || !report.queue.trim()) throw new Error('Revision apply report is missing queue.');
  if (review.queue !== report.queue) {
    throw new Error(`Revision review queue ${review.queue} does not match apply report queue ${report.queue}.`);
  }
  if (!Array.isArray(review.plans)) throw new Error('Revision review is missing plans array.');
  if (!Array.isArray(report.applied)) throw new Error('Revision apply report is missing applied array.');
  if (!Array.isArray(report.skipped)) throw new Error('Revision apply report is missing skipped array.');

  const reviewByPlan = new Map(review.plans.map((plan) => [plan.file, plan]));
  const reportEntries = [
    ...report.applied.map((item) => ({ ...item, status: 'applied', skipReason: null })),
    ...report.skipped.map((item) => ({ ...item, status: 'skipped', skipReason: item.reason ?? null }))
  ];
  const reportPlanSet = new Set(reportEntries.map((item) => item.plan).filter(Boolean));
  const chain = [];

  for (const entry of reportEntries) {
    const reviewPlan = reviewByPlan.get(entry.plan) ?? null;
    const planArtifact = await readWorkspaceJsonMaybe(root, entry.plan, 'revision plan');
    const taskArtifact = entry.status === 'applied'
      ? await readWorkspaceJsonMaybe(root, entry.file, 'revision task')
      : { file: entry.file ?? null, readable: false, data: null, error: entry.skipReason ?? 'not applied' };
    const plan = summarizeAuditPlan(planArtifact, reviewPlan);
    const task = entry.status === 'applied' ? summarizeAuditTask(taskArtifact, entry.plan) : null;
    const currentTask = options.verifyCurrent && entry.status === 'applied'
      ? await findCurrentAuditTask(root, report.queue, entry.nextTaskId, entry.plan)
      : null;
    const consistency = {
      planInReview: Boolean(reviewPlan),
      planReadable: plan.readable,
      taskReadable: entry.status === 'applied' ? task.readable : null,
      taskPointsToPlan: entry.status === 'applied' ? task.pointsToPlan : null,
      sourceTaskMatches: entry.status === 'applied'
        ? (task.readable ? task.revisionOf === (entry.sourceTaskId ?? plan.sourceTaskId ?? null) : null)
        : null,
      queueMatches: plan.queue === report.queue,
      currentTaskFound: currentTask ? currentTask.found : null,
      currentTaskPointsToPlan: currentTask ? currentTask.pointsToPlan : null,
      currentSourceTaskMatches: currentTask?.found
        ? currentTask.revisionOf === (entry.sourceTaskId ?? plan.sourceTaskId ?? null)
        : null
    };
    chain.push({
      plan: entry.plan ?? null,
      status: entry.status,
      action: entry.action ?? null,
      skipReason: entry.skipReason,
      review: reviewPlan ? {
        recommendedAction: reviewPlan.recommendedAction ?? null,
        needsAction: reviewPlan.needsAction ?? null,
        actionReason: reviewPlan.actionReason ?? null,
        stale: reviewPlan.stale ?? null,
        applied: reviewPlan.applied ?? null
      } : null,
      planArtifact: plan,
      resultTask: task,
      reportEntry: {
        sourceTaskId: entry.sourceTaskId ?? null,
        nextTaskId: entry.nextTaskId ?? null,
        file: entry.file ?? null,
        reason: entry.skipReason
      },
      consistency
    });
    chain[chain.length - 1].currentTask = currentTask;
  }

  const totals = {
    reviewPlans: review.plans.length,
    reportEntries: reportEntries.length,
    applied: chain.filter((item) => item.status === 'applied').length,
    skipped: chain.filter((item) => item.status === 'skipped').length,
    linkedTasks: chain.filter((item) => item.resultTask?.readable).length,
    missingTasks: chain.filter((item) => item.status === 'applied' && !item.resultTask?.readable).length,
    taskPlanPathMismatches: chain.filter((item) => item.status === 'applied' && item.resultTask?.readable && !item.resultTask.pointsToPlan).length,
    plansNotInReview: chain.filter((item) => !item.consistency.planInReview).length,
    unreadablePlans: chain.filter((item) => !item.consistency.planReadable).length,
    unreportedReviewPlans: review.plans.filter((plan) => !reportPlanSet.has(plan.file)).length,
    currentTasksFound: options.verifyCurrent ? chain.filter((item) => item.currentTask?.found).length : null,
    currentTasksMissing: options.verifyCurrent ? chain.filter((item) => item.status === 'applied' && !item.currentTask?.found).length : null,
    currentTaskPlanPathMismatches: options.verifyCurrent ? chain.filter((item) => item.currentTask?.found && !item.currentTask.pointsToPlan).length : null,
    currentTaskLocations: options.verifyCurrent ? countCurrentLocations(chain) : null
  };
  const driftSeverity = normalizeRevisionAuditDriftSeverity(options.driftSeverity);
  const allowPolicy = await loadRevisionAuditDriftAllowPolicy(root, options);
  const allowedTypes = allowPolicy.activeTypes;

  const result = {
    mode: 'revision_audit_chain',
    generatedAt: new Date().toISOString(),
    queue: review.queue,
    verification: {
      currentState: Boolean(options.verifyCurrent),
      failOnDrift: Boolean(options.failOnDrift),
      driftSeverity,
      driftAllow: allowedTypes,
      driftAllowFile: allowPolicy.file
    },
    review: {
      file: reviewArtifact.file,
      generatedAt: review.generatedAt ?? null,
      plansDir: review.plansDir ?? null,
      totalPlanFiles: review.totalPlanFiles ?? null,
      shownPlans: review.shownPlans ?? review.plans.length,
      filters: review.filters ?? null
    },
    applyReport: {
      file: reportArtifact.file,
      generatedAt: report.generatedAt ?? null,
      review: report.review ?? null,
      actions: Array.isArray(report.actions) ? report.actions : [],
      reviewedPlans: report.reviewedPlans ?? null,
      appliedCount: report.appliedCount ?? report.applied.length,
      skippedCount: report.skippedCount ?? report.skipped.length
    },
    totals,
    chain,
    unreportedReviewPlans: review.plans
      .filter((plan) => !reportPlanSet.has(plan.file))
      .map((plan) => ({
        file: plan.file,
        recommendedAction: plan.recommendedAction ?? null,
        needsAction: plan.needsAction ?? null,
        actionReason: plan.actionReason ?? null
      }))
  };
  const driftFindings = buildRevisionAuditDriftFindings(result, {
    verifyCurrent: Boolean(options.verifyCurrent)
  });
  const activeAllowByType = new Map();
  for (const entry of allowPolicy.entries) {
    if (!entry.active || activeAllowByType.has(entry.type)) continue;
    activeAllowByType.set(entry.type, entry);
  }
  const findings = driftFindings.map((finding) => {
    const allow = activeAllowByType.get(finding.type) ?? null;
    return {
      ...finding,
      allowed: Boolean(allow),
      allow: allow ? {
        source: allow.source,
        file: allow.file,
        reason: allow.reason,
        owner: allow.owner,
        expiresAt: allow.expiresAt
      } : null
    };
  });
  const blockingFindings = findings.filter((finding) => !finding.allowed);
  result.drift = {
    failed: revisionAuditDriftFails(blockingFindings, driftSeverity),
    failSeverity: driftSeverity,
    allowedTypes,
    allowPolicy,
    allowedCount: findings.filter((finding) => finding.allowed).length,
    errorCount: findings.filter((finding) => finding.severity === 'error').length,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
    blockingErrorCount: blockingFindings.filter((finding) => finding.severity === 'error').length,
    blockingWarningCount: blockingFindings.filter((finding) => finding.severity === 'warning').length,
    findings
  };
  return result;
}

function renderRevisionAuditChainMarkdown(chain) {
  const lines = [];
  lines.push(`# Revision Audit Chain: ${chain.queue}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Generated: ${chain.generatedAt}`);
  lines.push(`- Review: \`${chain.review.file}\``);
  lines.push(`- Apply report: \`${chain.applyReport.file}\``);
  lines.push(`- Review plans: ${chain.totals.reviewPlans}`);
  lines.push(`- Report entries: ${chain.totals.reportEntries}`);
  lines.push(`- Applied: ${chain.totals.applied}`);
  lines.push(`- Skipped: ${chain.totals.skipped}`);
  lines.push(`- Linked tasks: ${chain.totals.linkedTasks}`);
  lines.push(`- Missing tasks: ${chain.totals.missingTasks}`);
  lines.push(`- Task plan path mismatches: ${chain.totals.taskPlanPathMismatches}`);
  lines.push(`- Plans not in review: ${chain.totals.plansNotInReview}`);
  lines.push(`- Unreadable plans: ${chain.totals.unreadablePlans}`);
  lines.push(`- Unreported review plans: ${chain.totals.unreportedReviewPlans}`);
  lines.push(`- Verify current state: ${chain.verification.currentState ? 'yes' : 'no'}`);
  lines.push(`- Fail on drift: ${chain.verification.failOnDrift ? 'yes' : 'no'}`);
  lines.push(`- Drift fail severity: ${chain.drift.failSeverity}`);
  lines.push(`- Drift allow: ${chain.drift.allowedTypes.length ? chain.drift.allowedTypes.join(', ') : 'none'}`);
  lines.push(`- Drift allow file: ${chain.verification.driftAllowFile ? `\`${chain.verification.driftAllowFile}\`` : 'none'}`);
  lines.push(`- Drift allow entries: active ${chain.drift.allowPolicy.entries.filter((entry) => entry.active).length}, expired ${chain.drift.allowPolicy.entries.filter((entry) => entry.expired).length}`);
  lines.push(`- Drift status: ${chain.drift.failed ? 'fail' : 'ok'}`);
  lines.push(`- Drift findings: errors ${chain.drift.errorCount}, warnings ${chain.drift.warningCount}, allowed ${chain.drift.allowedCount}`);
  lines.push(`- Blocking drift findings: errors ${chain.drift.blockingErrorCount}, warnings ${chain.drift.blockingWarningCount}`);
  if (chain.verification.currentState) {
    lines.push(`- Current tasks found: ${chain.totals.currentTasksFound}`);
    lines.push(`- Current tasks missing: ${chain.totals.currentTasksMissing}`);
    lines.push(`- Current task plan path mismatches: ${chain.totals.currentTaskPlanPathMismatches}`);
    lines.push(`- Current task locations: ${Object.entries(chain.totals.currentTaskLocations ?? {}).map(([location, count]) => `${location}=${count}`).join(', ') || 'none'}`);
  }
  lines.push('');
  if (chain.drift.findings.length > 0) {
    lines.push('## Drift Findings');
    lines.push('');
    for (const finding of chain.drift.findings) {
      const allowed = finding.allowed ? ' (allowed)' : '';
      lines.push(`- ${finding.severity} \`${finding.type}\`${allowed} ${finding.plan ? `for \`${finding.plan}\`` : ''}: ${finding.detail}`);
      if (finding.allow) {
        lines.push(`  - Allow: ${finding.allow.reason ?? 'no reason'}; owner=${finding.allow.owner ?? 'n/a'}; expiresAt=${finding.allow.expiresAt ?? 'none'}; source=${finding.allow.source}`);
      }
    }
    lines.push('');
  }
  lines.push('## Chain');
  lines.push('');
  if (chain.chain.length === 0) {
    lines.push('No apply report entries found.');
    lines.push('');
  }
  for (const item of chain.chain) {
    lines.push(`### ${item.status}: ${item.plan ?? 'unknown'}`);
    lines.push('');
    lines.push(`- Action: ${item.action ?? 'n/a'}`);
    if (item.skipReason) lines.push(`- Skip reason: ${item.skipReason}`);
    lines.push(`- In review: ${item.consistency.planInReview ? 'yes' : 'no'}`);
    lines.push(`- Plan readable: ${item.consistency.planReadable ? 'yes' : 'no'}`);
    lines.push(`- Queue matches: ${item.consistency.queueMatches ? 'yes' : 'no'}`);
    if (item.review) {
      lines.push(`- Review action: ${item.review.recommendedAction ?? 'n/a'}`);
      lines.push(`- Review reason: ${item.review.actionReason ?? 'n/a'}`);
    }
    if (item.planArtifact.readable) {
      lines.push(`- Plan title: ${item.planArtifact.title ?? 'n/a'}`);
      lines.push(`- Source task: \`${item.planArtifact.sourceTaskId ?? 'unknown'}\``);
      lines.push(`- Revision request: ${item.planArtifact.revisionRequest ? `\`${item.planArtifact.revisionRequest}\`` : 'none'}`);
      lines.push(`- Guard: ${formatRevisionPlanList(item.planArtifact.guardReasons)}`);
    } else {
      lines.push(`- Plan error: ${item.planArtifact.error ?? 'unknown'}`);
    }
    if (item.status === 'applied') {
      lines.push(`- Result task: \`${item.reportEntry.nextTaskId ?? 'unknown'}\``);
      lines.push(`- Result task file: ${item.reportEntry.file ? `\`${item.reportEntry.file}\`` : 'none'}`);
      lines.push(`- Task readable: ${item.consistency.taskReadable ? 'yes' : 'no'}`);
      lines.push(`- Task points to plan: ${item.consistency.taskPointsToPlan ? 'yes' : 'no'}`);
      lines.push(`- Source task matches: ${item.consistency.sourceTaskMatches ? 'yes' : 'no'}`);
      if (chain.verification.currentState) {
        lines.push(`- Current task found: ${item.consistency.currentTaskFound ? 'yes' : 'no'}`);
        if (item.currentTask?.found) {
          lines.push(`- Current task location: \`${item.currentTask.location}\``);
          lines.push(`- Current task status: ${item.currentTask.status ?? 'n/a'}`);
          lines.push(`- Current task file: \`${item.currentTask.file}\``);
          lines.push(`- Current task points to plan: ${item.consistency.currentTaskPointsToPlan ? 'yes' : 'no'}`);
          lines.push(`- Current source task matches: ${item.consistency.currentSourceTaskMatches ? 'yes' : 'no'}`);
        } else {
          lines.push(`- Current task error: ${item.currentTask?.error ?? 'not checked'}`);
        }
      }
    }
    lines.push('');
  }
  if (chain.unreportedReviewPlans.length > 0) {
    lines.push('## Unreported Review Plans');
    lines.push('');
    for (const plan of chain.unreportedReviewPlans) {
      lines.push(`- \`${plan.file}\`: ${plan.recommendedAction ?? 'unknown'} (${plan.actionReason ?? 'no reason'})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function writeRevisionAuditChainOutput(root, chain, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision audit chain output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision audit chain output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const info = { file: path.relative(root, outputFile), format: null };
  const ext = path.extname(outputFile).toLowerCase();
  if (ext === '.json') {
    info.format = 'json';
    await writeJson(outputFile, { ...chain, output: info });
    return info;
  }
  if (ext === '.md') {
    info.format = 'markdown';
    await writeFile(outputFile, renderRevisionAuditChainMarkdown({ ...chain, output: info }));
    return info;
  }
  throw new Error('Revision audit chain --output must end with .json or .md.');
}

function buildRevisionAuditDriftReport(chain) {
  return {
    mode: 'revision_audit_drift_report',
    generatedAt: new Date().toISOString(),
    queue: chain.queue,
    verification: chain.verification,
    review: chain.review,
    applyReport: chain.applyReport,
    totals: {
      reportEntries: chain.totals.reportEntries,
      applied: chain.totals.applied,
      skipped: chain.totals.skipped,
      missingTasks: chain.totals.missingTasks,
      taskPlanPathMismatches: chain.totals.taskPlanPathMismatches,
      plansNotInReview: chain.totals.plansNotInReview,
      unreadablePlans: chain.totals.unreadablePlans,
      unreportedReviewPlans: chain.totals.unreportedReviewPlans,
      currentTasksFound: chain.totals.currentTasksFound,
      currentTasksMissing: chain.totals.currentTasksMissing,
      currentTaskPlanPathMismatches: chain.totals.currentTaskPlanPathMismatches,
      currentTaskLocations: chain.totals.currentTaskLocations
    },
    drift: chain.drift,
    findings: chain.drift.findings
  };
}

function renderRevisionAuditDriftReportMarkdown(report) {
  const lines = [];
  lines.push(`# Revision Drift Report: ${report.queue}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Review: \`${report.review.file}\``);
  lines.push(`- Apply report: \`${report.applyReport.file}\``);
  lines.push(`- Verify current state: ${report.verification.currentState ? 'yes' : 'no'}`);
  lines.push(`- Fail on drift: ${report.verification.failOnDrift ? 'yes' : 'no'}`);
  lines.push(`- Drift fail severity: ${report.drift.failSeverity}`);
  lines.push(`- Drift allow: ${report.drift.allowedTypes.length ? report.drift.allowedTypes.join(', ') : 'none'}`);
  lines.push(`- Drift allow file: ${report.verification.driftAllowFile ? `\`${report.verification.driftAllowFile}\`` : 'none'}`);
  lines.push(`- Drift allow entries: active ${report.drift.allowPolicy.entries.filter((entry) => entry.active).length}, expired ${report.drift.allowPolicy.entries.filter((entry) => entry.expired).length}`);
  lines.push(`- Drift status: ${report.drift.failed ? 'fail' : 'ok'}`);
  lines.push(`- Errors: ${report.drift.errorCount}`);
  lines.push(`- Warnings: ${report.drift.warningCount}`);
  lines.push(`- Allowed findings: ${report.drift.allowedCount}`);
  lines.push(`- Blocking errors: ${report.drift.blockingErrorCount}`);
  lines.push(`- Blocking warnings: ${report.drift.blockingWarningCount}`);
  lines.push(`- Report entries: ${report.totals.reportEntries}`);
  lines.push(`- Plans not in review: ${report.totals.plansNotInReview}`);
  lines.push(`- Unreadable plans: ${report.totals.unreadablePlans}`);
  lines.push(`- Unreported review plans: ${report.totals.unreportedReviewPlans}`);
  if (report.verification.currentState) {
    lines.push(`- Current tasks missing: ${report.totals.currentTasksMissing}`);
    lines.push(`- Current task plan path mismatches: ${report.totals.currentTaskPlanPathMismatches}`);
    lines.push(`- Current task locations: ${Object.entries(report.totals.currentTaskLocations ?? {}).map(([location, count]) => `${location}=${count}`).join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No drift findings.');
  } else {
    for (const finding of report.findings) {
      const task = finding.nextTaskId ? ` nextTaskId=\`${finding.nextTaskId}\`` : '';
      const allowed = finding.allowed ? ' allowed=yes' : ' allowed=no';
      lines.push(`- ${finding.severity} \`${finding.type}\` ${finding.plan ? `plan=\`${finding.plan}\`` : 'plan=unknown'}${task}${allowed}`);
      lines.push(`  - Detail: ${finding.detail}`);
      if (finding.allow) {
        lines.push(`  - Allow: ${finding.allow.reason ?? 'no reason'}; owner=${finding.allow.owner ?? 'n/a'}; expiresAt=${finding.allow.expiresAt ?? 'none'}; source=${finding.allow.source}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderRevisionAuditDriftReportGithubMarkdown(report) {
  const lines = [];
  const status = report.drift.failed ? 'FAIL' : 'OK';
  const blockingTotal = report.drift.blockingErrorCount + report.drift.blockingWarningCount;
  const totalFindings = report.drift.errorCount + report.drift.warningCount;
  lines.push(`# Revision Drift Summary: ${report.queue}`);
  lines.push('');
  lines.push(`**Status:** ${status}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Blocking findings | ${blockingTotal} |`);
  lines.push(`| Blocking errors | ${report.drift.blockingErrorCount} |`);
  lines.push(`| Blocking warnings | ${report.drift.blockingWarningCount} |`);
  if (report.drift.baseline) {
    lines.push(`| Baseline-known findings | ${report.drift.baselineKnownCount ?? 0} |`);
    lines.push(`| New findings | ${report.drift.newCount ?? 0} |`);
    lines.push(`| New blocking errors | ${report.drift.newBlockingErrorCount ?? 0} |`);
    lines.push(`| New blocking warnings | ${report.drift.newBlockingWarningCount ?? 0} |`);
  }
  lines.push(`| Total findings | ${totalFindings} |`);
  lines.push(`| Allowed findings | ${report.drift.allowedCount} |`);
  lines.push(`| Report entries | ${report.totals.reportEntries} |`);
  lines.push(`| Applied | ${report.totals.applied} |`);
  lines.push(`| Skipped | ${report.totals.skipped} |`);
  if (report.verification.currentState) {
    lines.push(`| Current tasks missing | ${report.totals.currentTasksMissing ?? 0} |`);
    lines.push(`| Current task plan mismatches | ${report.totals.currentTaskPlanPathMismatches ?? 0} |`);
  }
  lines.push('');
  lines.push('## Settings');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Review: \`${report.review.file}\``);
  lines.push(`- Apply report: \`${report.applyReport.file}\``);
  lines.push(`- Verify current state: ${report.verification.currentState ? 'yes' : 'no'}`);
  lines.push(`- Fail on drift: ${report.verification.failOnDrift ? 'yes' : 'no'}`);
  lines.push(`- Fail severity: ${report.drift.failSeverity}`);
  lines.push(`- Allow types: ${report.drift.allowedTypes.length ? report.drift.allowedTypes.map((type) => `\`${type}\``).join(', ') : 'none'}`);
  if (report.verification.driftAllowFile) {
    lines.push(`- Allow file: \`${report.verification.driftAllowFile}\``);
  }
  if (report.drift.baseline) {
    lines.push(`- Baseline: \`${report.drift.baseline.file}\` (${report.drift.baseline.findingCount} findings)`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No drift findings.');
  } else if (report.drift.baseline) {
    lines.push('| Severity | Allowed | Baseline | Type | Plan | Detail |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const finding of report.findings.slice(0, 20)) {
      lines.push(`| ${finding.severity} | ${finding.allowed ? 'yes' : 'no'} | ${finding.baselineKnown ? 'known' : 'new'} | \`${finding.type}\` | ${finding.plan ? `\`${finding.plan}\`` : 'unknown'} | ${markdownTableCell(finding.detail)} |`);
    }
  } else {
    lines.push('| Severity | Allowed | Type | Plan | Detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const finding of report.findings.slice(0, 20)) {
      lines.push(`| ${finding.severity} | ${finding.allowed ? 'yes' : 'no'} | \`${finding.type}\` | ${finding.plan ? `\`${finding.plan}\`` : 'unknown'} | ${markdownTableCell(finding.detail)} |`);
    }
    if (report.findings.length > 20) {
      lines.push('');
      lines.push(`Showing 20 of ${report.findings.length} findings. See the JSON audit artifact for the full list.`);
    }
    const allowedFindings = report.findings.filter((finding) => finding.allow);
    if (allowedFindings.length > 0) {
      lines.push('');
      lines.push('## Allow Details');
      lines.push('');
      for (const finding of allowedFindings.slice(0, 10)) {
        lines.push(`- \`${finding.type}\` for ${finding.plan ? `\`${finding.plan}\`` : 'unknown'}: ${finding.allow.reason ?? 'no reason'} (owner=${finding.allow.owner ?? 'n/a'}, expiresAt=${finding.allow.expiresAt ?? 'none'})`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function markdownTableCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

async function writeRevisionAuditDriftReportOutput(root, chain, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision audit drift report output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision audit drift report output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const info = { file: path.relative(root, outputFile), format: null };
  const summaryFormat = normalizeRevisionAuditDriftSummaryFormat(options.summaryFormat);
  const report = buildRevisionAuditDriftReport(chain);
  const ext = path.extname(outputFile).toLowerCase();
  if (ext === '.json') {
    info.format = 'json';
    info.summaryFormat = summaryFormat;
    await writeJson(outputFile, { ...report, output: info, summaryFormat });
    return info;
  }
  if (ext === '.md') {
    info.format = summaryFormat === 'github' ? 'github-markdown' : 'markdown';
    info.summaryFormat = summaryFormat;
    const renderer = summaryFormat === 'github'
      ? renderRevisionAuditDriftReportGithubMarkdown
      : renderRevisionAuditDriftReportMarkdown;
    await writeFile(outputFile, renderer({ ...report, output: info, summaryFormat }));
    return info;
  }
  throw new Error('Revision audit chain --drift-report must end with .json or .md.');
}

async function appendRevisionAuditGithubStepSummary(root, chain, options = {}) {
  if (!options.enabled) return null;
  const target = String(process.env.GITHUB_STEP_SUMMARY ?? '').trim();
  if (!target) {
    throw new Error('queue-revision-audit-chain --drift-summary-append-github-step requires GITHUB_STEP_SUMMARY.');
  }
  const outputFile = path.resolve(target);
  await mkdir(path.dirname(outputFile), { recursive: true });
  const info = {
    file: displayPath(root, outputFile),
    format: 'github-markdown',
    summaryFormat: 'github',
    append: true
  };
  const report = buildRevisionAuditDriftReport(chain);
  const content = renderRevisionAuditDriftReportGithubMarkdown({
    ...report,
    output: info,
    summaryFormat: 'github'
  });
  await appendFile(outputFile, `${content}\n\n`);
  return info;
}

function displayPath(root, file) {
  const relative = path.relative(root, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return file;
}

function emitRevisionAuditGithubAnnotations(chain, options = {}) {
  if (!options.enabled) return null;
  const findings = chain.drift.findings.filter((finding) => !finding.allowed && !finding.baselineKnown);
  const info = {
    format: 'github-annotations',
    stream: 'stderr',
    emitted: findings.length,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    skippedAllowed: chain.drift.findings.filter((finding) => finding.allowed).length,
    skippedBaselineKnown: chain.drift.findings.filter((finding) => !finding.allowed && finding.baselineKnown).length
  };
  for (const finding of findings) {
    const level = finding.severity === 'error' ? 'error' : 'warning';
    const props = [
      `title=${escapeGithubWorkflowCommandProperty(`loop drift: ${finding.type}`)}`
    ];
    if (finding.plan) props.push(`file=${escapeGithubWorkflowCommandProperty(finding.plan)}`);
    const message = `${finding.detail}${finding.nextTaskId ? ` (nextTaskId=${finding.nextTaskId})` : ''}`;
    console.error(`::${level} ${props.join(',')}::${escapeGithubWorkflowCommandData(message)}`);
  }
  return info;
}

function escapeGithubWorkflowCommandData(value) {
  return String(value ?? '')
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function escapeGithubWorkflowCommandProperty(value) {
  return escapeGithubWorkflowCommandData(value)
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function buildRevisionDriftAllowTemplate(options = {}) {
  const types = [...parseCsvSet(options.type)];
  if (types.length === 0) throw new Error('queue-revision-drift-allow-template requires --type.');
  const owner = String(options.owner ?? process.env.USER ?? process.env.USERNAME ?? 'unknown').trim() || 'unknown';
  const reason = String(options.reason ?? 'TODO: explain why this drift can be temporarily allowed.').trim();
  if (!reason) throw new Error('queue-revision-drift-allow-template reason cannot be empty.');
  const expiresAt = options.expiresAt
    ? String(options.expiresAt).trim()
    : new Date(Date.now() + parseDurationMs(options.ttl ?? '24h', 'ttl')).toISOString();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`Invalid expires-at: ${expiresAt}`);
  }
  if (expiresAtMs <= Date.now()) {
    throw new Error(`expires-at must be in the future: ${expiresAt}`);
  }
  return {
    generatedAt: new Date().toISOString(),
    allowed: types.map((type) => ({
      type,
      reason,
      owner,
      expiresAt
    }))
  };
}

async function writeRevisionDriftAllowTemplateOutput(root, template, output, options = {}) {
  if (!output) throw new Error('queue-revision-drift-allow-template requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision drift allow template output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision drift allow template output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  if (path.extname(outputFile).toLowerCase() !== '.json') {
    throw new Error('queue-revision-drift-allow-template --output must end with .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeJson(outputFile, template);
  return { file: path.relative(root, outputFile), format: 'json' };
}

const HELP = `loop-engineering - verifiable agent work loops

Usage:
  loop-engineering init [--root <workspace>] [--force]
  loop-engineering run --config configs/loops/name.json [--root <workspace>] [--json]
  loop-engineering verify [--config configs/loops/name.json] [--root <workspace>]
  loop-engineering status [--config configs/loops/name.json] [--root <workspace>]
  loop-engineering summarize [--id name | --queue name] [--limit 20] [--root <workspace>] [--json]
  loop-engineering doctor [--root <workspace>] [--json]
  loop-engineering dashboard-inspect [--id todo-id] [--state state] [--query text] [--root <workspace>] [--json]
  loop-engineering dashboard-health [--max-age-seconds 3600] [--root <workspace>] [--json]
  loop-engineering dashboard-export --output-dir directory [--root <workspace>] [--json]
  loop-engineering dashboard-serve [--host 127.0.0.1] [--port 0] [--allow-non-loopback] [--root <workspace>]
  loop-engineering repair-plan --id name [--output repair-plan.json] [--root <workspace>] [--json] [--force]
  loop-engineering project-intake --name project --brief "Project brief" [--type auto|web_app|code_project|research|content|ops|qa|knowledge_base|infra_audit|assistant_workflow] [--queue name] [--check "npm test"] [--root <workspace>] [--json]
  loop-engineering project-plan --project project [--root <workspace>] [--json] [--force]
  loop-engineering project-status --project project [--root <workspace>] [--json]
  loop-engineering enqueue --queue name --title "Title" (--task "Body" | --file task.md) [--root <workspace>]
  loop-engineering route-message --message "User message" [--queue name] [--route --confirm-execute] [--supersede-active | --amend-active] [--source-channel name --source-target id --source-account id --source-message-id id --source-reply-to id] [--root <workspace>] [--json]
  loop-engineering run-queue --config configs/loops/queues/name.json [--progress-notify-command "command"] [--root <workspace>]
  loop-engineering run-queue --queue name --dispatcher "command" [--preflight-config configs/loops/name.json] [--root <workspace>]
  loop-engineering run-queue-drain --config configs/loops/queues/name.json [--max-tasks 100] [--root <workspace>]
  loop-engineering queue-status --queue name [--root <workspace>] [--json]
  loop-engineering queue-park --queue name --task-id id --wait-kind human_input|external_condition --reason "..." [--wait-timeout-ms N --reminder-interval-ms N --escalation-interval-ms N --max-reminders N] [--root <workspace>] [--json]
  loop-engineering action-reserve --idempotency-key key --kind paid_api|notification|deployment|process_control|publication|external_message|gated_mutation --authorization-scope scope --request-json '{}' [--root <workspace>]
  loop-engineering action-claim --idempotency-key key --owner worker [--lease-ms N] [--root <workspace>]
  loop-engineering action-inspect --idempotency-key key [--root <workspace>]
  loop-engineering action-settle --idempotency-key key --fencing-token N [--evidence text] [--root <workspace>]
  loop-engineering action-release --idempotency-key key [--fencing-token N] --reason text [--evidence text] [--root <workspace>]
  loop-engineering action-reconcile --idempotency-key key --outcome accepted|not_accepted --evidence text [--root <workspace>]
  loop-engineering queue-wait-tick --queue name (--notify-command "command" | --dry-run) [--now ISO] [--root <workspace>] [--json]
  loop-engineering queue-wait-resume --queue name --task-id id --verified --recovery-signal "..." [--root <workspace>] [--json]
  loop-engineering queue-terminal-notify --queue name (--notify-command "command" | --dry-run) [--root <workspace>] [--json]
  loop-engineering queue-acceptance-refresh --queue name --task-id id [--root <workspace>] [--json]
  loop-engineering queue-scheduler-tick --queue name [--config configs/loops/queues/name.json] [--plan-only] [--force-due] [--initial-interval 10m] [--min-interval 1m] [--max-interval 4h] [--jitter 30s] [--no-progress-report] [--progress-report-interval 30m] [--progress-notify-command "command"] [--root <workspace>] [--json]
  loop-engineering queue-init --queue name [--root <workspace>] [--force]
  loop-engineering code-queue-init --queue name [--root <workspace>] [--force]
  loop-engineering queue-peek --queue name [--root <workspace>] [--json]
  loop-engineering queue-cancel --queue name --task-id id [--reason "..."] [--root <workspace>]
  loop-engineering queue-requeue --queue name --task-id id [--root <workspace>]
  loop-engineering queue-revision-plan --queue name --task-id id [--title "Title"] [--task "Body"] [--strategy "Changed strategy" | --strategy-file file.md] [--output plan.json|plan.md | --output-dir [dir]] [--force] [--root <workspace>] [--json]
  loop-engineering queue-revision-apply-plan --plan plan.json [--queue name] [--force] [--root <workspace>] [--json]
  loop-engineering queue-revision-apply-plan --from-review action-list.json [--action apply_ready,apply_or_refresh_stale] [--output apply-report.md|apply-report.json] [--queue name] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-review --queue name [--plans-dir dir] [--needs-action] [--stale-after 24h] [--applied-report apply-report.json] [--output action-list.md|action-list.json] [--limit 20] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-audit-chain --review action-list.json --apply-report apply-report.json [--verify-current] [--fail-on-drift] [--drift-severity error|warning] [--drift-allow type,type] [--drift-allow-file drift-allow.json] [--output audit-chain.md|audit-chain.json] [--drift-report drift-report.md|drift-report.json] [--drift-summary-format default|github] [--drift-summary-append-github-step] [--drift-github-annotations] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-check --review action-list.json --apply-report apply-report.json [--baseline previous-audit.json] [--drift-allow type,type] [--drift-allow-file drift-allow.json] [--output audit-chain.md|audit-chain.json] [--drift-report drift-report.md|drift-report.json] [--no-github-step-summary] [--no-github-annotations] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-bootstrap --queue name [--plans-dir dir] [--stale-after 24h] [--action apply_ready,apply_or_refresh_stale] [--output-dir dir] [--baseline-output previous-audit.json] [--drift-allow type,type] [--drift-allow-file drift-allow.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-workflow-template --queue name --output .github/workflows/loop-revision-ci.yml [--output-dir artifact-dir] [--baseline-output previous-audit.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-status-badge --output loop-revision-ci-badge.md [--repo owner/name] [--workflow loop-revision-ci.yml] [--branch main] [--label "Loop Revision CI"] [--queue name] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-readme-update [--readme README.md] [--repo owner/name] [--workflow loop-revision-ci.yml] [--branch main] [--label "Loop Revision CI"] [--queue name] [--section-title "Loop Revision CI"] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-install-guide --queue name --output install-guide.md|install-guide.json [--repo owner/name] [--workflow loop-revision-ci.yml] [--branch main] [--label "Loop Revision CI"] [--readme README.md] [--baseline-output previous-audit.json] [--output-dir artifact-dir] [--drift-allow-file drift-allow.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-self-test --queue name [--output self-test.md|self-test.json] [--repo owner/name] [--workflow loop-revision-ci.yml] [--branch main] [--label "Loop Revision CI"] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-doctor --queue name [--workflow loop-revision-ci.yml|.github/workflows/file.yml] [--readme README.md] [--baseline previous-audit.json] [--output-dir artifact-dir] [--drift-allow-file drift-allow.json] [--output report.md|report.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-repair-plan --queue name [--from doctor.json] [--repo owner/name] [--workflow loop-revision-ci.yml|.github/workflows/file.yml] [--readme README.md] [--baseline previous-audit.json] [--output-dir artifact-dir] [--drift-allow-file drift-allow.json] --output repair-plan.md|repair-plan.json [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-apply-repair-plan --from repair-plan.json --confirm-apply [--action action_id[,action_id]] [--repo owner/name] [--branch main] [--label "Loop Revision CI"] [--output apply-report.md|apply-report.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-health-summary --queue name [--workflow loop-revision-ci.yml|.github/workflows/file.yml] [--readme README.md] [--baseline previous-audit.json] [--drift-allow-file drift-allow.json] [--bootstrap-dir dir] [--repair-plan repair-plan.json] [--apply-report apply-report.json] [--output summary.md|summary.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-dashboard [--queue name] [--workflow loop-revision-ci.yml|.github/workflows/file.yml] [--readme README.md] [--baseline previous-audit.json] [--drift-allow-file drift-allow.json] [--bootstrap-dir dir] [--output dashboard.md|dashboard.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-release-checklist [--queue name] [--workflow loop-revision-ci.yml|.github/workflows/file.yml] [--readme README.md] [--baseline previous-audit.json] [--drift-allow-file drift-allow.json] [--bootstrap-dir dir] [--output release-checklist.md|release-checklist.json] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-ci-baseline-update --from current-audit.json --output previous-audit.json [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-drift-allow-template --type finding_type[,finding_type] --output drift-allow.json [--owner name] [--reason "..."] [--expires-at iso | --ttl 24h] [--root <workspace>] [--json] [--force]
  loop-engineering queue-revision-next --queue name --task-id id [--title "Title"] [--task "Body"] [--strategy "Changed strategy" | --strategy-file file.md] [--force] [--root <workspace>] [--json]
  loop-engineering queue-lineage --queue name --task-id id [--root <workspace>] [--json]
  loop-engineering queue-lineage-bundle --queue name --task-id id [--output review.md] [--force] [--root <workspace>] [--json]
  loop-engineering queue-human-decision --queue name --task-id id --decision approve|request_changes|reject [--comment "..."] [--enqueue-revision] [--strategy "Changed strategy" | --strategy-file file.md] [--force] [--root <workspace>] [--json]
  loop-engineering workflow-metrics --queue name [--limit 100] [--root <workspace>] [--json]
  loop-engineering workflow-tune-plan --queue name [--limit 100] [--root <workspace>] [--json]
  loop-engineering code-worktree-list --queue name [--limit 20] [--root <workspace>] [--json]
  loop-engineering code-worktree-inspect --queue name [--task-id id | --run-id id] [--root <workspace>] [--json]
  loop-engineering code-worktree-diff --queue name [--task-id id | --run-id id] [--root <workspace>] [--json]
  loop-engineering code-worktree-export --queue name [--task-id id | --run-id id] [--output file.patch] [--force] [--root <workspace>] [--json]
  loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/task.patch [--root <workspace>] [--json]
  loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/task.patch [--root <workspace>] [--allow-dirty] [--json]
  loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/task.patch --confirm-apply [--root <workspace>] [--allow-dirty] [--json]
  loop-engineering code-review-bundle --queue name [--task-id id | --run-id id] [--output review.md] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-closeout --queue name [--task-id id | --run-id id] [--output closeout.md] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-autoflow --queue name [--task-id id | --run-id id | --all-actionable] [--until review|closeout] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-finish --queue name [--task-id id | --run-id id] --confirm-apply --confirm-cleanup [--force] [--root <workspace>] [--json]
  loop-engineering code-task-run --queue name --title "Title" (--task "Body" | --file task.md) --confirm-apply --confirm-cleanup [--force] [--root <workspace>] [--json]
  loop-engineering code-task-dashboard --queue name [--limit 20] [--root <workspace>] [--json]
  loop-engineering code-task-status --queue name [--task-id id | --run-id id] [--limit 20] [--root <workspace>] [--json]
  loop-engineering code-worktree-cleanup-plan --queue name [--limit 50] [--root <workspace>] [--json]
  loop-engineering code-worktree-cleanup --queue name --confirm-cleanup [--limit 50] [--include-orphans] [--root <workspace>] [--json]

Exit codes:
  0 success/report-only
  2 breaker escalation or paused loop
  1 invalid spec, command error outside a check, or runtime failure`;

async function runCommand(args) {
  if (!args.config) throw new Error('run requires --config.');
  const root = args.root;
  const { spec, file: specPath } = await loadSpec(root, args.config);
  const state = await loadState(root, spec);
  if (state.paused) {
    const reason = typeof state.pauseReason === 'string' ? state.pauseReason : 'state.paused=true';
    console.error(`Loop ${spec.id} is paused: ${reason}`);
    return 2;
  }

  const runId = `${isoStamp()}_${spec.id}`;
  const startedAt = new Date();
  const results = [];
  let runtimeError = null;

  for (const check of spec.checks) {
    if (Date.now() - startedAt.getTime() > (spec.maxRuntimeMs ?? 120000)) {
      runtimeError = `maxRuntimeMs exceeded before check ${check.id}`;
      break;
    }
    results.push(await runCheck(root, check));
  }

  const checksOk = runtimeError === null && results.every((r) => r.ok);
  const outcome = checksOk ? 'success' : 'failure';
  const signature = runtimeError ? `runtime:${runtimeError}` : failureSignature(results);
  const breaker = applyBreaker(spec, state, outcome, signature);
  const finishedAt = new Date().toISOString();
  const runPath = path.join(runsDirFor(root, spec.id), `${runId}.json`);
  const run = {
    version: 1,
    runId,
    loopId: spec.id,
    goal: spec.goal,
    level: spec.level,
    mode: spec.mode,
    specPath: path.relative(root, specPath),
    startedAt: startedAt.toISOString(),
    finishedAt,
    durationMs: Date.parse(finishedAt) - startedAt.getTime(),
    outcome,
    failureSignature: signature,
    breaker,
    runtimeError,
    checks: results,
    runPath: path.relative(root, runPath)
  };

  await writeJson(runPath, run);
  await writeJson(statePathFor(root, spec.id), nextState(state, run));

  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    console.log(`${spec.id}: ${outcome}${breaker.escalated ? ' (ESCALATED)' : ''}`);
    console.log(`run: ${path.relative(root, runPath)}`);
    if (breaker.escalated || outcome === 'failure') console.log(`reason: ${breaker.reason}`);
  }

  return breaker.escalated ? 2 : 0;
}

async function verifyCommand(args) {
  const files = await configFilesFromArgs(args.root, args.config ? ['--config', args.config] : []);
  if (files.length === 0) throw new Error('No loop configs found.');
  const reports = [];
  for (const file of files) {
    const { spec } = await loadSpec(args.root, file);
    const state = await loadState(args.root, spec);
    const latest = await latestRun(args.root, spec.id);
    reports.push({
      config: file,
      loopId: spec.id,
      level: spec.level,
      mode: spec.mode,
      checks: spec.checks.length,
      stateOk: state.version === 1 && state.loopId === spec.id,
      latestRun: latest?.run?.runId ?? null,
      latestOutcome: latest?.run?.outcome ?? null
    });
  }
  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) {
      const status = r.stateOk ? 'ok' : 'fail';
      console.log(`${status} ${r.loopId} (${r.level}/${r.mode}) checks=${r.checks} latest=${r.latestOutcome ?? 'none'}`);
    }
  }
  return reports.every((r) => r.stateOk) ? 0 : 1;
}

async function statusCommand(args) {
  const files = await configFilesFromArgs(args.root, args.config ? ['--config', args.config] : []);
  if (files.length === 0) throw new Error('No loop configs found.');
  const reports = [];
  for (const file of files) {
    const { spec } = await loadSpec(args.root, file);
    const state = await loadState(args.root, spec);
    const latest = await latestRun(args.root, spec.id);
    reports.push({
      loopId: spec.id,
      goal: spec.goal,
      level: spec.level,
      mode: spec.mode,
      paused: Boolean(state.paused),
      runs: state.runs,
      lastOutcome: state.lastOutcome,
      consecutiveFailures: state.consecutiveFailures,
      latestRun: latest?.file ?? null
    });
  }
  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) {
      console.log(r.loopId);
      console.log(`  goal: ${r.goal}`);
      console.log(`  level/mode: ${r.level}/${r.mode}`);
      console.log(`  paused: ${r.paused ? 'yes' : 'no'}`);
      console.log(`  runs: ${r.runs}`);
      console.log(`  last outcome: ${r.lastOutcome ?? 'none'}`);
      console.log(`  consecutive failures: ${r.consecutiveFailures}`);
      console.log(`  latest run: ${r.latestRun ?? 'none'}`);
    }
  }
  return 0;
}

async function summarizeCommand(args) {
  const summaries = await summarizeLoopRuns(args.root, {
    id: args.id,
    queue: args.queue,
    limit: args.limit ?? 20
  });
  if (args.json) {
    console.log(JSON.stringify(summaries, null, 2));
  } else if (summaries.length === 0) {
    console.log('no run artifacts found');
  } else {
    for (const summary of summaries) {
      console.log(summary.id);
      console.log(`  inspected/readable: ${summary.inspectedRuns}/${summary.readableRuns}`);
      console.log(`  latest: ${summary.latestStatus ?? 'none'} ${summary.latestRun ?? ''}`.trimEnd());
      console.log(`  success rate: ${summary.successRate === null ? 'n/a' : `${summary.successRate}%`}`);
      console.log(`  avg duration: ${summary.averageDurationMs === null ? 'n/a' : `${summary.averageDurationMs}ms`}`);
      console.log(`  counts: ${Object.entries(summary.counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
      if (summary.recentFailures.length > 0) {
        console.log('  recent failures:');
        for (const failure of summary.recentFailures) {
          console.log(`    - ${failure.status} ${failure.file}`);
          if (failure.reason) console.log(`      reason: ${failure.reason}`);
        }
      }
    }
  }
  return 0;
}

async function doctorCommand(args) {
  const report = await doctorReport(args.root, { limit: args.limit ?? 10 });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`loop-engineering doctor: ${report.ok ? 'ok' : 'fail'} (${report.failCount} fail, ${report.warnCount} warn)`);
    for (const check of report.checks) {
      const status = check.ok ? 'ok' : check.level;
      console.log(`${status} ${check.id}`);
      if (!check.ok && check.detail) {
        const detail = typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail);
        console.log(`  ${detail}`);
      }
    }
  }
  return report.failCount > 0 ? 1 : 0;
}

async function repairPlanCommand(args) {
  if (!args.id) throw new Error('repair-plan requires --id.');
  const latest = await latestRun(args.root, args.id);
  if (!latest?.run) throw new Error(`No run artifacts found for loop ${args.id}.`);
  const plan = loopRepairPlan(latest.run);
  if (args.output) {
    const output = path.resolve(args.root, safeRelativePath(args.output, 'repair plan output'));
    if (await fileExists(output) && !args.force) throw new Error(`Repair plan output already exists: ${args.output}. Use --force to overwrite.`);
    if (!output.endsWith('.json')) throw new Error('repair-plan --output must end with .json.');
    await writeJson(output, plan);
    plan.output = path.relative(args.root, output);
  }
  if (args.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`${plan.loopId}: repair plan ${plan.status} (read-only)`);
    if (plan.output) console.log(`output: ${plan.output}`);
    for (const finding of plan.findings) {
      console.log(`  ${finding.checkId}: ${finding.kind}`);
      if (Object.hasOwn(finding, 'expected')) console.log(`    expected: ${JSON.stringify(finding.expected)}`);
      if (Object.hasOwn(finding, 'actual')) console.log(`    actual: ${JSON.stringify(finding.actual)}`);
    }
  }
  return 0;
}

async function initCommand(args) {
  const config = await initWorkspace(args.root, { force: args.force });
  console.log(`initialized loop engineering at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function queueInitCommand(args) {
  if (!args.queue) throw new Error('queue-init requires --queue.');
  const config = await initQueueConfig(args.root, args.queue, { force: args.force });
  console.log(`initialized queue ${args.queue} at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function codeQueueInitCommand(args) {
  if (!args.queue) throw new Error('code-queue-init requires --queue.');
  const config = await initCodeQueueConfig(args.root, args.queue, { force: args.force });
  console.log(`initialized code worktree queue ${args.queue} at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function projectIntakeCommand(args) {
  if (!args.name) throw new Error('project-intake requires --name.');
  if (!args.brief) throw new Error('project-intake requires --brief.');
  const result = await projectIntake(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`project intake: ${result.project}`);
    console.log(`  type: ${result.type}`);
    console.log(`  status: ${result.status}`);
    console.log(`  queue: ${result.queue.queue} (${result.queue.kind})`);
    console.log(`  backlog: ${result.backlogCount}`);
    console.log(`  intake: ${result.intakeFile}`);
    console.log(`  plan: ${result.planFile}`);
  }
  return 0;
}

async function projectPlanCommand(args) {
  if (!args.name && !args.project) throw new Error('project-plan requires --project or --name.');
  const result = await projectPlan(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`project plan: ${result.project}`);
    console.log(`  type: ${result.type}`);
    console.log(`  config: ${result.projectConfig}`);
    for (const config of result.queueConfigs) console.log(`  queue config: ${config}`);
    console.log(`  backlog: ${result.backlogFile} (${result.backlogCount} tasks)`);
    console.log(`  plan: ${result.planFile}`);
  }
  return 0;
}

async function projectStatusCommand(args) {
  if (!args.name && !args.project) throw new Error('project-status requires --project or --name.');
  const result = await projectStatus(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`project: ${result.project}`);
    console.log(`  type: ${result.type}`);
    console.log(`  config: ${result.projectConfig}`);
    console.log(`  goal: ${result.goal}`);
    console.log(`  queues: ${result.queues.length}`);
    console.log(`  totals: queued=${result.totals.queued}, active=${result.totals.active}, done=${result.totals.done}, failed=${result.totals.failed}, runs=${result.totals.runs}`);
    if (result.backlog) console.log(`  backlog: ${result.backlog.file} (${result.backlog.count} tasks)`);
    if (result.needsAttention.length) console.log(`  needs attention: ${result.needsAttention.join(', ')}`);
    for (const action of result.nextActions) console.log(`  next: ${action}`);
  }
  return 0;
}

async function enqueueCommand(args) {
  if (!args.queue) throw new Error('enqueue requires --queue.');
  const result = await enqueueTask(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`queued: ${result.file}`);
  }
  return 0;
}

async function routeMessageCommand(args) {
  if (!args.message) throw new Error('route-message requires --message.');
  const result = args.route
    ? await routeLoopMessage(args.root, args)
    : classifyLoopMessage(args.message);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`intent: ${result.intent}`);
    console.log(`risk: ${result.risk}`);
    console.log(`enqueue: ${result.enqueue ? 'yes' : 'no'}`);
    if (result.action) console.log(`action: ${result.action}`);
    if (result.file) console.log(`task: ${result.file}`);
  }
  return 0;
}

async function runQueueCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, {
    ...args,
    retry: buildRetryArgs(args, config.retry),
    onProgress: args.json ? undefined : printProgressEvent
  });
  const result = await runQueueOnce(args.root, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === 'locked') {
    console.log(`${result.queue}: locked until ${result.lock?.expiresAt ?? 'unknown'}`);
  } else if (!result.processed) {
    console.log(`${result.queue}: no queued tasks`);
  } else {
    console.log(`${result.queue}: ${result.status}`);
    console.log(`task: ${result.taskPath}`);
    console.log(`run: ${result.runPath}`);
  }
  return result.exitCode;
}

async function runQueueDrainCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, {
    ...args,
    retry: buildRetryArgs(args, config.retry),
    onProgress: args.json ? undefined : printProgressEvent
  });
  const result = await runQueueDrain(args.root, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === 'locked') {
    console.log(`${result.queue}: busy; ${result.remaining} task(s) queued for the active drain`);
  } else {
    console.log(`${result.queue}: ${result.status}`);
    console.log(`processed: ${result.processed}`);
    console.log(`remaining: ${result.remaining}`);
    console.log(`stop: ${result.stopReason}`);
  }
  return result.exitCode;
}

async function queueStatusCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueStatus(args.root, options.queue);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.queue);
    for (const [key, value] of Object.entries(result)) {
      if (key !== 'queue') console.log(`  ${key}: ${value}`);
    }
  }
  return 0;
}

async function queueTerminalNotifyCommand(args) {
  if (!args.queue) throw new Error('queue-terminal-notify requires --queue.');
  const result = await notifyTerminalTasks(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: inspected=${result.inspected} sent=${result.sent} failed=${result.failed}`);
    for (const item of result.results) {
      console.log(`  ${item.taskId} ${item.status}: ${item.outcome}`);
    }
  }
  return result.failed > 0 ? 1 : 0;
}

async function queueAcceptanceRefreshCommand(args) {
  if (!args.queue || !args.taskId) throw new Error('queue-acceptance-refresh requires --queue and --task-id.');
  const result = await refreshTaskAcceptance(args.root, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.queue}: ${result.taskId} ${result.outcome}${result.status ? ` (${result.status})` : ''}`);
  return 0;
}

async function queueHumanInputNotifyCommand(args) {
  if (!args.queue) throw new Error('queue-human-input-notify requires --queue.');
  const result = await notifyHumanInputRequests(args.root, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.queue}: inspected=${result.inspected} sent=${result.sent} failed=${result.failed}`);
  return result.failed > 0 ? 1 : 0;
}

async function queueHumanInputResolveCommand(args) {
  if (!args.queue) throw new Error('queue-human-input-resolve requires --queue.');
  const result = await resolveHumanInput(args.root, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.gate.gate_id}: ${result.outcome}`);
  return 0;
}

async function queueParkCommand(args) {
  if (!args.queue || !args.taskId) throw new Error('queue-park requires --queue and --task-id.');
  const result = await parkQueueTask(args.root, {
    ...args,
    kind: args.waitKind,
    policy: { timeoutMs: args.waitTimeoutMs, reminderIntervalMs: args.reminderIntervalMs, escalationIntervalMs: args.escalationIntervalMs, maxReminders: args.maxReminders }
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${args.taskId}: ${result.outcome}`);
  return 0;
}

async function queueWaitTickCommand(args) {
  if (!args.queue) throw new Error('queue-wait-tick requires --queue.');
  const result = await tickParkedTasks(args.root, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.queue}: inspected=${result.inspected} sent=${result.sent} failed=${result.failed}`);
  return result.failed > 0 ? 1 : 0;
}

async function queueWaitResumeCommand(args) {
  if (!args.queue || !args.taskId) throw new Error('queue-wait-resume requires --queue and --task-id.');
  const result = await resumeParkedTask(args.root, args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${args.taskId}: ${result.outcome}`);
  return 0;
}

async function queueSchedulerTickCommand(args) {
  const inferredConfig = args.queue ? `configs/loops/queues/${args.queue}.json` : undefined;
  const inferredConfigExists = inferredConfig
    ? await fileExists(path.resolve(args.root, safeRelativePath(inferredConfig, 'queue config')))
    : false;
  const configPath = args.config ?? (inferredConfigExists ? inferredConfig : undefined);
  const config = await loadQueueConfig(args.root, configPath);
  const options = mergeQueueOptions(config, {
    ...args,
    scheduler: config.scheduler,
    retry: buildRetryArgs(args, config.retry),
    onProgress: args.json || args.planOnly ? undefined : printProgressEvent
  });
  const result = await queueSchedulerTick(args.root, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: scheduler ${result.status}`);
    console.log(`  due: ${result.due ? 'yes' : 'no'}`);
    console.log(`  executed: ${result.executed ? 'yes' : 'no'}`);
    console.log(`  next interval: ${formatDurationApprox(result.currentIntervalMs)}`);
    console.log(`  next run: ${result.nextRunAt}`);
    console.log(`  state: ${result.statePath}`);
    console.log(`  progress report: ${result.progressReportPath}`);
    console.log(`  notify progress: ${result.progressReport.shouldNotify ? 'yes' : 'no'}`);
    console.log(`  reasons: ${result.reasons.join(', ') || 'none'}`);
    if (result.run?.runPath) console.log(`  run: ${result.run.runPath}`);
  }
  if (args.failOnRunFailure && result.run?.exitCode) return result.run.exitCode;
  return 0;
}

async function queuePeekCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queuePeek(args.root, options.queue, { limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.tasks.length === 0) {
    console.log(`${result.queue}: no queued tasks`);
  } else {
    for (const task of result.tasks) {
      console.log(`${task.id} ${task.title}`);
      console.log(`  attempts: ${task.attempts}`);
      console.log(`  file: ${task.file}`);
    }
  }
  return 0;
}

async function queueCancelCommand(args) {
  if (!args.taskId) throw new Error('queue-cancel requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueCancel(args.root, options.queue, args.taskId, {
    reason: args.reason,
    includeActive: args.includeActive
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`canceled ${result.taskId}: ${result.file}`);
  return 0;
}

async function queueRequeueCommand(args) {
  if (!args.taskId) throw new Error('queue-requeue requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueRequeue(args.root, options.queue, args.taskId, { from: args.from });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`requeued ${result.taskId}: ${result.file}`);
  return 0;
}

async function revisionStrategyFromArgs(args) {
  if (args.strategy !== undefined && args.strategyFile !== undefined) {
    throw new Error('Use either --strategy or --strategy-file, not both.');
  }
  if (args.strategyFile === undefined) return args.strategy;
  const file = path.resolve(args.root, safeRelativePath(args.strategyFile, 'strategy file'));
  return await readFile(file, 'utf8');
}

async function queueRevisionNextCommand(args) {
  if (!args.taskId) throw new Error('queue-revision-next requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const strategy = await revisionStrategyFromArgs(args);
  const result = await queueRevisionNext(args.root, options.queue, args.taskId, {
    title: args.title,
    task: args.task,
    strategy,
    force: args.force,
    revisionPolicy: options.revisionPolicy
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`queued revision ${result.nextTask.id}: ${result.file}`);
    console.log(`  source task: ${result.sourceTaskId}`);
    console.log(`  revision request: ${result.revisionRequest}`);
    if (result.revisionStrategyDiff?.summary) {
      const s = result.revisionStrategyDiff.summary;
      console.log(`  strategy diff: carried ${s.carried_forward_targets}/${s.total_targets}, changed ${s.targets_with_changed_strategy}/${s.total_targets}, needs detail ${s.targets_needing_strategy_detail}`);
      if (result.revisionStrategyDiff.recommendations?.length) {
        console.log(`  strategy recommendation: ${result.revisionStrategyDiff.recommendations[0]}`);
      }
    }
    if (result.revisionPolicyGuard?.reasons?.length) {
      console.log(`  revision guard: ${result.revisionPolicyGuard.reasons.join('; ')}`);
    }
  }
  return 0;
}

async function queueRevisionPlanCommand(args) {
  if (!args.taskId) throw new Error('queue-revision-plan requires --task-id.');
  if (args.output !== undefined && args.outputDir !== undefined) {
    throw new Error('Use either --output or --output-dir, not both.');
  }
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const strategy = await revisionStrategyFromArgs(args);
  const result = await queueRevisionPlan(args.root, options.queue, args.taskId, {
    title: args.title,
    task: args.task,
    strategy,
    force: args.force,
    revisionPolicy: options.revisionPolicy
  });
  const output = await writeRevisionPlanOutput(args.root, result, args.output, { force: args.force });
  const outputDir = await writeRevisionPlanOutputDir(args.root, result, args.outputDir, { force: args.force });
  if (args.json) {
    console.log(JSON.stringify({
      ...result,
      ...(output ? { outputFile: output.file, outputFormat: output.format } : {}),
      ...(outputDir ? { outputDir: outputDir.dir, outputFiles: outputDir.files } : {})
    }, null, 2));
  } else {
    console.log(`${result.queue}: revision plan for ${result.sourceTaskId}`);
    console.log(`  can enqueue: ${result.canEnqueue ? 'yes' : 'no'}`);
    console.log(`  revision request: ${result.revisionRequest}`);
    console.log(`  title: ${result.plannedTask.title}`);
    if (output) console.log(`  output: ${output.file}`);
    if (outputDir) {
      console.log(`  output dir: ${outputDir.dir}`);
      for (const item of outputDir.files) console.log(`    - ${item.file}`);
    }
    if (result.revisionPolicyGuard?.reasons?.length) {
      console.log(`  revision guard: ${result.revisionPolicyGuard.reasons.join('; ')}`);
    }
    if (result.revisionStrategyDiff?.summary) {
      const s = result.revisionStrategyDiff.summary;
      console.log(`  strategy diff: carried ${s.carried_forward_targets}/${s.total_targets}, changed ${s.targets_with_changed_strategy}/${s.total_targets}, needs detail ${s.targets_needing_strategy_detail}`);
      if (result.revisionStrategyDiff.recommendations?.length) {
        console.log(`  strategy recommendation: ${result.revisionStrategyDiff.recommendations[0]}`);
      }
    }
    console.log('  planned task body:');
    console.log(indent(result.plannedTask.body));
  }
  return result.canEnqueue ? 0 : 2;
}

async function queueRevisionApplyPlanCommand(args) {
  if (args.plan && args.fromReview) throw new Error('queue-revision-apply-plan accepts either --plan or --from-review, not both.');
  if (!args.plan && !args.fromReview) throw new Error('queue-revision-apply-plan requires --plan or --from-review.');
  const config = await loadQueueConfig(args.root, args.config);
  if (args.fromReview) {
    const result = await queueRevisionApplyFromReview(args.root, args.fromReview, {
      queue: args.queue ?? config.queue,
      action: args.action
    });
    const output = await writeRevisionApplyReportOutput(args.root, result, args.output, {
      force: args.force
    });
    if (output) result.output = output;
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`applied revision plans from review: ${result.review}`);
      console.log(`  queue: ${result.queue}`);
      if (output) console.log(`  output: ${output.file}`);
      console.log(`  actions: ${result.actions.join(', ')}`);
      console.log(`  applied: ${result.appliedCount}`);
      console.log(`  skipped: ${result.skippedCount}`);
      for (const item of result.applied) {
        console.log(`  - applied ${item.plan}: ${item.nextTaskId} -> ${item.file}`);
      }
      for (const item of result.skipped) {
        console.log(`  - skipped ${item.plan ?? 'unknown'}: ${item.reason}`);
      }
    }
    return 0;
  }
  const result = await queueRevisionApplyPlan(args.root, args.plan, {
    queue: args.queue ?? config.queue,
    force: args.force
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`queued revision from plan ${result.nextTask.id}: ${result.file}`);
    console.log(`  plan: ${result.revisionPlan}`);
    console.log(`  source task: ${result.sourceTaskId}`);
    console.log(`  revision request: ${result.revisionRequest}`);
    if (result.revisionStrategyDiff?.summary) {
      const s = result.revisionStrategyDiff.summary;
      console.log(`  strategy diff: carried ${s.carried_forward_targets}/${s.total_targets}, changed ${s.targets_with_changed_strategy}/${s.total_targets}, needs detail ${s.targets_needing_strategy_detail}`);
    }
    if (result.revisionPolicyGuard?.reasons?.length) {
      console.log(`  revision guard: ${result.revisionPolicyGuard.reasons.join('; ')}`);
    }
  }
  return 0;
}

async function queueRevisionApplyFromReview(root, reviewPath, options = {}) {
  const reviewFile = path.resolve(root, safeRelativePath(reviewPath, 'revision review'));
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  if (!review || typeof review !== 'object') throw new Error('Revision review must be a JSON object.');
  if (typeof review.queue !== 'string' || !review.queue.trim()) throw new Error('Revision review is missing queue.');
  if (!Array.isArray(review.plans)) throw new Error('Revision review is missing plans array.');

  const allowedApplyActions = new Set(['apply_ready', 'apply_or_refresh_stale']);
  const actions = parseCsvSet(options.action, [...allowedApplyActions]);
  const unsupported = [...actions].filter((action) => !allowedApplyActions.has(action));
  if (unsupported.length > 0) {
    throw new Error(`--from-review only supports apply actions: ${[...allowedApplyActions].join(', ')}. Unsupported: ${unsupported.join(', ')}`);
  }

  const queue = options.queue ?? review.queue;
  if (queue !== review.queue) {
    throw new Error(`Revision review queue ${review.queue} does not match requested queue ${queue}.`);
  }

  const fresh = await queueRevisionReview(root, queue, {
    dir: review.plansDir
  });
  const freshByFile = new Map(fresh.plans.map((plan) => [plan.file, plan]));
  const applied = [];
  const skipped = [];

  for (const originalPlan of review.plans) {
    const freshPlan = freshByFile.get(originalPlan.file);
    const plan = freshPlan ?? originalPlan;
    if (!actions.has(originalPlan.recommendedAction)) {
      skipped.push({
        plan: originalPlan.file,
        action: originalPlan.recommendedAction ?? null,
        reason: 'action not selected'
      });
      continue;
    }
    if (!freshPlan) {
      skipped.push({
        plan: originalPlan.file,
        action: originalPlan.recommendedAction ?? null,
        reason: 'plan no longer exists in current review'
      });
      continue;
    }
    if (!plan.readable) {
      skipped.push({ plan: plan.file, action: plan.recommendedAction, reason: 'plan is unreadable' });
      continue;
    }
    if (plan.applied) {
      skipped.push({ plan: plan.file, action: plan.recommendedAction, reason: 'plan is already applied' });
      continue;
    }
    if (!plan.queueMatches) {
      skipped.push({ plan: plan.file, action: plan.recommendedAction, reason: 'plan queue mismatch' });
      continue;
    }
    if (!plan.canEnqueue || !plan.guardAllowed) {
      skipped.push({ plan: plan.file, action: plan.recommendedAction, reason: 'plan is blocked by revision guard' });
      continue;
    }
    const result = await queueRevisionApplyPlan(root, plan.file, {
      queue
    });
    applied.push({
      plan: plan.file,
      action: plan.recommendedAction,
      sourceTaskId: result.sourceTaskId,
      nextTaskId: result.nextTask.id,
      file: result.file
    });
  }

  return {
    mode: 'from_review',
    generatedAt: new Date().toISOString(),
    review: path.relative(root, reviewFile),
    queue,
    actions: [...actions],
    reviewedPlans: review.plans.length,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped
  };
}

async function queueRevisionReviewCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueRevisionReview(args.root, options.queue, {
    dir: args.plansDir,
    limit: args.limit,
    needsAction: args.needsAction,
    staleAfterMs: parseDurationMs(args.staleAfter, 'stale-after'),
    appliedReport: args.appliedReport
  });
  const output = await writeRevisionReviewOutput(args.root, result, args.output, {
    force: args.force
  });
  if (output) result.output = output;
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: revision plan review`);
    console.log(`  plans dir: ${result.plansDir}`);
    if (output) console.log(`  output: ${output.file}`);
    if (result.appliedReport) {
      console.log(`  applied report: ${result.appliedReport.file} (applied ${result.appliedReport.appliedCount}, skipped ${result.appliedReport.skippedCount})`);
    }
    const filter = result.filters.needsAction ? `, matched ${result.matchedPlans} needs-action` : '';
    const stale = result.filters.staleAfterMs !== null ? `, stale ${result.stalePlans} after ${formatDurationApprox(result.filters.staleAfterMs)}` : '';
    const report = result.appliedReport ? `, report-matched ${result.applyReportMatchedPlans}` : '';
    console.log(`  plans: shown ${result.shownPlans}/${result.totalPlanFiles}${filter}, applied ${result.appliedPlans}, unapplied ${result.unappliedPlans}, blocked ${result.blockedPlans}, needs-action ${result.needsActionPlans}, unreadable ${result.unreadablePlans}${stale}${report}`);
    for (const plan of result.plans) {
      if (!plan.readable) {
        console.log(`  - ${plan.file}: action=${plan.recommendedAction} stale=${plan.stale ? 'yes' : 'no'} unreadable (${plan.error})`);
        continue;
      }
      const s = plan.strategyDiffSummary;
      const strategy = s
        ? `changed ${s.targets_with_changed_strategy}/${s.total_targets}, needs detail ${s.targets_needing_strategy_detail}`
        : 'strategy diff none';
      const guard = plan.guardReasons.length ? plan.guardReasons.join('; ') : 'ok';
      const queueNote = plan.queueMatches ? '' : ` queue=${plan.queue ?? 'unknown'}`;
      const age = plan.planAgeMs === null ? 'n/a' : formatDurationApprox(plan.planAgeMs);
      console.log(`  - ${plan.file}: action=${plan.recommendedAction} needs-action=${plan.needsAction ? 'yes' : 'no'} stale=${plan.stale ? 'yes' : 'no'} age=${age} can=${plan.canEnqueue ? 'yes' : 'no'} applied=${plan.applied ? 'yes' : 'no'} round=${plan.revisionRound ?? 'n/a'} ${strategy}${queueNote}`);
      console.log(`    reason: ${plan.actionReason}`);
      console.log(`    guard: ${guard}`);
      if (plan.appliedTasks.length > 0) {
        console.log(`    applied tasks: ${plan.appliedTasks.map((task) => `${task.taskId}(${task.subdir})`).join(', ')}`);
      }
      if ((plan.applyReportEntries ?? []).length > 0) {
        console.log(`    apply report: ${plan.applyReportEntries.map((entry) => {
          if (entry.status === 'applied') return `${entry.status}:${entry.nextTaskId ?? 'unknown'}`;
          return `${entry.status}:${entry.reason ?? 'unknown'}`;
        }).join(', ')}`);
      }
    }
  }
  return 0;
}

async function queueRevisionAuditChainCommand(args) {
  if (!args.review) throw new Error('queue-revision-audit-chain requires --review.');
  if (!args.applyReport) throw new Error('queue-revision-audit-chain requires --apply-report.');
  if (args.driftSummaryFormat && !args.driftReport && !args.driftSummaryAppendGithubStep) {
    throw new Error('queue-revision-audit-chain --drift-summary-format requires --drift-report or --drift-summary-append-github-step.');
  }
  const result = await buildRevisionAuditChain(args.root, args.review, args.applyReport, {
    verifyCurrent: args.verifyCurrent || args.failOnDrift,
    failOnDrift: args.failOnDrift,
    driftSeverity: args.driftSeverity,
    driftAllow: args.driftAllow,
    driftAllowFile: args.driftAllowFile
  });
  const output = await writeRevisionAuditChainOutput(args.root, result, args.output, {
    force: args.force
  });
  const driftReport = await writeRevisionAuditDriftReportOutput(args.root, result, args.driftReport, {
    force: args.force,
    summaryFormat: args.driftSummaryFormat
  });
  const githubStepSummary = await appendRevisionAuditGithubStepSummary(args.root, result, {
    enabled: args.driftSummaryAppendGithubStep
  });
  const githubAnnotations = emitRevisionAuditGithubAnnotations(result, {
    enabled: args.driftGithubAnnotations
  });
  if (output) result.output = output;
  if (driftReport) result.driftReport = driftReport;
  if (githubStepSummary) result.githubStepSummary = githubStepSummary;
  if (githubAnnotations) result.githubAnnotations = githubAnnotations;
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: revision audit chain`);
    console.log(`  review: ${result.review.file}`);
    console.log(`  apply report: ${result.applyReport.file}`);
    if (output) console.log(`  output: ${output.file}`);
    if (driftReport) console.log(`  drift report: ${driftReport.file}`);
    if (githubStepSummary) console.log(`  github step summary: ${githubStepSummary.file}`);
    if (githubAnnotations) console.log(`  github annotations: ${githubAnnotations.emitted} emitted (${githubAnnotations.errors} errors, ${githubAnnotations.warnings} warnings, skipped allowed ${githubAnnotations.skippedAllowed})`);
    if (result.verification.driftAllowFile) console.log(`  drift allow file: ${result.verification.driftAllowFile}`);
    console.log(`  entries: ${result.totals.reportEntries}, applied ${result.totals.applied}, skipped ${result.totals.skipped}`);
    console.log(`  linked tasks: ${result.totals.linkedTasks}, missing tasks ${result.totals.missingTasks}, task-plan mismatches ${result.totals.taskPlanPathMismatches}`);
    console.log(`  plans not in review: ${result.totals.plansNotInReview}, unreadable plans ${result.totals.unreadablePlans}, unreported review plans ${result.totals.unreportedReviewPlans}`);
    console.log(`  drift: ${result.drift.failed ? 'fail' : 'ok'} (${result.drift.errorCount} errors, ${result.drift.warningCount} warnings, allowed ${result.drift.allowedCount}, blocking errors ${result.drift.blockingErrorCount}, blocking warnings ${result.drift.blockingWarningCount}, fail severity ${result.drift.failSeverity})`);
    if (result.drift.allowedTypes.length > 0) console.log(`  drift allow: ${result.drift.allowedTypes.join(', ')}`);
    if (result.verification.currentState) {
      const locations = Object.entries(result.totals.currentTaskLocations ?? {}).map(([location, count]) => `${location}=${count}`).join(', ') || 'none';
      console.log(`  current: found ${result.totals.currentTasksFound}, missing ${result.totals.currentTasksMissing}, task-plan mismatches ${result.totals.currentTaskPlanPathMismatches}, locations ${locations}`);
    }
    for (const finding of result.drift.findings) {
      console.log(`  drift ${finding.severity}${finding.allowed ? ' allowed' : ''} ${finding.type}: ${finding.plan ?? 'unknown'} - ${finding.detail}`);
    }
    for (const item of result.chain) {
      const task = item.status === 'applied' ? ` -> ${item.reportEntry.nextTaskId ?? 'unknown'}` : '';
      const issue = item.consistency.taskPointsToPlan === false ? ' task-plan-mismatch' : '';
      const current = item.currentTask ? ` current=${item.currentTask.found ? item.currentTask.location : 'missing'}` : '';
      console.log(`  - ${item.status} ${item.plan ?? 'unknown'}${task}${issue}${current}`);
    }
  }
  return args.failOnDrift && result.drift.failed ? 2 : 0;
}

async function queueRevisionCiCheckCommand(args) {
  if (!args.review) throw new Error('queue-revision-ci-check requires --review.');
  if (!args.applyReport) throw new Error('queue-revision-ci-check requires --apply-report.');
  const driftSeverity = args.driftSeverity ?? 'warning';
  const appendGithubStep = !args.noGithubStepSummary && Boolean(String(process.env.GITHUB_STEP_SUMMARY ?? '').trim());
  const emitGithubAnnotations = !args.noGithubAnnotations;
  const result = await buildRevisionAuditChain(args.root, args.review, args.applyReport, {
    verifyCurrent: true,
    failOnDrift: true,
    driftSeverity,
    driftAllow: args.driftAllow,
    driftAllowFile: args.driftAllowFile
  });
  const baseline = await applyRevisionAuditDriftBaseline(args.root, result, args.baseline);
  result.ciCheck = {
    command: 'queue-revision-ci-check',
    failOnDrift: true,
    driftSeverity: result.drift.failSeverity,
    verifyCurrent: true,
    baseline,
    githubStepSummary: appendGithubStep ? 'appended' : 'skipped',
    githubStepSummaryReason: appendGithubStep
      ? null
      : (args.noGithubStepSummary ? 'disabled' : 'GITHUB_STEP_SUMMARY not set'),
    githubAnnotations: emitGithubAnnotations ? 'enabled' : 'disabled'
  };
  const output = await writeRevisionAuditChainOutput(args.root, result, args.output, {
    force: args.force
  });
  const driftReport = await writeRevisionAuditDriftReportOutput(args.root, result, args.driftReport, {
    force: args.force,
    summaryFormat: args.driftSummaryFormat ?? 'github'
  });
  const githubStepSummary = await appendRevisionAuditGithubStepSummary(args.root, result, {
    enabled: appendGithubStep
  });
  const githubAnnotations = emitRevisionAuditGithubAnnotations(result, {
    enabled: emitGithubAnnotations
  });
  if (output) result.output = output;
  if (driftReport) result.driftReport = driftReport;
  if (githubStepSummary) result.githubStepSummary = githubStepSummary;
  if (githubAnnotations) result.githubAnnotations = githubAnnotations;
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: revision CI check`);
    console.log(`  review: ${result.review.file}`);
    console.log(`  apply report: ${result.applyReport.file}`);
    if (output) console.log(`  output: ${output.file}`);
    if (driftReport) console.log(`  drift report: ${driftReport.file}`);
    if (githubStepSummary) {
      console.log(`  github step summary: ${githubStepSummary.file}`);
    } else {
      console.log(`  github step summary: skipped (${result.ciCheck.githubStepSummaryReason})`);
    }
    if (githubAnnotations) console.log(`  github annotations: ${githubAnnotations.emitted} emitted (${githubAnnotations.errors} errors, ${githubAnnotations.warnings} warnings, skipped allowed ${githubAnnotations.skippedAllowed}, skipped baseline ${githubAnnotations.skippedBaselineKnown})`);
    console.log(`  drift: ${result.drift.failed ? 'fail' : 'ok'} (${result.drift.errorCount} errors, ${result.drift.warningCount} warnings, allowed ${result.drift.allowedCount}, blocking errors ${result.drift.blockingErrorCount}, blocking warnings ${result.drift.blockingWarningCount}, fail severity ${result.drift.failSeverity})`);
    if (result.drift.baseline) {
      console.log(`  baseline: ${result.drift.baseline.file} (known ${result.drift.baselineKnownCount}, new ${result.drift.newCount}, new blocking errors ${result.drift.newBlockingErrorCount}, new blocking warnings ${result.drift.newBlockingWarningCount})`);
    }
    if (result.drift.allowedTypes.length > 0) console.log(`  drift allow: ${result.drift.allowedTypes.join(', ')}`);
    for (const finding of result.drift.findings) {
      console.log(`  drift ${finding.severity}${finding.allowed ? ' allowed' : ''} ${finding.type}: ${finding.plan ?? 'unknown'} - ${finding.detail}`);
    }
  }
  return result.drift.failed ? 2 : 0;
}

async function queueRevisionCiBaselineUpdateCommand(args) {
  if (!args.from) throw new Error('queue-revision-ci-baseline-update requires --from.');
  if (!args.output) throw new Error('queue-revision-ci-baseline-update requires --output.');
  const source = await readWorkspaceJson(args.root, args.from, 'revision drift baseline source');
  const baseline = buildRevisionCiBaselineArtifact(source);
  const output = await writeRevisionCiBaselineArtifact(args.root, baseline, args.output, {
    force: args.force
  });
  baseline.output = output;
  if (args.json) {
    console.log(JSON.stringify(baseline, null, 2));
  } else {
    console.log(`${baseline.queue}: revision CI baseline updated`);
    console.log(`  source: ${baseline.source.file}`);
    console.log(`  output: ${output.file}`);
    console.log(`  findings: ${baseline.totals.findings} (${baseline.totals.errors} errors, ${baseline.totals.warnings} warnings, allowed ${baseline.totals.allowed})`);
    if (baseline.totals.sourceBaselineKnown > 0) console.log(`  source baseline-known: ${baseline.totals.sourceBaselineKnown}`);
  }
  return 0;
}

function revisionCiBootstrapOutputDir(root, queue, value) {
  const rel = value === undefined || value === null || value === true
    ? path.join('runtime', 'loops', queue, 'ci-bootstrap', isoStamp())
    : safeRelativePath(value, 'revision CI bootstrap output dir');
  return {
    file: path.resolve(root, rel),
    relative: rel
  };
}

async function writeRevisionCiBootstrapManifest(root, bootstrap, outputDir, options = {}) {
  const outputFile = path.join(outputDir.file, 'bootstrap.json');
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI bootstrap manifest already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await writeJson(outputFile, bootstrap);
  return {
    file: path.relative(root, outputFile),
    format: 'json'
  };
}

async function runRevisionCiBootstrap(root, options) {
  if (!options.queue) throw new Error('queue-revision-ci-bootstrap requires --queue or --config.');
  const outputDir = revisionCiBootstrapOutputDir(root, options.queue, options.outputDir);
  await mkdir(outputDir.file, { recursive: true });

  const staleAfterMs = parseDurationMs(options.staleAfter, 'stale-after');
  const reviewPath = path.join(outputDir.relative, 'action-list.json');
  const applyReportPath = path.join(outputDir.relative, 'apply-report.json');
  const auditPath = path.join(outputDir.relative, 'audit-chain.json');
  const driftReportPath = path.join(outputDir.relative, 'drift-report.md');
  const baselinePath = options.baselineOutput
    ? safeRelativePath(options.baselineOutput, 'revision CI bootstrap baseline output')
    : path.join(outputDir.relative, 'previous-audit.json');

  const review = await queueRevisionReview(root, options.queue, {
    dir: options.plansDir,
    needsAction: true,
    staleAfterMs
  });
  const reviewOutput = await writeRevisionReviewOutput(root, review, reviewPath, {
    force: options.force
  });

  const applyReport = await queueRevisionApplyFromReview(root, reviewOutput.file, {
    queue: options.queue,
    action: options.action
  });
  const applyOutput = await writeRevisionApplyReportOutput(root, applyReport, applyReportPath, {
    force: options.force
  });
  applyReport.output = applyOutput;

  const audit = await buildRevisionAuditChain(root, reviewOutput.file, applyOutput.file, {
    verifyCurrent: true,
    failOnDrift: false,
    driftSeverity: options.driftSeverity ?? 'warning',
    driftAllow: options.driftAllow,
    driftAllowFile: options.driftAllowFile
  });
  const auditOutput = await writeRevisionAuditChainOutput(root, audit, auditPath, {
    force: options.force
  });
  audit.output = auditOutput;
  const driftReport = await writeRevisionAuditDriftReportOutput(root, audit, driftReportPath, {
    force: options.force,
    summaryFormat: options.driftSummaryFormat ?? 'github'
  });
  audit.driftReport = driftReport;

  const baseline = buildRevisionCiBaselineArtifact({
    file: auditOutput.file,
    data: {
      ...audit,
      output: auditOutput
    }
  });
  const baselineOutput = await writeRevisionCiBaselineArtifact(root, baseline, baselinePath, {
    force: options.force
  });
  baseline.output = baselineOutput;

  const bootstrap = {
    mode: 'revision_ci_bootstrap',
    generatedAt: new Date().toISOString(),
    queue: options.queue,
    outputDir: outputDir.relative,
    filters: {
      needsAction: true,
      staleAfterMs,
      plansDir: review.plansDir
    },
    actions: applyReport.actions,
    artifacts: {
      review: reviewOutput,
      applyReport: applyOutput,
      auditChain: auditOutput,
      driftReport,
      baseline: baselineOutput
    },
    summary: {
      reviewedPlans: review.shownPlans,
      needsActionPlans: review.needsActionPlans,
      applied: applyReport.appliedCount,
      skipped: applyReport.skippedCount,
      driftFindings: audit.drift.findings.length,
      driftErrors: audit.drift.errorCount,
      driftWarnings: audit.drift.warningCount,
      baselineFindings: baseline.totals.findings
    },
    ciCommand: `loop-engineering queue-revision-ci-check --review ${reviewOutput.file} --apply-report ${applyOutput.file} --baseline ${baselineOutput.file} --drift-report ${driftReport.file}`
  };
  const manifest = await writeRevisionCiBootstrapManifest(root, bootstrap, outputDir, {
    force: options.force
  });
  bootstrap.artifacts.manifest = manifest;
  return bootstrap;
}

async function queueRevisionCiBootstrapCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const bootstrap = await runRevisionCiBootstrap(args.root, {
    ...options,
    outputDir: args.outputDir,
    staleAfter: args.staleAfter,
    plansDir: args.plansDir,
    action: args.action,
    baselineOutput: args.baselineOutput,
    driftSeverity: args.driftSeverity,
    driftAllow: args.driftAllow,
    driftAllowFile: args.driftAllowFile,
    driftSummaryFormat: args.driftSummaryFormat,
    force: args.force
  });

  if (args.json) {
    console.log(JSON.stringify(bootstrap, null, 2));
  } else {
    console.log(`${bootstrap.queue}: revision CI bootstrap`);
    console.log(`  output dir: ${bootstrap.outputDir}`);
    console.log(`  review: ${reviewOutput.file}`);
    console.log(`  apply report: ${applyOutput.file}`);
    console.log(`  audit chain: ${auditOutput.file}`);
    console.log(`  drift report: ${driftReport.file}`);
    console.log(`  baseline: ${baselineOutput.file}`);
    console.log(`  manifest: ${manifest.file}`);
    console.log(`  plans: reviewed ${bootstrap.summary.reviewedPlans}, needs-action ${bootstrap.summary.needsActionPlans}, applied ${bootstrap.summary.applied}, skipped ${bootstrap.summary.skipped}`);
    console.log(`  drift: ${bootstrap.summary.driftFindings} findings (${bootstrap.summary.driftErrors} errors, ${bootstrap.summary.driftWarnings} warnings)`);
    console.log(`  ci command: ${bootstrap.ciCommand}`);
  }
  return 0;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function buildRevisionCiWorkflowTemplate(options = {}) {
  const queue = String(options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-workflow-template requires --queue or --config.');
  const artifactDir = options.outputDir && options.outputDir !== true
    ? safeRelativePath(options.outputDir, 'revision CI workflow artifact dir')
    : '.loop-engineering/revision-ci/${{ github.run_id }}';
  const baseline = options.baselineOutput
    ? safeRelativePath(options.baselineOutput, 'revision CI workflow baseline output')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json');
  const cli = 'node packages/loop-engineering/bin/loop-engineering.mjs';
  const q = shellSingleQuote(queue);
  const artifacts = shellSingleQuote(artifactDir);
  const baselineFile = shellSingleQuote(baseline);
  const currentBaseline = '"$ARTIFACT_DIR/current-baseline.json"';
  const lines = [];
  lines.push('name: Loop Revision CI');
  lines.push('');
  lines.push('on:');
  lines.push('  pull_request:');
  lines.push('  push:');
  lines.push('    branches: [ main ]');
  lines.push('  workflow_dispatch:');
  lines.push('');
  lines.push('jobs:');
  lines.push('  revision-ci:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    permissions:');
  lines.push('      contents: read');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');
  lines.push('      - uses: actions/setup-node@v4');
  lines.push('        with:');
  lines.push("          node-version: '22'");
  lines.push('      - name: Build revision CI artifacts');
  lines.push('        run: |');
  lines.push(`          ARTIFACT_DIR=${artifacts}`);
  lines.push(`          BASELINE=${baselineFile}`);
  lines.push('          mkdir -p "$ARTIFACT_DIR" "$(dirname "$BASELINE")"');
  lines.push('          if [ ! -f "$BASELINE" ]; then');
  lines.push(`            ${cli} queue-revision-ci-bootstrap \\`);
  lines.push(`              --queue ${q} \\`);
  lines.push('              --output-dir "$ARTIFACT_DIR" \\');
  lines.push('              --baseline-output "$BASELINE" \\');
  lines.push('              --force');
  lines.push('            echo "Created initial loop revision CI baseline: $BASELINE" >> "$GITHUB_STEP_SUMMARY"');
  lines.push('            exit 0');
  lines.push('          fi');
  lines.push(`          ${cli} queue-revision-ci-bootstrap \\`);
  lines.push(`            --queue ${q} \\`);
  lines.push('            --output-dir "$ARTIFACT_DIR" \\');
  lines.push(`            --baseline-output ${currentBaseline} \\`);
  lines.push('            --force');
  lines.push('      - name: Check revision drift');
  lines.push('        run: |');
  lines.push(`          ARTIFACT_DIR=${artifacts}`);
  lines.push(`          BASELINE=${baselineFile}`);
  lines.push(`          ${cli} queue-revision-ci-check \\`);
  lines.push('            --review "$ARTIFACT_DIR/action-list.json" \\');
  lines.push('            --apply-report "$ARTIFACT_DIR/apply-report.json" \\');
  lines.push('            --baseline "$BASELINE" \\');
  lines.push('            --output "$ARTIFACT_DIR/audit-chain.json" \\');
  lines.push('            --drift-report "$ARTIFACT_DIR/drift-report.md" \\');
  lines.push('            --force');
  lines.push('      - uses: actions/upload-artifact@v4');
  lines.push('        if: always()');
  lines.push('        with:');
  lines.push('          name: loop-revision-ci-${{ github.run_id }}');
  lines.push('          path: |');
  lines.push(`            ${artifactDir}/`);
  lines.push(`            ${baseline}`);
  lines.push('');
  return {
    mode: 'revision_ci_workflow_template',
    generatedAt: new Date().toISOString(),
    queue,
    artifactDir,
    baseline,
    format: 'github-actions-yaml',
    content: lines.join('\n')
  };
}

async function writeRevisionCiWorkflowTemplateOutput(root, template, output, options = {}) {
  if (!output) throw new Error('queue-revision-ci-workflow-template requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI workflow template output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI workflow template output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.yml' && ext !== '.yaml') {
    throw new Error('queue-revision-ci-workflow-template --output must end with .yml or .yaml.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, template.content);
  return {
    file: path.relative(root, outputFile),
    format: template.format
  };
}

async function queueRevisionCiWorkflowTemplateCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const template = buildRevisionCiWorkflowTemplate({
    queue: options.queue,
    outputDir: args.outputDir,
    baselineOutput: args.baselineOutput
  });
  const output = await writeRevisionCiWorkflowTemplateOutput(args.root, template, args.output, {
    force: args.force
  });
  const result = {
    ...template,
    output
  };
  if (args.json) {
    console.log(JSON.stringify({ ...result, content: undefined }, null, 2));
  } else {
    console.log(`${result.queue}: revision CI workflow template`);
    console.log(`  output: ${output.file}`);
    console.log(`  artifact dir: ${result.artifactDir}`);
    console.log(`  baseline: ${result.baseline}`);
  }
  return 0;
}

function parseGithubRepoFromRemoteUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  const ssh = text.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  const https = text.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/)?$/);
  if (https) return https[1];
  return null;
}

async function inferGithubRepoFromGitConfig(root) {
  try {
    const config = await readFile(path.join(root, '.git', 'config'), 'utf8');
    const origin = config.match(/\[remote "origin"\][\s\S]*?(?=\n\[|$)/);
    const url = origin?.[0]?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return parseGithubRepoFromRemoteUrl(url);
  } catch {
    return null;
  }
}

function encodeGithubPathSegment(value) {
  return encodeURIComponent(String(value)).replaceAll('%2F', '/');
}

function buildRevisionCiStatusBadge(options = {}) {
  const repo = String(options.repo ?? 'OWNER/REPO').trim();
  const workflow = String(options.workflow ?? 'loop-revision-ci.yml').trim();
  const branch = String(options.branch ?? 'main').trim();
  const label = String(options.label ?? 'Loop Revision CI').trim();
  if (!repo || !repo.includes('/')) throw new Error('queue-revision-ci-status-badge requires --repo owner/name or a GitHub origin remote.');
  if (!workflow) throw new Error('queue-revision-ci-status-badge requires a workflow file name.');
  if (!branch) throw new Error('queue-revision-ci-status-badge requires a branch.');
  if (!label) throw new Error('queue-revision-ci-status-badge requires a label.');
  const workflowPath = encodeGithubPathSegment(workflow);
  const branchQuery = encodeURIComponent(branch);
  const badgeUrl = `https://github.com/${repo}/actions/workflows/${workflowPath}/badge.svg?branch=${branchQuery}`;
  const workflowUrl = `https://github.com/${repo}/actions/workflows/${workflowPath}`;
  const queue = options.queue ? String(options.queue).trim() : null;
  const lines = [];
  lines.push(`[![${label}](${badgeUrl})](${workflowUrl})`);
  lines.push('');
  lines.push(queue
    ? `Loop revision CI status for queue \`${queue}\`.`
    : 'Loop revision CI status.');
  lines.push('');
  return {
    mode: 'revision_ci_status_badge',
    generatedAt: new Date().toISOString(),
    repo,
    workflow,
    branch,
    label,
    queue,
    badgeUrl,
    workflowUrl,
    content: lines.join('\n')
  };
}

async function writeRevisionCiStatusBadgeOutput(root, badge, output, options = {}) {
  if (!output) throw new Error('queue-revision-ci-status-badge requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI status badge output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI status badge output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  if (path.extname(outputFile).toLowerCase() !== '.md') {
    throw new Error('queue-revision-ci-status-badge --output must end with .md.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, badge.content);
  return {
    file: path.relative(root, outputFile),
    format: 'markdown'
  };
}

async function queueRevisionCiStatusBadgeCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const inferredRepo = args.repo ? null : await inferGithubRepoFromGitConfig(args.root);
  const badge = buildRevisionCiStatusBadge({
    repo: args.repo ?? inferredRepo,
    workflow: args.workflow,
    branch: args.branch,
    label: args.label,
    queue: args.queue ?? config.queue ?? null
  });
  const output = await writeRevisionCiStatusBadgeOutput(args.root, badge, args.output, {
    force: args.force
  });
  const result = {
    ...badge,
    output,
    repoInferred: !args.repo && Boolean(inferredRepo)
  };
  if (args.json) {
    console.log(JSON.stringify({ ...result, content: undefined }, null, 2));
  } else {
    console.log(`${result.repo}: revision CI status badge`);
    console.log(`  output: ${output.file}`);
    console.log(`  workflow: ${result.workflow}`);
    console.log(`  branch: ${result.branch}`);
    if (result.queue) console.log(`  queue: ${result.queue}`);
    console.log(`  repo inferred: ${result.repoInferred ? 'yes' : 'no'}`);
  }
  return 0;
}

const REVISION_CI_README_START = '<!-- loop-revision-ci:start -->';
const REVISION_CI_README_END = '<!-- loop-revision-ci:end -->';

function buildRevisionCiReadmeSection(options = {}) {
  const badge = buildRevisionCiStatusBadge(options);
  const sectionTitle = String(options.sectionTitle ?? 'Loop Revision CI').trim();
  if (!sectionTitle) throw new Error('queue-revision-ci-readme-update requires a non-empty section title.');
  const lines = [];
  lines.push(REVISION_CI_README_START);
  lines.push(`## ${sectionTitle}`);
  lines.push('');
  lines.push(badge.content.trimEnd());
  lines.push(REVISION_CI_README_END);
  lines.push('');
  return {
    mode: 'revision_ci_readme_section',
    generatedAt: new Date().toISOString(),
    repo: badge.repo,
    workflow: badge.workflow,
    branch: badge.branch,
    label: badge.label,
    queue: badge.queue,
    badgeUrl: badge.badgeUrl,
    workflowUrl: badge.workflowUrl,
    sectionTitle,
    markerStart: REVISION_CI_README_START,
    markerEnd: REVISION_CI_README_END,
    content: lines.join('\n')
  };
}

function updateRevisionCiReadmeContent(existing, section) {
  const content = String(existing ?? '');
  const start = content.indexOf(REVISION_CI_README_START);
  const end = content.indexOf(REVISION_CI_README_END);
  const block = section.content.trimEnd();
  if ((start === -1) !== (end === -1)) {
    throw new Error('README contains only one loop revision CI marker; expected both start and end markers.');
  }
  if (start !== -1) {
    if (end < start) throw new Error('README loop revision CI end marker appears before the start marker.');
    const afterEnd = end + REVISION_CI_README_END.length;
    return {
      action: 'replaced',
      content: `${content.slice(0, start)}${block}${content.slice(afterEnd)}`
    };
  }
  const title = content.match(/^(# .*(?:\r?\n|$))/);
  if (title) {
    const insertAt = title[0].length;
    const rest = content.slice(insertAt).replace(/^\s*/, '');
    return {
      action: 'inserted_after_title',
      content: `${content.slice(0, insertAt)}\n${block}\n\n${rest}`
    };
  }
  return {
    action: 'inserted_at_top',
    content: `${block}\n\n${content.replace(/^\s*/, '')}`
  };
}

async function queueRevisionCiReadmeUpdateCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const readmeRel = safeRelativePath(args.readme ?? 'README.md', 'revision CI README');
  const readmeFile = path.resolve(args.root, readmeRel);
  if (path.extname(readmeFile).toLowerCase() !== '.md') {
    throw new Error('queue-revision-ci-readme-update --readme must end with .md.');
  }
  if (!(await fileExists(readmeFile))) {
    throw new Error(`README file does not exist: ${path.relative(args.root, readmeFile)}`);
  }
  const inferredRepo = args.repo ? null : await inferGithubRepoFromGitConfig(args.root);
  const section = buildRevisionCiReadmeSection({
    repo: args.repo ?? inferredRepo,
    workflow: args.workflow,
    branch: args.branch,
    label: args.label,
    queue: args.queue ?? config.queue ?? null,
    sectionTitle: args.sectionTitle
  });
  const existing = await readFile(readmeFile, 'utf8');
  const updated = updateRevisionCiReadmeContent(existing, section);
  if (updated.content === existing) {
    updated.action = 'unchanged';
  } else {
    await writeFile(readmeFile, updated.content);
  }
  const result = {
    ...section,
    content: undefined,
    readme: {
      file: path.relative(args.root, readmeFile),
      action: updated.action,
      markerStart: REVISION_CI_README_START,
      markerEnd: REVISION_CI_README_END
    },
    repoInferred: !args.repo && Boolean(inferredRepo)
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.repo}: revision CI README updated`);
    console.log(`  readme: ${result.readme.file}`);
    console.log(`  action: ${result.readme.action}`);
    console.log(`  workflow: ${result.workflow}`);
    console.log(`  branch: ${result.branch}`);
    if (result.queue) console.log(`  queue: ${result.queue}`);
    console.log(`  repo inferred: ${result.repoInferred ? 'yes' : 'no'}`);
  }
  return 0;
}

function commandLine(parts) {
  return parts.filter(Boolean).join(' ');
}

function buildRevisionCiInstallGuide(options = {}) {
  const queue = String(options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-install-guide requires --queue or --config.');
  const workflow = String(options.workflow ?? 'loop-revision-ci.yml').trim();
  const branch = String(options.branch ?? 'main').trim();
  const label = String(options.label ?? 'Loop Revision CI').trim();
  const repo = String(options.repo ?? 'OWNER/REPO').trim();
  const readme = safeRelativePath(options.readme ?? 'README.md', 'revision CI install guide README');
  const workflowFile = path.join('.github', 'workflows', workflow);
  const artifactDir = options.outputDir && options.outputDir !== true
    ? safeRelativePath(options.outputDir, 'revision CI install guide artifact dir')
    : '.loop-engineering/revision-ci/${{ github.run_id }}';
  const baseline = options.baselineOutput
    ? safeRelativePath(options.baselineOutput, 'revision CI install guide baseline output')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json');
  const driftAllowFile = options.driftAllowFile
    ? safeRelativePath(options.driftAllowFile, 'revision CI install guide drift allow file')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'drift-allow.json');
  const repoFlag = options.repoExplicit ? `--repo ${shellSingleQuote(repo)}` : '';
  const commands = [
    {
      id: 'workflow_template',
      label: 'Generate GitHub Actions workflow',
      command: commandLine([
        'loop-engineering queue-revision-ci-workflow-template',
        '--queue', shellSingleQuote(queue),
        '--output', shellSingleQuote(workflowFile),
        '--output-dir', shellSingleQuote(artifactDir),
        '--baseline-output', shellSingleQuote(baseline)
      ])
    },
    {
      id: 'drift_allow_template',
      label: 'Create auditable drift allow-file template when exceptions are needed',
      command: commandLine([
        'loop-engineering queue-revision-drift-allow-template',
        '--type unreported_actionable_review_plan',
        '--owner platform-ci',
        '--reason', shellSingleQuote('Pending owner review before the next batch apply.'),
        '--ttl 24h',
        '--output', shellSingleQuote(driftAllowFile)
      ])
    },
    {
      id: 'readme_update',
      label: 'Insert or refresh README status section',
      command: commandLine([
        'loop-engineering queue-revision-ci-readme-update',
        '--queue', shellSingleQuote(queue),
        '--readme', shellSingleQuote(readme),
        repoFlag,
        '--workflow', shellSingleQuote(workflow),
        '--branch', shellSingleQuote(branch),
        '--label', shellSingleQuote(label)
      ])
    },
    {
      id: 'initial_bootstrap',
      label: 'Generate first baseline and artifact bundle locally',
      command: commandLine([
        'loop-engineering queue-revision-ci-bootstrap',
        '--queue', shellSingleQuote(queue),
        '--output-dir', shellSingleQuote(path.join('runtime', 'loops', queue, 'ci-bootstrap', 'initial')),
        '--baseline-output', shellSingleQuote(baseline),
        '--force'
      ])
    },
    {
      id: 'strict_ci_check',
      label: 'Run strict CI drift check after bootstrap artifacts exist',
      command: commandLine([
        'loop-engineering queue-revision-ci-check',
        '--review', shellSingleQuote(path.join('runtime', 'loops', queue, 'ci-bootstrap', 'initial', 'action-list.json')),
        '--apply-report', shellSingleQuote(path.join('runtime', 'loops', queue, 'ci-bootstrap', 'initial', 'apply-report.json')),
        '--baseline', shellSingleQuote(baseline),
        '--drift-allow-file', shellSingleQuote(driftAllowFile),
        '--drift-report', shellSingleQuote(path.join('runtime', 'loops', queue, 'ci-bootstrap', 'initial', 'drift-report.md'))
      ])
    }
  ];
  return {
    mode: 'revision_ci_install_guide',
    generatedAt: new Date().toISOString(),
    queue,
    repo,
    repoExplicit: Boolean(options.repoExplicit),
    repoInferred: Boolean(options.repoInferred),
    workflow,
    workflowFile,
    branch,
    label,
    readme,
    artifactDir,
    baseline,
    driftAllowFile,
    commands,
    checklist: [
      'Generate the workflow template and review the YAML before committing it.',
      'Create a drift allow file only when there is a temporary, owned, expiring exception.',
      'Update the README marker section so the queue has a visible CI entry point.',
      'Run bootstrap once to create the first baseline artifact.',
      'Commit the workflow, README marker, and accepted baseline together.',
      'Let GitHub Actions run the strict CI check on the next pull request or push.'
    ]
  };
}

function renderRevisionCiInstallGuideMarkdown(guide) {
  const lines = [];
  lines.push(`# Loop Revision CI Install Guide: ${guide.queue}`);
  lines.push('');
  lines.push(`Generated at: ${guide.generatedAt}`);
  lines.push('');
  lines.push('| Target | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Queue | \`${guide.queue}\` |`);
  lines.push(`| Repository | \`${guide.repo}\`${guide.repoInferred ? ' (inferred)' : guide.repoExplicit ? '' : ' (placeholder; pass `--repo owner/name` if needed)'} |`);
  lines.push(`| Workflow | \`${guide.workflowFile}\` |`);
  lines.push(`| Branch | \`${guide.branch}\` |`);
  lines.push(`| README | \`${guide.readme}\` |`);
  lines.push(`| Baseline | \`${guide.baseline}\` |`);
  lines.push(`| Artifact dir | \`${guide.artifactDir}\` |`);
  lines.push(`| Drift allow file | \`${guide.driftAllowFile}\` |`);
  lines.push('');
  lines.push('## Checklist');
  lines.push('');
  for (const item of guide.checklist) lines.push(`- [ ] ${item}`);
  lines.push('');
  lines.push('## Commands');
  for (const item of guide.commands) {
    lines.push('');
    lines.push(`### ${item.label}`);
    lines.push('');
    lines.push('```bash');
    lines.push(item.command);
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiInstallGuideOutput(root, guide, output, options = {}) {
  if (!output) throw new Error('queue-revision-ci-install-guide requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI install guide output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI install guide output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-install-guide --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, guide);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiInstallGuideMarkdown(guide));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiInstallGuideCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const options = mergeQueueOptions(config, args);
  const inferredRepo = args.repo ? null : await inferGithubRepoFromGitConfig(args.root);
  const guide = buildRevisionCiInstallGuide({
    queue: options.queue,
    repo: args.repo ?? inferredRepo ?? 'OWNER/REPO',
    repoExplicit: Boolean(args.repo),
    repoInferred: !args.repo && Boolean(inferredRepo),
    workflow: args.workflow,
    branch: args.branch,
    label: args.label,
    readme: args.readme,
    outputDir: args.outputDir,
    baselineOutput: args.baselineOutput,
    driftAllowFile: args.driftAllowFile
  });
  const output = await writeRevisionCiInstallGuideOutput(args.root, guide, args.output, {
    force: args.force
  });
  const result = { ...guide, output };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: revision CI install guide`);
    console.log(`  output: ${output.file}`);
    console.log(`  workflow: ${result.workflowFile}`);
    console.log(`  readme: ${result.readme}`);
    console.log(`  baseline: ${result.baseline}`);
    console.log(`  drift allow file: ${result.driftAllowFile}`);
    console.log(`  repo: ${result.repo}${result.repoInferred ? ' (inferred)' : result.repoExplicit ? '' : ' (placeholder)'}`);
  }
  return 0;
}

function renderRevisionCiSelfTestMarkdown(report) {
  const lines = [];
  lines.push(`# Loop Revision CI Self-Test: ${report.queue}`);
  lines.push('');
  lines.push(`Status: ${report.ok ? 'ok' : 'failed'}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Temporary workspace: \`${report.tempRoot}\``);
  lines.push('');
  lines.push('| Check | Status | Detail |');
  lines.push('| --- | --- | --- |');
  for (const check of report.checks) {
    lines.push(`| \`${check.id}\` | ${check.ok ? 'ok' : 'failed'} | ${check.detail ? String(check.detail).replaceAll('|', '\\|') : ''} |`);
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  for (const [key, value] of Object.entries(report.artifacts)) {
    lines.push(`- ${key}: \`${value}\``);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiSelfTestReport(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI self-test output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI self-test output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-self-test --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiSelfTestMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiSelfTestCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const options = mergeQueueOptions(config, args);
  const queue = String(options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-self-test requires --queue or --config.');
  const repo = String(args.repo ?? 'owner/repo').trim();
  const workflow = String(args.workflow ?? 'loop-revision-ci.yml').trim();
  const branch = String(args.branch ?? 'main').trim();
  const label = String(args.label ?? 'Loop Revision CI').trim();
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'loop-revision-ci-self-test-'));
  const checks = [];
  const artifacts = {
    workflow: path.join('.github', 'workflows', workflow),
    readme: 'README.md',
    driftAllowFile: path.join('runtime', 'loops', queue, 'ci-baseline', 'drift-allow.json'),
    bootstrapDir: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test'),
    baseline: path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json'),
    ciAudit: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test', 'ci-audit-chain.json'),
    ciDriftReport: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test', 'ci-drift-report.md'),
    healthSummary: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test', 'health-summary.json'),
    dashboard: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test', 'dashboard.json'),
    releaseChecklist: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'self-test', 'release-checklist.json')
  };
  const check = async (id, detail, fn) => {
    await fn();
    checks.push({ id, ok: true, detail });
  };

  await mkdir(path.join(tempRoot, '.git'), { recursive: true });
  await writeFile(path.join(tempRoot, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${repo}.git\n`);
  await writeFile(path.join(tempRoot, 'README.md'), `# Revision CI Self-Test\n\nTemporary workspace for ${queue}.\n`);

  await check('workflow-template', artifacts.workflow, async () => {
    const template = buildRevisionCiWorkflowTemplate({
      queue,
      outputDir: '.loop-engineering/revision-ci/${{ github.run_id }}',
      baselineOutput: artifacts.baseline
    });
    await writeRevisionCiWorkflowTemplateOutput(tempRoot, template, artifacts.workflow, { force: true });
    const content = await readFile(path.join(tempRoot, artifacts.workflow), 'utf8');
    if (!content.includes('queue-revision-ci-bootstrap') || !content.includes('queue-revision-ci-check')) {
      throw new Error('Generated workflow is missing revision CI commands.');
    }
  });

  await check('drift-allow-template', artifacts.driftAllowFile, async () => {
    const template = buildRevisionDriftAllowTemplate({
      type: 'unreported_actionable_review_plan',
      owner: 'self-test',
      reason: 'Temporary self-test allow-file shape verification.',
      ttl: '24h'
    });
    await writeRevisionDriftAllowTemplateOutput(tempRoot, template, artifacts.driftAllowFile, { force: true });
  });

  await check('readme-marker', artifacts.readme, async () => {
    const section = buildRevisionCiReadmeSection({ queue, repo, workflow, branch, label });
    const existing = await readFile(path.join(tempRoot, artifacts.readme), 'utf8');
    const updated = updateRevisionCiReadmeContent(existing, section);
    await writeFile(path.join(tempRoot, artifacts.readme), updated.content);
    const content = await readFile(path.join(tempRoot, artifacts.readme), 'utf8');
    if (!content.includes(REVISION_CI_README_START) || !content.includes(REVISION_CI_README_END)) {
      throw new Error('README marker block was not written.');
    }
  });

  await check('bootstrap-artifacts', artifacts.bootstrapDir, async () => {
    await mkdir(path.join(tempRoot, artifacts.bootstrapDir), { recursive: true });
    const reviewPath = path.join(artifacts.bootstrapDir, 'action-list.json');
    const applyReportPath = path.join(artifacts.bootstrapDir, 'apply-report.json');
    const auditPath = path.join(artifacts.bootstrapDir, 'audit-chain.json');
    const driftReportPath = path.join(artifacts.bootstrapDir, 'drift-report.md');
    const review = await queueRevisionReview(tempRoot, queue, { needsAction: true });
    const reviewOutput = await writeRevisionReviewOutput(tempRoot, review, reviewPath, { force: true });
    const applyReport = await queueRevisionApplyFromReview(tempRoot, reviewOutput.file, { queue });
    const applyOutput = await writeRevisionApplyReportOutput(tempRoot, applyReport, applyReportPath, { force: true });
    const audit = await buildRevisionAuditChain(tempRoot, reviewOutput.file, applyOutput.file, {
      verifyCurrent: true,
      failOnDrift: false,
      driftSeverity: 'warning',
      driftAllowFile: artifacts.driftAllowFile
    });
    const auditOutput = await writeRevisionAuditChainOutput(tempRoot, audit, auditPath, { force: true });
    const driftReport = await writeRevisionAuditDriftReportOutput(tempRoot, audit, driftReportPath, {
      force: true,
      summaryFormat: 'github'
    });
    const baseline = buildRevisionCiBaselineArtifact({
      file: auditOutput.file,
      data: { ...audit, output: auditOutput }
    });
    const baselineOutput = await writeRevisionCiBaselineArtifact(tempRoot, baseline, artifacts.baseline, { force: true });
    const bootstrap = {
      mode: 'revision_ci_bootstrap',
      generatedAt: new Date().toISOString(),
      queue,
      outputDir: artifacts.bootstrapDir,
      filters: {
        needsAction: true,
        staleAfterMs: null,
        plansDir: path.join('runtime', 'loops', queue, 'revision-plans')
      },
      actions: ['apply_ready', 'apply_or_refresh_stale'],
      artifacts: {
        review: reviewOutput,
        applyReport: applyOutput,
        auditChain: auditOutput,
        driftReport,
        baseline: baselineOutput,
        manifest: {
          file: path.join(artifacts.bootstrapDir, 'bootstrap.json'),
          format: 'json'
        }
      },
      summary: {
        reviewedPlans: review.totalPlanFiles ?? 0,
        needsActionPlans: review.plans?.filter((plan) => plan.needsAction).length ?? 0,
        applied: applyReport.appliedCount ?? 0,
        skipped: applyReport.skippedCount ?? 0,
        driftFindings: audit.drift?.findings?.length ?? 0,
        driftErrors: audit.drift?.errorCount ?? 0,
        driftWarnings: audit.drift?.warningCount ?? 0,
        baselineFindings: baseline.totals?.findings ?? 0
      }
    };
    await writeRevisionCiBootstrapManifest(tempRoot, bootstrap, {
      file: path.join(tempRoot, artifacts.bootstrapDir),
      relative: artifacts.bootstrapDir
    }, { force: true });
  });

  await check('strict-ci-check', artifacts.ciAudit, async () => {
    const reviewPath = path.join(artifacts.bootstrapDir, 'action-list.json');
    const applyReportPath = path.join(artifacts.bootstrapDir, 'apply-report.json');
    const audit = await buildRevisionAuditChain(tempRoot, reviewPath, applyReportPath, {
      verifyCurrent: true,
      failOnDrift: true,
      driftSeverity: 'warning',
      driftAllowFile: artifacts.driftAllowFile
    });
    await applyRevisionAuditDriftBaseline(tempRoot, audit, artifacts.baseline);
    if (audit.drift.failed) throw new Error('Strict CI check failed in self-test workspace.');
    await writeRevisionAuditChainOutput(tempRoot, audit, artifacts.ciAudit, { force: true });
    await writeRevisionAuditDriftReportOutput(tempRoot, audit, artifacts.ciDriftReport, {
      force: true,
      summaryFormat: 'github'
    });
  });

  await check('health-summary', artifacts.healthSummary, async () => {
    const health = await buildRevisionCiHealthSummary(tempRoot, {
      queue,
      baseline: artifacts.baseline,
      driftAllowFile: artifacts.driftAllowFile
    });
    if (!health.ok || !health.latestBootstrap.found || !health.audit.readable || !health.baseline.readable) {
      throw new Error('Revision CI health summary did not find the self-test artifacts.');
    }
    await writeRevisionCiHealthSummaryOutput(tempRoot, health, artifacts.healthSummary, { force: true });
  });

  await check('dashboard', artifacts.dashboard, async () => {
    const dashboard = await buildRevisionCiDashboard(tempRoot, {
      queue,
      baseline: artifacts.baseline,
      driftAllowFile: artifacts.driftAllowFile
    });
    if (!dashboard.ok || dashboard.queueCount !== 1 || dashboard.items[0]?.queue !== queue) {
      throw new Error('Revision CI dashboard did not summarize the self-test queue.');
    }
    await writeRevisionCiDashboardOutput(tempRoot, dashboard, artifacts.dashboard, { force: true });
  });

  await check('release-checklist', artifacts.releaseChecklist, async () => {
    const checklist = await buildRevisionCiReleaseChecklist(tempRoot, {
      queue,
      baseline: artifacts.baseline,
      driftAllowFile: artifacts.driftAllowFile
    });
    if (!checklist.ok || checklist.blockingOpenCount !== 0 || checklist.dashboard.queueCount !== 1) {
      throw new Error('Revision CI release checklist did not pass in the self-test workspace.');
    }
    await writeRevisionCiReleaseChecklistOutput(tempRoot, checklist, artifacts.releaseChecklist, { force: true });
  });

  const report = {
    mode: 'revision_ci_self_test',
    generatedAt: new Date().toISOString(),
    ok: checks.every((item) => item.ok),
    queue,
    repo,
    workflow,
    branch,
    label,
    tempRoot,
    checks,
    artifacts
  };
  const output = await writeRevisionCiSelfTestReport(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.queue}: revision CI self-test ${report.ok ? 'ok' : 'failed'}`);
    console.log(`  temp root: ${report.tempRoot}`);
    if (output) console.log(`  output: ${output.file}`);
    for (const item of report.checks) console.log(`  ${item.ok ? 'ok' : 'fail'} ${item.id}: ${item.detail}`);
  }
  return report.ok ? 0 : 1;
}

function workflowFileFromArg(workflow) {
  const value = String(workflow ?? 'loop-revision-ci.yml').trim();
  if (!value) throw new Error('queue-revision-ci-doctor requires a non-empty workflow value.');
  return value.includes('/') || value.includes('\\')
    ? safeRelativePath(value, 'revision CI workflow file')
    : path.join('.github', 'workflows', value);
}

function pushDoctorCheck(checks, id, level, ok, detail) {
  checks.push({ id, level, ok: Boolean(ok), detail });
}

async function runRevisionCiDoctor(root, options = {}) {
  const queue = String(options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-doctor requires --queue or --config.');
  const workflow = workflowFileFromArg(options.workflow);
  const readme = safeRelativePath(options.readme ?? 'README.md', 'revision CI doctor README');
  const baseline = options.baseline
    ? safeRelativePath(options.baseline, 'revision CI doctor baseline')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json');
  const artifactDir = options.outputDir && options.outputDir !== true
    ? safeRelativePath(options.outputDir, 'revision CI doctor artifact dir')
    : '.loop-engineering/revision-ci/${{ github.run_id }}';
  const driftAllowFile = options.driftAllowFile
    ? safeRelativePath(options.driftAllowFile, 'revision CI doctor drift allow file')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'drift-allow.json');
  const checks = [];

  const workflowPath = path.join(root, workflow);
  let workflowContent = '';
  if (await fileExists(workflowPath)) {
    workflowContent = await readFile(workflowPath, 'utf8');
    pushDoctorCheck(checks, 'workflow-exists', 'fail', true, workflow);
    pushDoctorCheck(checks, 'workflow-has-bootstrap', 'fail', workflowContent.includes('queue-revision-ci-bootstrap'), 'contains queue-revision-ci-bootstrap');
    pushDoctorCheck(checks, 'workflow-has-ci-check', 'fail', workflowContent.includes('queue-revision-ci-check'), 'contains queue-revision-ci-check');
    pushDoctorCheck(checks, 'workflow-queue-match', 'fail', workflowContent.includes(queue), `contains queue ${queue}`);
    pushDoctorCheck(checks, 'workflow-baseline-path-match', 'fail', workflowContent.includes(baseline), `contains baseline ${baseline}`);
    pushDoctorCheck(checks, 'workflow-artifact-dir-match', 'warn', workflowContent.includes(artifactDir), `contains artifact dir ${artifactDir}`);
  } else {
    pushDoctorCheck(checks, 'workflow-exists', 'fail', false, workflow);
  }

  const readmePath = path.join(root, readme);
  let readmeContent = '';
  if (await fileExists(readmePath)) {
    readmeContent = await readFile(readmePath, 'utf8');
    const start = readmeContent.indexOf(REVISION_CI_README_START);
    const end = readmeContent.indexOf(REVISION_CI_README_END);
    pushDoctorCheck(checks, 'readme-exists', 'fail', true, readme);
    pushDoctorCheck(checks, 'readme-marker-pair', 'fail', start !== -1 && end !== -1 && end > start, 'contains loop revision CI marker pair');
    pushDoctorCheck(checks, 'readme-queue-match', 'warn', readmeContent.includes(queue), `contains queue ${queue}`);
    pushDoctorCheck(checks, 'readme-workflow-link', 'warn', readmeContent.includes(path.basename(workflow)), `contains workflow ${path.basename(workflow)}`);
  } else {
    pushDoctorCheck(checks, 'readme-exists', 'fail', false, readme);
  }

  const baselinePath = path.join(root, baseline);
  if (await fileExists(baselinePath)) {
    try {
      const data = JSON.parse(await readFile(baselinePath, 'utf8'));
      pushDoctorCheck(checks, 'baseline-exists', 'fail', true, baseline);
      pushDoctorCheck(checks, 'baseline-mode', 'fail', data.mode === 'revision_drift_baseline', `mode=${data.mode ?? 'missing'}`);
      pushDoctorCheck(checks, 'baseline-queue-match', 'fail', data.queue === queue, `queue=${data.queue ?? 'missing'}`);
    } catch (err) {
      pushDoctorCheck(checks, 'baseline-readable-json', 'fail', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    pushDoctorCheck(checks, 'baseline-exists', 'fail', false, baseline);
  }

  const driftAllowPath = path.join(root, driftAllowFile);
  if (await fileExists(driftAllowPath)) {
    try {
      const data = JSON.parse(await readFile(driftAllowPath, 'utf8'));
      const entries = Array.isArray(data.allowed) ? data.allowed : [];
      pushDoctorCheck(checks, 'drift-allow-file-exists', 'warn', true, driftAllowFile);
      pushDoctorCheck(checks, 'drift-allow-file-shape', 'fail', Array.isArray(data.allowed), 'allowed[] is present');
      pushDoctorCheck(checks, 'drift-allow-file-auditable', 'warn', entries.every((entry) => entry.type && entry.reason && entry.owner && entry.expiresAt), `${entries.length} entries`);
    } catch (err) {
      pushDoctorCheck(checks, 'drift-allow-file-readable-json', 'fail', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    pushDoctorCheck(checks, 'drift-allow-file-exists', 'warn', false, `${driftAllowFile} (optional)`);
  }

  const failCount = checks.filter((item) => item.level === 'fail' && !item.ok).length;
  const warnCount = checks.filter((item) => item.level === 'warn' && !item.ok).length;
  return {
    mode: 'revision_ci_doctor',
    generatedAt: new Date().toISOString(),
    ok: failCount === 0,
    failCount,
    warnCount,
    queue,
    paths: {
      workflow,
      readme,
      baseline,
      artifactDir,
      driftAllowFile
    },
    checks
  };
}

function renderRevisionCiDoctorMarkdown(report) {
  const lines = [];
  lines.push(`# Loop Revision CI Doctor: ${report.queue}`);
  lines.push('');
  lines.push(`Status: ${report.ok ? 'ok' : 'failed'}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Failures: ${report.failCount}`);
  lines.push(`Warnings: ${report.warnCount}`);
  lines.push('');
  lines.push('| Path | Value |');
  lines.push('| --- | --- |');
  for (const [key, value] of Object.entries(report.paths)) {
    lines.push(`| ${key} | \`${value}\` |`);
  }
  lines.push('');
  lines.push('| Check | Level | Status | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const check of report.checks) {
    lines.push(`| \`${check.id}\` | ${check.level} | ${check.ok ? 'ok' : 'failed'} | ${String(check.detail ?? '').replaceAll('|', '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiDoctorReport(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI doctor output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI doctor output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-doctor --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiDoctorMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiDoctorCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const options = mergeQueueOptions(config, args);
  const report = await runRevisionCiDoctor(args.root, {
    queue: options.queue,
    workflow: args.workflow,
    readme: args.readme,
    baseline: args.baseline ?? args.baselineOutput,
    outputDir: args.outputDir,
    driftAllowFile: args.driftAllowFile
  });
  const output = await writeRevisionCiDoctorReport(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.queue}: revision CI doctor ${report.ok ? 'ok' : 'failed'}`);
    if (output) console.log(`  output: ${output.file}`);
    console.log(`  failures: ${report.failCount}`);
    console.log(`  warnings: ${report.warnCount}`);
    for (const item of report.checks) {
      console.log(`  ${item.ok ? 'ok' : item.level} ${item.id}: ${item.detail}`);
    }
  }
  return report.ok ? 0 : 2;
}

function hasFailedDoctorCheck(report, predicate) {
  return (report.checks ?? []).some((check) => !check.ok && predicate(check));
}

function addRepairAction(actions, action) {
  if (actions.some((item) => item.id === action.id)) return;
  actions.push(action);
}

function buildRevisionCiRepairPlan(doctor, options = {}) {
  const queue = String(doctor.queue ?? options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-repair-plan requires --queue or a doctor report with queue.');
  const paths = {
    workflow: doctor.paths?.workflow ?? workflowFileFromArg(options.workflow),
    readme: doctor.paths?.readme ?? safeRelativePath(options.readme ?? 'README.md', 'revision CI repair README'),
    baseline: doctor.paths?.baseline ?? (options.baseline
      ? safeRelativePath(options.baseline, 'revision CI repair baseline')
      : path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json')),
    artifactDir: doctor.paths?.artifactDir ?? (options.outputDir && options.outputDir !== true
      ? safeRelativePath(options.outputDir, 'revision CI repair artifact dir')
      : '.loop-engineering/revision-ci/${{ github.run_id }}'),
    driftAllowFile: doctor.paths?.driftAllowFile ?? (options.driftAllowFile
      ? safeRelativePath(options.driftAllowFile, 'revision CI repair drift allow file')
      : path.join('runtime', 'loops', queue, 'ci-baseline', 'drift-allow.json'))
  };
  const workflowName = path.basename(paths.workflow);
  const repoFlag = options.repo ? `--repo ${shellSingleQuote(options.repo)}` : '';
  const actions = [];

  if (hasFailedDoctorCheck(doctor, (check) => check.id.startsWith('workflow-'))) {
    addRepairAction(actions, {
      id: 'regenerate_workflow',
      reason: 'Workflow is missing or does not reference the expected revision CI queue, baseline, artifact dir, bootstrap, or check command.',
      command: commandLine([
        'loop-engineering queue-revision-ci-workflow-template',
        '--queue', shellSingleQuote(queue),
        '--output', shellSingleQuote(paths.workflow),
        '--output-dir', shellSingleQuote(paths.artifactDir),
        '--baseline-output', shellSingleQuote(paths.baseline),
        '--force'
      ])
    });
  }

  if (hasFailedDoctorCheck(doctor, (check) => check.id.startsWith('readme-'))) {
    addRepairAction(actions, {
      id: 'refresh_readme_marker',
      reason: 'README is missing or does not contain the stable loop revision CI marker block.',
      command: commandLine([
        'loop-engineering queue-revision-ci-readme-update',
        '--queue', shellSingleQuote(queue),
        '--readme', shellSingleQuote(paths.readme),
        repoFlag,
        '--workflow', shellSingleQuote(workflowName)
      ])
    });
  }

  if (hasFailedDoctorCheck(doctor, (check) => check.id.startsWith('baseline-'))) {
    addRepairAction(actions, {
      id: 'rebuild_baseline',
      reason: 'Baseline is missing, unreadable, or not queue-matched.',
      command: commandLine([
        'loop-engineering queue-revision-ci-bootstrap',
        '--queue', shellSingleQuote(queue),
        '--output-dir', shellSingleQuote(path.join('runtime', 'loops', queue, 'ci-bootstrap', 'repair')),
        '--baseline-output', shellSingleQuote(paths.baseline),
        '--force'
      ])
    });
  }

  if (hasFailedDoctorCheck(doctor, (check) => check.id.startsWith('drift-allow-file'))) {
    addRepairAction(actions, {
      id: 'refresh_drift_allow_file',
      reason: 'Drift allow-file is missing, unreadable, or missing auditable fields.',
      command: commandLine([
        'loop-engineering queue-revision-drift-allow-template',
        '--type unreported_actionable_review_plan',
        '--owner platform-ci',
        '--reason', shellSingleQuote('Pending owner review before the next batch apply.'),
        '--ttl 24h',
        '--output', shellSingleQuote(paths.driftAllowFile),
        '--force'
      ])
    });
  }

  addRepairAction(actions, {
    id: 'rerun_doctor',
    reason: 'Re-run doctor after applying selected repair commands.',
    command: commandLine([
      'loop-engineering queue-revision-ci-doctor',
      '--queue', shellSingleQuote(queue),
      '--workflow', shellSingleQuote(paths.workflow),
      '--readme', shellSingleQuote(paths.readme),
      '--baseline', shellSingleQuote(paths.baseline),
      '--output-dir', shellSingleQuote(paths.artifactDir),
      '--drift-allow-file', shellSingleQuote(paths.driftAllowFile)
    ])
  });

  const actionable = actions.filter((item) => item.id !== 'rerun_doctor');
  return {
    mode: 'revision_ci_repair_plan',
    generatedAt: new Date().toISOString(),
    queue,
    doctor: {
      ok: Boolean(doctor.ok),
      failCount: doctor.failCount ?? 0,
      warnCount: doctor.warnCount ?? 0,
      source: options.source ?? null
    },
    paths,
    actions,
    actionCount: actionable.length,
    status: actionable.length === 0 ? 'no_repairs_needed' : 'repairs_available'
  };
}

function renderRevisionCiRepairPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# Loop Revision CI Repair Plan: ${plan.queue}`);
  lines.push('');
  lines.push(`Status: ${plan.status}`);
  lines.push(`Generated at: ${plan.generatedAt}`);
  lines.push(`Doctor failures: ${plan.doctor.failCount}`);
  lines.push(`Doctor warnings: ${plan.doctor.warnCount}`);
  if (plan.doctor.source) lines.push(`Doctor source: \`${plan.doctor.source}\``);
  lines.push('');
  lines.push('| Path | Value |');
  lines.push('| --- | --- |');
  for (const [key, value] of Object.entries(plan.paths)) {
    lines.push(`| ${key} | \`${value}\` |`);
  }
  lines.push('');
  lines.push('## Actions');
  lines.push('');
  if (plan.actionCount === 0) {
    lines.push('No repair commands are needed.');
  } else {
    for (const action of plan.actions) {
      lines.push(`### ${action.id}`);
      lines.push('');
      lines.push(action.reason);
      lines.push('');
      lines.push('```bash');
      lines.push(action.command);
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function writeRevisionCiRepairPlanOutput(root, plan, output, options = {}) {
  if (!output) throw new Error('queue-revision-ci-repair-plan requires --output.');
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI repair plan output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI repair plan output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-repair-plan --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, plan);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiRepairPlanMarkdown(plan));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiRepairPlanCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const options = mergeQueueOptions(config, args);
  const source = args.from ? await readWorkspaceJson(args.root, args.from, 'revision CI doctor source') : null;
  const doctor = source?.data ?? await runRevisionCiDoctor(args.root, {
    queue: options.queue,
    workflow: args.workflow,
    readme: args.readme,
    baseline: args.baseline ?? args.baselineOutput,
    outputDir: args.outputDir,
    driftAllowFile: args.driftAllowFile
  });
  if (doctor.mode !== 'revision_ci_doctor') {
    throw new Error('queue-revision-ci-repair-plan --from must point to a queue-revision-ci-doctor JSON report.');
  }
  const plan = buildRevisionCiRepairPlan(doctor, {
    queue: options.queue,
    workflow: args.workflow,
    readme: args.readme,
    baseline: args.baseline ?? args.baselineOutput,
    outputDir: args.outputDir,
    driftAllowFile: args.driftAllowFile,
    repo: args.repo,
    source: source?.file ?? null
  });
  const output = await writeRevisionCiRepairPlanOutput(args.root, plan, args.output, {
    force: args.force
  });
  plan.output = output;
  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`${plan.queue}: revision CI repair plan ${plan.status}`);
    console.log(`  output: ${output.file}`);
    console.log(`  actions: ${plan.actionCount}`);
    for (const action of plan.actions) console.log(`  - ${action.id}: ${action.command}`);
  }
  return 0;
}

function actionableRevisionCiRepairActions(plan) {
  return (plan.actions ?? []).filter((action) => action.id !== 'rerun_doctor');
}

function selectedRevisionCiRepairActionIds(plan, value) {
  const available = new Set(actionableRevisionCiRepairActions(plan).map((action) => action.id));
  const selected = parseCsvSet(value, [...available]);
  const unknown = [...selected].filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown repair action(s): ${unknown.join(', ')}. Available: ${[...available].join(', ') || 'none'}.`);
  }
  return selected;
}

async function applyRevisionCiRepairAction(root, plan, actionId, options = {}) {
  const queue = plan.queue;
  const paths = plan.paths ?? {};
  if (actionId === 'regenerate_workflow') {
    const template = buildRevisionCiWorkflowTemplate({
      queue,
      outputDir: paths.artifactDir,
      baselineOutput: paths.baseline
    });
    const output = await writeRevisionCiWorkflowTemplateOutput(root, template, paths.workflow, {
      force: true
    });
    return { output };
  }

  if (actionId === 'refresh_readme_marker') {
    const readmeRel = safeRelativePath(paths.readme ?? 'README.md', 'revision CI repair README');
    const readmeFile = path.resolve(root, readmeRel);
    if (path.extname(readmeFile).toLowerCase() !== '.md') {
      throw new Error('repair README path must end with .md.');
    }
    if (!(await fileExists(readmeFile))) {
      throw new Error(`README file does not exist: ${path.relative(root, readmeFile)}`);
    }
    const inferredRepo = options.repo ? null : await inferGithubRepoFromGitConfig(root);
    const section = buildRevisionCiReadmeSection({
      repo: options.repo ?? inferredRepo,
      workflow: path.basename(paths.workflow ?? 'loop-revision-ci.yml'),
      branch: options.branch,
      label: options.label,
      queue
    });
    const existing = await readFile(readmeFile, 'utf8');
    const updated = updateRevisionCiReadmeContent(existing, section);
    if (updated.content === existing) updated.action = 'unchanged';
    else await writeFile(readmeFile, updated.content);
    return {
      readme: {
        file: path.relative(root, readmeFile),
        action: updated.action
      },
      repo: section.repo,
      repoInferred: !options.repo && Boolean(inferredRepo)
    };
  }

  if (actionId === 'rebuild_baseline') {
    const bootstrap = await runRevisionCiBootstrap(root, {
      queue,
      outputDir: path.join('runtime', 'loops', queue, 'ci-bootstrap', 'repair'),
      baselineOutput: paths.baseline,
      force: true
    });
    return {
      bootstrap: {
        outputDir: bootstrap.outputDir,
        artifacts: bootstrap.artifacts,
        summary: bootstrap.summary
      }
    };
  }

  if (actionId === 'refresh_drift_allow_file') {
    const template = buildRevisionDriftAllowTemplate({
      type: 'unreported_actionable_review_plan',
      owner: 'platform-ci',
      reason: 'Pending owner review before the next batch apply.',
      ttl: '24h'
    });
    const output = await writeRevisionDriftAllowTemplateOutput(root, template, paths.driftAllowFile, {
      force: true
    });
    return {
      output,
      entries: template.allowed.length,
      expiresAt: template.allowed[0]?.expiresAt ?? null
    };
  }

  throw new Error(`Unsupported repair action: ${actionId}`);
}

function renderRevisionCiApplyRepairPlanMarkdown(report) {
  const lines = [];
  lines.push(`# Loop Revision CI Apply Repair Plan: ${report.queue}`);
  lines.push('');
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Repair plan: \`${report.repairPlan}\``);
  lines.push(`Confirmed: ${report.confirmed ? 'yes' : 'no'}`);
  lines.push(`Applied: ${report.appliedCount}`);
  lines.push(`Skipped: ${report.skippedCount}`);
  lines.push(`Failed: ${report.failedCount}`);
  lines.push('');
  lines.push('## Actions');
  lines.push('');
  if (report.actions.length === 0) {
    lines.push('No repair actions were selected.');
  } else {
    for (const action of report.actions) {
      lines.push(`- \`${action.id}\`: ${action.status}`);
      if (action.reason) lines.push(`  - Reason: ${action.reason}`);
      if (action.error) lines.push(`  - Error: ${action.error}`);
    }
  }
  lines.push('');
  lines.push('## Doctor');
  lines.push('');
  if (report.doctor) {
    lines.push(`- Status: ${report.doctor.ok ? 'ok' : 'failed'}`);
    lines.push(`- Failures: ${report.doctor.failCount}`);
    lines.push(`- Warnings: ${report.doctor.warnCount}`);
  } else {
    lines.push('Doctor was not rerun.');
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiApplyRepairPlanReport(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI apply repair plan output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI apply repair plan output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-apply-repair-plan --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiApplyRepairPlanMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiApplyRepairPlanCommand(args) {
  if (!args.from) throw new Error('queue-revision-ci-apply-repair-plan requires --from repair-plan.json.');
  const source = await readWorkspaceJson(args.root, args.from, 'revision CI repair plan');
  const plan = source.data;
  if (plan.mode !== 'revision_ci_repair_plan') {
    throw new Error('queue-revision-ci-apply-repair-plan --from must point to a queue-revision-ci-repair-plan JSON report.');
  }
  const selected = selectedRevisionCiRepairActionIds(plan, args.action);
  const confirmed = Boolean(args.confirmApply);
  const actions = [];
  for (const action of actionableRevisionCiRepairActions(plan)) {
    if (!selected.has(action.id)) {
      actions.push({ id: action.id, status: 'skipped', reason: 'action not selected' });
      continue;
    }
    if (!confirmed) {
      actions.push({ id: action.id, status: 'pending_confirmation', reason: 'requires --confirm-apply' });
      continue;
    }
    try {
      const result = await applyRevisionCiRepairAction(args.root, plan, action.id, {
        repo: args.repo,
        branch: args.branch,
        label: args.label
      });
      actions.push({ id: action.id, status: 'applied', result });
    } catch (err) {
      actions.push({
        id: action.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  let doctor = null;
  if (confirmed) {
    doctor = await runRevisionCiDoctor(args.root, {
      queue: plan.queue,
      workflow: plan.paths?.workflow,
      readme: plan.paths?.readme,
      baseline: plan.paths?.baseline,
      outputDir: plan.paths?.artifactDir,
      driftAllowFile: plan.paths?.driftAllowFile
    });
  }
  const failedCount = actions.filter((action) => action.status === 'failed').length;
  const report = {
    mode: 'revision_ci_apply_repair_plan',
    generatedAt: new Date().toISOString(),
    queue: plan.queue,
    repairPlan: source.file,
    confirmed,
    status: !confirmed
      ? 'confirmation_required'
      : (failedCount > 0 || doctor?.ok === false ? 'failed' : 'applied'),
    selectedActions: [...selected],
    appliedCount: actions.filter((action) => action.status === 'applied').length,
    skippedCount: actions.filter((action) => action.status === 'skipped').length,
    failedCount,
    actions,
    doctor
  };
  const output = await writeRevisionCiApplyRepairPlanReport(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.queue}: revision CI apply repair plan ${report.status}`);
    if (output) console.log(`  output: ${output.file}`);
    console.log(`  confirmed: ${report.confirmed ? 'yes' : 'no'}`);
    console.log(`  applied: ${report.appliedCount}`);
    console.log(`  skipped: ${report.skippedCount}`);
    console.log(`  failed: ${report.failedCount}`);
    if (doctor) console.log(`  doctor: ${doctor.ok ? 'ok' : 'failed'} (${doctor.failCount} failures, ${doctor.warnCount} warnings)`);
    for (const action of actions) {
      console.log(`  - ${action.id}: ${action.status}${action.error ? ` (${action.error})` : ''}`);
    }
  }
  return report.status === 'failed' ? 2 : 0;
}

function summarizeRevisionCiJsonArtifact(artifact, expectedMode, expectedQueue) {
  const data = artifact.data;
  return {
    file: artifact.file,
    configured: Boolean(artifact.file),
    found: artifact.readable,
    readable: artifact.readable,
    mode: data?.mode ?? null,
    modeMatches: artifact.readable ? data?.mode === expectedMode : false,
    queue: data?.queue ?? null,
    queueMatches: artifact.readable ? data?.queue === expectedQueue : false,
    generatedAt: data?.generatedAt ?? null,
    error: artifact.error
  };
}

async function readRevisionCiJsonArtifact(root, rel, label, expectedMode, expectedQueue) {
  const artifact = await readWorkspaceJsonMaybe(root, rel, label);
  return summarizeRevisionCiJsonArtifact(artifact, expectedMode, expectedQueue);
}

function summarizeRevisionCiBaseline(artifact, queue) {
  const base = summarizeRevisionCiJsonArtifact(artifact, 'revision_drift_baseline', queue);
  const totals = artifact.data?.totals ?? {};
  return {
    ...base,
    totals: {
      findings: totals.findings ?? null,
      errors: totals.errors ?? null,
      warnings: totals.warnings ?? null,
      allowed: totals.allowed ?? null,
      sourceBaselineKnown: totals.sourceBaselineKnown ?? null
    }
  };
}

function summarizeRevisionCiAudit(artifact, queue) {
  const base = summarizeRevisionCiJsonArtifact(artifact, 'revision_audit_chain', queue);
  const drift = artifact.data?.drift ?? {};
  const totals = artifact.data?.totals ?? {};
  return {
    ...base,
    drift: {
      failed: Boolean(drift.failed),
      errorCount: drift.errorCount ?? null,
      warningCount: drift.warningCount ?? null,
      allowedCount: drift.allowedCount ?? null,
      blockingErrorCount: drift.blockingErrorCount ?? null,
      blockingWarningCount: drift.blockingWarningCount ?? null,
      findingCount: Array.isArray(drift.findings) ? drift.findings.length : null
    },
    totals: {
      reviewPlans: totals.reviewPlans ?? null,
      reportEntries: totals.reportEntries ?? null,
      applied: totals.applied ?? null,
      skipped: totals.skipped ?? null,
      currentTasksMissing: totals.currentTasksMissing ?? null,
      unreportedReviewPlans: totals.unreportedReviewPlans ?? null
    }
  };
}

function summarizeRevisionCiApplyReport(artifact, queue) {
  const base = summarizeRevisionCiJsonArtifact(artifact, artifact.data?.mode, queue);
  const acceptedModes = new Set(['from_review', 'revision_ci_apply_repair_plan']);
  const data = artifact.data ?? {};
  return {
    ...base,
    modeMatches: artifact.readable ? acceptedModes.has(data.mode) : false,
    review: data.review ?? null,
    reviewedPlans: data.reviewedPlans ?? null,
    appliedCount: data.appliedCount ?? null,
    skippedCount: data.skippedCount ?? null,
    failedCount: data.failedCount ?? null,
    status: data.status ?? null,
    actionCount: Array.isArray(data.actions) ? data.actions.length : null
  };
}

function summarizeRevisionCiRepairPlanArtifact(artifact, queue) {
  const base = summarizeRevisionCiJsonArtifact(artifact, 'revision_ci_repair_plan', queue);
  const data = artifact.data ?? {};
  return {
    ...base,
    status: data.status ?? null,
    actionCount: data.actionCount ?? null,
    doctor: data.doctor ?? null
  };
}

function summarizeRevisionCiDriftAllowFile(artifact) {
  const data = artifact.data;
  const entries = Array.isArray(data?.allowed) ? data.allowed : [];
  const now = Date.now();
  return {
    file: artifact.file,
    configured: Boolean(artifact.file),
    found: artifact.readable,
    readable: artifact.readable,
    entryCount: artifact.readable ? entries.length : null,
    activeCount: artifact.readable ? entries.filter((entry) => Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) > now).length : null,
    expiredCount: artifact.readable ? entries.filter((entry) => Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) <= now).length : null,
    auditable: artifact.readable ? entries.every((entry) => entry.type && entry.reason && entry.owner && entry.expiresAt) : false,
    error: artifact.error
  };
}

async function findLatestRevisionCiBootstrap(root, queue, bootstrapDirOption) {
  const baseRel = bootstrapDirOption
    ? safeRelativePath(bootstrapDirOption, 'revision CI health bootstrap dir')
    : path.join('runtime', 'loops', queue, 'ci-bootstrap');
  const baseDir = path.resolve(root, baseRel);
  const candidates = [];

  async function addManifest(rel) {
    const artifact = await readWorkspaceJsonMaybe(root, rel, 'revision CI bootstrap manifest');
    if (!artifact.readable) return;
    if (artifact.data?.mode !== 'revision_ci_bootstrap') return;
    candidates.push(artifact);
  }

  await addManifest(path.join(baseRel, 'bootstrap.json'));
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await addManifest(path.join(baseRel, entry.name, 'bootstrap.json'));
    }
  } catch {
    // Missing bootstrap history is a normal pre-install state.
  }

  candidates.sort((a, b) => {
    const at = Date.parse(a.data?.generatedAt ?? '') || 0;
    const bt = Date.parse(b.data?.generatedAt ?? '') || 0;
    if (at !== bt) return bt - at;
    return String(b.file).localeCompare(String(a.file));
  });
  const latest = candidates[0] ?? null;
  return {
    searchedDir: path.relative(root, baseDir),
    found: Boolean(latest),
    file: latest?.file ?? null,
    generatedAt: latest?.data?.generatedAt ?? null,
    queue: latest?.data?.queue ?? null,
    queueMatches: latest ? latest.data?.queue === queue : false,
    summary: latest?.data?.summary ?? null,
    artifacts: latest?.data?.artifacts ?? null,
    ciCommand: latest?.data?.ciCommand ?? null
  };
}

function computeRevisionCiHealthStatus(report) {
  const findings = [];
  if (!report.doctor.ok) findings.push('doctor_failed');
  if (!report.baseline.readable) findings.push('baseline_unreadable_or_missing');
  else {
    if (!report.baseline.modeMatches) findings.push('baseline_mode_mismatch');
    if (!report.baseline.queueMatches) findings.push('baseline_queue_mismatch');
  }
  if (report.latestBootstrap.found && !report.latestBootstrap.queueMatches) findings.push('bootstrap_queue_mismatch');
  if (report.audit.configured) {
    if (!report.audit.readable) findings.push('audit_unreadable');
    else {
      if (!report.audit.modeMatches) findings.push('audit_mode_mismatch');
      if (!report.audit.queueMatches) findings.push('audit_queue_mismatch');
      if (report.audit.drift.failed) findings.push('audit_drift_failed');
    }
  }
  if (report.repairPlan.configured && report.repairPlan.readable && report.repairPlan.status === 'repairs_available') {
    findings.push('repair_plan_has_available_repairs');
  }
  if (report.applyReport.configured && report.applyReport.readable && report.applyReport.status === 'failed') {
    findings.push('apply_report_failed');
  }
  return {
    ok: findings.length === 0,
    status: findings.length === 0 ? 'ok' : 'attention',
    findings
  };
}

async function buildRevisionCiHealthSummary(root, options = {}) {
  const queue = String(options.queue ?? '').trim();
  if (!queue) throw new Error('queue-revision-ci-health-summary requires --queue or --config.');
  const doctor = await runRevisionCiDoctor(root, {
    queue,
    workflow: options.workflow,
    readme: options.readme,
    baseline: options.baseline,
    outputDir: options.outputDir,
    driftAllowFile: options.driftAllowFile
  });
  const baselinePath = options.baseline
    ? safeRelativePath(options.baseline, 'revision CI health baseline')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'previous-audit.json');
  const driftAllowPath = options.driftAllowFile
    ? safeRelativePath(options.driftAllowFile, 'revision CI health drift allow file')
    : path.join('runtime', 'loops', queue, 'ci-baseline', 'drift-allow.json');
  const latestBootstrap = await findLatestRevisionCiBootstrap(root, queue, options.bootstrapDir);
  const repairPlan = options.repairPlan
    ? summarizeRevisionCiRepairPlanArtifact(await readWorkspaceJsonMaybe(root, options.repairPlan, 'revision CI repair plan'), queue)
    : { configured: false, file: null, found: false, readable: false, error: null };
  const applyReportPath = options.applyReport ?? latestBootstrap.artifacts?.applyReport?.file ?? null;
  const auditPath = latestBootstrap.artifacts?.auditChain?.file ?? null;
  const reviewPath = latestBootstrap.artifacts?.review?.file ?? null;
  const driftReportPath = latestBootstrap.artifacts?.driftReport?.file ?? null;
  const baselineArtifact = await readWorkspaceJsonMaybe(root, baselinePath, 'revision CI baseline');
  const auditArtifact = auditPath
    ? await readWorkspaceJsonMaybe(root, auditPath, 'revision CI audit chain')
    : { file: null, readable: false, data: null, error: 'no latest bootstrap audit artifact' };
  const applyArtifact = applyReportPath
    ? await readWorkspaceJsonMaybe(root, applyReportPath, 'revision apply report')
    : { file: null, readable: false, data: null, error: 'no apply report configured or discovered' };
  const driftAllowArtifact = await readWorkspaceJsonMaybe(root, driftAllowPath, 'revision CI drift allow file');
  const report = {
    mode: 'revision_ci_health_summary',
    generatedAt: new Date().toISOString(),
    queue,
    doctor: {
      ok: doctor.ok,
      failCount: doctor.failCount,
      warnCount: doctor.warnCount,
      checks: doctor.checks.map((check) => ({
        id: check.id,
        level: check.level,
        ok: check.ok,
        detail: check.detail
      })),
      paths: doctor.paths
    },
    latestBootstrap,
    review: {
      configured: Boolean(reviewPath),
      file: reviewPath,
      found: Boolean(reviewPath)
    },
    applyReport: applyReportPath
      ? summarizeRevisionCiApplyReport(applyArtifact, queue)
      : { configured: false, file: null, found: false, readable: false, error: applyArtifact.error },
    audit: auditPath
      ? summarizeRevisionCiAudit(auditArtifact, queue)
      : { configured: false, file: null, found: false, readable: false, error: auditArtifact.error },
    driftReport: {
      configured: Boolean(driftReportPath),
      file: driftReportPath,
      found: Boolean(driftReportPath)
    },
    baseline: summarizeRevisionCiBaseline(baselineArtifact, queue),
    driftAllowFile: summarizeRevisionCiDriftAllowFile(driftAllowArtifact),
    repairPlan
  };
  const health = computeRevisionCiHealthStatus(report);
  return {
    ...report,
    ok: health.ok,
    status: health.status,
    findings: health.findings
  };
}

function renderRevisionCiHealthSummaryMarkdown(report) {
  const lines = [];
  lines.push(`# Loop Revision CI Health Summary: ${report.queue}`);
  lines.push('');
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Findings: ${report.findings.length ? report.findings.join(', ') : 'none'}`);
  lines.push('');
  lines.push('## Doctor');
  lines.push('');
  lines.push(`- Status: ${report.doctor.ok ? 'ok' : 'failed'}`);
  lines.push(`- Failures: ${report.doctor.failCount}`);
  lines.push(`- Warnings: ${report.doctor.warnCount}`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- Latest bootstrap: ${report.latestBootstrap.found ? `\`${report.latestBootstrap.file}\`` : `none found under \`${report.latestBootstrap.searchedDir}\``}`);
  lines.push(`- Baseline: \`${report.baseline.file}\` (${report.baseline.readable ? 'readable' : 'missing/unreadable'})`);
  lines.push(`- Audit chain: ${report.audit.configured ? `\`${report.audit.file}\` (${report.audit.readable ? 'readable' : 'unreadable'})` : 'not discovered'}`);
  lines.push(`- Apply report: ${report.applyReport.configured ? `\`${report.applyReport.file}\` (${report.applyReport.readable ? 'readable' : 'unreadable'})` : 'not configured or discovered'}`);
  lines.push(`- Repair plan: ${report.repairPlan.configured ? `\`${report.repairPlan.file}\` (${report.repairPlan.status ?? 'unknown'})` : 'not configured'}`);
  lines.push(`- Drift allow file: \`${report.driftAllowFile.file}\` (${report.driftAllowFile.readable ? `${report.driftAllowFile.entryCount} entries, ${report.driftAllowFile.activeCount} active` : 'missing/unreadable optional file'})`);
  lines.push('');
  lines.push('## Drift');
  lines.push('');
  if (report.audit.configured && report.audit.readable) {
    lines.push(`- Failed: ${report.audit.drift.failed ? 'yes' : 'no'}`);
    lines.push(`- Findings: ${report.audit.drift.findingCount}`);
    lines.push(`- Errors: ${report.audit.drift.errorCount}`);
    lines.push(`- Warnings: ${report.audit.drift.warningCount}`);
    lines.push(`- Allowed: ${report.audit.drift.allowedCount}`);
  } else {
    lines.push('No audit chain was discovered from the latest bootstrap.');
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiHealthSummaryOutput(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI health summary output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI health summary output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-health-summary --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiHealthSummaryMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiHealthSummaryCommand(args) {
  const config = args.config ? await loadQueueConfig(args.root, args.config) : {};
  const options = mergeQueueOptions(config, args);
  const report = await buildRevisionCiHealthSummary(args.root, {
    queue: options.queue,
    workflow: args.workflow,
    readme: args.readme,
    baseline: args.baseline ?? args.baselineOutput,
    outputDir: args.outputDir,
    driftAllowFile: args.driftAllowFile,
    bootstrapDir: args.bootstrapDir,
    repairPlan: args.repairPlan,
    applyReport: args.applyReport
  });
  const output = await writeRevisionCiHealthSummaryOutput(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.queue}: revision CI health ${report.status}`);
    if (output) console.log(`  output: ${output.file}`);
    console.log(`  doctor: ${report.doctor.ok ? 'ok' : 'failed'} (${report.doctor.failCount} failures, ${report.doctor.warnCount} warnings)`);
    console.log(`  bootstrap: ${report.latestBootstrap.found ? report.latestBootstrap.file : 'none'}`);
    console.log(`  baseline: ${report.baseline.readable ? 'readable' : 'missing/unreadable'} ${report.baseline.file}`);
    console.log(`  audit drift: ${report.audit.configured && report.audit.readable ? `${report.audit.drift.findingCount} findings (${report.audit.drift.errorCount} errors, ${report.audit.drift.warningCount} warnings)` : 'not discovered'}`);
    console.log(`  findings: ${report.findings.length ? report.findings.join(', ') : 'none'}`);
  }
  return report.ok ? 0 : 2;
}

async function revisionCiDashboardQueueTargets(root, args) {
  if (args.config || args.queue) {
    const config = args.config ? await loadQueueConfig(root, args.config) : {};
    const options = mergeQueueOptions(config, args);
    if (!options.queue) throw new Error('queue-revision-ci-dashboard requires --queue, --config, or queue config files.');
    return [{
      queue: options.queue,
      config: args.config ?? null,
      options
    }];
  }
  const dir = path.join(root, 'configs', 'loops', 'queues');
  const targets = [];
  for (const fileName of await listJsonFilesMaybe(dir)) {
    const rel = path.join('configs', 'loops', 'queues', fileName);
    try {
      const config = await loadQueueConfig(root, rel);
      const options = mergeQueueOptions(config, {});
      targets.push({
        queue: options.queue,
        config: rel,
        options
      });
    } catch (err) {
      targets.push({
        queue: path.basename(fileName, '.json'),
        config: rel,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return targets;
}

function summarizeRevisionCiDashboardItem(target, health) {
  if (!health) {
    return {
      queue: target.queue,
      config: target.config,
      ok: false,
      status: 'attention',
      error: target.error ?? 'health summary failed',
      doctor: null,
      latestBootstrap: null,
      baseline: null,
      audit: null,
      findings: ['dashboard_target_error']
    };
  }
  return {
    queue: target.queue,
    config: target.config,
    ok: health.ok,
    status: health.status,
    doctor: {
      ok: health.doctor.ok,
      failCount: health.doctor.failCount,
      warnCount: health.doctor.warnCount
    },
    latestBootstrap: {
      found: health.latestBootstrap.found,
      file: health.latestBootstrap.file,
      generatedAt: health.latestBootstrap.generatedAt
    },
    baseline: {
      readable: health.baseline.readable,
      file: health.baseline.file,
      findings: health.baseline.totals.findings
    },
    audit: {
      configured: health.audit.configured,
      readable: health.audit.readable,
      driftFailed: health.audit.drift?.failed ?? false,
      driftFindings: health.audit.drift?.findingCount ?? null,
      driftErrors: health.audit.drift?.errorCount ?? null,
      driftWarnings: health.audit.drift?.warningCount ?? null
    },
    findings: health.findings
  };
}

async function buildRevisionCiDashboard(root, args) {
  const targets = await revisionCiDashboardQueueTargets(root, args);
  const items = [];
  for (const target of targets) {
    if (target.error) {
      items.push(summarizeRevisionCiDashboardItem(target, null));
      continue;
    }
    try {
      const health = await buildRevisionCiHealthSummary(root, {
        queue: target.queue,
        workflow: args.workflow,
        readme: args.readme,
        baseline: args.baseline ?? args.baselineOutput,
        outputDir: args.outputDir,
        driftAllowFile: args.driftAllowFile,
        bootstrapDir: args.bootstrapDir
      });
      items.push(summarizeRevisionCiDashboardItem(target, health));
    } catch (err) {
      items.push(summarizeRevisionCiDashboardItem({
        ...target,
        error: err instanceof Error ? err.message : String(err)
      }, null));
    }
  }
  const attentionCount = items.filter((item) => !item.ok).length;
  return {
    mode: 'revision_ci_dashboard',
    generatedAt: new Date().toISOString(),
    root,
    ok: attentionCount === 0,
    status: attentionCount === 0 ? 'ok' : 'attention',
    queueCount: items.length,
    attentionCount,
    items
  };
}

function renderRevisionCiDashboardMarkdown(report) {
  const lines = [];
  lines.push('# Loop Revision CI Dashboard');
  lines.push('');
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Queues: ${report.queueCount}`);
  lines.push(`Attention: ${report.attentionCount}`);
  lines.push('');
  lines.push('| Queue | Status | Doctor | Bootstrap | Baseline | Drift | Findings |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const item of report.items) {
    const doctor = item.doctor
      ? `${item.doctor.ok ? 'ok' : 'failed'} (${item.doctor.failCount}f/${item.doctor.warnCount}w)`
      : `error: ${String(item.error ?? 'unknown').replaceAll('|', '\\|')}`;
    const bootstrap = item.latestBootstrap?.found ? item.latestBootstrap.file : 'none';
    const baseline = item.baseline?.readable ? `${item.baseline.file} (${item.baseline.findings ?? 0} findings)` : 'missing/unreadable';
    const drift = item.audit?.readable
      ? `${item.audit.driftFindings ?? 0} findings (${item.audit.driftErrors ?? 0}e/${item.audit.driftWarnings ?? 0}w)`
      : 'not discovered';
    lines.push(`| \`${item.queue}\` | ${item.status} | ${doctor} | ${bootstrap} | ${baseline} | ${drift} | ${item.findings.length ? item.findings.join(', ') : 'none'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiDashboardOutput(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI dashboard output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI dashboard output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-dashboard --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiDashboardMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiDashboardCommand(args) {
  const report = await buildRevisionCiDashboard(args.root, args);
  const output = await writeRevisionCiDashboardOutput(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`revision CI dashboard ${report.status}`);
    if (output) console.log(`  output: ${output.file}`);
    console.log(`  queues: ${report.queueCount}`);
    console.log(`  attention: ${report.attentionCount}`);
    for (const item of report.items) {
      console.log(`  - ${item.queue}: ${item.status}${item.findings.length ? ` (${item.findings.join(', ')})` : ''}`);
    }
  }
  return report.ok ? 0 : 2;
}

function revisionCiReleaseChecklistItem(id, label, ok, detail, options = {}) {
  return {
    id,
    label,
    ok: Boolean(ok),
    level: options.level ?? 'blocker',
    queue: options.queue ?? null,
    detail: detail ?? ''
  };
}

async function buildRevisionCiReleaseChecklist(root, args = {}) {
  const dashboard = await buildRevisionCiDashboard(root, args);
  const items = [];
  items.push(revisionCiReleaseChecklistItem(
    'queue_targets_found',
    'At least one queue is included in the release check',
    dashboard.queueCount > 0,
    `${dashboard.queueCount} queue(s) inspected`
  ));
  items.push(revisionCiReleaseChecklistItem(
    'dashboard_ok',
    'Revision CI dashboard is healthy',
    dashboard.ok,
    `${dashboard.attentionCount} queue(s) need attention`
  ));
  for (const item of dashboard.items) {
    const prefix = `queue_${item.queue}`;
    items.push(revisionCiReleaseChecklistItem(
      `${prefix}_doctor_ok`,
      'Revision CI doctor passes',
      item.doctor?.ok === true,
      item.doctor ? `${item.doctor.failCount} failure(s), ${item.doctor.warnCount} warning(s)` : item.error,
      { queue: item.queue }
    ));
    items.push(revisionCiReleaseChecklistItem(
      `${prefix}_bootstrap_found`,
      'Latest bootstrap manifest is present',
      item.latestBootstrap?.found === true,
      item.latestBootstrap?.file ?? 'missing',
      { queue: item.queue }
    ));
    items.push(revisionCiReleaseChecklistItem(
      `${prefix}_baseline_readable`,
      'Revision drift baseline is readable',
      item.baseline?.readable === true,
      item.baseline?.file ?? 'missing',
      { queue: item.queue }
    ));
    items.push(revisionCiReleaseChecklistItem(
      `${prefix}_drift_clear`,
      'Latest audit drift does not fail CI',
      item.audit?.readable === true && item.audit?.driftFailed !== true,
      item.audit?.readable
        ? `${item.audit.driftFindings ?? 0} finding(s), ${item.audit.driftErrors ?? 0} error(s), ${item.audit.driftWarnings ?? 0} warning(s)`
        : 'audit not discovered',
      { queue: item.queue }
    ));
    items.push(revisionCiReleaseChecklistItem(
      `${prefix}_health_findings_clear`,
      'Health summary has no findings',
      item.findings.length === 0,
      item.findings.length ? item.findings.join(', ') : 'none',
      { queue: item.queue }
    ));
  }
  const manualItems = [
    {
      id: 'npm_check',
      label: 'Run package verification before release',
      command: 'npm run check',
      reason: 'Covers syntax, smoke commands, revision CI self-test, summarize, and doctor.'
    },
    {
      id: 'workspace_doctor',
      label: 'Run workspace doctor before release',
      command: 'loop-engineering doctor --root /path/to/workspace --json',
      reason: 'Confirms the target workspace has no loop configuration or runtime health failures.'
    },
    {
      id: 'package_dry_run',
      label: 'Inspect publish contents before release',
      command: 'npm pack --dry-run',
      reason: 'Shows the files that would be included in the npm package.'
    }
  ];
  const blockingOpenCount = items.filter((item) => item.level === 'blocker' && !item.ok).length;
  return {
    mode: 'revision_ci_release_checklist',
    generatedAt: new Date().toISOString(),
    root,
    ok: blockingOpenCount === 0,
    status: blockingOpenCount === 0 ? 'ok' : 'attention',
    blockingOpenCount,
    queueCount: dashboard.queueCount,
    attentionCount: dashboard.attentionCount,
    items,
    manualItems,
    dashboard: {
      status: dashboard.status,
      ok: dashboard.ok,
      queueCount: dashboard.queueCount,
      attentionCount: dashboard.attentionCount,
      items: dashboard.items
    }
  };
}

function renderRevisionCiReleaseChecklistMarkdown(report) {
  const lines = [];
  lines.push('# Loop Revision CI Release Checklist');
  lines.push('');
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Queues: ${report.queueCount}`);
  lines.push(`Blocking open: ${report.blockingOpenCount}`);
  lines.push('');
  lines.push('## Machine Checks');
  lines.push('');
  lines.push('| Check | Queue | Status | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of report.items) {
    const detail = String(item.detail ?? '').replaceAll('|', '\\|');
    lines.push(`| \`${item.id}\` | ${item.queue ? `\`${item.queue}\`` : '-'} | ${item.ok ? 'ok' : item.level} | ${detail} |`);
  }
  lines.push('');
  lines.push('## Manual Gates');
  lines.push('');
  lines.push('| Gate | Command | Reason |');
  lines.push('| --- | --- | --- |');
  for (const item of report.manualItems) {
    lines.push(`| ${item.label.replaceAll('|', '\\|')} | \`${item.command.replaceAll('|', '\\|')}\` | ${item.reason.replaceAll('|', '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function writeRevisionCiReleaseChecklistOutput(root, report, output, options = {}) {
  if (!output) return null;
  const outputFile = path.resolve(root, safeRelativePath(output, 'revision CI release checklist output'));
  if ((await fileExists(outputFile)) && !options.force) {
    throw new Error(`Revision CI release checklist output already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  const ext = path.extname(outputFile).toLowerCase();
  if (ext !== '.md' && ext !== '.json') {
    throw new Error('queue-revision-ci-release-checklist --output must end with .md or .json.');
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (ext === '.json') {
    await writeJson(outputFile, report);
    return { file: path.relative(root, outputFile), format: 'json' };
  }
  await writeFile(outputFile, renderRevisionCiReleaseChecklistMarkdown(report));
  return { file: path.relative(root, outputFile), format: 'markdown' };
}

async function queueRevisionCiReleaseChecklistCommand(args) {
  const report = await buildRevisionCiReleaseChecklist(args.root, args);
  const output = await writeRevisionCiReleaseChecklistOutput(args.root, report, args.output, {
    force: args.force
  });
  if (output) report.output = output;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`revision CI release checklist ${report.status}`);
    if (output) console.log(`  output: ${output.file}`);
    console.log(`  queues: ${report.queueCount}`);
    console.log(`  blocking open: ${report.blockingOpenCount}`);
    for (const item of report.items.filter((entry) => !entry.ok)) {
      console.log(`  - ${item.id}: ${item.detail}`);
    }
  }
  return report.ok ? 0 : 2;
}

async function queueRevisionDriftAllowTemplateCommand(args) {
  if (args.expiresAt && args.ttl) throw new Error('Use either --expires-at or --ttl, not both.');
  const template = buildRevisionDriftAllowTemplate(args);
  const output = await writeRevisionDriftAllowTemplateOutput(args.root, template, args.output, {
    force: args.force
  });
  if (args.json) {
    console.log(JSON.stringify({ ...template, output }, null, 2));
  } else {
    console.log(`revision drift allow template: ${output.file}`);
    console.log(`  types: ${template.allowed.map((entry) => entry.type).join(', ')}`);
    console.log(`  owner: ${template.allowed[0]?.owner ?? 'unknown'}`);
    console.log(`  expires at: ${template.allowed[0]?.expiresAt ?? 'unknown'}`);
    console.log(`  reason: ${template.allowed[0]?.reason ?? 'n/a'}`);
  }
  return 0;
}

async function queueLineageCommand(args) {
  if (!args.taskId) throw new Error('queue-lineage requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueLineage(args.root, options.queue, args.taskId);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: lineage ${result.rootTaskId} (${result.totalKnownAttempts} attempt${result.totalKnownAttempts === 1 ? '' : 's'})`);
    console.log(`  requested: ${result.requestedTaskId}`);
    console.log(`  path: ${result.currentPath.join(' -> ')}`);
    for (const attempt of result.attempts) {
      const judgement = attempt.run?.finalJudgement?.outcome ?? 'no-judgement';
      const checkpoint = attempt.revisionNextCheckpoint ? ` next=${attempt.revisionNextCheckpoint}` : '';
      console.log(`  - r${attempt.revisionRound} ${attempt.taskId} [${attempt.location}/${attempt.status ?? 'unknown'}] ${judgement}${checkpoint}`);
      if (attempt.run?.revisionRequest?.path) {
        console.log(`    revision_request: ${attempt.run.revisionRequest.path}`);
      }
      if (attempt.run?.path) {
        console.log(`    run: ${attempt.run.path}`);
      }
    }
  }
  return 0;
}

async function queueLineageBundleCommand(args) {
  if (!args.taskId) throw new Error('queue-lineage-bundle requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueLineageBundle(args.root, options.queue, args.taskId, {
    output: args.output,
    force: args.force
  });
  if (args.json) {
    const { markdown: _markdown, ...json } = result;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`${result.queue}: lineage review bundle`);
    console.log(`  root task: ${result.rootTaskId}`);
    console.log(`  requested: ${result.requestedTaskId}`);
    console.log(`  attempts: ${result.totalKnownAttempts}`);
    console.log(`  verdict: ${result.verdict}`);
    console.log(`  bundle: ${result.bundleFile}`);
    console.log(`  json: ${result.jsonFile}`);
  }
  return 0;
}

async function queueHumanDecisionCommand(args) {
  if (!args.taskId) throw new Error('queue-human-decision requires --task-id.');
  if (!args.decision) throw new Error('queue-human-decision requires --decision.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const strategy = await revisionStrategyFromArgs(args);
  const result = await queueHumanDecision(args.root, options.queue, args.taskId, {
    decision: args.decision,
    comment: args.comment,
    reason: args.reason,
    reviewer: args.reviewer,
    force: args.force,
    enqueueRevision: args.enqueueRevision,
    title: args.title,
    task: args.task,
    strategy
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: human decision ${result.decision}`);
    console.log(`  task: ${result.taskId}`);
    console.log(`  decision: ${result.decisionFile}`);
    if (result.revisionRequestFile) console.log(`  revision request: ${result.revisionRequestFile}`);
    if (result.revisionNext) console.log(`  queued revision: ${result.revisionNext.nextTask.id} (${result.revisionNext.file})`);
  }
  return 0;
}

async function workflowMetricsCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await workflowMetrics(args.root, options.queue, { limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: workflow metrics`);
    console.log(`  inspected runs: ${result.inspected_runs}`);
    console.log(`  failed runs: ${result.failed_runs}`);
    console.log(`  status counts: ${Object.entries(result.status_counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    console.log(`  final judgements: ${Object.entries(result.final_judgement_counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    console.log(`  duration ms: avg=${result.duration_ms.average ?? 'n/a'} p50=${result.duration_ms.p50 ?? 'n/a'} p95=${result.duration_ms.p95 ?? 'n/a'} max=${result.duration_ms.max ?? 'n/a'}`);
    console.log(`  verification: commands=${result.verification.commands}, failures=${result.verification.failures}`);
    console.log(`  revision: requests=${result.revision.requests}, revision_runs=${result.revision.runs_with_revision_round}`);
    console.log(`  human gate: required=${result.human_gate.required}, blocked_or_required=${result.human_gate.blocked_or_required}`);
    if (result.common_failure_signatures.length > 0) {
      console.log('  common failures:');
      for (const item of result.common_failure_signatures) console.log(`    - ${item.count} ${item.signature}`);
    }
    console.log('  recommendations:');
    for (const item of result.recommendations) console.log(`    - ${item}`);
  }
  return 0;
}

async function workflowTunePlanCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await workflowTuningPlan(args.root, options.queue, {
    limit: args.limit,
    config
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: workflow tuning plan`);
    console.log(`  mode: ${result.mode}`);
    console.log(`  inspected runs: ${result.inspected_runs}`);
    console.log(`  config: ${result.config_path ?? 'none'}`);
    console.log('  actions:');
    for (const item of result.actions) {
      console.log(`    - ${item.priority} ${item.id}: ${item.recommendation}`);
    }
    const overlayKeys = Object.keys(result.config_overlay);
    console.log(`  config overlay: ${overlayKeys.length ? overlayKeys.join(', ') : 'none'}`);
    console.log('  apply: review plan, edit config manually, then run doctor and workflow-metrics');
  }
  return 0;
}

async function codeWorktreeListCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeList(args.root, options.queue, { limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.worktrees.length === 0) {
    console.log(`${result.queue}: no code worktree artifacts found`);
  } else {
    for (const item of result.worktrees) {
      console.log(`${item.status} ${item.taskId}`);
      console.log(`  branch: ${item.worktree?.branch ?? 'none'}`);
      console.log(`  path: ${item.worktree?.path ?? 'none'}`);
      console.log(`  dirty: ${item.worktree?.dirty ? 'yes' : 'no'}`);
      console.log(`  verify: ${item.verifyOk ? 'ok' : 'fail'}`);
      console.log(`  run: ${item.file}`);
    }
  }
  return 0;
}

async function codeWorktreeInspectCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeInspect(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  title: ${result.title ?? ''}`);
    console.log(`  branch: ${result.worktree?.branch ?? 'none'}`);
    console.log(`  path: ${result.worktree?.path ?? 'none'}`);
    console.log(`  head: ${result.worktree?.head ?? 'none'}`);
    console.log(`  dirty: ${result.worktree?.dirty ? 'yes' : 'no'}`);
    console.log(`  verify: ${result.verifyOk ? 'ok' : 'fail'}`);
    if (result.worktree?.statusShort) console.log(`  status:\n${indent(result.worktree.statusShort)}`);
    if (result.worktree?.diffStat) console.log(`  diff stat:\n${indent(result.worktree.diffStat)}`);
    if (result.worktree?.diffNameStatus) console.log(`  diff names:\n${indent(result.worktree.diffNameStatus)}`);
    if (result.worktree?.untracked) console.log(`  untracked:\n${indent(result.worktree.untracked)}`);
    console.log(`  run: ${result.file}`);
  }
  return 0;
}

async function codeWorktreeDiffCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeDiff(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  branch: ${result.worktree?.branch ?? 'none'}`);
    console.log(`  path: ${result.worktree?.path ?? 'none'}`);
    console.log(`  run: ${result.file}`);
    if (result.diffStat) console.log(`\nDiff stat:\n${result.diffStat}`);
    if (result.diffNameStatus) console.log(`\nDiff names:\n${result.diffNameStatus}`);
    if (result.untracked) console.log(`\nUntracked files:\n${result.untracked}`);
    if (result.patch) console.log(`\nPatch:\n${result.patch}`);
    else console.log('\nPatch: (empty)');
  }
  return 0;
}

async function codeWorktreeExportCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeExport(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  patch: ${result.patchFile}`);
    console.log(`  manifest: ${result.manifestFile}`);
    console.log(`  bytes: ${result.patchBytes}`);
    if (result.untracked) console.log(`  untracked:\n${indent(result.untracked)}`);
  }
  return 0;
}

async function codePatchVerifyCommand(args) {
  const result = await codePatchVerify(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  ok: ${result.ok ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.applyCheck) {
      console.log(`  git apply --check: exit ${result.applyCheck.exitCode}`);
      if (result.applyCheck.stderr) console.log(`  stderr:\n${indent(result.applyCheck.stderr)}`);
      if (result.applyCheck.stdout) console.log(`  stdout:\n${indent(result.applyCheck.stdout)}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codePatchApplyPlanCommand(args) {
  const result = await codePatchApplyPlan(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  can apply: ${result.canApply ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.affectedPaths.length > 0) console.log(`  affected:\n${indent(result.affectedPaths.join('\n'))}`);
    if (result.dirtyAffected) console.log(`  dirty affected files:\n${indent(result.affectedStatus.stdout)}`);
    if (result.applyCheck) {
      console.log(`  git apply --check: exit ${result.applyCheck.exitCode}`);
      if (result.applyCheck.stderr) console.log(`  stderr:\n${indent(result.applyCheck.stderr)}`);
      if (result.applyCheck.stdout) console.log(`  stdout:\n${indent(result.applyCheck.stdout)}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codePatchApplyCommand(args) {
  const result = await codePatchApply(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty,
    confirmApply: args.confirmApply
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  applied: ${result.applied ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.affectedPaths?.length > 0) console.log(`  affected:\n${indent(result.affectedPaths.join('\n'))}`);
    if (result.apply) {
      console.log(`  git apply: exit ${result.apply.exitCode}`);
      if (result.apply.stderr) console.log(`  stderr:\n${indent(result.apply.stderr)}`);
      if (result.apply.stdout) console.log(`  stdout:\n${indent(result.apply.stdout)}`);
    }
    if (result.applyCheck) console.log(`  prior git apply --check: exit ${result.applyCheck.exitCode}`);
  }
  return result.ok ? 0 : 1;
}

async function codeReviewBundleCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeReviewBundle(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    const { markdown: _markdown, ...json } = result;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  review: ${result.reviewFile}`);
    console.log(`  json: ${result.jsonFile}`);
    console.log(`  patch: ${result.patchExport.patchFile} (${result.patchExport.exists ? 'exists' : 'missing'})`);
    if (result.patchVerify) console.log(`  patch verify: ${result.patchVerify.status}`);
    if (result.applyPlan) console.log(`  apply plan: ${result.applyPlan.status} canApply=${result.applyPlan.canApply ? 'yes' : 'no'}`);
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return 0;
}

async function codeTaskCloseoutCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskCloseout(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    const { markdown: _markdown, ...json } = result;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`${result.closeoutStatus} ${result.taskId ?? result.runId}`);
    console.log(`  closeout: ${result.closeoutFile}`);
    console.log(`  json: ${result.jsonFile}`);
    console.log(`  review: ${result.review.exists ? 'exists' : 'missing'} ${result.review.reviewFile}`);
    console.log(`  patch: ${result.patchExport.exists ? 'exists' : 'missing'} ${result.patchExport.patchFile}`);
    console.log(`  worktree: ${result.worktreeState.exists ? 'exists' : 'missing'} ${result.worktreeState.path ?? 'none'}`);
    console.log(`  cleanup: ${result.cleanup.recommendation ?? 'unknown'}`);
    if (result.actions.length > 0) {
      console.log('  next actions:');
      for (const action of result.actions) console.log(`    - ${action}`);
    }
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return 0;
}

async function codeTaskAutoflowCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const flowOptions = {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    until: args.until,
    patch: args.patchOutput,
    review: args.reviewOutput,
    closeout: args.closeoutOutput,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  };
  const result = args.allActionable
    ? await codeTaskAutoflowBatch(args.root, options.queue, flowOptions)
    : await codeTaskAutoflow(args.root, options.queue, flowOptions);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.allActionable) {
    console.log(`${result.queue}: autoflow ${result.status}`);
    console.log(`  until: ${result.until}`);
    console.log(`  inspected tasks: ${result.inspectedTasks}`);
    console.log(`  actionable tasks: ${result.candidateTasks}`);
    console.log(`  safety: no apply, no cleanup, no queue state changes`);
    console.log(`  counts: ${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    for (const item of result.results) {
      console.log(`${item.status} ${item.taskId ?? item.runId}`);
      for (const step of item.steps ?? []) {
        const detail = step.artifact ? ` ${step.artifact}` : '';
        console.log(`  ${step.name}: ${step.status}${detail}`);
      }
      if (item.errors?.length > 0) {
        for (const error of item.errors) console.log(`  error ${error.step}: ${error.message}`);
      }
    }
  } else {
    console.log(`${result.queue}: autoflow ${result.status}`);
    console.log(`  task: ${result.taskId ?? result.runId}`);
    console.log(`  until: ${result.until}`);
    console.log(`  patch: ${result.artifacts.patchFile}`);
    console.log(`  review: ${result.artifacts.reviewFile}`);
    if (result.until === 'closeout') console.log(`  closeout: ${result.artifacts.closeoutFile}`);
    console.log('  safety: no apply, no cleanup, no queue state changes');
    for (const step of result.steps) {
      const detail = step.artifact ? ` ${step.artifact}` : '';
      console.log(`  ${step.name}: ${step.status}${detail}`);
    }
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codeTaskFinishCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskFinish(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty,
    confirmApply: args.confirmApply,
    confirmCleanup: args.confirmCleanup
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: finish ${result.status}`);
    console.log(`  task: ${result.taskId ?? result.runId}`);
    console.log(`  finish: ${result.finishFile}`);
    console.log(`  json: ${result.jsonFile}`);
    console.log(`  patch applied: ${result.patchApply?.applied ? 'yes' : 'no'}`);
    console.log(`  worktree cleaned: ${result.cleanup?.removed ? 'yes' : 'no'}`);
    if (result.cleanup?.branch) console.log(`  branch retained: ${result.cleanup.branch}`);
    console.log('  safety: no stage, commit, push, merge, branch delete, or queue state changes');
    for (const step of result.steps) {
      const reason = step.reason ? ` (${step.reason})` : '';
      console.log(`  ${step.name}: ${step.status}${reason}`);
    }
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codeTaskRunCommand(args) {
  const configPath = args.config ?? (args.queue ? `configs/loops/queues/${args.queue}.json` : undefined);
  const config = await loadQueueConfig(args.root, configPath);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskRun(args.root, options.queue, {
    config: options,
    title: args.title,
    task: args.task,
    file: args.file,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty,
    confirmApply: args.confirmApply,
    confirmCleanup: args.confirmCleanup,
    onProgress: args.json ? undefined : printProgressEvent
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: task run ${result.status}`);
    console.log(`  task: ${result.taskId}`);
    console.log(`  title: ${result.title}`);
    console.log(`  queue run: ${result.queueRun?.status ?? 'not_run'} ${result.queueRun?.runPath ?? ''}`.trimEnd());
    console.log(`  autoflow: ${result.autoflow?.status ?? 'not_run'}`);
    console.log(`  finish: ${result.finish?.status ?? 'not_run'}`);
    console.log(`  final verification: ${result.finalVerification.status}`);
    if (result.finalVerification.commands.length > 0) {
      for (const item of result.finalVerification.commands) {
        console.log(`    ${item.result.exitCode === 0 ? 'ok' : 'fail'} ${item.cmd}`);
      }
    }
    console.log('  safety: applied and cleaned only because confirmation flags were supplied; no stage, commit, push, merge, or branch delete');
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codeTaskStatusCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskStatus(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.tasks.length === 0) {
    console.log(`${result.queue}: no code task artifacts found`);
  } else {
    console.log(`${result.queue}: code task status`);
    console.log(`  tasks: ${result.tasks.length}`);
    console.log(`  counts: ${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    for (const task of result.tasks) {
      console.log(`${task.overallStatus} ${task.taskId ?? task.runId}`);
      console.log(`  title: ${task.title ?? ''}`);
      console.log(`  task state: ${task.taskState ?? 'unknown'}`);
      console.log(`  worktree: ${task.worktree.exists ? 'exists' : 'missing'} ${task.worktree.path ?? 'none'}`);
      console.log(`  patch: ${task.patch.exists ? 'exists' : 'missing'} ${task.patch.verifyStatus ?? 'not_run'}`);
      console.log(`  review: ${task.review.exists ? 'exists' : 'missing'}`);
      console.log(`  closeout: ${task.closeout.exists ? task.closeout.status ?? 'exists' : 'missing'}`);
      console.log(`  finish: ${task.finish.exists ? task.finish.status ?? 'exists' : 'missing'}`);
      console.log(`  cleanup: ${task.cleanup.recommendation ?? 'unknown'}`);
      if (task.nextActions.length > 0) {
        console.log('  next actions:');
        for (const action of task.nextActions) console.log(`    - ${action}`);
      }
      console.log(`  run: ${task.sourceRunFile}`);
    }
  }
  return 0;
}

async function codeTaskDashboardCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskDashboard(args.root, options.queue, {
    config: options,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: code task dashboard`);
    console.log(`  queued: ${result.queueSummary.queued}`);
    console.log(`  active: ${result.queueSummary.active}`);
    console.log(`  done: ${result.queueSummary.done}`);
    console.log(`  failed: ${result.queueSummary.failed}`);
    console.log(`  canceled: ${result.queueSummary.canceled}`);
    console.log(`  runs inspected: ${result.taskSummary.inspectedRuns}`);
    console.log(`  task counts: ${Object.entries(result.taskSummary.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    console.log(`  actions: ${Object.entries(result.actionCounts).map(([key, value]) => `${key}=${value}`).join(', ')}`);
    console.log(`  cleanup: candidates=${result.cleanupSummary.cleanupCandidates}, unexported_dirty=${result.cleanupSummary.unexportedDirty}, rejected_patches=${result.cleanupSummary.rejectedPatches}, missing=${result.cleanupSummary.missingWorktrees}, orphans=${result.cleanupSummary.orphanWorktrees}`);
    if (result.priority.length > 0) {
      console.log('  priority:');
      for (const task of result.priority) {
        console.log(`    - ${task.overallStatus} ${task.taskId ?? task.runId} ${task.title ?? ''}`.trimEnd());
      }
    }
    if (result.recommendedCommands.length > 0) {
      console.log('  recommended commands:');
      for (const command of result.recommendedCommands) console.log(`    ${command}`);
    }
    console.log('  safety: read-only; no apply, cleanup, or queue state changes');
  }
  return 0;
}

async function codeWorktreeCleanupPlanCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeCleanupPlan(args.root, options.queue, {
    config: options,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: cleanup plan`);
    console.log(`  inspected: ${result.inspectedRuns}`);
    console.log(`  cleanup candidates: ${result.cleanupCandidates.length}`);
    console.log(`  unexported dirty: ${result.unexportedDirty.length}`);
    console.log(`  rejected patches: ${result.rejectedPatches.length}`);
    console.log(`  missing worktrees: ${result.missingWorktrees.length}`);
    console.log(`  orphan worktrees: ${result.orphanWorktrees.length}`);
    for (const item of result.worktrees) {
      console.log(`${item.recommendation} ${item.taskId ?? item.runId}`);
      console.log(`  worktree: ${item.worktree?.path ?? 'none'}`);
      if (item.exportedPatchFile) console.log(`  patch: ${item.exportedPatchFile} (${item.patchVerify?.status ?? 'unknown'})`);
      for (const command of item.recommendedCommands) console.log(`  command: ${command}`);
    }
    for (const item of result.orphanWorktrees) {
      console.log(`orphan_worktree ${item.path}`);
      console.log(`  command: ${item.command}`);
    }
  }
  return 0;
}

async function codeWorktreeCleanupCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeCleanup(args.root, options.queue, {
    config: options,
    limit: args.limit,
    confirmCleanup: args.confirmCleanup,
    includeOrphans: args.includeOrphans
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: cleanup ${result.status}`);
    console.log(`  removed worktrees: ${result.removedWorktrees.length}`);
    console.log(`  removed orphans: ${result.removedOrphans.length}`);
    console.log(`  skipped: ${result.skipped.length}`);
    for (const item of result.removedWorktrees) {
      console.log(`removed ${item.taskId ?? item.runId}`);
      console.log(`  worktree: ${item.worktree}`);
      console.log(`  git worktree remove: exit ${item.remove.exitCode}`);
      if (item.branch) console.log(`  branch retained: ${item.branch}`);
    }
    for (const item of result.removedOrphans) {
      console.log(`removed_orphan ${item.path}`);
      console.log(`  git worktree remove: exit ${item.remove.exitCode}`);
    }
    for (const item of result.skipped) {
      console.log(`skipped ${item.taskId ?? item.runId ?? item.path}`);
      console.log(`  reason: ${item.reason}`);
    }
  }
  return result.ok ? 0 : 1;
}

function indent(value) {
  return String(value).split('\n').filter(Boolean).map((line) => `    ${line}`).join('\n');
}

function buildRetryArgs(args, existing) {
  if (args.maxAttempts === undefined && args.retryDelayMs === undefined && args.retryExitCodes === undefined) {
    return existing;
  }
  return {
    ...(existing ?? {}),
    ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.retryDelayMs !== undefined ? { retryDelayMs: args.retryDelayMs } : {}),
    ...(args.retryExitCodes !== undefined ? { retryExitCodes: args.retryExitCodes } : {})
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  if (command === 'init') return initCommand(args);
  if (command === 'queue-init') return queueInitCommand(args);
  if (command === 'code-queue-init') return codeQueueInitCommand(args);
  if (command === 'run') return runCommand(args);
  if (command === 'verify') return verifyCommand(args);
  if (command === 'status') return statusCommand(args);
  if (command === 'summarize') return summarizeCommand(args);
  if (command === 'doctor') return doctorCommand(args);
  if (command.startsWith('dashboard-')) return dashboardCommand(command, args);
  if (command === 'agent-register' || command.startsWith('todo-')) return todoControlPlaneCommand(command, args);
  if (command.startsWith('action-')) return actionReservationCommand(command, args);
  if (command === 'repair-plan') return repairPlanCommand(args);
  if (command === 'project-intake') return projectIntakeCommand(args);
  if (command === 'project-plan') return projectPlanCommand(args);
  if (command === 'project-status') return projectStatusCommand(args);
  if (command === 'enqueue') return enqueueCommand(args);
  if (command === 'route-message') return routeMessageCommand(args);
  if (command === 'run-queue') return runQueueCommand(args);
  if (command === 'run-queue-drain') return runQueueDrainCommand(args);
  if (command === 'queue-status') return queueStatusCommand(args);
  if (command === 'queue-park') return queueParkCommand(args);
  if (command === 'queue-wait-tick') return queueWaitTickCommand(args);
  if (command === 'queue-wait-resume') return queueWaitResumeCommand(args);
  if (command === 'queue-terminal-notify') return queueTerminalNotifyCommand(args);
  if (command === 'queue-acceptance-refresh') return queueAcceptanceRefreshCommand(args);
  if (command === 'queue-human-input-notify') return queueHumanInputNotifyCommand(args);
  if (command === 'queue-human-input-resolve') return queueHumanInputResolveCommand(args);
  if (command === 'queue-scheduler-tick') return queueSchedulerTickCommand(args);
  if (command === 'queue-peek') return queuePeekCommand(args);
  if (command === 'queue-cancel') return queueCancelCommand(args);
  if (command === 'queue-requeue') return queueRequeueCommand(args);
  if (command === 'queue-revision-plan') return queueRevisionPlanCommand(args);
  if (command === 'queue-revision-apply-plan') return queueRevisionApplyPlanCommand(args);
  if (command === 'queue-revision-review') return queueRevisionReviewCommand(args);
  if (command === 'queue-revision-audit-chain') return queueRevisionAuditChainCommand(args);
  if (command === 'queue-revision-ci-check') return queueRevisionCiCheckCommand(args);
  if (command === 'queue-revision-ci-bootstrap') return queueRevisionCiBootstrapCommand(args);
  if (command === 'queue-revision-ci-workflow-template') return queueRevisionCiWorkflowTemplateCommand(args);
  if (command === 'queue-revision-ci-status-badge') return queueRevisionCiStatusBadgeCommand(args);
  if (command === 'queue-revision-ci-readme-update') return queueRevisionCiReadmeUpdateCommand(args);
  if (command === 'queue-revision-ci-install-guide') return queueRevisionCiInstallGuideCommand(args);
  if (command === 'queue-revision-ci-self-test') return queueRevisionCiSelfTestCommand(args);
  if (command === 'queue-revision-ci-doctor') return queueRevisionCiDoctorCommand(args);
  if (command === 'queue-revision-ci-repair-plan') return queueRevisionCiRepairPlanCommand(args);
  if (command === 'queue-revision-ci-apply-repair-plan') return queueRevisionCiApplyRepairPlanCommand(args);
  if (command === 'queue-revision-ci-health-summary') return queueRevisionCiHealthSummaryCommand(args);
  if (command === 'queue-revision-ci-dashboard') return queueRevisionCiDashboardCommand(args);
  if (command === 'queue-revision-ci-release-checklist') return queueRevisionCiReleaseChecklistCommand(args);
  if (command === 'queue-revision-ci-baseline-update') return queueRevisionCiBaselineUpdateCommand(args);
  if (command === 'queue-revision-drift-allow-template') return queueRevisionDriftAllowTemplateCommand(args);
  if (command === 'queue-revision-next') return queueRevisionNextCommand(args);
  if (command === 'queue-lineage') return queueLineageCommand(args);
  if (command === 'queue-lineage-bundle') return queueLineageBundleCommand(args);
  if (command === 'queue-human-decision') return queueHumanDecisionCommand(args);
  if (command === 'workflow-metrics') return workflowMetricsCommand(args);
  if (command === 'workflow-tune-plan') return workflowTunePlanCommand(args);
  if (command === 'code-worktree-list') return codeWorktreeListCommand(args);
  if (command === 'code-worktree-inspect') return codeWorktreeInspectCommand(args);
  if (command === 'code-worktree-diff') return codeWorktreeDiffCommand(args);
  if (command === 'code-worktree-export') return codeWorktreeExportCommand(args);
  if (command === 'code-patch-verify') return codePatchVerifyCommand(args);
  if (command === 'code-patch-apply-plan') return codePatchApplyPlanCommand(args);
  if (command === 'code-patch-apply') return codePatchApplyCommand(args);
  if (command === 'code-review-bundle') return codeReviewBundleCommand(args);
  if (command === 'code-task-closeout') return codeTaskCloseoutCommand(args);
  if (command === 'code-task-autoflow') return codeTaskAutoflowCommand(args);
  if (command === 'code-task-finish') return codeTaskFinishCommand(args);
  if (command === 'code-task-run') return codeTaskRunCommand(args);
  if (command === 'code-task-dashboard') return codeTaskDashboardCommand(args);
  if (command === 'code-task-status') return codeTaskStatusCommand(args);
  if (command === 'code-worktree-cleanup-plan') return codeWorktreeCleanupPlanCommand(args);
  if (command === 'code-worktree-cleanup') return codeWorktreeCleanupCommand(args);
  throw new Error(`Unknown command: ${command}`);
}

async function dashboardCommand(command, args) {
  if (command === 'dashboard-serve') {
    const server = await createDashboardServer(args.root, { host: args.host, port: args.port, allowNonLoopback: args.allowNonLoopback });
    const address = server.address();
    console.log(JSON.stringify({ status: 'serving', read_only: true, address }, null, 2));
    return new Promise((resolve) => {
      const stop = () => server.close(() => resolve(0));
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  }
  if (command === 'dashboard-export') {
    if (!args.outputDir || args.outputDir === true) throw new Error('dashboard-export requires --output-dir.');
    console.log(JSON.stringify(await exportDashboard(args.root, args.outputDir, { now: args.now }), null, 2));
    return 0;
  }
  const projection = await buildOperatorProjection(args.root, { now: args.now });
  if (command === 'dashboard-health') {
    const result = dashboardHealth(projection, { maxAgeSeconds: args.maxAgeSeconds });
    console.log(JSON.stringify(result, null, 2)); return result.status === 'ok' ? 0 : 2;
  }
  if (command === 'dashboard-inspect') {
    const filtered = filterProjection(projection, { query: args.query, state: args.todoState });
    const result = args.id ? filtered.todos.find((item) => item.id === args.id) ?? filtered.queues.flatMap((queue) => queue.tasks).find((item) => item.id === args.id) ?? null : filtered;
    console.log(JSON.stringify(result, null, 2)); return result === null ? 1 : 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function jsonInput(raw, label) {
  if (!raw) throw new Error(`${label} is required.`);
  if (raw.trim().startsWith('{')) return JSON.parse(raw);
  return JSON.parse(await readFile(path.resolve(raw), 'utf8'));
}

async function todoControlPlaneCommand(command, args) {
  let result;
  if (command === 'agent-register') result = await registerAgent(args.root, await jsonInput(args.agentJson, '--agent-json'));
  else if (command === 'todo-create') result = await createTodo(args.root, await jsonInput(args.todoJson, '--todo-json'));
  else if (command === 'todo-list') result = await listTodos(args.root, { state: args.todoState });
  else if (command === 'todo-inspect') result = await inspectTodo(args.root, args.todoId);
  else if (command === 'todo-claim') result = await claimTodo(args.root, args);
  else if (command === 'todo-renew') result = await renewTodo(args.root, args);
  else if (command === 'todo-release') result = await releaseTodo(args.root, args);
  else if (command === 'todo-handoff') result = await handoffTodo(args.root, args);
  else if (command === 'todo-accept') result = await decideHandoff(args.root, { ...args, accept: true });
  else if (command === 'todo-reject') result = await decideHandoff(args.root, { ...args, accept: false });
  else if (command === 'todo-recover') result = await recoverTodos(args.root, args);
  else if (command === 'todo-import-legacy') result = await importLegacyTodos(args.root, args);
  else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  return result === null ? 1 : 0;
}

async function actionReservationCommand(command, args) {
  if (!args.idempotencyKey) throw new Error(`${command} requires --idempotency-key.`);
  let result;
  if (command === 'action-reserve') {
    result = await reserveAction(args.root, {
      idempotencyKey: args.idempotencyKey,
      kind: args.kind,
      authorizationScope: args.authorizationScope,
      request: JSON.parse(args.requestJson ?? '{}')
    });
  } else if (command === 'action-inspect') result = await inspectAction(args.root, args.idempotencyKey);
  else if (command === 'action-claim') result = await claimAction(args.root, { idempotencyKey: args.idempotencyKey, owner: args.owner, leaseMs: args.leaseMs });
  else if (command === 'action-settle') result = await settleAction(args.root, { idempotencyKey: args.idempotencyKey, fencingToken: args.fencingToken, evidence: args.evidence });
  else if (command === 'action-release') result = await releaseAction(args.root, { idempotencyKey: args.idempotencyKey, fencingToken: args.fencingToken, reason: args.reason, evidence: args.evidence });
  else if (command === 'action-reconcile') result = await reconcileAction(args.root, { idempotencyKey: args.idempotencyKey, outcome: args.outcome, evidence: args.evidence });
  else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  return result === null ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
