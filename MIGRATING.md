# Migrating to Taskforce Loop Engineering 0.12.0

## Goal API and primary CLI

The five-command Goal interface is additive. Existing advanced commands and artifact formats are not removed or automatically rewritten. New integrations should prefer `init/run/status/review/doctor --id`; existing integrations may migrate incrementally. See `docs/transactional-kernel-and-goal-api.md`.

## Operator projection

No runtime artifact migration is required. P3 reads P0/P1/P2 and legacy queue/project artifacts in place and emits projection schema `1.0.0`; existing writers remain authoritative. Consumers should use `schema_version`, tolerate additive fields, and treat degraded health as a refresh/investigation signal. `dashboard-serve` is loopback-only unless `--allow-non-loopback` is explicit.

## Action reservation artifacts

Existing queue, notification, and Human-Gate Lifecycle v2 artifacts remain
valid. New side-effecting integrations should migrate their prior idempotency
records through `migrateLegacyActionArtifact()` from
`lib/action-reservations.mjs`. Import is idempotent: the legacy key, canonical
request, action kind, and authorization scope become an immutable version 1
reservation; importing the same artifact again is a no-op, while conflicting
content fails closed. There is no eager workspace rewrite.

The version 1 record schema includes `idempotency_key`, `kind`, `state`,
`request_fingerprint`, immutable `request`, `fencing_counter`, `claim`,
`authorization`, `settlement`, `release`, `reconciliation`, and `events`.
Legacy send ledgers continue to suppress duplicates; adapters should adopt this
contract before their next side-effecting execution boundary.

## Package rename

The npm package moved from `agent-loop-engineering` to
`taskforce-loop-engineering`. Existing CLI command names remain available, so
workspace scripts do not need to change.

## Package upgrade

Upgrade the CLI normally, then run the package checks before changing an existing OpenClaw integration:

```bash
npm install -g taskforce-loop-engineering@0.12.0
loop-engineering-openclaw-manage --root /path/to/workspace --action upgrade-plan
```

If the plan reports `ready`, apply it explicitly:

```bash
loop-engineering-openclaw-manage \
  --root /path/to/workspace \
  --action upgrade \
  --confirm-upgrade
```

The manager refuses to overwrite installer-managed files or the managed `AGENTS.md` block when their hashes differ. Review and reconcile those changes manually before retrying.

## Existing 0.5 workspaces

Version 0.5 did not install a standard OpenClaw integration manifest. For an existing hand-built integration, first run the installer without confirmation and review its plan:

```bash
loop-engineering-openclaw-install \
  --root /path/to/workspace \
  --queue agent-tasks \
  --worker-agent main
```

Use `--confirm-install` only after resolving path conflicts. Existing queue runtime is not deleted or migrated automatically.

## Behavior changes

- Installation planning now calls `openclaw agents list --json`. The selected worker must already exist; omitting `--worker-agent` chooses `main` or a sole available agent, otherwise the installer asks for an explicit choice.
- In the generated OpenClaw integration, “走 loop” starts immediately when idle. If another task is active, the new request supersedes it as a correction, preserves the old evidence and replacement lineage, and starts after the old dispatcher stops safely. Use explicit queue-only wording for ordinary deferred work; `run-queue-drain` remains an opt-in batch command.
- “继续当前 loop，补充要求：…” amends the active task in place. Upgrade the generated integration so the worker receives the live amendment path and rereads it before checkpoints and completion.
- Generated wrappers now pass a progress notifier into `run-queue`. The originating conversation receives phase milestones, long-run heartbeats, and new checkpoint summaries; delivery remains scoped to recorded source metadata.
- “只入队”, “只排队”, “暂不执行”, and “不立即执行” keep the task queued without starting a worker.
- Worker agent names are installation settings and are not fixed to Ironman.
- Every task uses an isolated `agent:<worker>:loop-task-<task-id>` session.
- Asynchronous delivery requires recorded source `channel` and `target`; missing routing metadata fails closed.
- A confirmed install or managed upgrade now creates and enables a per-queue systemd user scheduler. Queue configs require its heartbeat, so queued project work cannot silently wait forever. Uninstall disables and removes the managed units while retaining queue runtime.
- `repair-plan` is read-only. Version 0.6 does not add an automatic configuration repair command.

After installation or upgrade, validate the integration:

```bash
loop-engineering-openclaw-doctor --root /path/to/workspace --queue agent-tasks --worker-agent main
loop-engineering-openclaw-smoke --root /path/to/workspace --queue agent-tasks --worker-agent main
```
# Human-Gate Lifecycle v2

Existing tasks with `status: "waiting_for_human"` remain supported and continue
to appear in `waiting/`. New parked tasks add a versioned `parked` object while
using the same directory, so no queue migration is required. Operators can
adopt v2 incrementally:

```bash
loop-engineering queue-park --queue agent-tasks --task-id <id> \
  --wait-kind external_condition --reason "VPS unavailable"
loop-engineering queue-wait-tick --queue agent-tasks --notify-command '<sender>'
loop-engineering queue-wait-resume --queue agent-tasks --task-id <id> \
  --verified --recovery-signal 'probe=vps-1;ssh_banner=verified'
```

Timeout changes visibility and enables throttled escalation; it never rejects
the task, consumes authorization, or retries a privileged action. Resume is
fail-closed without a verified recovery signal. The original task id, wait id,
authorization state, notification evidence, and execution-boundary key remain
durable across restart.
# P2 typed todo migration

Run `loop-engineering todo-import-legacy --root <workspace>` to import existing `runtime/loops/*/{inbox,waiting,active}/*.json` artifacts. Import is additive and idempotent: stable ids use `legacy:<queue>:<task-id>`, source files are not modified, and waiting items retain their parked gate. Imported items receive explicit legacy acceptance/evidence defaults and can then be inspected or enriched before claim.

New integrations should register agents with `agent-register`, create typed todos with `todo-create`, and use the claim fencing token for every renew, release, and handoff operation. Continue reconciling P1 `unknown` action outcomes before recovery or reassignment.
