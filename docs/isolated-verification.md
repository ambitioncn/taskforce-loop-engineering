# Isolated verification for code queues

Linux code queues can opt into fail-closed verification by adding
`worktree.isolatedVerification` beside `worktree.verifyCommands`:

```json
{
  "worktree": {
    "enabled": true,
    "verifyCommands": ["python3 -m unittest discover -s tests"],
    "isolatedVerification": {
      "inputs": ["src", "tests", "pyproject.toml"],
      "runtimeFiles": []
    }
  }
}
```

`inputs` are exact project files or recursive directories. They are frozen into
a private read-only snapshot; symlinks, missing paths, and special files fail
closed. Do not list generated output directories. Commands run from `/work`,
with `/out` as their only persistent writable output. The environment has no
inherited proxy, `NODE_OPTIONS`, home directory, or network access. The host
must have `python3`, `bwrap`, and `strace`; no nonisolated fallback exists.

`runtimeFiles` is an optional list of exact regular files under `/home` or `/opt` (for
example, a user-local Node binary). Each is mounted read-only at its original
path and hashed before and after execution. System files under `/usr`, `/bin`,
`/lib`, `/lib64`, and `/etc` are mounted read-only by the backend. Directory
toolchains, browser profiles, Docker, Git replay, and networked gates are not
supported by this generic backend. Use a separately reviewed project-specific
gate for those, and do not mark its result as this backend's receipt.

Each command gets a fresh, unguessable evidence directory containing the input
snapshot, host-owned trace, output, logs, and `terminal.json`. Loop accepts a
verification only when its process exits zero **and** the receipt proves a
zero-exit command, declared reads, unchanged source/snapshot/tool files, and
process-group cleanup. All commands in one verification group must share the
same input digest. Missing, malformed, stale, or red receipts fail verification.
The queue run records the evidence directory and digest in its verification
artifact. `code-task-run` repeats isolated verification after applying a
reviewed patch; its evidence lives beside the project root in
`.loop-isolation-evidence/<task-id>/`.

This is a verification backend, not an automatic project dependency inventory
or a substitute for independent acceptance review. Each project must declare
its inputs and prove its dynamic dependencies with a real command and negative
control before making isolation mandatory for that queue.
