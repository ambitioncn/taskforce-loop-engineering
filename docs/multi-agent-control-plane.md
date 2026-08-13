# Multi-Agent Control Plane (P2)

P2 stores typed todos, registered agents, leases, handoffs, and ownership history in `runtime/loops/control-plane/state.json`. Every mutation is serialized by an atomic filesystem mutex and committed with rename. `audit.jsonl` records each ownership transition.

## Todo contract

Every todo has a stable id, dependencies, deterministic priority, risk and authority class, required capabilities, an acceptance contract, evidence requirements, a quota/cost envelope, lineage/context, authorization, idempotency keys, and an explicit state. See `templates/todo.schema.json`.

Eligibility is deterministic: descending priority, then creation time, then id. A todo is claimable only when dependencies are complete, the agent has every capability and the authority grant, quota is sufficient, the P0 human gate is runnable, and every P1 action outcome is safe. An unknown or stale in-flight action requires reconciliation before reassignment.

Claims carry a monotonically increasing fencing token. Renew/release require the active owner, current token, and live lease. Expired claims are recovered as runnable only when no parked gate or unresolved action can cause duplicate effects.

Handoff packets durably preserve lineage, context, evidence, authorization, idempotency keys, and the source fencing token. The target rechecks eligibility on acceptance and receives a new fencing token. Rejection restores the source claim while its lease is live.

## CLI

```text
agent-register --agent-json agent.json
todo-create --todo-json todo.json
todo-list [--state runnable]
todo-inspect --todo-id ID
todo-claim --agent-id AGENT [--todo-id ID] [--lease-ms N]
todo-renew --todo-id ID --agent-id AGENT --fencing-token N [--lease-ms N]
todo-release --todo-id ID --agent-id AGENT --fencing-token N [--completed] [--evidence TEXT]
todo-handoff --todo-id ID --agent-id AGENT --target-agent-id AGENT --fencing-token N [--handoff-id ID]
todo-accept|todo-reject --handoff-id ID --agent-id AGENT
todo-recover [--now EPOCH_MS]
todo-import-legacy
```

`--todo-json` and `--agent-json` accept either an inline JSON object or a file path. All commands accept `--root` and emit JSON.
