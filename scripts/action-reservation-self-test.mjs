import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  actionAdapters,
  claimAction,
  inspectAction,
  markActionUnknown,
  migrateLegacyActionArtifact,
  reconcileAction,
  releaseAction,
  reserveAction,
  settleAction
} from '../lib/action-reservations.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-action-reservation-'));
const base = { idempotencyKey: 'paid:task-1:step-1', kind: 'paid_api', authorizationScope: 'approval:task-1:provider-call', request: { model: 'mock', promptHash: 'abc', cents: 4 } };

const reserved = await reserveAction(root, base);
assert.equal(reserved.created, true);
assert.equal((await reserveAction(root, base)).duplicate, true);
await assert.rejects(() => reserveAction(root, { ...base, request: { ...base.request, cents: 5 } }), /different request/);

// Concurrent workers get one atomic lease and one fencing token.
const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claimAction(root, { idempotencyKey: base.idempotencyKey, owner: `worker-${i}`, leaseMs: 1000 })));
assert.equal(claims.filter((item) => item.claimed).length, 1);
const winner = claims.find((item) => item.claimed);
await assert.rejects(() => settleAction(root, { idempotencyKey: base.idempotencyKey, fencingToken: winner.fencingToken + 1 }), /fencing token/);
assert.equal((await settleAction(root, { idempotencyKey: base.idempotencyKey, fencingToken: winner.fencingToken, evidence: { upstreamId: 'mock-1' } })).settled, true);
assert.equal((await settleAction(root, { idempotencyKey: base.idempotencyKey, fencingToken: winner.fencingToken })).duplicate, true);
assert.equal((await inspectAction(root, base.idempotencyKey)).authorization.state, 'consumed');
await assert.rejects(() => releaseAction(root, { idempotencyKey: base.idempotencyKey, reason: 'late release' }), /cannot be released/);

// Crash before send: an expired claim becomes unknown, never blindly claimable.
const beforeSend = { ...base, idempotencyKey: 'paid:crash-before-send' };
await reserveAction(root, beforeSend);
await claimAction(root, { idempotencyKey: beforeSend.idempotencyKey, owner: 'crashed', leaseMs: 1 });
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal((await claimAction(root, { idempotencyKey: beforeSend.idempotencyKey, owner: 'recovery', leaseMs: 10 })).reason, 'reconcile_required');
await reconcileAction(root, { idempotencyKey: beforeSend.idempotencyKey, outcome: 'not_accepted', evidence: { local: 'adapter_not_invoked' } });
assert.equal((await claimAction(root, { idempotencyKey: beforeSend.idempotencyKey, owner: 'recovery', leaseMs: 100 })).claimed, true);

// Crash after upstream acceptance: reconciliation settles without another send/charge.
const afterAcceptance = { ...base, idempotencyKey: 'paid:crash-after-acceptance' };
await reserveAction(root, afterAcceptance);
const afterClaim = await claimAction(root, { idempotencyKey: afterAcceptance.idempotencyKey, owner: 'worker', leaseMs: 100 });
await markActionUnknown(root, { idempotencyKey: afterAcceptance.idempotencyKey, fencingToken: afterClaim.fencingToken, reason: 'accepted_before_local_commit' });
await reconcileAction(root, { idempotencyKey: afterAcceptance.idempotencyKey, outcome: 'accepted', evidence: { upstreamId: 'mock-accepted' } });
assert.equal((await claimAction(root, { idempotencyKey: afterAcceptance.idempotencyKey, owner: 'retry' })).reason, 'settled');

// Notification adapter suppresses duplicates, and an unused reservation can release authorization.
await actionAdapters.notification.reserve(root, { idempotencyKey: 'notify:task-1:terminal', authorizationScope: 'task-1:source-chat', request: { target: 'mock-chat', digest: 'done' } });
const notifyDuplicate = await actionAdapters.notification.reserve(root, { idempotencyKey: 'notify:task-1:terminal', authorizationScope: 'task-1:source-chat', request: { target: 'mock-chat', digest: 'done' } });
assert.equal(notifyDuplicate.duplicate, true);
const releasable = { ...base, idempotencyKey: 'deploy:cancelled', kind: 'deployment', authorizationScope: 'approval:deploy-staging' };
await reserveAction(root, releasable);
assert.equal((await releaseAction(root, { idempotencyKey: releasable.idempotencyKey, reason: 'operator_cancelled', evidence: { ticket: 'mock' } })).record.authorization.state, 'released');

// Legacy artifacts are imported without changing their logical identity.
const migrated = await migrateLegacyActionArtifact(root, { idempotency_key: 'legacy:notification:1', kind: 'notification', authorization_scope: 'legacy:chat', request: { digest: 'old' } });
assert.equal(migrated.created, true);
assert.equal((await migrateLegacyActionArtifact(root, { idempotency_key: 'legacy:notification:1', kind: 'notification', authorization_scope: 'legacy:chat', request: { digest: 'old' } })).duplicate, true);

console.log(JSON.stringify({ status: 'ok', assertions: 'reservation, fingerprint, concurrency, fencing, crash recovery, reconciliation, authorization, release, adapters, migration' }));
