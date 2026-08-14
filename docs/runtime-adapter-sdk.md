# Runtime Adapter SDK v1

`lib/runtime-adapter-sdk.mjs` is the platform-neutral contract. Contract id is
`loop.runtime-adapter`, semantic version `1.0.0`; consumers must reject unknown
major versions. The SDK normalizes capabilities, session/run identity, step
ledger events, authorized effects, human gates, heartbeat/continuation,
redacted evidence/telemetry, and stable `AdapterError` codes.

## Ten-minute, credential-free path

From this package, run `npm run demo:adapter`, `npm run check:adapters`, then
`npm run check`. All four paths use the same in-memory transport and make no
network calls. The existing dashboard remains a read-only projection; the demo
prints the command for opening it against a local workspace.

## Runtime paths

| Runtime | Factory | Integration transport |
| --- | --- | --- |
| OpenClaw | `createOpenClawAdapter` | map invoke to trusted session/task tools |
| Hermes | `createHermesAdapter` | map invoke to Hermes run lifecycle |
| Codex CLI | `createCodexCliAdapter` | map invoke to local Codex exec/resume |
| Claude Code | `createClaudeCodeAdapter` | map invoke to local Claude session/resume |

Each transport implements `invoke(operation, payload)`. Operations are
`run.start`, `run.heartbeat`, and `run.continue`. Side effects never pass through
that generic transport: call `prepareEffect` first, persist its idempotency key
in the P0/P1 ledger, obtain explicit authorization, then submit through the
product-specific effect adapter. Missing authorization fails closed.

## Compatibility and migration

| Surface | Status |
| --- | --- |
| package 0.13 / P0 / P1 ledgers | compatible; unchanged |
| `runtime-adapter-v1.mjs` OpenClaw/Hermes/custom fixtures | retained |
| SDK v1 four-runtime contract | additive and preferred |
| future SDK major | rejected until explicitly supported |

Migrate by replacing fixture imports with a `create*Adapter(transport)` factory,
creating a session then run, recording every step, and routing effects through
`prepareEffect`. Convert caught errors using `AdapterError.toJSON()`; never log
raw credentials. To extend, add a runtime to `RUNTIMES`, a thin factory, and run
the exported conformance function with an offline transport before connecting a
real runtime.

Error codes are `INVALID_INPUT`, `UNSUPPORTED_CONTRACT`,
`UNSUPPORTED_VERSION`, `UNSUPPORTED_RUNTIME`, `INVALID_ADAPTER`,
`INVALID_STEP_STATE`, `EFFECT_KEY_REQUIRED`, `EFFECT_NOT_AUTHORIZED`,
`INVALID_GATE_DECISION`, and retryable `TRANSPORT_FAILURE`.
