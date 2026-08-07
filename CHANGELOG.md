# Changelog

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
