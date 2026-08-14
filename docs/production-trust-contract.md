# P1 Production-Trust Evidence Terminal Contract

Status: local release candidate. Project completion requires every required P1
backlog item to have repeatable evidence; a scenario or milestone alone is not
project completion. Push, publication, deployment, production credentials,
real paid calls, production process control, and external effects are excluded.

## Terminal outcome

P1 turns the P0 schema-v2 execution ledger and effect protocol into a sustainable
production-trust evidence system. CI/canary runs emit schema-versioned,
integrity-sealed evidence plus a secret-redacted public summary. Baselines,
trends, explicit thresholds, failure attribution, runtime compatibility, cost,
error rate, and recovery time remain independently reviewable.

## Required acceptance

1. The deterministic multi-agent canary exercises long soak, exclusive claim,
   lease expiry, kill/restart handoff, stale fencing, parked gate, crash before
   and after submit, accepted-before-local-settle, reconciliation, checkpoint
   resume, reusable replay, and replay divergence through the P0 ledger/effect
   protocol. It does not maintain a second execution state store.
2. Duplicate settled effects and accepted stale fences are exactly zero;
   unreconciled unknown outcomes are zero at terminal acceptance. Recovery time,
   error rate, model calls, and paid-call cost meet recorded thresholds.
3. OpenClaw, Hermes, and custom runtime-adapter fixtures pass contract v1 using
   simulated I/O. The boundary is explicit: fixtures prove adapter compatibility,
   not availability of a real gateway or provider.
4. Evidence schema v1 supports baselines and metric deltas, threshold failures
   with attribution, SHA-256 tamper detection, credential-shaped field redaction,
   and a minimized public summary. Offline reruns require no network or secret.
5. GitHub CI template/artifact upload and badge markup are release candidates;
   no workflow is published in this local task. Doctor and dashboard project the
   latest evidence state without mutating it.
6. Full regression, package dry-run, package content inspection, and clean local
   install pass. The packaged candidate includes schema, CI template, library,
   canary, tests, docs, and backlog.

## Real/simulated boundary and deferred canary

`production-soak.mjs` is the authoritative offline CI canary. The separate
`live-runtime-soak.mjs` may perform runtime probes and is not invoked by release
acceptance. A real long-duration OpenClaw/Hermes run, production credentials,
paid inference, or external side effect needs a separate human authorization and
must produce a successor evidence artifact clearly labeled `real_runtime`.

## Trust limits

SHA-256 detects later artifact changes but is not an external timestamp or
signature. Local filesystem leases provide single-host coordination, not
distributed consensus or Byzantine-worker protection. Exactly-once effects still
depend on an upstream idempotency/reconciliation API. Unknown outcomes lacking
authoritative evidence fail closed and remain reconciliation debt.
