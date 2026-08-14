import assert from 'node:assert/strict';
import { customAdapterExample, hermesAdapter, openClawAdapter, validateRuntimeAdapter } from '../lib/runtime-adapter-v1.mjs';

const calls = [];
const io = { invoke: async (bin, args) => (calls.push({ bin, args }), { accepted: true }), now: () => '2026-01-01T00:00:00.000Z', lookup: async (key) => ({ key, status: 'not_accepted' }) };
for (const adapter of [openClawAdapter, hermesAdapter, customAdapterExample]) {
  validateRuntimeAdapter(adapter);
  assert.equal((await adapter.dispatch({ worker: 'w1', prompt: 'safe local task' }, io)).accepted, true);
  assert.equal(await adapter.heartbeat({}, io), '2026-01-01T00:00:00.000Z');
  assert.equal((await adapter.reconcile({ idempotencyKey: 'k1' }, io)).status, 'not_accepted');
}
assert.throws(() => validateRuntimeAdapter({ contract: 'loop.runtime-adapter', version: 2 }), /unsupported/);
assert.equal(calls.length, 3);
console.log('runtime adapter contract self-test passed');
