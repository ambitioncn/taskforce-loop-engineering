# Transactional kernel and Goal API

The public API is `Goal.init`, `Goal.run`, `Goal.status`, `Goal.review`, and `Goal.doctor` from `lib/goal-api.mjs`. The matching primary CLI is:

```sh
loop-engineering init --id demo --goal "Ship the complete verified result"
loop-engineering run --id demo
loop-engineering status --id demo
loop-engineering review --id demo --decision revise --reason "change strategy"
loop-engineering doctor --id demo
```

## Transaction model

Every mutation enters `TransactionalStateKernel.transact` with typed effects. Writers hold an exclusive lease, receive a monotonically increasing fencing token, and may provide `expectedGeneration` for compare-and-swap. Each new effect produces a receipt containing its digest and the previous receipt hash. State records the receipt head and exact effect keys, so replay applies the same logical effect zero or one times. Fencing tokens are persisted when a lease is issued, so no two leases share a token and a released lease cannot commit.

`replayEffect(effect, execute)` holds the writer lease from the applied-effect check through the commit, so concurrent callers wait and then receive the existing receipt. Before `execute` runs, an intent is stored in `pending_effects`; if the process dies before the commit, a later `replayEffect` returns `reconcileRequired: true` instead of executing again. Settle it with `reconcileEffect(effect, { executed: true, outcome })` once the upstream result is known, or `{ executed: false }` to allow a retry.

Completion is fenced. Its validator must accept the complete terminal contract; a successful milestone alone cannot set `completed`. Human gates, revisions, action reservations, evidence, and completion are effect types rather than replacement state machines, so existing queue and reservation artifacts remain compatible.

External adapters must use the effect key as their upstream idempotency key. For uncertain provider outcomes, reconcile that key before retrying; do not invent a new effect key.

## Compatibility and migration

All pre-0.16 advanced commands remain available. Existing `run --config`, `status --config`, queue, project, action-reservation, revision, human-gate, dashboard, and code-worktree commands retain their behavior.

The five-command surface is additive. Keep existing automation unchanged, create new goals through `init --id --goal`, use `run/status/review/doctor --id` ordinarily, and retain advanced commands for administration and diagnostics. No automatic migration rewrites legacy state. Adapters may project terminal contracts, revision lineage, human gates, and action reservations as typed effects while keeping authoritative legacy artifacts intact.
