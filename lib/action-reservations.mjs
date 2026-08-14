import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrateActionReservation } from './execution-ledger.mjs';

const ACTION_KINDS = new Set(['paid_api', 'notification', 'deployment', 'process_control', 'publication', 'external_message', 'gated_mutation']);
const TERMINAL_STATES = new Set(['settled', 'released']);

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function actionRequestFingerprint(request, authorizationScope) {
  requireText(authorizationScope, 'authorizationScope');
  return createHash('sha256').update(JSON.stringify(canonical({ request, authorizationScope }))).digest('hex');
}

function safeKey(key) {
  requireText(key, 'idempotencyKey');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(key)) throw new Error('idempotencyKey contains unsafe characters or is too long.');
  return key;
}

function paths(root, key) {
  const encoded = createHash('sha256').update(safeKey(key)).digest('hex');
  const dir = path.join(root, 'runtime', 'loops', 'action-reservations');
  return { dir, file: path.join(dir, `${encoded}.json`), lock: path.join(dir, `${encoded}.lock`) };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
}

async function acquireMutex(lock, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
      else if (Date.now() >= deadline) throw new Error('Timed out acquiring action reservation mutex.');
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function mutate(root, key, operation) {
  const location = paths(root, key);
  await mkdir(location.dir, { recursive: true });
  await acquireMutex(location.lock);
  try {
    const record = await readJson(location.file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const result = await operation(record, location.file);
    if (result.write) await atomicWrite(location.file, result.record);
    return result.output ?? result.record;
  } finally {
    await rm(location.lock, { recursive: true, force: true });
  }
}

export async function reserveAction(root, input) {
  const key = safeKey(input.idempotencyKey);
  const kind = requireText(input.kind, 'kind');
  if (!ACTION_KINDS.has(kind)) throw new Error(`Unsupported action kind: ${kind}`);
  const scope = requireText(input.authorizationScope, 'authorizationScope');
  const fingerprint = actionRequestFingerprint(input.request, scope);
  return mutate(root, key, async (record) => {
    if (record) {
      if (record.request_fingerprint !== fingerprint || record.kind !== kind || record.authorization.scope !== scope) {
        throw new Error('Idempotency key is already bound to a different request or authorization scope.');
      }
      return { write: false, output: { created: false, duplicate: true, record } };
    }
    const now = new Date().toISOString();
    const created = {
      version: 1, idempotency_key: key, kind, state: 'reserved', request_fingerprint: fingerprint,
      request: canonical(input.request), created_at: now, updated_at: now, fencing_counter: 0, claim: null,
      authorization: { scope, state: 'reserved', reserved_at: now, consumed_at: null, released_at: null },
      settlement: null, release: null, reconciliation: null, events: [{ type: 'reserved', at: now }]
    };
    return { write: true, record: created, output: { created: true, duplicate: false, record: created } };
  });
}

export async function inspectAction(root, idempotencyKey) {
  const location = paths(root, idempotencyKey);
  return readJson(location.file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
}

export async function claimAction(root, input) {
  const leaseMs = Number(input.leaseMs ?? 60_000);
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer.');
  return mutate(root, input.idempotencyKey, async (record) => {
    if (!record) throw new Error('Action must be reserved before it can be claimed.');
    if (TERMINAL_STATES.has(record.state)) return { write: false, output: { claimed: false, reason: record.state, record } };
    const nowMs = Date.now();
    if (record.state === 'claimed') {
      if (Date.parse(record.claim.lease_expires_at) > nowMs) return { write: false, output: { claimed: false, reason: 'lease_active', record } };
      const at = new Date().toISOString();
      const unknown = { ...record, state: 'unknown', updated_at: at, reconciliation: { required: true, reason: 'stale_lease', marked_at: at }, events: [...record.events, { type: 'outcome_unknown', reason: 'stale_lease', at }] };
      return { write: true, record: unknown, output: { claimed: false, reason: 'reconcile_required', record: unknown } };
    }
    if (record.state === 'unknown') return { write: false, output: { claimed: false, reason: 'reconcile_required', record } };
    const at = new Date().toISOString();
    const token = Number(record.fencing_counter) + 1;
    const claimed = { ...record, state: 'claimed', updated_at: at, fencing_counter: token, claim: { owner: requireText(input.owner, 'owner'), fencing_token: token, claimed_at: at, lease_expires_at: new Date(nowMs + leaseMs).toISOString() }, events: [...record.events, { type: 'claimed', fencing_token: token, at }] };
    return { write: true, record: claimed, output: { claimed: true, fencingToken: token, record: claimed } };
  });
}

function assertFence(record, token) {
  if (record.state !== 'claimed' || record.claim?.fencing_token !== Number(token)) throw new Error('Stale or invalid fencing token.');
}

export async function markActionUnknown(root, input) {
  return mutate(root, input.idempotencyKey, async (record) => {
    if (!record) throw new Error('Action reservation not found.');
    assertFence(record, input.fencingToken);
    const at = new Date().toISOString();
    const next = { ...record, state: 'unknown', updated_at: at, reconciliation: { required: true, reason: input.reason ?? 'upstream_outcome_unknown', marked_at: at }, events: [...record.events, { type: 'outcome_unknown', reason: input.reason ?? 'upstream_outcome_unknown', at }] };
    return { write: true, record: next };
  });
}

export async function settleAction(root, input) {
  return mutate(root, input.idempotencyKey, async (record) => {
    if (!record) throw new Error('Action reservation not found.');
    if (record.state === 'settled') return { write: false, output: { settled: false, duplicate: true, record } };
    assertFence(record, input.fencingToken);
    const at = new Date().toISOString();
    const next = { ...record, state: 'settled', updated_at: at, authorization: { ...record.authorization, state: 'consumed', consumed_at: at }, settlement: { status: 'succeeded', evidence: input.evidence ?? null, settled_at: at, fencing_token: Number(input.fencingToken) }, reconciliation: null, events: [...record.events, { type: 'settled', fencing_token: Number(input.fencingToken), at }] };
    return { write: true, record: next, output: { settled: true, duplicate: false, record: next } };
  });
}

export async function releaseAction(root, input) {
  return mutate(root, input.idempotencyKey, async (record) => {
    if (!record) throw new Error('Action reservation not found.');
    if (record.state === 'settled') throw new Error('Consumed authorization cannot be released.');
    if (record.state === 'released') return { write: false, output: { released: false, duplicate: true, record } };
    if (record.state === 'claimed') assertFence(record, input.fencingToken);
    if (record.state === 'unknown') throw new Error('Unknown upstream outcome must be reconciled before release.');
    const at = new Date().toISOString();
    const next = { ...record, state: 'released', updated_at: at, authorization: { ...record.authorization, state: 'released', released_at: at }, release: { reason: requireText(input.reason, 'reason'), evidence: input.evidence ?? null, released_at: at }, events: [...record.events, { type: 'released', at }] };
    return { write: true, record: next, output: { released: true, duplicate: false, record: next } };
  });
}

export async function reconcileAction(root, input) {
  return mutate(root, input.idempotencyKey, async (record) => {
    if (!record) throw new Error('Action reservation not found.');
    if (record.state !== 'unknown') throw new Error('Only an unknown action outcome can be reconciled.');
    if (!['accepted', 'not_accepted'].includes(input.outcome)) throw new Error('outcome must be accepted or not_accepted.');
    const at = new Date().toISOString();
    if (input.outcome === 'accepted') {
      const next = { ...record, state: 'settled', updated_at: at, authorization: { ...record.authorization, state: 'consumed', consumed_at: at }, settlement: { status: 'succeeded', evidence: input.evidence ?? null, settled_at: at, reconciled: true }, reconciliation: { required: false, outcome: 'accepted', evidence: input.evidence ?? null, reconciled_at: at }, events: [...record.events, { type: 'reconciled_accepted', at }] };
      return { write: true, record: next };
    }
    const next = { ...record, state: 'reserved', updated_at: at, claim: null, reconciliation: { required: false, outcome: 'not_accepted', evidence: input.evidence ?? null, reconciled_at: at }, events: [...record.events, { type: 'reconciled_not_accepted', at }] };
    return { write: true, record: next };
  });
}

export const actionAdapters = Object.freeze(Object.fromEntries(['paid_api', 'notification', 'deployment'].map((kind) => [kind, Object.freeze({
  kind,
  reserve: (root, input) => reserveAction(root, { ...input, kind }),
  claim: claimAction,
  markUnknown: markActionUnknown,
  settle: settleAction,
  release: releaseAction,
  reconcile: reconcileAction,
  inspect: inspectAction
})])));

export async function migrateLegacyActionArtifact(root, legacy) {
  const key = legacy.idempotency_key ?? legacy.idempotencyKey;
  const request = legacy.request ?? { legacy_artifact: legacy.source ?? 'unknown' };
  const scope = legacy.authorization_scope ?? legacy.authorization?.scope ?? 'legacy:unscoped';
  return reserveAction(root, { idempotencyKey: key, kind: legacy.kind ?? 'gated_mutation', request, authorizationScope: scope });
}

export async function projectActionToEffectProtocol(root, idempotencyKey) {
  const reservation = await inspectAction(root, idempotencyKey);
  if (!reservation) throw new Error('Action reservation not found.');
  return migrateActionReservation(root, reservation);
}
