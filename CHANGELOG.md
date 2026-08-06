# Changelog

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
