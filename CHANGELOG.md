# Changelog

## Unreleased

## 0.12.0 - 2026-08-13

- Add P3 read-only Operator Dashboard, normalized schema, loopback HTTP/JSON API, static export, inspect and health commands.
- Integrate P0 gates, P1 reconciliation and P2 ownership/lease/handoff projections with legacy artifacts.
- Add redaction, traversal/XSS/bind protections and deterministic/security/performance coverage.

## 0.11.0 - 2026-08-13

- Add Human-Gate Lifecycle v2 parked waits for human input and external conditions, configurable timeout/reminder/escalation policy, durable idempotent notification evidence, verified recovery signals, and exactly-once execution-boundary metadata.
- Extend `queue-status` with operator-visible waiting states and add `queue-park`, `queue-wait-tick`, and `queue-wait-resume` commands.
- Add a VPS-down/SSH-banner-timeout regression fixture proving throttled reminders, preserved unconsumed authorization, verified resume, and restart-safe idempotency.
- Add the durable Action Idempotency and Reservation Contract with immutable request fingerprints, scoped authorization ledger, atomic leased claims and fencing tokens, settlement/release evidence, unknown-outcome reconciliation, paid-call/notification/deployment adapters, operator CLI commands, and backward-compatible artifact import.
- Add concurrency and crash-restart acceptance coverage while preserving Human-Gate Lifecycle v2.
- Add the P2 Multi-Agent Control Plane: typed todos, agent capability registration, deterministic atomic claim with lease/fencing, dependency and quota eligibility, durable handoff, orphan recovery, legacy import, ownership audit, CLI, schema, docs, and P0/P1 safety integration.

## 0.10.0 - 2026-08-11

- Add OpenClaw installer language adaptation with `--language auto|en|zh`.
- Auto-select Chinese for Chinese locales and English for all other or missing locales; explicit language selection takes precedence.
- Persist the resolved language in queue configuration and installer manifests, and localize generated conversation instructions, worker prompts, progress reports, human-input gates, and terminal notifications.

## 0.9.1 - 2026-08-11

- Recognize explicit `用 loop engineering` requests that ask to align, complete, enhance, develop, or build a system as executable Loop tasks instead of direct chat.
- Make the generated OpenClaw conversation wrapper fail closed when channel, target, account, or message-id routing metadata is missing, preventing unscoped human-gate and terminal tasks.
- Document the mandatory wrapper and notification-delivery postcondition, and add regression coverage for the original Growth OS phrasing and missing-source failure.

## 0.9.0 - 2026-08-08

- Add a native Hermes Agent conversation integration with a plan-first installer, `hermes -z` one-shot worker dispatcher, `hermes send` notifier, managed scheduler, and source-bound delivery routing.
- Add a read-only Hermes doctor and disposable end-to-end smoke covering task contracts, checkpoints, final judgement, human-gate scanning, and terminal notification return.
- Add Hermes integration self-tests, including real systemd unit verification for paths containing spaces and non-ASCII characters.
- Add an explicit cross-platform installation confirmation summary to both OpenClaw and Hermes plans, showing the target platform, absolute CLI path, workspace, queue, scheduler, notification routing, and write status before installation.

## 0.8.5 - 2026-08-08

- Fixed generated systemd scheduler units so `WorkingDirectory` and `ExecStart` use unquoted, byte-safe systemd path escapes.
- Added real `systemd-analyze verify` coverage for scheduler paths containing spaces and non-ASCII characters.

## 0.8.4 - 2026-08-07

- Reclaim queue locks immediately when their recorded owner PID no longer
  exists, even if the lease has not expired. Scheduler status no longer reports
  those dead-owner locks as live, and an orphaned `active/` task forces recovery
  on the next timer wake-up instead of waiting for scheduler backoff or lease
  expiry.

- Distinguish one-time secret human inputs from durable non-sensitive decisions
  and attestations, so review approvals remain available as structured evidence
  while OTPs, passwords, tokens, and credential values are still destroyed after
  consumption.
- Restrict human-gate reconciliation to the final judgement's effective
  checkpoint set for every outcome, preventing a project-in-progress tick from
  resurrecting historical waiting gates after a newer checkpoint clears them.
- Allow an explicitly superseded human gate to requeue a task from `waiting/`
  through the normal queue CLI instead of requiring a manual file move.

## 0.8.3 - 2026-08-07

- Select the latest single-milestone checkpoint by durable checkpoint identity/sequence instead of regenerated acceptance-review timestamps, preventing a lexically late legacy `cp9` review from overriding a blocked `cp46+` checkpoint.
- Limit blocked human-input notification to the final judgement's effective checkpoint set, move blocked tasks from `failed/` into `waiting/`, and make the local Ironman scheduler run human-gate and terminal notification reconciliation after each notified tick.

## 0.8.2 - 2026-08-07

- Classify transcript-compaction timeouts and selected transport failures as recoverable runtime interruptions instead of development revisions. Preserve accepted checkpoints, rotate the worker session, and return the same project task to the queue with bounded recovery attempts.
- Bound long-lived project sessions by rotating the worker session after a configurable number of successful project ticks (`retry.sessionMaxTicks`, default 10).

## 0.8.1 - 2026-08-07

- Make the standard OpenClaw installer and upgrade path install and enable a managed per-queue systemd user scheduler, configure required scheduler heartbeats by default, and use an absolute packaged CLI path so systemd does not depend on an interactive shell `PATH`.
- Make uninstall disable and remove the managed scheduler units, while retaining queue runtime and refusing to overwrite locally modified managed units.

## 0.8.0 - 2026-08-07

- Add project-aware completion semantics: accepted milestones return project tasks to `inbox/` as `project_in_progress` until an explicit project terminal contract is accepted.
- Replace filename/tail-based checkpoint judgement with milestone lineage, revision ancestry, sequence, and recency so resolved historical blockers and `cp10` ordering cannot corrupt the final judgement.
- Separate current blockers from `deferred_gates`, and preserve future authorization boundaries without blocking safe local backlog work.
- Add a durable human-input lifecycle with a distinct `waiting/` queue state. Inputs received while queued, active, failed, or canceled are delivered on the next safe tick, consumed once, and closed by a successor checkpoint.
- Keep one-time secrets out of task bodies and ordinary JSON artifacts. Store them in permission-restricted temporary files, pass only references and hashes, and destroy plaintext after dispatch.
- Recover orphaned `active/` tasks immediately after a new runner acquires the queue lock. The task is atomically returned to `inbox/`, recovery metadata is retained, and the same tick resumes from durable checkpoints instead of leaving a zombie active task until the stale timeout.
- Add required scheduler heartbeat health checks. A queue with `scheduler.required=true` and queued work now fails `doctor` with `scheduler_missing` when no fresh external scheduler tick has been observed.
- Add regression coverage for project continuation, checkpoint lineage and ordering, human-input state transitions and redaction, orphan recovery, and scheduler heartbeat fail-closed behavior.

## 0.7.2 - 2026-08-06

- Keep `ready_for_human_review` tasks out of `done/` until an explicit human decision is recorded; emit a scoped acceptance notification, fail closed when delivery routing is missing, and transition approved tasks to `completed` only after approval.
- Forward configured human-gate policy into generated task contracts so queue state and final judgement agree.
- Add regression coverage for the complete `ready_for_human_review → approve → completed` lifecycle.

## 0.7.1 - 2026-08-05

- Make the standalone ClawHub skill self-sufficient by documenting the official npm package, GitHub repository, Node.js requirement, license, and installation commands.
- Distinguish installing the skill, installing the CLI, and integrating the CLI with OpenClaw.
- Add plan, confirmed install, doctor, and disposable smoke commands for a verifiable OpenClaw deployment.
- Require checking an exact workspace source path before using the source-only CLI fallback.

## 0.7.0 - 2026-08-05

- Rename the project, npm package, GitHub repository, and bundled skill to Taskforce Loop Engineering.
- Keep the `loop-engineering` and `agent-loop` CLI commands for backward compatibility.
- Add the explicit conversation contract for immediate execution, queue-only overrides, active-task amendments, and safe supersede lineage.
- Require project-level terminal contracts, complete backlogs, acceptance evidence, and precise milestone-versus-project completion reporting.
- License the project under Apache License 2.0.

## 0.6.0 - 2026-08-02

- Add structured `json-value` checks with RFC 6901 pointers and expected/actual drift evidence.
- Add read-only `repair-plan` output for failed loop checks; no automatic apply mode exists.
- Add the standard OpenClaw integration lifecycle: plan-only install, confirmed install, read-only doctor, disposable end-to-end smoke, hash-audited upgrade, and safe uninstall.
- Make the generated conversation wrapper supersede an active loop when a new explicit `走 loop` correction arrives: record replacement lineage, stop the old dispatcher process group or next safe checkpoint, and start the replacement after lock release. Explicit queue-only wording still suppresses execution.
- Add active-task amendments: `继续当前 loop，补充要求：…` keeps the same worker session, writes versioned amendment artifacts, updates task/dev/acceptance plans, and makes checkpoints acknowledge the applied amendment version.
- Add source-bound live progress delivery for conversation loops: ordered phase milestones, five-minute worker heartbeats, live checkpoint watching, and idempotent per-task progress ledgers.
- Add `run-queue-drain` with `--max-tasks` to process a queue serially until empty without allowing overlapping workers in the same queue.
- Run each loop task in a configured worker agent's isolated `loop-task-<task-id>` session and mark prompts as already loop-managed to prevent recursive routing.
- Preserve source channel, target, account, and reply metadata for idempotent asynchronous human-gate and terminal notifications.
- Preserve formal queue runtime and evidence during uninstall, and refuse upgrade/removal when installer-managed content has drifted.
- Include configuration drift and OpenClaw integration tests in the default package check.
- Validate the worker during install planning; auto-select existing `main` or a sole available agent, and fail clearly instead of creating or referencing a missing agent.

## 0.5.0

- Add conversation routing, resumable human-input gates, source-bound notifications, and goal-directed strategy transitions.
