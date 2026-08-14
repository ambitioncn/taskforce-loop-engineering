export const ADAPTER_CONTRACT = 'loop.runtime-adapter';
export const ADAPTER_MAJOR = 1;

function requiredFunction(adapter, name) {
  if (typeof adapter?.[name] !== 'function') throw new Error(`adapter.${name} must be a function`);
}

export function validateRuntimeAdapter(adapter) {
  if (adapter?.contract !== ADAPTER_CONTRACT || adapter?.version !== ADAPTER_MAJOR) {
    throw new Error(`unsupported runtime adapter contract: ${adapter?.contract}@${adapter?.version}`);
  }
  if (!['openclaw', 'hermes', 'custom'].includes(adapter.runtime)) throw new Error('unsupported adapter runtime');
  for (const name of ['dispatch', 'heartbeat', 'reconcile']) requiredFunction(adapter, name);
  return adapter;
}

export function defineRuntimeAdapter({ runtime, dispatch, heartbeat, reconcile, capabilities = [] }) {
  return validateRuntimeAdapter({ contract: ADAPTER_CONTRACT, version: ADAPTER_MAJOR, runtime, capabilities: [...new Set(capabilities)].sort(), dispatch, heartbeat, reconcile });
}

export const openClawAdapter = defineRuntimeAdapter({
  runtime: 'openclaw', capabilities: ['dispatch', 'heartbeat', 'reconcile'],
  dispatch: async (request, io) => io.invoke('openclaw', ['agent', '--agent', request.worker, '--message', request.prompt]),
  heartbeat: async (_request, io) => io.now(), reconcile: async (request, io) => io.lookup(request.idempotencyKey)
});
export const hermesAdapter = defineRuntimeAdapter({
  runtime: 'hermes', capabilities: ['dispatch', 'heartbeat', 'reconcile'],
  dispatch: async (request, io) => io.invoke('hermes', ['-z', request.prompt]),
  heartbeat: async (_request, io) => io.now(), reconcile: async (request, io) => io.lookup(request.idempotencyKey)
});

export const customAdapterExample = defineRuntimeAdapter({
  runtime: 'custom', capabilities: ['dispatch', 'heartbeat', 'reconcile'],
  dispatch: async (request, io) => io.invoke('example-runtime', [request.prompt]),
  heartbeat: async (_request, io) => io.now(), reconcile: async (request, io) => io.lookup(request.idempotencyKey)
});
