import { customAdapterExample } from '../lib/runtime-adapter-v1.mjs';
const audit = [];
const io = { invoke: async (binary, args) => (audit.push({ binary, args, externalWrite: false, paid: false }), { accepted: true }), now: () => new Date().toISOString(), lookup: async () => ({ status: 'not_accepted' }) };
await customAdapterExample.dispatch({ prompt: 'credential-free local canary', worker: 'demo' }, io);
console.log(JSON.stringify({ support: 'example-contract-only', credentialsUsed: false, externalWrites: false, paidCalls: false, audit }, null, 2));
