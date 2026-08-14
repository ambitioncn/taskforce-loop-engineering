import assert from 'node:assert/strict';
import { AdapterError, createClaudeCodeAdapter, createCodexCliAdapter, createHermesAdapter, createMemoryTransport, createOpenClawAdapter, validateAdapter } from '../lib/runtime-adapter-sdk.mjs';

export async function conform(factory) {
  const transport = createMemoryTransport(); const adapter = validateAdapter(factory(transport));
  const session = await adapter.createSession({ key: 'offline-demo', metadata: { apiKey: 'must-not-leak' } });
  const run = await adapter.startRun({ sessionId: session.sessionId, requestId: 'request-1', input: { prompt: 'local only' } });
  await adapter.recordStep({ runId: run.runId, stepId: 'step-1', evidence: [{ local: true, token: 'hidden' }] });
  await assert.rejects(adapter.prepareEffect({ runId: run.runId, effectId: 'send', idempotencyKey: 'send:1' }), (error) => error instanceof AdapterError && error.code === 'EFFECT_NOT_AUTHORIZED');
  const effect = await adapter.prepareEffect({ runId: run.runId, effectId: 'write-local', idempotencyKey: 'write:1', authorized: true, payload: { password: 'hidden' } });
  assert.equal(effect.state, 'authorized'); assert.equal(effect.payload.password, '[REDACTED]');
  await adapter.resolveGate({ gateId: 'gate-1', decision: 'approved', responseRef: 'local-ref' });
  const beat = await adapter.heartbeat({ runId: run.runId });
  assert.equal((await adapter.continueRun({ runId: run.runId, continuationToken: beat.continuationToken })).status, 'running');
  assert.equal(JSON.stringify(adapter.telemetry).includes('must-not-leak'), false);
  return { runtime: adapter.runtime, version: adapter.version, capabilities: adapter.capabilities, assertions: 11 };
}

const results = [];
for (const factory of [createOpenClawAdapter, createHermesAdapter, createCodexCliAdapter, createClaudeCodeAdapter]) results.push(await conform(factory));
console.log(JSON.stringify({ status: 'passed', boundary: 'credential-free simulated transport', results }));
