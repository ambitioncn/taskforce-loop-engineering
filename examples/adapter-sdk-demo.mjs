import { createMemoryTransport, createOpenClawAdapter } from '../lib/runtime-adapter-sdk.mjs';

const adapter = createOpenClawAdapter(createMemoryTransport());
const session = await adapter.createSession({ key: 'ten-minute-demo' });
const run = await adapter.startRun({ sessionId: session.sessionId, requestId: 'demo', input: { prompt: 'credential-free' } });
await adapter.recordStep({ runId: run.runId, stepId: 'hello', evidence: [{ kind: 'local-demo' }] });
const heartbeat = await adapter.heartbeat({ runId: run.runId });
await adapter.continueRun({ runId: run.runId, continuationToken: heartbeat.continuationToken });
console.log(JSON.stringify({ session, run, heartbeat, dashboard: 'run `loop-engineering dashboard --root .` for the existing read-only projection', telemetry: adapter.telemetry }, null, 2));
