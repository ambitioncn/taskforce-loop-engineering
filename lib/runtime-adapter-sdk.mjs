import { createHash, randomUUID } from 'node:crypto';

export const RUNTIME_ADAPTER_CONTRACT = 'loop.runtime-adapter';
export const RUNTIME_ADAPTER_VERSION = '1.0.0';
export const RUNTIME_ADAPTER_MAJOR = 1;
export const RUNTIMES = Object.freeze(['openclaw', 'hermes', 'codex-cli', 'claude-code']);
export const EFFECT_STATES = Object.freeze(['prepared', 'authorized', 'submitted', 'settled', 'unknown', 'rejected']);

export class AdapterError extends Error {
  constructor(code, message, { retryable = false, cause, details } = {}) {
    super(message, { cause });
    this.name = 'AdapterError'; this.code = code; this.retryable = retryable;
    this.details = redact(details ?? null);
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details }; }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    /token|secret|password|credential|authorization|cookie|api[-_]?key/i.test(key)
      ? [key, '[REDACTED]'] : [key, redact(item)]));
}

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new AdapterError('INVALID_INPUT', `${label} is required`);
  return value.trim();
};
const stableId = (prefix, value) => `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;

export function validateAdapter(adapter) {
  if (adapter?.contract !== RUNTIME_ADAPTER_CONTRACT) throw new AdapterError('UNSUPPORTED_CONTRACT', 'unsupported adapter contract');
  const major = Number.parseInt(String(adapter.version).split('.')[0], 10);
  if (major !== RUNTIME_ADAPTER_MAJOR) throw new AdapterError('UNSUPPORTED_VERSION', `unsupported adapter version: ${adapter?.version}`);
  if (!RUNTIMES.includes(adapter.runtime)) throw new AdapterError('UNSUPPORTED_RUNTIME', `unsupported runtime: ${adapter?.runtime}`);
  for (const method of ['createSession', 'startRun', 'recordStep', 'prepareEffect', 'resolveGate', 'heartbeat', 'continueRun']) {
    if (typeof adapter[method] !== 'function') throw new AdapterError('INVALID_ADAPTER', `adapter.${method} must be a function`);
  }
  return adapter;
}

export function defineRuntimeAdapter({ runtime, capabilities = [], transport }) {
  if (!transport || typeof transport.invoke !== 'function') throw new AdapterError('INVALID_ADAPTER', 'transport.invoke must be a function');
  const events = [];
  const emit = (type, payload) => {
    const event = redact({ contract: 'loop.telemetry', version: 1, type, runtime, at: new Date().toISOString(), ...payload });
    events.push(event); transport.telemetry?.(event); return event;
  };
  const invoke = async (operation, payload) => {
    try { return redact(await transport.invoke(operation, redact(payload))); }
    catch (cause) {
      if (cause instanceof AdapterError) throw cause;
      throw new AdapterError('TRANSPORT_FAILURE', `${runtime} ${operation} failed`, { retryable: true, cause });
    }
  };
  const adapter = {
    contract: RUNTIME_ADAPTER_CONTRACT, version: RUNTIME_ADAPTER_VERSION, runtime,
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    telemetry: events,
    async createSession(input = {}) {
      const sessionId = input.sessionId ?? stableId('ses', { runtime, key: required(input.key, 'session key') });
      const out = { sessionId, runtime, metadata: redact(input.metadata ?? {}) }; emit('session.created', out); return out;
    },
    async startRun(input = {}) {
      const sessionId = required(input.sessionId, 'sessionId');
      const runId = input.runId ?? stableId('run', { sessionId, requestId: input.requestId ?? randomUUID() });
      const result = await invoke('run.start', { sessionId, runId, input: input.input ?? null });
      const out = { sessionId, runId, status: result?.status ?? 'running' }; emit('run.started', out); return out;
    },
    async recordStep(input = {}) {
      const runId = required(input.runId, 'runId'); const stepId = required(input.stepId, 'stepId');
      const state = input.state ?? 'completed';
      if (!['pending', 'running', 'completed', 'failed', 'waiting'].includes(state)) throw new AdapterError('INVALID_STEP_STATE', `invalid step state: ${state}`);
      const evidence = redact(input.evidence ?? []); emit('step.recorded', { runId, stepId, state, evidence }); return { runId, stepId, state, evidence };
    },
    async prepareEffect(input = {}) {
      const runId = required(input.runId, 'runId'); const effectId = required(input.effectId, 'effectId');
      if (!input.idempotencyKey) throw new AdapterError('EFFECT_KEY_REQUIRED', 'effect idempotencyKey is required');
      if (input.authorized !== true) throw new AdapterError('EFFECT_NOT_AUTHORIZED', 'effect is fail-closed until explicitly authorized');
      const out = { runId, effectId, idempotencyKey: input.idempotencyKey, state: 'authorized', payload: redact(input.payload ?? null) };
      emit('effect.authorized', out); return out;
    },
    async resolveGate(input = {}) {
      const gateId = required(input.gateId, 'gateId');
      if (!['approved', 'rejected'].includes(input.decision)) throw new AdapterError('INVALID_GATE_DECISION', 'gate decision must be approved or rejected');
      const out = { gateId, decision: input.decision, responseRef: input.responseRef ?? null }; emit('gate.resolved', out); return out;
    },
    async heartbeat(input = {}) {
      const runId = required(input.runId, 'runId'); const result = await invoke('run.heartbeat', { runId });
      const out = { runId, alive: result?.alive !== false, continuationToken: result?.continuationToken ?? null };
      emit('run.heartbeat', out); return out;
    },
    async continueRun(input = {}) {
      const runId = required(input.runId, 'runId'); const continuationToken = required(input.continuationToken, 'continuationToken');
      const result = await invoke('run.continue', { runId, continuationToken });
      const out = { runId, status: result?.status ?? 'running' }; emit('run.continued', out); return out;
    }
  };
  return validateAdapter(adapter);
}

export function createMemoryTransport() {
  const calls = [];
  return { calls, async invoke(operation, payload) {
    calls.push({ operation, payload });
    if (operation === 'run.heartbeat') return { alive: true, continuationToken: `continue_${payload.runId}` };
    return { status: 'running' };
  } };
}

export const createOpenClawAdapter = (transport) => defineRuntimeAdapter({ runtime: 'openclaw', capabilities: ['sessions', 'effects', 'human-gates', 'continuation'], transport });
export const createHermesAdapter = (transport) => defineRuntimeAdapter({ runtime: 'hermes', capabilities: ['sessions', 'effects', 'human-gates', 'continuation'], transport });
export const createCodexCliAdapter = (transport) => defineRuntimeAdapter({ runtime: 'codex-cli', capabilities: ['sessions', 'effects', 'human-gates', 'continuation'], transport });
export const createClaudeCodeAdapter = (transport) => defineRuntimeAdapter({ runtime: 'claude-code', capabilities: ['sessions', 'effects', 'human-gates', 'continuation'], transport });
