# Migrating to Taskforce Loop Engineering 0.7.0

## Package rename

The npm package moved from `agent-loop-engineering` to
`taskforce-loop-engineering`. Existing CLI command names remain available, so
workspace scripts do not need to change.

## Package upgrade

Upgrade the CLI normally, then run the package checks before changing an existing OpenClaw integration:

```bash
npm install -g taskforce-loop-engineering@0.7.0
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
