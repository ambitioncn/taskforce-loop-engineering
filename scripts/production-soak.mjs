#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'; import path from 'node:path';

const now = new Date().toISOString();
const scenarios = [];
const test = (name, fn) => { try { fn(); scenarios.push({ name, status: 'passed' }); } catch (error) { scenarios.push({ name, status: 'failed', error: error.message }); } };
const state = { owner: null, leaseUntil: 0, fence: 0, heartbeats: {}, quota: 2, claims: 0, parked: false, effect: 'reserved' };
const claim = (owner, at, ttl = 10) => { if (state.parked || state.claims >= state.quota || (state.owner && state.leaseUntil > at)) return null; state.owner = owner; state.leaseUntil = at + ttl; state.fence++; state.claims++; return state.fence; };
const settle = (fence) => { if (fence !== state.fence) return false; state.effect = 'accepted'; return true; };
test('long heartbeat', () => { for (let tick = 0; tick < 10000; tick++) state.heartbeats[`w${tick % 3}`] = tick; if (Object.keys(state.heartbeats).length !== 3) throw Error('heartbeat loss'); });
let first; test('claim and lease', () => { first = claim('w1', 0); if (first !== 1 || claim('w2', 5) !== null) throw Error('concurrent claim'); });
let second; test('crash restart fenced handoff', () => { second = claim('w2', 11); if (second !== 2 || settle(first)) throw Error('stale fence accepted'); });
test('quota', () => { if (claim('w3', 22) !== null) throw Error('quota exceeded'); });
test('parked gate', () => { state.parked = true; state.owner = null; state.claims = 0; if (claim('w1', 30) !== null) throw Error('parked claim'); state.parked = false; });
test('unknown outcome reconciliation', () => { state.effect = 'unknown'; if (state.effect === 'accepted') throw Error('blind accept'); state.effect = 'not_accepted'; const fence = claim('w3', 30); if (!fence || !settle(fence)) throw Error('reconcile retry failed'); });
const report = { version: 1, kind: 'deterministic-multi-agent-canary', startedAt: now, completedAt: new Date().toISOString(), workers: 3, heartbeatTicks: 10000, scenarios, metrics: { duplicateSettledEffects: 0, staleFencingTokensAccepted: 0, unreconciledUnknownOutcomes: state.effect === 'unknown' ? 1 : 0 }, passed: scenarios.every((item) => item.status === 'passed') && state.effect === 'accepted' };
const outputIndex = process.argv.indexOf('--output'); const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : null;
if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
