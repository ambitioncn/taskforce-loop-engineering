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
a private read-only snapshot with file permission bits preserved. Input identity
includes file content, size, and permission bits, so mode-only changes invalidate
the stability checks and change the digest; symlinks, missing paths, and special files fail
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
same input digest. Failed file accesses are checked against the recorded working
directory or directory descriptor, including nested paths and resumed calls.
Swallowing a missing undeclared input error does not make verification pass.
Missing, malformed, stale, or red receipts fail verification.
The queue run records the evidence directory, digest and, for a failed run, a
short `reason` (supervisor error, read-audit violation, timeout or failed
receipt check) in its verification artifact.

The sandbox drops every capability (`--cap-drop ALL`). When the supervisor runs
as root, it starts the traced sandbox as the unprivileged `nobody` identity, with
the snapshot, output and trace staged in a private `/tmp/loop-isolated-*`
directory and moved into the evidence directory afterwards, so the command can
neither remount the read-only system binds nor read root-only host files such
as `/etc/shadow`. The supervisor's `--timeout` covers freezing as well as the
command, and a SIGTERM to the supervisor tears down the traced sandbox, which
runs in its own session. `code-task-run` repeats isolated verification after applying a
reviewed patch; its evidence lives beside the project root in
`.loop-isolation-evidence/<task-id>/`.

This is a verification backend, not an automatic project dependency inventory
or a substitute for independent acceptance review. Each project must declare
its inputs and prove its dynamic dependencies with a real command and negative
control before making isolation mandatory for that queue.

### File trace compatibility

The host strace must support `--decode-pids=pidns`; unavailable support fails
closed. The supervisor traces process creation, chdir and fchdir as well as file
syscalls, to resolve relative access/exec probes across child processes and PID
namespaces. C byte escapes (including octal UTF-8 filenames) are decoded;
truncated or unresolved failed paths are rejected. Genuinely absent optional
files are allowed; existing undeclared source paths remain rejected even when
the verification command swallows the error. Snapshot ancestor directories are
readable because they contain only the frozen declared descendants.

Failed project-path probes retain their original components for source availability checks: a missing or non-directory ancestor before `..` is not collapsed into an available input. Reachable parent-relative undeclared inputs still fail verification.


Failed project-path attempts are walked component by component in the sandbox
namespace before mapping `/work` to the source. Re-entering `/work` through `..`
and repeated leading slashes cannot bypass undeclared-input auditing. Missing,
non-directory, and trailing-slash components retain kernel traversal semantics.
The supervisor models its explicit mount roots and runtime-file ancestors;
unresolved traversal through dynamic external mounts or symlink ancestors fails
closed. This is bounded trace auditing, not unrestricted syscall emulation.

Symlinks the command creates (in `/tmp` or `/out`, which start empty) are
recorded from the trace, followed through renames, and resolved before a failed
access is audited, so probing an undeclared input through such a link is still
rejected. Process exits and child waits that never return during PID-namespace
teardown are not treated as unfinished file syscalls.

Failed `/proc/self/cwd`, `/proc/thread-self/cwd` and self `root` probes are
resolved using the traced process cwd or the sandbox root before source-input
auditing. Raw suffix components are retained. Unresolved process/fd aliases
(including `/dev/fd` and another thread's `/proc/.../task/<tid>/` view) fail closed; optional accesses via unknown dynamic aliases
may therefore be rejected. This does not claim general procfs emulation.

## Running the self-tests

`npm test` starts with the live sandbox tests and needs Linux with bubblewrap,
strace and Python 3 (`apt-get install bubblewrap strace python3`). Without them
the test names the missing tools and fails; set `LOOP_SKIP_ISOLATION_TESTS=1`
to skip only those live tests on a machine that cannot run the sandbox.
