import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decideQuota, readQuotaLedger, recordVerifiedSliceSpend } from '../lib/quota-runtime-decision.mjs';

const budget = { tokens: 100, time_ms: 1_000, money_minor: 50, rounds: 3 };
const request = { tokens: 10, time_ms: 100, money_minor: 5, rounds: 1 };
assert.equal(decideQuota({ has_work: true, limits: budget, request }).decision, 'execute');
assert.equal(decideQuota({ has_work: false, limits: budget }).decision, 'silent');
assert.equal(decideQuota({ has_work: true, repairable_error: true, limits: budget }).decision, 'self-repair');
assert.equal(decideQuota({ has_work: true, external_condition_pending: true, limits: budget }).decision, 'wait');
assert.equal(decideQuota({ has_work: true, limits: budget, spend: { tokens: 95 }, request }).decision, 'wait');
assert.equal(decideQuota({ has_work: true, limits: budget, spend: { tokens: 95 }, request, can_wait_for_reset: false }).decision, 'ask');

const fallback = decideQuota({ has_work: true, limits: budget, request, lane_id: 'paid', lanes: [
  { id: 'paid', state: 'waiting_for_human' },
  { id: 'local', state: 'runnable', safe_fallback: true, audited: true }
] });
assert.equal(fallback.decision, 'execute'); assert.equal(fallback.lane_id, 'local'); assert.equal(fallback.reason, 'audited_safe_fallback');
assert.equal(decideQuota({ has_work: true, limits: budget, request, lane_id: 'paid', lanes: [{ id: 'paid', state: 'waiting_for_human' }, { id: 'unsafe', state: 'runnable', safe_fallback: true, audited: false }] }).decision, 'ask');

const root = await mkdtemp(path.join(tmpdir(), 'quota-runtime-'));
assert.equal((await recordVerifiedSliceSpend(root, { slice_id: 'idle', status: 'idle', verified: false, spend: request })).recorded, false);
assert.deepEqual((await readQuotaLedger(root)).spend, { tokens: 0, time_ms: 0, money_minor: 0, rounds: 0 });
assert.equal((await recordVerifiedSliceSpend(root, { slice_id: 's1', status: 'completed', verified: true, spend: request, evidence: 'test:pass' })).recorded, true);
assert.equal((await recordVerifiedSliceSpend(root, { slice_id: 's1', status: 'completed', verified: true, spend: request })).recorded, false);
assert.deepEqual((await readQuotaLedger(root)).spend, request);
console.log(JSON.stringify({ ok: true, assertions: ['five decisions', 'scheduler hint', 'four budget dimensions', 'verified-only spend', 'idle free', 'idempotent spend', 'audited fallback'] }));
