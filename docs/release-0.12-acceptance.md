# Taskforce Loop Engineering 0.12 release acceptance

Status: local release candidate accepted on 2026-08-13. Publication and deployment are explicitly out of scope for this acceptance.

## Terminal outcome

Version 0.12 provides one coherent local package containing:

- P0 Human-Gate Lifecycle v2 with parked waits, throttled reminders and escalations, verified recovery, and restart-safe authorization preservation.
- P1 Action Idempotency and Reservation Contract with immutable request fingerprints, authorization settlement, fenced claims, and unknown-outcome reconciliation.
- P2 Multi-Agent Control Plane with typed todos, capability and authority matching, dependency/quota scheduling, fenced leases, handoff, and orphan recovery.
- P3 read-only Operator Dashboard with normalized P0/P1/P2 projections, loopback serving, static export, redaction, and traversal/XSS protections.

## Acceptance ledger

| Item | Status | Evidence |
| --- | --- | --- |
| P0 implementation and crash/recovery behavior | accepted | `scripts/human-gate-lifecycle-v2-self-test.mjs` |
| P1 reservation, concurrency, fencing, crash recovery, and reconciliation | accepted | `scripts/action-reservation-self-test.mjs` |
| P2 ownership, scheduling, lease, handoff, and P0/P1 safety | accepted | `scripts/todo-control-plane-self-test.mjs` |
| P3 projection, security, restart, and large-queue behavior | accepted | `scripts/operator-dashboard-self-test.mjs` |
| OpenClaw and Hermes installer compatibility | accepted | `scripts/openclaw-install-self-test.mjs`, `scripts/hermes-install-self-test.mjs` |
| Full package regression suite | accepted | `npm run check` on 2026-08-13 |
| Package contents and clean registry-style installation | accepted | `npm pack --dry-run` plus installation from the generated 0.12.0 tarball |
| Documentation and migration boundary | accepted | `README.md`, `CHANGELOG.md`, `MIGRATING.md`, and `docs/` |

## Completion boundary

The local release candidate is complete when every ledger item above is accepted and there are no code or documentation failures. A milestone alone cannot satisfy this contract.

Git commit, tag, GitHub release, npm/ClawHub publication, and installation into a production agent are separate externally visible release actions. They require an explicit release decision and are not implied by local acceptance.

Unmet local items: none.

External release gates: publish/tag/push/deploy decision.
