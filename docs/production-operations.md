# Production Trust Operations

Run `npm run check:production-trust` before release review. The safe demo is
`node examples/safe-canary.mjs`; it uses an in-memory I/O boundary, contains no
credential, makes no paid call, and performs no external write. The soak command
writes a local audit report when passed `--output <file>`.

Back up both `events.jsonl` and `snapshot.json` before migration or upgrade.
Restore into a new directory, replay it, compare event count/checksum and only
then switch the configured path. Never truncate a checksum error; a malformed
final partial line may be ignored as a torn write, while corruption elsewhere
fails closed. Reconcile every `unknown` external outcome against the upstream
provider before permitting a retry.

Upgrade plans are read-only. A customized dispatcher/config receives
`preserve_customized`, which is not apply-ready. Review a byte-exact backup and
merge plan; do not use force overwrite. Publishing, real canary traffic,
production deployment, credentials, process control and paid services require
separate operator authorization.

Support boundaries are listed in `production-trust-contract.md`. In particular,
the custom adapter is an example/contract surface, not an operated runtime, and
the local journal is not a distributed consensus database.

When detached verification finishes after a task was judged, first write a
successor checkpoint that revises the blocked checkpoint, then run
`loop-engineering queue-acceptance-refresh --queue <queue> --task-id <task>`.
The refresh runs only when a checkpoint is newer than the final judgement;
repeated calls return `already_current` and do not re-run acceptance.
