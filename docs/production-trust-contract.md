# Production Trust Contract (0.13)

Status: local release candidate. This contract is terminal only when every
required item in `production-trust-backlog.json` is accepted by recorded local
evidence. Publishing and production deployment are deliberately outside it.

## Required outcomes

1. Runtime adapters implement contract v1 and pass the same conformance suite.
   OpenClaw and Hermes are supported integrations; the custom adapter is the
   reference extension point.
2. State mutations use a checksummed append-only journal with atomic snapshot
   checkpoints, replay, migration from version-1 JSON state, backup and restore.
   A committed external P1 side effect is never inferred from local intent:
   ambiguous attempts remain `unknown` until reconciled with upstream evidence.
3. The deterministic multi-worker canary covers heartbeat, claim, lease expiry,
   fenced handoff, crash/restart replay, concurrent claims, quota, parked gates,
   and unknown-outcome reconciliation and emits an auditable JSON report.
4. Upgrade planning detects unmanaged or locally modified Ironman layouts and
   produces a non-destructive plan. Customized dispatcher/config files are
   preserved; application requires a separate explicit confirmation and has a
   backup-based rollback plan.
5. The public demo is credential-free, loopback/local-only, makes no paid call
   or external write, and labels support boundaries.
6. Release acceptance includes threat model, reliability/performance thresholds,
   full regression, package dry-run, and clean-install verification.

## Release thresholds

- Adapter conformance: all three fixtures pass; incompatible major versions fail.
- Journal: torn tail is ignored, checksum corruption fails closed, snapshot and
  replay agree, backup restore agrees, migration is idempotent.
- Canary: all scenarios pass, duplicate settled side effects = 0, stale fencing
  tokens accepted = 0, unreconciled unknown outcomes = 0.
- Regression: `npm run check` and `npm run check:production-trust` pass.
- Packaging: `npm pack --dry-run` contains all contract, runtime and demo assets.

## Threat model and trust boundaries

Untrusted inputs include adapter responses, task JSON, journal tails, installer
layouts, and human-gate text. Controls are schema validation, bounded strings,
checksums, atomic rename, fencing tokens, canonical idempotency keys, path
containment, fail-closed version negotiation, and explicit confirmation gates.
The package does not claim Byzantine-worker protection, distributed consensus,
or exactly-once behavior from an upstream service lacking idempotency/reconcile
APIs. Host compromise, stolen credentials, and malicious runtime binaries remain
operator responsibilities.

## Support levels

- OpenClaw: supported, contract-tested adapter and managed installer.
- Hermes: supported, contract-tested adapter and managed installer.
- Custom runtime: contract/example support; lifecycle is operator-owned.
- Distributed database/HA: not provided by the local journal backend.
