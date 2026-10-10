# Migrating to Taskforce Loop Engineering 0.16.0

0.16.0 is a correctness and security release. No artifact rewrite is needed:
queue, project, reservation, journal and kernel files written by 0.15.x are read
in place. A few behaviours change on purpose.

## Upgrade steps

```bash
npm install -g taskforce-loop-engineering@0.16.0
# OpenClaw workspaces
loop-engineering-openclaw-manage --root /path/to/workspace --action upgrade-plan
loop-engineering-openclaw-manage --root /path/to/workspace --action upgrade --confirm-upgrade
# Hermes workspaces
loop-engineering-hermes-install --root /path/to/workspace --confirm-install --force
```

Upgrading regenerates the scheduler unit with a literal `WorkingDirectory=`, so
workspaces whose path contains spaces or non-ASCII characters start correctly.
An upgrade keeps the recorded `--dashboard-listen` mode. If the per-user
dashboard already serves another workspace, the installer now leaves it alone
and reports `dashboardAutostart.skipped`.

## Dashboard Human Gate decisions need an operator token

`POST /api/v1/gate-commands` previously accepted any caller and trusted the
`actor_id` in the request. It now requires a registered operator:

```bash
loop-engineering dashboard-operator-add --actor-id alice --root /path/to/workspace
```

Enter the printed token in the dashboard's "Operator token" field (it is shown
once; only its SHA-256 digest is stored in `configs/loops/dashboard-operators.json`).
The gate's `allowed_actors` must contain that actor id. Remove access with
`dashboard-operator-remove`. Until an operator exists, the dashboard is
browse-only. Loopback dashboards also reject requests whose `Host` is not
`127.0.0.1`, `localhost` or `[::1]`; add other names with `--allowed-host`.

## Chat replies name the gate generation

Card-bound replies must now be `/approve gate_<id>@<generation>`,
`/reject gate_<id>@<generation>` or
`/request_revision gate_<id>@<generation> <reason>`. Cards include the exact
`reply_command` for each button. A reply without a generation returns
`generation_required` instead of being applied to whatever generation is
current.

## Code worktree cleanup needs a complete export

`code-worktree-export` now writes the full patch including untracked files and
records `complete` and `contentSha256` in its manifest. Cleanup of a dirty
worktree refuses exports from earlier versions
(`dirty_export_incomplete_reexport_required`) and worktrees changed after the
export (`dirty_worktree_changed_since_export`). Re-export with `--force`, then
clean up.

## Stricter CLI values

A flag followed by nothing or by another flag (`--title --task x`) and
non-integer numeric values (`--timeout-ms 10m`, `--limit abc`) are now errors.
Scripts that relied on the old lenient parsing must pass explicit values.

## Evidence and redaction

`sealEvidence` recomputes `passed` from thresholds, scenarios and compatibility,
so a report whose metrics fail cannot be sealed as passed. The default seal is a
plain SHA-256 digest that detects corruption only; set `LOOP_EVIDENCE_HMAC_KEY`
(or pass `{ key }`) for an HMAC seal, and supply the same key when verifying.
Redaction now also covers camelCase credentials such as `accessToken` and
`Authorization`, while `fencing_token` and token counters stay visible.

## Queue runtime

The runner renews its lease, so `leaseMs` no longer needs headroom for the
longest possible run. Orphaned active tasks are recovered at most
`retry.orphanRecoveryMaxAttempts` times (default 3) and then moved to `failed/`
as `orphan_recovery_exhausted`. Unreadable task files are moved to
`runtime/loops/<queue>/quarantine/` for inspection instead of blocking the queue.

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
