# Taskforce Loop Engineering

## Primary Goal interface

The ordinary public surface is `init`, `run`, `status`, `review`, and `doctor`:

```sh
loop-engineering init --id demo --goal "Deliver the complete verified result"
loop-engineering run --id demo
loop-engineering status --id demo
loop-engineering review --id demo --decision revise --reason "change strategy"
loop-engineering doctor --id demo
```

Node.js callers can use `Goal.init/run/status/review/doctor`. Existing queue, project, revision, human-gate, reservation, dashboard, and worktree commands remain supported as advanced commands. See [the transactional kernel and migration guide](docs/transactional-kernel-and-goal-api.md).

[![production trust](https://github.com/ambitioncn/taskforce-loop-engineering/actions/workflows/production-trust.yml/badge.svg)](https://github.com/ambitioncn/taskforce-loop-engineering/actions/workflows/production-trust.yml)

## Platform-neutral adapter SDK

OpenClaw, Hermes, Codex CLI, and Claude Code share the versioned runtime
contract in `lib/runtime-adapter-sdk.mjs`. Start without credentials or network
access with `npm run demo:adapter`, then verify every runtime using
`npm run check:adapters`. See [docs/runtime-adapter-sdk.md](docs/runtime-adapter-sdk.md)
for the contract, compatibility matrix, migration, and extension guide.

## 0.13 production trust

The local production-trust contract, runtime adapter v1, durable journal,
multi-worker canary, non-destructive Ironman upgrade planner, safe demo and
unified acceptance are documented in
[docs/production-trust-contract.md](docs/production-trust-contract.md). Run
`npm run check:production-trust`; external publishing and deployment remain
separately authorized actions. The command writes integrity-sealed evidence and
a redacted public summary to `.production-evidence/`. The default canary is
offline and fixture-only: it performs no model call or external side effect.
Copy `templates/github-production-trust.yml` into `.github/workflows/` only
when publication is separately approved.

## Read-only operator dashboard (P3)

Version 0.12 adds a dependency-free operator projection over projects, queues, P0 gates, P1 action reservations and P2 typed todo ownership. Use `dashboard-inspect`, `dashboard-health`, `dashboard-export`, or the loopback-only `dashboard-serve`. See [docs/operator-dashboard.md](docs/operator-dashboard.md) for API, security and schema details.

The consolidated P0-P3 local release contract and evidence ledger are recorded in [docs/release-0.12-acceptance.md](docs/release-0.12-acceptance.md). Publishing, tagging, pushing, and production installation remain separate release actions.

## Action idempotency and reservation

Every side-effecting action must reserve a durable idempotency key before an
adapter is invoked. The reservation binds a canonical request fingerprint to an
authorization scope. A worker then atomically claims a lease and receives a
monotonic fencing token; only that token can settle the action or release its
reservation. Paid API, notification, and deployment adapters expose the same
lifecycle from `lib/action-reservations.mjs`.

```bash
loop-engineering action-reserve --idempotency-key task:step:attempt \
  --kind paid_api --authorization-scope approval:task:provider \
  --request-json '{"model":"example","requestDigest":"sha256"}'
loop-engineering action-claim --idempotency-key task:step:attempt \
  --owner worker-1 --lease-ms 60000
loop-engineering action-settle --idempotency-key task:step:attempt \
  --fencing-token 1 --evidence upstream-request-id
```

An expired claim becomes `unknown`, not runnable. Operators must inspect and
reconcile it as `accepted` (durably settle and consume authorization) or
`not_accepted` (return to reserved) using `action-inspect` and
`action-reconcile`. This is the crash boundary that prevents blind replay and
double spend after an upstream acceptance whose local commit was interrupted.
Terminal records retain settlement or release evidence and an append-only event
history under `runtime/loops/action-reservations/`.

## Human-Gate Lifecycle v2

Park work without treating an external dependency as failure or repeatedly
retrying a privileged action:

```bash
loop-engineering queue-park --queue agent-tasks --task-id <id> \
  --wait-kind external_condition --reason "SSH banner timed out" \
  --wait-timeout-ms 86400000 --reminder-interval-ms 3600000 \
  --escalation-interval-ms 86400000 --max-reminders 3

loop-engineering queue-wait-tick --queue agent-tasks \
  --notify-command '<source-bound notifier>'

loop-engineering queue-wait-resume --queue agent-tasks --task-id <id> \
  --verified --recovery-signal 'probe=vps-1;ssh_banner=verified'
```

`queue-status --json` distinguishes `waiting_for_human`,
`external_condition_wait`, `timed_out_or_escalated`, and `runnable` state.
Reminder and escalation sends are throttled and leave durable evidence under
`runtime/loops/<queue>/wait-notifications/`. Timeout never rejects a task,
consumes a stored authorization, or repeats an action. Verified resume preserves
the original task/wait identity and exactly-once execution boundary.

Durable loop engineering for repeated agent work on OpenClaw and Hermes Agent. It provides a small
Node CLI that executes JSON loop specs, records append-only run artifacts, and
uses a circuit breaker to escalate repeated failures.

It also includes a small durable task queue runner for explicit loop-managed
work handoffs, plus an assisted code queue mode that runs each task in an
isolated git worktree.

## Install

From npm:

```bash
npm install -g taskforce-loop-engineering
```

Or run without installing:

```bash
npx -p taskforce-loop-engineering loop-engineering --help
```

## OpenClaw conversation installer

Installing the npm package alone does not intercept chat messages or choose an
execution agent. Use the OpenClaw installer to plan a conversation integration:

```bash
loop-engineering-openclaw-install \
  --root /path/to/openclaw/workspace \
  --queue agent-tasks
```

The installer accepts `--language auto|en|zh`. `auto` is the default: Chinese
locales install Chinese conversation rules and notifications; all other or
missing locales install English. Use `--language en` or `--language zh` to
override locale detection explicitly.

The installer reads `openclaw agents list --json` during the plan. Without
`--worker-agent`, it chooses an existing `main`, or the only available agent
when exactly one exists. If there is no unambiguous choice, it fails with the
available agent ids and asks for `--worker-agent`; it never creates an agent.
An explicitly selected worker must already exist.

The default is read-only and prints an installation confirmation summary with
the target platform, absolute platform CLI path, workspace, queue, scheduler,
notification routing, and whether writes are enabled. After review,
install the queue, configurable worker dispatcher, atomic route-and-run wrapper,
channel-neutral asynchronous notifier, workspace health preflight, and managed
`AGENTS.md` routing block with:

```bash
loop-engineering-openclaw-install \
  --root /path/to/openclaw/workspace \
  --queue agent-tasks \
  --worker-agent main \
  --confirm-install
```

In an English installation, conversation requests can use forms such as:

- `Use Loop Engineering to fix this issue.`
- `Run this through Loop Engineering.`
- `Queue this only; do not run it yet.`
- `Continue the current loop with this amendment: ...`

Chinese installations provide equivalent Chinese conversation rules and
examples. The generated dispatcher uses a per-task session key of
`agent:<worker-agent>:loop-task-<task-id>` and explicitly marks the task as
already loop-managed to prevent recursive re-enqueue. Existing generated files
are not overwritten unless `--force` is supplied after review. The installed
conversation policy treats an explicit Loop Engineering request as enqueue plus
immediate execution; explicit queue-only wording remains the override.
The confirmed installer also creates and enables a managed per-queue systemd
user timer. It wakes the adaptive scheduler once per minute; the persisted
scheduler cadence still decides whether work is due. Generated queue configs
require a fresh scheduler heartbeat, so queued work fails `doctor` with
`scheduler_missing` instead of waiting indefinitely when the timer is absent.
After every installed runner tick, the wrapper idempotently scans human-input
gates and terminal tasks. The generated notifier delivers through
`openclaw message send` using the task's recorded `channel`, `target`, `account`,
and `reply_to`; it refuses delivery when channel or target metadata is missing.

Validate the installation without sending a real message:

```bash
loop-engineering-openclaw-doctor \
  --root /path/to/openclaw/workspace \
  --queue agent-tasks \
  --worker-agent main
```

The doctor checks generated files, queue wiring, the OpenClaw CLI, the selected
worker agent, and a notification dry-run. It reports `externalWrite: false` and
uses `openclaw message send --dry-run` for the delivery probe.

After doctor passes, run the disposable end-to-end smoke:

```bash
loop-engineering-openclaw-smoke \
  --root /path/to/openclaw/workspace \
  --queue agent-tasks \
  --worker-agent main
```

It creates a uniquely named temporary queue, routes a read-only task through
the configured worker session, verifies task contract/development plan/
acceptance plan/final judgement artifacts, scans human gates, and exercises the
terminal return with notification dry-run. The temporary config and runtime are
removed in a guarded `finally` block. Use `--keep-artifacts` only for explicit
debugging review.

Plan upgrades or removal before changing an existing integration:

```bash
loop-engineering-openclaw-manage --root /path/to/workspace --action upgrade-plan
loop-engineering-openclaw-manage --root /path/to/workspace --action upgrade --confirm-upgrade
loop-engineering-openclaw-manage --root /path/to/workspace --action uninstall-plan
loop-engineering-openclaw-manage --root /path/to/workspace --action uninstall --confirm-uninstall
```

The installer manifest records SHA-256 hashes for generated files, systemd
units, and the exact managed `AGENTS.md` block. Upgrade/uninstall refuses when
managed content was edited. Upgrade installs and enables the scheduler for
older managed integrations. Uninstall first disables the timer, then removes
only clean managed files, units, and that exact instructions block; queue
runtime is explicitly retained.

## Hermes Agent conversation installer

Hermes Agent is supported through a native dispatcher and notifier while the
platform-neutral Loop Engineering CLI continues to own durable task state,
checkpoints, revisions, and final judgement. Generate a read-only plan first:

```bash
loop-engineering-hermes-install \
  --root /path/to/hermes/workspace \
  --queue agent-tasks
```

After review, install the Hermes one-shot worker dispatcher, `hermes send`
notifier, queue wrapper, workspace routing instructions, and managed systemd
user timer:

```bash
loop-engineering-hermes-install \
  --root /path/to/hermes/workspace \
  --queue agent-tasks \
  --confirm-install
```

Like the OpenClaw installer, the read-only Hermes plan prints the target
platform, absolute Hermes CLI path, workspace, queue, scheduler, notification
routing, and write status before `--confirm-install` can enable changes.

The dispatcher invokes `hermes -z` (`--oneshot`) with the managed task contract and artifact
paths. Notifications invoke `hermes send --to` without an LLM call. Conversation
routing must preserve `--source-target` in Hermes
`platform:chat_id[:thread_id]` form so progress, human gates, and terminal
results return to the correct chat. The installer records the absolute Hermes
executable path so systemd does not depend on an interactive shell `PATH`. The
scheduler uses systemd rather than a
Hermes Cron agent session, so queue continuity remains entirely artifact-based.
This managed installer currently targets Linux hosts with systemd user services;
the platform-neutral core CLI can still run manually on other Hermes platforms.

Validate the integration and then run a disposable read-only end-to-end smoke:

```bash
loop-engineering-hermes-doctor \
  --root /path/to/hermes/workspace \
  --queue agent-tasks

loop-engineering-hermes-smoke \
  --root /path/to/hermes/workspace \
  --queue agent-tasks
```

The doctor checks the Hermes CLI, `hermes send`, generated files, queue wiring,
and a delivery dry-run. The smoke creates a temporary queue, executes a bounded
Hermes worker task, verifies contract/plan/final-judgement artifacts, tests the
notification return path without sending externally, and removes its artifacts.

## Commands

```bash
loop-engineering init --root /path/to/workspace
loop-engineering verify --root /path/to/workspace
loop-engineering run --root /path/to/workspace --config configs/loops/workspace-health.json
loop-engineering status --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace
loop-engineering repair-plan --id workspace-health --output repair-plan.json
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering project-intake --name launch-site --brief "Build a launch website" --type auto
loop-engineering project-plan --project launch-site
loop-engineering project-status --project launch-site
loop-engineering queue-init --queue agent-tasks
loop-engineering code-queue-init --queue code-tasks
loop-engineering enqueue --queue agent-tasks --title "Check logs" --task "Inspect the latest logs."
loop-engineering run-queue --config configs/loops/queues/agent-tasks.json
loop-engineering run-queue-drain --config configs/loops/queues/agent-tasks.json --max-tasks 100
loop-engineering queue-status --queue agent-tasks
loop-engineering queue-scheduler-tick --config configs/loops/queues/agent-tasks.json
loop-engineering queue-scheduler-tick --queue agent-tasks --plan-only --json
loop-engineering queue-peek --queue agent-tasks
loop-engineering queue-cancel --queue agent-tasks --task-id <id> --reason "not needed"
loop-engineering queue-requeue --queue agent-tasks --task-id <id>
loop-engineering queue-revision-plan --queue agent-tasks --task-id <id> --output-dir
loop-engineering queue-revision-apply-plan --from-review action-list.json --output apply-report.md
loop-engineering queue-revision-review --queue agent-tasks --needs-action --stale-after 24h --applied-report apply-report.json --output action-list.md
loop-engineering queue-revision-audit-chain --review action-list.json --apply-report apply-report.json --verify-current --fail-on-drift --output audit-chain.md --drift-report drift-report.md --drift-summary-format github --drift-summary-append-github-step --drift-github-annotations
loop-engineering queue-revision-ci-check --review action-list.json --apply-report apply-report.json --baseline previous-audit.json --drift-report drift-report.md
loop-engineering queue-revision-ci-bootstrap --queue agent-tasks
loop-engineering queue-revision-ci-workflow-template --queue agent-tasks --output .github/workflows/loop-revision-ci.yml
loop-engineering queue-revision-ci-status-badge --queue agent-tasks --output loop-revision-ci-badge.md
loop-engineering queue-revision-ci-readme-update --queue agent-tasks --readme README.md
loop-engineering queue-revision-ci-install-guide --queue agent-tasks --output loop-revision-ci-install-guide.md
loop-engineering queue-revision-ci-self-test --queue agent-tasks --output loop-revision-ci-self-test.md
loop-engineering queue-revision-ci-doctor --queue agent-tasks --output loop-revision-ci-doctor.md
loop-engineering queue-revision-ci-repair-plan --queue agent-tasks --output loop-revision-ci-repair-plan.md
loop-engineering queue-revision-ci-apply-repair-plan --from loop-revision-ci-repair-plan.json --confirm-apply --output loop-revision-ci-apply-repair-plan.md
loop-engineering queue-revision-ci-health-summary --queue agent-tasks --output loop-revision-ci-health-summary.md
loop-engineering queue-revision-ci-dashboard --output loop-revision-ci-dashboard.md
loop-engineering queue-revision-ci-release-checklist --output loop-revision-ci-release-checklist.md
loop-engineering queue-revision-ci-baseline-update --from current-audit.json --output previous-audit.json
loop-engineering queue-revision-drift-allow-template --type unreported_actionable_review_plan --output drift-allow.json
loop-engineering queue-revision-next --queue agent-tasks --task-id <id>
loop-engineering queue-lineage --queue agent-tasks --task-id <id>
loop-engineering queue-lineage-bundle --queue agent-tasks --task-id <id>
loop-engineering queue-human-decision --queue agent-tasks --task-id <id> --decision approve|request_changes|reject
loop-engineering workflow-metrics --queue agent-tasks
loop-engineering code-worktree-list --queue code-tasks
loop-engineering code-worktree-inspect --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --queue code-tasks --task-id <id>
loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/<id>.patch
loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/<id>.patch
loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/<id>.patch --confirm-apply
loop-engineering code-review-bundle --queue code-tasks --task-id <id>
loop-engineering code-task-closeout --queue code-tasks --task-id <id>
loop-engineering code-task-autoflow --queue code-tasks --task-id <id>
loop-engineering code-task-autoflow --queue code-tasks --all-actionable --until closeout
loop-engineering code-task-finish --queue code-tasks --task-id <id> --confirm-apply --confirm-cleanup
loop-engineering code-task-run --queue code-tasks --title "Task" --task "Do the work" --confirm-apply --confirm-cleanup
loop-engineering code-task-dashboard --queue code-tasks
loop-engineering code-task-status --queue code-tasks
loop-engineering code-worktree-cleanup-plan --queue code-tasks
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup
```

Artifacts are written to:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

## Explainable configuration drift

Use a `json-value` check when a loop must compare one JSON configuration value
without hiding the evidence inside a shell command:

```json
{
  "id": "default-model",
  "type": "json-value",
  "file": "config/app.json",
  "pointer": "/agents/defaults/model/primary",
  "expected": "provider/model"
}
```

Run artifacts record `expected`, `actual`, and a structured drift kind. After a
failed run, `repair-plan --id <loop>` creates a read-only review artifact. It
never edits the checked configuration or applies a repair.

## Project Intake

Use project intake when the input is still a project brief rather than a queue
task. It turns a fuzzy request into a conservative project spec, initial
backlog, queue config, checks, and human gates while keeping execution separate.

```bash
loop-engineering project-intake \
  --root /path/to/workspace \
  --name launch-site \
  --brief "Build a launch website for a new product" \
  --type auto \
  --check "npm test"
```

`project-intake` writes a timestamped intake artifact plus a stable latest copy:

```text
runtime/loops/projects/<project>/intake/<timestamp>_<project>.json
runtime/loops/projects/<project>/intake/latest.json
runtime/loops/projects/<project>/plans/project-plan.md
```

Then solidify the plan:

```bash
loop-engineering project-plan --root /path/to/workspace --project launch-site
```

`project-plan` writes:

```text
configs/loops/projects/<project>.json
configs/loops/queues/<project>-dev.json or configs/loops/queues/<project>-tasks.json
runtime/loops/projects/<project>/backlog/initial.json
runtime/loops/projects/<project>/plans/project-plan.md
```

For code-oriented project types, the generated queue is a code worktree queue.
For research, content, operations, QA, knowledge-base, infra-audit, and
assistant-workflow types, it is a standard artifact queue. The project spec
defaults to local work, progress reports, and human confirmation for push,
publish, deploy, external writes, destructive actions, production config, and
credential changes.

Inspect the project-level view without changing queue state:

```bash
loop-engineering project-status --root /path/to/workspace --project launch-site
```

Project intake does not enqueue work or run a scheduler by itself. Use the
generated backlog and existing queue commands when the plan is ready.

## Observability

Use `doctor` for a read-only health view of the loop workspace:

```bash
loop-engineering doctor --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace --json
```

It checks the workspace root, loop configs, queue configs, runtime directories,
latest loop outcomes, queue status, active tasks, failed tasks, and active queue
locks. It exits non-zero only on hard failures; warnings are reported but do not
fail the command.

Use `summarize` to inspect recent run artifacts:

```bash
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering summarize --root /path/to/workspace --id workspace-health
loop-engineering summarize --root /path/to/workspace --queue agent-tasks
```

The summary reports inspected/readable/skipped run counts, status counts,
success rate, average duration, latest matching run, and recent failure reasons.
`--id` filters loop-spec runs, while `--queue` filters queue-dispatch runs.

Use `workflow-metrics` when the loop itself needs review:

```bash
loop-engineering workflow-metrics --root /path/to/workspace --queue agent-tasks
loop-engineering workflow-metrics --root /path/to/workspace --queue agent-tasks --limit 100 --json
loop-engineering workflow-tune-plan --root /path/to/workspace --queue agent-tasks --json
```

It reports status counts, final judgement counts, duration percentiles,
verification failures, revision pressure, human-gate pressure, common failure
signatures, progress phase counts, and optimization recommendations. The
command is read-only and does not rewrite queue state or configuration.
`workflow-tune-plan` is also read-only: it turns those metrics into an
operator-reviewable tuning plan with action items and a config overlay preview
for things such as `revisionPolicy` and human-action blocker patterns.

## Cron Wrapper

Use the bundled wrapper after installing the package:

```bash
LOOP_WORKDIR=/path/to/workspace \
  run-loop-cron.sh configs/loops/workspace-health.json
```

Set `LOOP_ALERT_COMMAND` to a command that accepts one message argument when
you want non-zero loop exits to notify a channel.

## Queue Runner

The queue runner is for explicit task handoffs. It does not route ordinary chat
or simple commands by itself.

Conversation integrations can use `route-message` to separate read-only status
questions from explicit execution handoffs:

```bash
loop-engineering route-message \
  --message "Use Loop Engineering to fix this issue" \
  --queue agent-tasks \
  --route \
  --confirm-execute \
  --source-channel feishu \
  --source-target user-id \
  --source-account main \
  --source-message-id message-id
```

Status intent summarizes without enqueueing. Routed execution tasks retain
their source metadata and use `risk=model_assessed`: the router does not reject
goals or create human gates from topic/tool keywords. The planner and executor
assess concrete actions contextually under their applicable authorization
policy.

Use a timer or watcher to deliver terminal states back to recorded sources:

```bash
loop-engineering queue-terminal-notify \
  --queue agent-tasks \
  --notify-command "send-loop-message"
```

Successful delivery is recorded once per task/status under
`runtime/loops/<queue>/notifications/`. The notify command receives the message
as its final argument plus `LOOP_NOTIFICATION_*` environment variables. Use
`--dry-run` to inspect notifications without writing an idempotency ledger.

Human-input checkpoints use a separate resumable protocol:

```bash
loop-engineering queue-human-input-notify \
  --queue agent-tasks \
  --notify-command "send-loop-message"

loop-engineering queue-human-input-resolve \
  --queue agent-tasks \
  --gate-id "<task-id>:<checkpoint-id>" \
  --input "123456"
```

The human-input notifier scans active and terminal tasks, sends the concrete
checkpoint blocker, and records a `waiting_for_human` gate. Resolution is
idempotent; a terminal blocked task is requeued with the response attached.
OTP, password, token, credential, and verification-code gates are inferred as
one-time secrets and destroyed after consumption. Review decisions, approvals,
assignments, and attestations remain available in the gate event as durable
non-sensitive evidence. Use `--secret-input` or `--non-secret-input` to override
the inference when gate wording is ambiguous.

Goal-directed controllers can use the exported `normalizeGoalDecision`,
`goalLoopTransition`, and `goalStrategyFingerprint` helpers. They distinguish
an approach failure from a goal failure, require evidence-based replanning, and
stop only for achievement, a concrete human gate, proven unreachability, or an
explicit exploration budget/repetition breaker.

Create a queue config:

```bash
loop-engineering queue-init --queue agent-tasks
```

That writes `configs/loops/queues/agent-tasks.json`:

```json
{
  "queue": "agent-tasks",
  "dispatcher": "node scripts/dispatch-task.mjs",
  "preflightConfig": "configs/loops/workspace-health.json",
  "timeoutMs": 1800000,
  "leaseMs": 1860000,
  "staleActiveMs": 3600000,
  "scheduler": {
    "initialInterval": "10m",
    "minInterval": "1m",
    "maxInterval": "4h",
    "speedupFactor": 0.5,
    "backoffFactor": 2,
    "idleBackoffFactor": 2,
    "humanGateBackoffFactor": 3,
    "longRunHeadroomFactor": 1.25,
    "jitter": "30s",
    "progressReport": {
      "enabled": true,
      "minInterval": "30m",
      "idleInterval": "4h",
      "notifyOnFailure": true,
      "notifyOnHumanGate": true,
      "notifyOnCompletion": true,
      "notifyOnStatusChange": true
    }
  },
  "retry": {
    "maxAttempts": 1,
    "retryDelayMs": 0,
    "retryExitCodes": [1],
    "requiresHumanActionPatterns": [
      "INSTALL_FAILED_USER_RESTRICTED",
      "device unauthorized",
      "no devices/emulators found",
      "Permission denied",
      "Operation not permitted",
      "requires human",
      "需要人工",
      "权限未开"
    ]
  },
  "revisionPolicy": {
    "enabled": true,
    "maxRevisionRounds": 3,
    "sameFailureThreshold": 2,
    "requireStrategyChange": true,
    "strategyChangeFailureThreshold": 2
  }
}
```

```bash
loop-engineering enqueue \
  --queue agent-tasks \
  --title "Check target app logs" \
  --task "Inspect the latest logs and summarize blockers."
```

Process one task:

```bash
loop-engineering run-queue \
  --config configs/loops/queues/agent-tasks.json
```

Drive a queue with adaptive cadence:

```bash
loop-engineering queue-scheduler-tick \
  --config configs/loops/queues/agent-tasks.json
```

The scheduler starts at 10 minutes by default, then persists its own state under
`runtime/loops/<queue>/scheduler/state.json`. Successful runs with more queued
work speed up toward `minInterval`; empty queues, failures, and human gates back
off toward `maxInterval`; long runs automatically push the next interval beyond
the observed duration to avoid re-entry. Use `--plan-only` to compute and write
the next schedule without running a queue tick, or `--force-due` to wake the
queue immediately after a manual nudge.

Scheduler ticks also write a human-readable progress report to
`runtime/loops/<queue>/progress/latest.json`. Progress reporting is enabled by
default and writes a local artifact on every scheduler tick;
the report is throttled by `minInterval`, but failures, human gates, status
changes, and queue completion can notify immediately. Pass
`--progress-notify-command "command"` to hand the summary text to an external
messaging wrapper; without that command the CLI only writes local artifacts. Use
`--no-progress-report` or `scheduler.progressReport.enabled=false` for explicit
quiet mode.

The dispatcher receives task details through environment variables:

```text
LOOP_QUEUE_ID
LOOP_TASK_ID
LOOP_TASK_TITLE
LOOP_TASK_BODY
LOOP_TASK_FILE
LOOP_TASK_FILE_REL
LOOP_TASK_RUNTIME_DIR
LOOP_TASK_RUNTIME_DIR_REL
LOOP_TASK_CONTRACT_FILE
LOOP_TASK_CONTRACT_FILE_REL
LOOP_ACCEPTANCE_PLAN_FILE
LOOP_ACCEPTANCE_PLAN_FILE_REL
LOOP_DEV_PLAN_FILE
LOOP_DEV_PLAN_FILE_REL
LOOP_CHECKPOINTS_DIR
LOOP_CHECKPOINTS_DIR_REL
LOOP_REVIEWS_DIR
LOOP_REVIEWS_DIR_REL
LOOP_HUMAN_REVIEW_DECISION_FILE
LOOP_HUMAN_REVIEW_DECISION_FILE_REL
LOOP_HUMAN_REVISION_REQUEST_FILE
LOOP_HUMAN_REVISION_REQUEST_FILE_REL
LOOP_RUN_ID
LOOP_ATTEMPT
LOOP_MAX_ATTEMPTS
```

Before dispatch, `run-queue` writes planning artifacts under
`runtime/loops/<queue>/tasks/<task_id>/`: `task_contract.json`,
`acceptance_plan.json`, `dev_plan.json`, `checkpoints/`, `reviews/`, and
`final_judgement.json`; when acceptance requires more work, it also writes
`revision_request.json`. The dispatcher can
read them through `LOOP_TASK_CONTRACT_FILE`, `LOOP_ACCEPTANCE_PLAN_FILE`,
`LOOP_DEV_PLAN_FILE`, `LOOP_CHECKPOINTS_DIR`, and `LOOP_REVIEWS_DIR`; the queue
run artifact records their paths, inferred risk level, human-gate flag,
acceptance check counts, planned checkpoint count, produced checkpoint files,
generated acceptance reviews, final judgement outcome, and revision request
summary. It also records a `lineage` summary so later rounds can see the root
task, current path, revision edges, and each known attempt's checkpoint,
review, final judgement, and revision request status.

During intake, the runner searches recent queue runs as a compact local error
and success library. Similar failed runs are written to `task_contract.json` as
`historical_patterns.error_library_matches`; similar successful runs become
`success_pattern_matches`. The contract also carries guidance so the dispatcher
can avoid known blockers and reuse successful tactics before it starts work.

Acceptance review includes a deterministic multi-critic baseline. Each
checkpoint review writes `critic_reviews` for correctness, safety, regression,
and domain/risk coverage. These critics are intentionally local and conservative
in v0.4.x, but the artifact shape is ready for stronger model or tool-backed
critics later.

Queues can add or override critics with `acceptanceCritics`:

```json
{
  "acceptanceCritics": [
    {
      "id": "artifact_traceability",
      "focus": "The task must leave enough evidence for review and handoff.",
      "requiredEvidence": ["summary", "verification", "files_changed"],
      "failureStatus": "revise",
      "revisionHint": "Produce a replayable checkpoint with changed files and verification output.",
      "evidenceHints": {
        "files_changed": "List the exact files or artifacts changed in the next checkpoint."
      }
    }
  ]
}
```

Supported evidence keys are `summary`, `verification`, `no_blockers`,
`risks_array`, `status_ready`, `files_changed`, `manual_review`,
`regression_checks`, `edge_cases`, `blocked_actions`, and `risk_level`.
If a configured critic reuses a default id such as `safety`, it overrides that
default critic's focus or evidence requirements while preserving the same review
artifact shape.

Critics can also declare revision guidance. `revisionHint` becomes the overall
next-round goal when that critic fails, and `evidenceHints` maps individual
missing evidence keys into concrete development instructions. Checkpoint
reviews write `missing_evidence`, `evidence_results`, and
`next_development_goals`; `revision_request.json`, revision task bodies, and
lineage bundles carry those fields forward so custom critics produce actionable
next-round work instead of a generic failed-critic note.

Live instrumentation and process-control requests are gated even when they are
local-only. Tasks mentioning tools or actions such as `frida`, `tcpdump`,
`adb`, `mitmproxy`, `hook`, `spawn`, `attach`, `decrypt`, `pcap`, `su`, `kill`,
or `pkill` are inferred as at least L2; destructive process cleanup is inferred
as L3. Dispatchers should stop at artifacts and wait for human review before
running those actions.

`run-queue` reports progress as it works so long-running tasks do not feel like
a black box. In normal CLI mode it prints concise stage events to stderr for
queue activation, planning, preflight, worktree setup, dispatch attempts,
verification, acceptance review, final judgement, revision requests, and final
queue status. `--json` keeps stdout/stderr machine-clean while still including
the same events in the returned JSON and the run artifact as `progress`.

`queue-lineage-bundle` turns that lineage into a human-readable Markdown review
bundle plus a JSON sidecar under `runtime/loops/<queue>/lineage-bundles/`.
The bundle highlights what each round produced, why acceptance failed, what the
next revision requested, and whether the latest round is ready for human review.

`queue-human-decision` records the human gate for a task under
`runtime/loops/<queue>/tasks/<task_id>/human_review_decision.json`. Decisions
are `approve`, `request_changes`, or `reject`. A `request_changes` decision
also writes `human_revision_request.json`, and `--enqueue-revision` can create
the next queued revision task from that feedback.

`queue-revision-plan` is the read-only preview for a failed task whose final
judgement is `needs_revision`. It reads the same `revision_request.json`, builds
the next task body, runs `revisionStrategyDiff`, and reports the revision guard
decision without writing to the queue. `queue-revision-next` uses the same plan
path, then creates the fresh queued task when the guard allows it. Both commands
can also use `human_revision_request.json` after a human `request_changes`
decision.
Pass `--output plan.json` or `--output plan.md` to save one preview artifact, or
pass `--output-dir` to write both
`runtime/loops/<queue>/revision-plans/<source-task-id>.json` and `.md` with a
stable default name. `--output-dir custom/dir` writes the same JSON/Markdown pair
under a custom workspace-relative directory. The output is written even when the
guard blocks the plan, so a blocked preview can be inspected and attached to a
human decision.
Use `queue-revision-apply-plan --plan plan.json` after review to enqueue the
saved JSON plan exactly as written instead of regenerating a fresh preview.
Blocked plans still require `--force`, and `--queue` can be supplied as an
extra assertion that the artifact is for the expected queue. Use
`queue-revision-apply-plan --from-review action-list.json` to apply the
safe enqueue actions from a saved review artifact in a batch. By default it
applies only `apply_ready` and `apply_or_refresh_stale`; `--action` can narrow
that list. The command refreshes current plan state before enqueueing, skips
already-applied plans, and never applies blocked, queue-mismatched, or unreadable
plans from the review. Pass `--output apply-report.md` or
`--output apply-report.json` to save the applied/skipped result as an audit
artifact; existing reports require `--force` to overwrite.
Use `queue-revision-review` to scan a queue's `revision-plans/` directory and
summarize which saved plans can enqueue, which guard reasons are present, their
strategy diff counts, and whether a plan has already been applied by a queued or
completed revision task. Pass `--plans-dir custom/dir` to review a custom plan
directory. Pass `--applied-report apply-report.json` to attach the latest batch
apply audit result to each matching plan, so a later action list can show which
report applied or skipped that plan. Pass `--needs-action` to hide already-applied plans and show only
plans that need an apply, blocked-plan review, queue-mismatch review, or
unreadable-file review. Pass `--stale-after 24h` to mark unapplied plans whose
generated time or file mtime is older than the threshold; supported units are
`ms`, `s`, `m`, `h`, and `d`. Pass `--output action-list.md` or
`--output action-list.json` to save the current filtered review as a human
approval artifact; existing outputs require `--force` to overwrite.
Use `queue-revision-audit-chain --review action-list.json --apply-report
apply-report.json --output audit-chain.md` to create a dedicated audit artifact
that links each reported plan to its review decision, saved plan JSON, apply
result, and resulting revision task when one was created. Add
`--verify-current` to rescan the current queue task directories and record where
each resulting task now lives, whether it still exists, and whether its current
`revisionPlanPath` still points back to the audited plan.
Add `--fail-on-drift` for CI-style checks. It implies current-state verification
and exits 2 when an error-level drift is found, including current task missing,
task-plan mismatch, source task mismatch, queue mismatch, unreadable plan JSON,
duplicate current task ids, or an apply report entry that is not present in the
review artifact. Actionable review plans that were not included in the apply
report are reported as warnings. Pass `--drift-report drift-report.md` or
`--drift-report drift-report.json` to save only the drift summary and findings
as a shorter CI artifact; existing drift reports require `--force` to overwrite.
When writing a Markdown drift report for GitHub Actions, add
`--drift-summary-format github` to produce a compact step-summary-friendly
report with a metric table and concise findings table; the default format
remains the existing detailed Markdown. In GitHub Actions, add
`--drift-summary-append-github-step` to append the same GitHub summary directly
to `$GITHUB_STEP_SUMMARY`; this does not require `--drift-report`, though both
can be used together when a saved artifact is also useful. Add
`--drift-github-annotations` to emit GitHub Actions `::error` / `::warning`
workflow commands for non-allowed drift findings on stderr, so the Checks UI can
link directly to the affected plan files without breaking `--json` stdout.
Use `queue-revision-ci-check --review action-list.json --apply-report
apply-report.json` as the short CI wrapper for the strict default: it implies
current-state verification, `--fail-on-drift`, `--drift-severity warning`,
GitHub annotations, and GitHub-format drift reports. When
`GITHUB_STEP_SUMMARY` is present, it also appends the summary automatically;
outside GitHub Actions it skips that append instead of failing. Use
`--no-github-step-summary` or `--no-github-annotations` to disable those CI UI
integrations.
Pass `--baseline previous-audit.json` or a previous drift-report JSON to compare
current findings with the saved baseline. Baseline-known findings remain visible
in JSON, Markdown, and step summary output, but CI failure and annotations only
use new non-allowed findings.
After a human has accepted the current drift, run
`queue-revision-ci-baseline-update --from current-audit.json --output
previous-audit.json` to write a compact JSON baseline for the next CI run. The
source may be an audit-chain JSON artifact or a drift-report JSON artifact.
For a first CI landing on a queue, use `queue-revision-ci-bootstrap --queue
agent-tasks`. It writes a complete artifact set under
`runtime/loops/<queue>/ci-bootstrap/<timestamp>/`: `action-list.json`,
`apply-report.json`, `audit-chain.json`, GitHub-style `drift-report.md`,
`previous-audit.json`, and `bootstrap.json`. Pass `--output-dir` to choose a
stable artifact directory, or `--baseline-output` when the baseline should be
written somewhere else.
Use `queue-revision-ci-workflow-template --queue agent-tasks --output
.github/workflows/loop-revision-ci.yml` to generate a starter GitHub Actions
workflow. The template creates a baseline on the first run when none exists,
then uses `queue-revision-ci-check` on later runs with GitHub step summary,
annotations, and artifact upload wired in.
Use `queue-revision-ci-status-badge --queue agent-tasks --output
loop-revision-ci-badge.md` to generate a README-ready badge snippet for that
workflow. The command infers `owner/repo` from the GitHub origin remote when it
can; pass `--repo owner/name`, `--workflow`, `--branch`, or `--label` to make
the badge explicit.
Use `queue-revision-ci-readme-update --queue agent-tasks --readme README.md`
to insert or refresh the same badge and a short status note inside a stable
`<!-- loop-revision-ci:start -->` / `<!-- loop-revision-ci:end -->` marker
block. Without an existing block, the command inserts one after the README
title. Pass `--section-title`, `--repo`, `--workflow`, `--branch`, or `--label`
to customize the generated section.
Use `queue-revision-ci-install-guide --queue agent-tasks --output
loop-revision-ci-install-guide.md` to generate a reviewable onboarding checklist
for a new queue. The guide links the workflow template, README marker update,
initial bootstrap baseline, strict CI check, and optional drift allow-file
template commands without writing those target files directly. Use `.json`
instead of `.md` when another script should consume the same plan.
Use `queue-revision-ci-self-test --queue agent-tasks --output
loop-revision-ci-self-test.md` to run a local smoke test in a temporary
workspace. The self-test writes a workflow template, drift allow-file template,
README marker, bootstrap artifacts, baseline, strict CI check artifacts, health
summary, and dashboard under `/tmp/loop-revision-ci-self-test-*`, then reports
the artifact paths. It
does not modify the current project except for the optional self-test report
specified by `--output`.
Use `queue-revision-ci-doctor --queue agent-tasks --output
loop-revision-ci-doctor.md` after landing revision CI in a real project. The
doctor checks that the workflow exists and references the queue, bootstrap,
strict CI check, baseline, and artifact directory; that README has the stable
marker block; that the baseline is readable and queue-matched; and that the
optional drift allow-file has an auditable shape when present. Failure-level
drift exits 2, while missing optional allow-files are warnings.
Use `queue-revision-ci-repair-plan --queue agent-tasks --output
loop-revision-ci-repair-plan.md` to turn a failed doctor run into a reviewable
command list. The repair plan can read an existing `queue-revision-ci-doctor`
JSON report with `--from doctor.json`, or run doctor inline. It proposes
commands to regenerate the workflow, refresh the README marker, rebuild the
baseline, refresh the drift allow-file, and rerun doctor, but it does not apply
those repairs itself.
Use `queue-revision-ci-apply-repair-plan --from repair-plan.json
--confirm-apply --output apply-repair-plan.md` after reviewing a JSON repair
plan. The command applies only known safe repair actions, can be narrowed with
`--action regenerate_workflow,rebuild_baseline`, writes an optional audit
report, and automatically reruns `queue-revision-ci-doctor` after the selected
repairs. Without `--confirm-apply`, it reports `confirmation_required` and
does not modify project files.
Use `queue-revision-ci-health-summary --queue agent-tasks --output
loop-revision-ci-health-summary.md` for a short read-only inspection view. It runs the
revision CI doctor, reads the configured baseline and drift allow-file, discovers
the latest bootstrap manifest under `runtime/loops/<queue>/ci-bootstrap/`, and
summarizes linked review/apply/audit/drift artifacts. Pass `--repair-plan` or
`--apply-report` to include a specific reviewed repair or apply report. The
command exits 2 when core health needs attention.
Use `queue-revision-ci-dashboard --output loop-revision-ci-dashboard.md` for a
read-only multi-queue overview. Without `--queue`, it scans
`configs/loops/queues/*.json`, runs the same health summary for each queue, and
renders a compact table with doctor, bootstrap, baseline, drift, and finding
status. Add `--queue agent-tasks` to narrow the dashboard to one queue. The
command exits 2 when any queue needs attention.
Use `queue-revision-ci-release-checklist --output
loop-revision-ci-release-checklist.md` before publishing or handing off the
revision CI setup. It reuses the dashboard inspection, turns each queue's
doctor/bootstrap/baseline/drift/health state into blocker checks, and adds
manual release gates for `npm run check`, workspace `doctor`, and
`npm pack --dry-run`. The command is read-only and exits 2 while any blocker is
open.
By default, `--fail-on-drift` fails only on error-level findings. Add
`--drift-severity warning` when a stricter queue should also fail on warnings;
use `--drift-severity error` to keep the default explicit in CI scripts. Pass
`--drift-allow current_task_missing,unreported_actionable_review_plan` to
temporarily allow named finding types; allowed findings stay visible in the
audit and drift reports but do not contribute to the fail-on-drift decision.
For auditable CI exceptions, pass `--drift-allow-file drift-allow.json`:

```json
{
  "allowed": [
    {
      "type": "unreported_actionable_review_plan",
      "reason": "Pending owner review before the next batch apply.",
      "owner": "platform-ci",
      "expiresAt": "2026-07-22T00:00:00.000Z"
    }
  ]
}
```

Expired allow-file entries remain visible in reports but do not allow findings.
Use `queue-revision-drift-allow-template` to create the file shape without
hand-writing JSON:

```bash
loop-engineering queue-revision-drift-allow-template \
  --type unreported_actionable_review_plan \
  --owner platform-ci \
  --reason "Pending owner review before the next batch apply." \
  --ttl 24h \
  --output drift-allow.json
```

The template command refuses existing outputs unless `--force` is used. It also
supports `--expires-at 2026-07-22T00:00:00.000Z` instead of `--ttl`.

The planned or queued task stores `revisionStrategyDiff`, which compares the
previous failed goals with the next task body and reports which targets were
carried forward, which have explicit changed-strategy signals, and which still
need a concrete new diagnosis, tactic, evidence source, or verification step.
Pass `--strategy "..."` or `--strategy-file strategy.md` to append a focused
`Changed strategy` section without replacing the generated revision task body;
the strategy is stored as `revisionStrategy` and participates in
`revisionStrategyDiff`.

`revisionPolicy` keeps the loop persistent without letting it repeat the same
failed approach forever. By default, a lineage can create up to 3 revision
rounds. If two consecutive rounds produce the same revision-goal signature,
`queue-revision-next` refuses to enqueue another automatic round. When
`requireStrategyChange` is enabled, `revisionStrategyDiff` is also enforced: if
two consecutive revision tasks carry failed targets forward without explicit
changed-strategy detail, the next automatic revision is blocked. The generated
revision task includes anti-loop instructions requiring a changed diagnosis,
implementation tactic, evidence source, or verification step. Use
`queue-lineage-bundle` and a human decision when the guard stops progress;
`queue-revision-next --force` is reserved for explicit human overrides.

Operational commands:

```bash
loop-engineering queue-status --config configs/loops/queues/agent-tasks.json
loop-engineering queue-peek --config configs/loops/queues/agent-tasks.json
loop-engineering queue-cancel --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-requeue --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-revision-plan --config configs/loops/queues/agent-tasks.json --task-id <id> --output-dir
loop-engineering queue-revision-apply-plan --config configs/loops/queues/agent-tasks.json --plan runtime/loops/agent-tasks/revision-plans/plan.json
loop-engineering queue-revision-review --config configs/loops/queues/agent-tasks.json
loop-engineering queue-revision-next --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-lineage --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-lineage-bundle --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-human-decision --config configs/loops/queues/agent-tasks.json --task-id <id> --decision approve
```

`run-queue` processes one task. `run-queue-drain` is an explicit batch/daemon
command that keeps claiming queued tasks serially until the inbox is empty or
`--max-tasks` is reached. The generated OpenClaw conversation wrapper does not
use drain mode: a new explicit Loop Engineering request while a task is active supersedes the
active task, records the replacement lineage, stops the old dispatcher process
group, and starts the corrected task after the lock is released. Explicit
queue-only wording still creates ordinary queued work. `Continue the current
loop with this amendment: ...` uses the amendment path instead: it keeps the same task and worker session,
writes `amendments/NNNN.json`, increments `amendment_version` in the task
contract, acceptance plan, and dev plan, and requires the worker to reread the
latest amendment before each checkpoint and final completion. Both commands use a lease lock so overlapping ticks do not process the same
task. `staleActiveMs` moves abandoned active tasks to `failed/` before the next
task is processed. `retry.maxAttempts` retries dispatcher failures whose exit
code is listed in `retry.retryExitCodes`.

Pass `--progress-notify-command` from a conversation wrapper to keep the source
session informed while the worker runs. The runner sends ordered, idempotent
milestones for activation, completed planning, preflight, worker start/result,
worktree/verification, acceptance, and final judgement. During a long dispatch
it sends a heartbeat every five minutes by default, and a checkpoint watcher
reports newly written checkpoints without waiting for the worker process to
finish. Source channel/target/account/reply metadata is reused; missing scoped
source metadata fails closed. Notification ledgers live under
`tasks/<task-id>/progress_notifications/` so retries do not resend the same
milestone.

Dispatcher command timeouts terminate the whole spawned process group, not just
the shell wrapper, so child processes such as `frida`, `tcpdump`, or `adb`
cannot keep running after the queue run has timed out. Dispatcher failures are
also classified before retry: output matching
`retry.requiresHumanActionPatterns` is marked `requires_human_action`, the task
finishes as `needs_human_input`, and no automatic retry is attempted. Use this
for device permissions, human approval prompts, missing authorization, or other
states where another run would repeat the same blocker.

Queue artifacts live under:

```text
runtime/loops/<queue>/inbox/*.json
runtime/loops/<queue>/active/*.json
runtime/loops/<queue>/done/*.json
runtime/loops/<queue>/failed/*.json
runtime/loops/<queue>/canceled/*.json
runtime/loops/<queue>/runs/*.json
```

## Assisted Code Worktrees

`v0.3.0` adds L2 assisted code queues. A code queue still uses `enqueue` and
`run-queue`, but the runner creates a git worktree and branch for the task,
runs the dispatcher inside that worktree, then runs configured verification
commands. It records the branch, worktree path, verification results, `git
status --short`, `git diff --stat`, and `git diff --name-status` in the run
artifact, plus untracked file names.

Create a starter config:

```bash
loop-engineering code-queue-init --queue code-tasks
```

That writes `configs/loops/queues/code-tasks.json` with:

```json
{
  "queue": "code-tasks",
  "dispatcher": "node scripts/dispatch-code-task.mjs",
  "preflightConfig": "configs/loops/workspace-health.json",
  "worktree": {
    "enabled": true,
    "baseDir": "runtime/loops/code-tasks/worktrees",
    "branchPrefix": "loop/code-tasks",
    "verifyCommands": ["npm test"],
    "keepOnSuccess": true
  }
}
```

The dispatcher receives the normal queue environment variables plus:

```text
LOOP_ROOT
LOOP_WORKTREE_PATH
LOOP_WORKTREE_PATH_REL
LOOP_WORKTREE_BRANCH
```

The runner deliberately does not push, merge, or delete worktrees. Treat the
artifact as a prepared patch workspace for review.

`v0.3.1` adds read-only worktree artifact inspection:

```bash
loop-engineering code-worktree-list --queue code-tasks
loop-engineering code-worktree-inspect --queue code-tasks --task-id <id>
loop-engineering code-worktree-inspect --queue code-tasks --run-id <id> --json
```

These commands read queue run artifacts and report branch, path, dirty status,
verification status, diff summaries, and untracked files. They do not remove
worktrees or change git state.

`v0.3.2` adds read-only patch review from the recorded worktree:

```bash
loop-engineering code-worktree-diff --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --queue code-tasks --run-id <id> --json
```

It resolves the worktree from the run artifact, keeps the path inside the
workspace root, then prints `git diff --stat HEAD`, `git diff --name-status
HEAD`, `git diff --binary HEAD`, and untracked file names. It does not stage,
commit, push, merge, delete, or checkout anything.

`v0.3.3` adds patch export artifacts:

```bash
loop-engineering code-worktree-export --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --queue code-tasks --run-id <id> --output review.patch --json
```

By default it writes `runtime/loops/<queue>/patches/<taskId>.patch` plus a
`.json` manifest containing source run, worktree, diff summary, and untracked
file names. It refuses to overwrite existing exports unless `--force` is set
and does not change git or queue state.

`v0.3.4` adds offline patch verification:

```bash
loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/<taskId>.patch
loop-engineering code-patch-verify --patch review.patch --json
```

It reads an exported patch, strips loop-engineering metadata comments, and runs
`git apply --check --binary` from the target workspace root. This verifies
whether the patch still applies without staging, committing, checking out,
merging, or changing queue state.

`v0.3.5` adds code worktree maintenance planning:

```bash
loop-engineering code-worktree-cleanup-plan --queue code-tasks
loop-engineering code-worktree-cleanup-plan --queue code-tasks --json
```

It inspects recent code queue run artifacts, checks whether recorded worktrees
still exist, detects dirty worktrees without exported patches, verifies default
patch exports when present, and reports orphan worktree directories under the
configured worktree base directory. It only prints recommendations and cleanup
commands; it does not remove worktrees or change git/queue state. `doctor`
also reports these code queue findings as warnings.

`v0.3.6` adds confirmation-gated patch application:

```bash
loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/<taskId>.patch
loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/<taskId>.patch --confirm-apply
```

`code-patch-apply-plan` is read-only. It strips loop-engineering metadata,
checks `git apply --check --binary`, reports affected files, and blocks when
those affected files are already dirty unless `--allow-dirty` is supplied.
`code-patch-apply` requires `--confirm-apply` and runs the same plan first; it
only applies the patch when the plan is ready. It does not stage, commit, push,
merge, checkout, delete worktrees, or change queue state.

`v0.3.7` adds review bundle artifacts:

```bash
loop-engineering code-review-bundle --queue code-tasks --task-id <taskId>
loop-engineering code-review-bundle --queue code-tasks --run-id <runId> --output review.md --json
```

It writes `runtime/loops/<queue>/reviews/<taskId>.md` plus a `.json` sidecar by
default. The bundle collects the task/run identity, worktree summary,
verification results, current worktree diff, exported patch presence,
`code-patch-verify`, and `code-patch-apply-plan` when a default exported patch
exists. It refuses to overwrite unless `--force` is set and does not export,
apply, stage, commit, push, merge, delete worktrees, or change queue state.

`v0.3.8` adds confirmation-gated worktree cleanup:

```bash
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup --include-orphans --json
```

It reruns `code-worktree-cleanup-plan` and removes only gated candidates with
`git worktree remove`. Dirty worktrees require a default exported patch,
successful `code-patch-verify`, and an existing review bundle Markdown plus
JSON sidecar. Orphan worktree directories are skipped unless `--include-orphans`
is supplied. The command does not stage, commit, push, merge, delete branches,
or change queue state.

`v0.3.9` adds closeout artifacts:

```bash
loop-engineering code-task-closeout --queue code-tasks --task-id <taskId>
loop-engineering code-task-closeout --queue code-tasks --run-id <runId> --output closeout.md --json
```

It writes `runtime/loops/<queue>/closeouts/<taskId>.md` plus a `.json` sidecar
by default. The closeout gathers run identity, verification, current worktree
state when present, patch export/verify/apply-plan status, review bundle
presence, cleanup recommendation, and remaining next actions. It refuses to
overwrite unless `--force` is set and does not apply patches, remove worktrees,
stage, commit, push, merge, delete branches, or change queue state.

`v0.3.10` adds a task-level status ledger:

```bash
loop-engineering code-task-status --queue code-tasks
loop-engineering code-task-status --queue code-tasks --task-id <taskId> --json
```

It reads recent code queue run artifacts and reports each task's queue state,
worktree existence, patch export and verification status, review bundle
presence, closeout status, cleanup recommendation, aggregate counts, and next
recommended commands. It is read-only and does not apply patches, remove
worktrees, stage, commit, push, merge, delete branches, or change queue state.

`v0.3.11` adds a safe code task autoflow:

```bash
loop-engineering code-task-autoflow --queue code-tasks --task-id <taskId>
loop-engineering code-task-autoflow --queue code-tasks --task-id <taskId> --until closeout --json
```

By default, `code-task-autoflow` runs the review preparation flow through
`export -> verify -> apply-plan -> review`. With `--until closeout`, it also
generates the closeout artifact. Existing patch, review, and closeout artifacts
are skipped unless `--force` is set. It does not apply patches, remove
worktrees, stage, commit, push, merge, delete branches, or change queue state.

`v0.3.12` adds batch autoflow for actionable code tasks:

```bash
loop-engineering code-task-autoflow --queue code-tasks --all-actionable
loop-engineering code-task-autoflow --queue code-tasks --all-actionable --until closeout --json
```

Batch autoflow reads `code-task-status`, selects tasks whose next actions need
patch export, review generation, or, with `--until closeout`, closeout
generation, then runs the same safe autoflow for each selected task. Custom
output paths are intentionally disabled in batch mode. It still does not apply
patches, remove worktrees, stage, commit, push, merge, delete branches, or
change queue state.

`v0.3.13` adds a read-only dashboard for code task queues:

```bash
loop-engineering code-task-dashboard --queue code-tasks
loop-engineering code-task-dashboard --queue code-tasks --json
```

The dashboard combines queue counts, task ledger counts, next-action counts,
cleanup/orphan summaries, priority tasks, and recommended follow-up commands.
It is read-only and does not apply patches, remove worktrees, stage, commit,
push, merge, delete branches, or change queue state.

`v0.3.14` adds confirmation-gated single-task finish:

```bash
loop-engineering code-task-finish --queue code-tasks --task-id <taskId> --confirm-apply --confirm-cleanup
loop-engineering code-task-finish --queue code-tasks --run-id <runId> --confirm-apply --confirm-cleanup --json
```

Finish requires default patch export/manifest, review bundle Markdown/JSON,
closeout Markdown/JSON, a ready `code-patch-apply-plan`, and a passing cleanup
gate. It then applies the patch to the main workspace and removes that one
reviewed worktree, writing `runtime/loops/<queue>/finishes/<taskId>.md` plus a
JSON sidecar. It is intentionally single-task only, requires both confirmation
flags, and still does not stage, commit, push, merge, delete branches, or
change queue state.

`v0.3.15` makes finish artifacts visible in status and dashboard views:

```bash
loop-engineering code-task-status --queue code-tasks --task-id <taskId>
loop-engineering code-task-dashboard --queue code-tasks --json
```

After closeout artifacts are present and the cleanup gate is ready, the status
ledger reports `ready_to_finish` and recommends the single-task
`code-task-finish` command. After finish succeeds, the same task reports
`landed`, includes finish artifact status, patch-applied, and worktree-cleaned
fields, and has no remaining next actions. Dashboards include landed tasks and
finish action counts. These views remain read-only.

`v0.3.16` adds a single end-to-end code task command for the basic loop
engineering workflow:

```bash
loop-engineering code-task-run \
  --queue code-tasks \
  --title "Implement the feature" \
  --task "Make the code change, update tests, and keep the package checks green." \
  --confirm-apply \
  --confirm-cleanup
```

`code-task-run` enqueues the task, processes one code worktree queue task,
runs autoflow through closeout, finishes the task by applying the reviewed
patch and cleaning that worktree, then reruns the queue's configured
`worktree.verifyCommands` in the main workspace. It stops at the first failed
stage and reports the artifact to inspect. It still requires
`--confirm-apply` and `--confirm-cleanup`, and it does not stage, commit, push,
merge, or delete branches.

`v0.6.0` adds explainable configuration drift and a standard OpenClaw
integration lifecycle. Structured checks preserve expected/actual evidence,
while `repair-plan` remains read-only. The integration installer supports
plan-only installation, doctor, disposable end-to-end smoke, hash-audited
upgrade, and safe uninstall with formal queue runtime retention. Generated
conversation wrappers enqueue and run one tick by default, use isolated
configured-worker sessions, prevent recursive routing, and deliver idempotent
human-gate or terminal notifications back to recorded source conversations.
See `MIGRATING.md` for the 0.5 to 0.6 transition.

`v0.5.0` connects loop-managed work to conversations and strengthens
goal-directed execution. `route-message` distinguishes status questions from
explicit execution handoffs while retaining source metadata for contextual
notifications. Human-input checkpoints can now notify the originating
conversation and resume idempotently from `LOOP <gate-id> <input>` replies.
Goal Loop controllers can distinguish an approach failure from a goal failure,
replan from evidence, fingerprint strategies to prevent repetition, and stop
only for achievement, a concrete human gate, proven unreachability, or an
explicit exploration breaker.

`v0.4.4` adds project intake and scheduler progress reporting. Project briefs
can now be converted into deterministic project specs, queue configs, initial
backlogs, action policies, checks, and project-level status without
auto-enqueueing work. Queue scheduler ticks now adapt cadence from a 10-minute
bootstrap interval and write progress artifacts by default, with optional
throttled chat notification hooks for surrounding wrappers.

`v0.4.3` adds a generic revision CI workflow for loop queues. It includes
revision plan preview/apply/review/audit artifacts, strict CI drift checks,
baseline updates, workflow and README onboarding helpers, self-test, doctor,
repair plan/apply, health summary, dashboard, and a release checklist. It also
adds workflow metrics, read-only tuning plans, configurable acceptance critics,
critic evidence hints, historical pattern retrieval, and strategy-diff guards
for repeated revision attempts.

`v0.4.2` hardens queue execution around live instrumentation failures. Command
timeouts now terminate the whole spawned process group, dispatcher output can be
classified as `requires_human_action` to stop retry, and default queue templates
recognize common device authorization and permission blockers such as
`INSTALL_FAILED_USER_RESTRICTED`. Task contracts also gate `frida`, `tcpdump`,
`adb`, process control, device install, and root shell work behind human review.
Queue runs now record and print concise progress events for long-running work.

`v0.4.1` adds revision persistence guards so development loops keep trying with
new evidence or strategy changes while blocking repeated identical failures.
Queue runs now create a task contract, acceptance plan, development plan,
checkpoint directory, acceptance review files, final judgement, revision
requests, lineage summaries, human review bundles, and human gate decision
records. Human reviewers can approve, reject, or request changes with
`queue-human-decision`; requested changes can be turned into the next revision
task with `--enqueue-revision`.

## Skill

The bundled skill is in `skills/taskforce-loop-engineering/SKILL.md`. Install it from
ClawHub or copy it into an agent's skill directory when you want Codex/OpenClaw
agents to follow the loop trigger policy and operational workflow.

ClawHub:

```text
https://clawhub.ai/ambitioncn/skills/taskforce-loop-engineering
```
# P2 multi-agent control plane

Loop Engineering includes typed executable todos with capability/authority-aware atomic claim, lease and fencing, deterministic dependency/quota scheduling, durable peer handoff, orphan recovery, and P0/P1 safety integration. See [docs/multi-agent-control-plane.md](docs/multi-agent-control-plane.md) for the data contract, CLI, and migration path.
