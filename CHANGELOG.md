# Changelog

## Unreleased

## 0.16.0 - 2026-10-10

### Upgrade notes

This release changes several behaviours on purpose; see `MIGRATING.md`.

- Dashboard Human Gate buttons need an operator token: run `loop-engineering dashboard-operator-add --actor-id <id>` and enter the printed token in the dashboard. Without a registered operator the dashboard is browse-only.
- Chat replies to a gate card must include the generation, e.g. `/approve gate_x@2`; cards show the exact `reply_command`.
- Patch exports made by earlier versions must be re-exported before `code-worktree-cleanup` removes a dirty worktree.
- CLI flags reject missing values and non-integer numbers (`--timeout-ms 10m` is now an error, not 10 ms).
- Evidence `passed` is recomputed from thresholds, scenarios and compatibility; set `LOOP_EVIDENCE_HMAC_KEY` for a tamper-resistant seal.
- Re-run `loop-engineering-openclaw-manage --action upgrade --confirm-upgrade` (Hermes: rerun the installer with `--confirm-install --force`) so generated workspace files and units pick up the installer fixes.

### Security and data loss

- Dashboard Human Gate commands now require an operator token (`dashboard-operator-add` / `dashboard-operator-remove`); the acting identity comes from the token instead of the request body, requests must be `application/json`, and loopback dashboards reject foreign `Host` headers (DNS rebinding). Gate evidence served by `/api/v1/gates` is redacted, and redaction now recognises camelCase keys such as `accessToken` and `Authorization` while keeping `fencing_token` visible. Without a registered operator, dashboard gate commands are disabled.
- Reject task ids that are not plain identifiers in every `--task-id` lookup, so `queue-cancel`, `queue-requeue` and review decisions cannot move or delete files outside the queue.
- `code-worktree-export` writes the complete patch, including untracked files as new-file diffs, instead of the last 60,000 characters; cleanup force-removes a dirty worktree only when its export manifest is complete and the worktree still matches it. Older exports must be re-exported before cleanup.
- Keep Human Gates for tasks outside any project waiting instead of cancelling them as `project_not_found` on the next status or run.

### Exactly-once execution and crash safety

- Stop classifying successful (exit 0) dispatches as recoverable runtime interruptions when the answer merely mentions free-text failure vocabulary such as "rate limit" or "connection reset"; only structured runtime trailers may override a zero exit, so completed work is no longer replayed.
- Exactly-once queue execution: the runner renews its queue lease while a task runs, stale-lock reclaim is serialized so two runners cannot both take the lock, and a stale active copy of a task that already finished is quarantined instead of re-executed. Orphan recovery stops after `retry.orphanRecoveryMaxAttempts` (default 3) and moves the task to `failed/` as `orphan_recovery_exhausted`.
- Canceling, parking or requeueing an active task now stops its dispatcher, and the runner no longer writes a second copy of a task an operator moved; a requeued or resumed task ignores supersede markers written before it was restarted. Amending a task that has just finished no longer recreates it in `active/`.
- Queue files are written atomically; an unreadable lock is reclaimed after a grace period and unreadable queued or active task files are moved to `quarantine/` instead of blocking the queue. Concurrent enqueues with the same title get distinct ids instead of overwriting each other.
- Action reservations, the todo control plane, the execution ledger and the durable journal share a token-owned file mutex (`lib/file-mutex.mjs`): stale locks are reclaimed under a second guard and only the owner releases a lock, so concurrent waiters can no longer both enter and grant one idempotency key to two requests. A settle or release reported after the claim's lease expired now becomes an `unknown` outcome for reconciliation, keeping the worker's evidence.
- `TransactionalStateKernel` persists issued fencing tokens and rejects released or superseded leases; `replayEffect` holds the lease across execute and commit and records an intent first, so an effect runs at most once even across crashes (`reconcileEffect` settles an interrupted one).
- `DurableJournal` serializes appends and discards a torn final line before appending, so a crash mid-write or concurrent appends no longer corrupt the chain permanently.
- Spawn failures (missing working directory, NUL bytes) become failed commands instead of crashing the runner, and the completion notification strips NUL bytes and records its result.
- Decode command output as UTF-8 across chunk boundaries so multi-byte text in patches and logs is not corrupted.
- Requeued worktree tasks continue in their existing branch and worktree instead of failing with "branch already exists", so runtime recovery and project continuation work in code queues.
- A handoff packet expires when its todo is recovered, so a stale accept can no longer reclaim a recovered or completed todo; the quota ledger serializes spend so concurrent slices are not lost.

### Project relay

- Let relay status reconciliation follow a relay task's revision lineage, so an item accepted after a revision round is completed instead of stalling the relay; independent duplicate lineages and lineages without exactly one accepted round still fail closed.
- Run scheduler relay maintenance only while holding the queue lock with no active task, and abandon a reconciliation write when the backlog changed after it was read, so concurrent agent edits are never overwritten.
- Retry a relay that was skipped because the queue was busy on a later idle scheduler tick, under the same fail-closed checks, only when the most recently enqueued backlog-bound task is completed and accepted, so a failed or canceled relay task still stops the chain; report it as `projectRelay` with `relayMaintenance` status.
- Skip the scheduler's relay scan when a cheap fingerprint of queue state and project relay files is unchanged, with an hourly full pass for in-place edits, and read each task file once per pass; an unreadable task file reports `relayMaintenance: "error"` instead of failing the tick.
- Treat duplicate or malformed backlog rows as unusable for relay predecessors, dependencies, and candidates instead of letting the last duplicate win.

### Installers

- systemd units now write `WorkingDirectory=` as the literal path (systemd does not decode escapes there), so scheduler and dashboard services start for workspaces whose path contains spaces or non-ASCII characters; the dashboard installer escapes `ExecStart=` by UTF-8 byte like the others. Installers, manage and smoke scripts resolve their own files with `fileURLToPath`, so a package installed under a path with spaces works.
- the OpenClaw and Hermes manifests are written before the scheduler is enabled, so a failed install is still uninstallable; reinstalling replaces an unchanged managed `AGENTS.md` block (a hand-edited one only with `--force`) and keeps the manifest consistent, so language or queue changes no longer block uninstall. OpenClaw uninstall stops and removes the dashboard service and gateway drop-ins it installed, upgrade keeps the recorded dashboard listen mode, and installers no longer repoint a dashboard that serves another workspace (`dashboard-autostart-install --force` overrides).

### Other fixes

- Project inference matches project names as whole tokens ("ui" no longer matches "build"), `json-value` checks compare JSON independent of key order, and applying the same revision plan (or `queue-revision-next`) twice no longer enqueues a duplicate revision without `--force`.
- Redaction is shared (`lib/redaction.mjs`) by evidence, execution ledger and dashboard: camelCase credentials are redacted, `fencing_token` and token counters stay visible. Evidence sealing recomputes `passed` from thresholds, scenarios and compatibility, and supports an HMAC seal via `LOOP_EVIDENCE_HMAC_KEY`; the unkeyed SHA-256 seal is documented as corruption detection only.
- Card-bound chat replies must name the generation they answer (`/approve gate_x@2`); each card button lists its `reply_command`, and a reply without one returns `generation_required` instead of always failing as stale.
- CLI flags now reject a missing value, a value that is the next flag, and non-integer numbers (`--timeout-ms 10m`). `run-loop-cron.sh` logs and alerts on an unreadable config and accepts an alert command with arguments. Patch headers with git-quoted non-ASCII paths are parsed, so the dirty-target check covers them. Removed the nonexistent `main` entry from `package.json`; CI runs adapter, production-trust and pack checks instead of repeating the competitive check.

## 0.15.21 - 2026-09-30

- Add opt-in reconciliation of mutable project relay backlog statuses against unique accepted done-task evidence, while preserving fail-closed project, backlog, and task-binding checks.
- Defer internal relay tasks and accept their bound project-relay markers in the OpenClaw route installer.

## 0.15.20 - 2026-09-29

- Add opt-in, source-preserving project backlog relay after accepted scoped tasks; fail closed on external or gated items, missing terminal authority, busy queues, and duplicates.
- Require a completed backlog-item binding and explicit in-progress terminal record for relay; reject missing or malformed authoritative backlogs instead of falling back to stale initial data.

## 0.15.19 - 2026-09-19

- Recover OpenClaw dispatcher launches rejected during Gateway restart drain by rotating the runtime session and requeueing the task.
- Match only explicit restart-admission signatures on non-zero exits, leaving unrelated HTTP 503 responses and successful diagnostic text untouched.

## 0.15.18 - 2026-09-18

- Recover non-zero dispatcher runs that report OpenClaw's missing user-visible-answer prompt by rotating the runtime session and requeueing the task.
- Preserve structured `incomplete_turn` and abandoned-liveness recovery even when a dispatcher wrapper exits successfully.
- Prevent successful recovered turns or ordinary task text that quotes the prompt from being misclassified and replayed.
- Add regression coverage for both recoverable failure and successful-output false-positive cases.

## 0.15.17 - 2026-09-13

- Stop OpenClaw doctor and disposable smoke probes from attaching the synthetic `doctor` account to dry-run notifications.
- Preserve normal account forwarding for real source-bound notifications while remaining compatible with OpenClaw installations that reject unknown account ids during dry-run validation.
- Add strict installer regression coverage that rejects any synthetic `--account doctor` delivery.

## 0.15.16 - 2026-09-13

- Resolve canonical project identifiers from nested checkpoint completion metadata so migrated project tasks continue against the correct authoritative backlog.
- Keep future external-action authorization gates deferred while safe local project work remains actionable.
- Add regression coverage for checkpoint-only project metadata and premature deferred-gate reconciliation.

## 0.15.15 - 2026-08-31

- Lock a task-level accepted terminal checkpoint monotonically so later broader-project governance cannot reopen or overwrite the completed task.
- Require fully materialized, source/actor/generation-bound Human Gate artifacts before moving tasks to waiting or sending actionable notifications.
- Fail closed for incomplete or non-authoritative Gate artifacts, and keep dry-run previews free of actionable reply commands.
- Add regressions for broader-project scope creep after task acceptance, empty/unbound gates, authoritative waiting placement, and notification consistency.

## 0.15.14 - 2026-08-30

- Add one authoritative cross-interface Human Gate command core for Dashboard and trusted chat adapters, with strict source binding, generation fencing, idempotency receipts, confirmation escalation, and fail-closed handling of ordinary chat.
- Upgrade quota checks into a runtime decision engine covering token, time, cost, and turn budgets, verified-only spend, idle-free accounting, scheduler hints, and audited safe fallback work.
- Productize the durable multi-agent control plane with agent registration, explainable matching, targeted wakeups, peer collaboration, fenced handoffs, conflict/orphan governance, and cross-runtime conformance evidence.
- Extend the operator workspace, OpenClaw installer, doctor, smoke, and bundled skill to expose and verify the new gate, quota, team, and project-control capabilities.

## 0.15.13 - 2026-08-28

- Add the project-first read-only operator workspace with terminal contracts, milestone/project status separation, revision lineage, human gates, external-action reservations, and acceptance/final-judge timelines.
- Couple the Dashboard service to OpenClaw and Hermes gateway startup and verify the wiring in platform doctors and installer self-tests.
- Support fail-closed `localhost` and Tailnet-only Dashboard listening modes without binding all network interfaces.

## 0.15.12 - 2026-08-28

- Fix public CI setup on repositories that intentionally do not commit an npm lockfile.

## 0.15.11 - 2026-08-28

- Add a transactional state kernel with typed effects, receipt chaining, CAS/fencing, exact-effect replay, crash recovery, and completion fencing.
- Add the public Goal API and five-command primary CLI while preserving advanced commands.
- Add public CI and seven competitive acceptance fixtures.

## 0.15.10 - 2026-08-28

- Materialize human-input gates only for permissions or external conditions that are explicitly missing and needed now; preserve authorized, consumed, future, and conditional boundaries as audit context instead of repeatedly blocking project progress.
- Honor project standing authorization for in-scope production backup, deploy, restart, readiness, restore, and rollback work while keeping publication, credential, destructive, and other excluded actions gated.
- Resolve checkpoint-bound subproject backlogs when deciding whether safe project work remains, with regression coverage for current blockers, dormant gates, and publication boundaries.

## 0.15.9 - 2026-08-25

- Clarify that the disposable OpenClaw smoke may write required checkpoint and verification artifacts only inside its temporary Loop runtime queue while user/project files, configuration, credentials, and external state remain read-only.
- Add regression coverage that rejects contradictory smoke permission wording or a missing checkpoint requirement.

## 0.15.8 - 2026-08-25

- Preserve every non-blocking risk from the effective terminal checkpoint in `final_judgement.residual_risks`, including accepted project completions without a continuation action.
- Deduplicate repeated terminal risks while retaining the accepted completion outcome.
- Add regression coverage proving accepted terminal checkpoints keep their operational risks visible.

## 0.15.7 - 2026-08-24

- Prevent accepted phase checkpoints from producing `ready_to_apply` when they explicitly mark project completion as `in_progress`, including both string and object completion forms.
- Preserve unresolved checkpoint risks in the final judgement and treat a concrete continuation action as project work that must continue instead of terminal completion.
- Use an accepted terminal contract as the authoritative project-completion source when no separate acceptance ledger is configured.
- Reconcile stale optional post-completion authorization gates into `done` rather than `canceled`, while retaining fail-closed behavior for real blockers.
- Add regression coverage for premature terminal judgement, terminal-contract status projection, and historical stale-gate reconciliation.

## 0.15.6 - 2026-08-24

- Allow project configurations to use an external authoritative `backlogSource` without duplicating an embedded backlog registry.
- Keep project status fail-closed when neither an embedded backlog nor an external backlog source is configured.
- Suppress false registry-drift findings when no embedded projection is intentionally present, while retaining drift detection when both representations exist.
- Add regression coverage for external-only authoritative project backlogs.

## 0.15.5 - 2026-08-24

- Treat embedded-runtime `incomplete_turn` / abandoned-liveness trailers as recoverable interruptions even when the dispatcher wrapper exits zero, preventing partial work from being accepted or stale human gates from being replayed.
- Keep future paid, deployment, and publication authorization boundaries deferred while an unrelated safe project backlog item remains actionable.
- Reconcile an already-materialized premature deferred gate by superseding it and restoring the project carrier to the runnable queue.
- Resolve the authoritative project from checkpoint milestones when a task still carries a broader parent project id.

## 0.15.4 - 2026-08-22

- Preserve source conversation and project metadata across revision planning, direct revision enqueue, and saved-plan application.
- Refuse to create an unroutable revision when a routed source task has lost its required channel or target.
- Materialize a human-input gate for the newest authoritative project carrier when it finishes blocked, while continuing to suppress historical failed-task replay.
- Add regression coverage for routed revision inheritance and blocked project gate delivery.

## 0.15.3 - 2026-08-22

- Remove workspace-specific Ironman queue and dispatcher instructions from the distributed skill.
- Resolve the installed queue and managed wrapper from each OpenClaw workspace, while keeping existing queue data untouched.
- Add a distribution self-test that rejects host-specific dispatcher leakage in future packages.

## 0.15.2 - 2026-08-21

- Enrich terminal notifications with final judgement, checkpoint summary, verification count, blockers, and next action.
- Link successful terminal notification ledgers back into queue run artifacts while preserving idempotent delivery.
- Materialize only actionable deferred human gates, preserve project standing authorizations in task contracts, and allocate append-only checkpoint identifiers when replanning.

## 0.15.1 - 2026-08-20

- Keep generated OpenClaw and Hermes scheduler services healthy when asynchronous human or terminal notification delivery fails, while preserving notification logging and retries.

## 0.15.0 - 2026-08-20

- Reconcile project-scoped human gates against the authoritative project contract and acceptance ledger, superseding stale or optional deferred gates without replay.
- Strengthen doctor and project status checks for structured gate context, acceptance-ledger drift, execution-ledger reconciliation, and project completion.
- Make active-task supersession project-aware across active and waiting tasks, and add end-to-end regression coverage for durable gate materialization.

## 0.14.0 - 2026-08-14

- Add the platform-neutral runtime adapter SDK v1 with OpenClaw, Hermes, Codex CLI, and Claude Code factories, shared conformance tests, fail-closed effects, redacted telemetry, migration guidance, and a credential-free demo.

## 0.13.0 - 2026-08-14

- Add versioned OpenClaw, Hermes, and custom runtime adapter contracts with a shared conformance suite.
- Add a checksummed, fsync-backed durable journal with replay, snapshots, migration, backup/restore, and fail-closed unknown-outcome handling.
- Add deterministic multi-worker canary and isolated live-runtime soak tooling, a credential-free demo, and a non-destructive customized-Ironman upgrade planner.
- Add unified production-trust acceptance and an idempotent acceptance refresh command so detached long-running evidence invalidates stale final judgements.

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
