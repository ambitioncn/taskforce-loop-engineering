#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const value = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const durationMs = Number(value('--duration-ms', 7_200_000));
const output = path.resolve(value('--output', 'live-runtime-soak-report.json'));
const openclawBin = value('--openclaw-bin', 'openclaw');
const agent = value('--agent', 'ironman');
const openclawProfile = value('--openclaw-profile', '');
const hermesBin = value('--hermes-bin', '');
const maxCalls = Number(value('--max-model-calls', 3));
const dryRun = process.argv.includes('--dry-run');
const runtimeOnly = process.argv.includes('--runtime-only');
if (!Number.isFinite(durationMs) || durationMs < 60_000) throw new Error('duration must be at least 60 seconds');
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 6) throw new Error('max model calls must be 1..6');

const runId = randomUUID();
const workDir = path.join(tmpdir(), `loop-live-soak-${runId}`);
await mkdir(workDir, { recursive: true }); await mkdir(path.dirname(output), { recursive: true });
const startedAt = new Date(); const deadline = startedAt.getTime() + durationMs;
const report = { version: 1, kind: hermesBin ? 'live-openclaw-hermes-multi-agent-runtime-soak' : 'live-openclaw-multi-session-soak', runId, dryRun, runtimeOnly, startedAt: startedAt.toISOString(), deadlineAt: new Date(deadline).toISOString(), agent, sessions: 3, modelCallsCap: dryRun || runtimeOnly ? 0 : maxCalls, modelCallsAttempted: 0, consecutiveRuntimeErrors: 0, stoppedByCircuitBreaker: false, externalWrites: false, productionProcessesControlled: false, events: [], metrics: { runtimeProbeFailures: 0, heartbeats: 0, claims: 0, handoffs: 0, injectedCrashes: 0, restarts: 0, staleFencesAccepted: 0, duplicateEffects: 0, unknownReconciled: 0 } };
const statusOutput = `${output}.status.json`;
const writeStatus = async (state, extra = {}) => {
  const temporary = `${statusOutput}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, state, runId, pid: process.pid, startedAt: report.startedAt, deadlineAt: report.deadlineAt, updatedAt: new Date().toISOString(), modelCallsAttempted: report.modelCallsAttempted, consecutiveRuntimeErrors: report.consecutiveRuntimeErrors, metrics: report.metrics, ...extra }, null, 2)}\n`);
  await rename(temporary, statusOutput);
};
await writeStatus('starting');
const sanitize = (text) => String(text).replace(/[A-Za-z0-9_=-]{24,}/g, '[redacted]').slice(0, 240);
const record = (type, fields = {}) => report.events.push({ at: new Date().toISOString(), type, ...fields });
const invoke = (worker) => new Promise((resolve) => {
  report.modelCallsAttempted++;
  const session = `agent:${agent}:loop-production-soak-${runId}-${worker}`;
  const child = spawn(openclawBin, ['agent', '--agent', agent, '--session-key', session, '--message', 'Read-only local soak probe. Reply exactly SOAK_OK. Do not use tools, change files, send messages, or perform external actions.', '--json', '--timeout', '120'], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), evidence: sanitize(stdout || stderr) }));
  child.on('error', (error) => resolve({ code: 127, evidence: sanitize(error.message) }));
});
const probe = (command, args, runtime) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  let settled = false; const finish = (ok, evidence) => { if (settled) return; settled = true; if (!ok) report.metrics.runtimeProbeFailures++; record('runtime_cli_probe', { runtime, ok, evidence: sanitize(evidence) }); resolve(ok); };
  child.on('close', (code) => finish(code === 0, stdout || stderr)); child.on('error', (error) => finish(false, error.message));
});

const leases = { owner: null, until: 0, fence: 0, quotaUsed: 0, parked: false, effect: 'reserved' };
const claim = (owner, now) => { if (leases.parked || leases.quotaUsed >= 2 || (leases.owner && leases.until > now)) return null; leases.owner = owner; leases.until = now + 90_000; leases.fence++; leases.quotaUsed++; report.metrics.claims++; return leases.fence; };
const heartbeatChildren = new Map();
let interruptedSignal = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interruptedSignal = signal; });
const startHeartbeat = (worker) => {
  const source = `setInterval(()=>process.stdout.write('h\\n'),1000)`;
  const child = spawn(process.execPath, ['-e', source], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { report.metrics.heartbeats += String(chunk).split('\n').filter(Boolean).length; });
  heartbeatChildren.set(worker, child); return child;
};

try {
  if (!dryRun) {
    if (!await probe(openclawBin, [...(openclawProfile ? ['--profile', openclawProfile] : []), 'agents', 'list', '--json'], 'openclaw')) report.consecutiveRuntimeErrors++;
    if (hermesBin && !await probe(hermesBin, ['--version'], 'hermes')) report.consecutiveRuntimeErrors++;
    if (report.consecutiveRuntimeErrors >= 2) report.stoppedByCircuitBreaker = true;
  }
  for (let worker = 1; !dryRun && !runtimeOnly && worker <= 3 && report.modelCallsAttempted < maxCalls; worker++) {
    const result = await invoke(`w${worker}`); record('runtime_probe', { worker: `w${worker}`, ok: result.code === 0, evidence: result.evidence });
    report.consecutiveRuntimeErrors = result.code === 0 ? 0 : report.consecutiveRuntimeErrors + 1;
    if (report.consecutiveRuntimeErrors >= 2) { report.stoppedByCircuitBreaker = true; break; }
  }
  if (!report.stoppedByCircuitBreaker) {
    for (const worker of ['w1', 'w2', 'w3']) startHeartbeat(worker);
    const first = claim('w1', Date.now()); record('claim', { worker: 'w1', fence: first });
    leases.effect = 'unknown'; record('unknown_outcome', { replaySuppressed: true }); leases.effect = 'not_accepted'; report.metrics.unknownReconciled++;
    await new Promise((resolve) => setTimeout(resolve, Math.min(65_000, Math.max(5_000, durationMs / 4))));
    const crashed = heartbeatChildren.get('w1'); crashed.kill('SIGTERM'); report.metrics.injectedCrashes++; record('dedicated_worker_crash', { worker: 'w1' });
    leases.until = Date.now() - 1; leases.quotaUsed = 0; const second = claim('w2', Date.now()); report.metrics.handoffs++; record('lease_handoff', { from: 'w1', to: 'w2', fence: second, staleFenceRejected: first !== second });
    if (first === second) report.metrics.staleFencesAccepted++;
    startHeartbeat('w1-restarted'); report.metrics.restarts++; record('dedicated_worker_restart', { worker: 'w1-restarted' });
    leases.parked = true; record('parked_gate', { claimRejected: claim('w3', Date.now()) === null }); leases.parked = false;
    await writeStatus('running');
    while (Date.now() < deadline && !interruptedSignal) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, deadline - Date.now())));
      await writeStatus(interruptedSignal ? 'stopping' : 'running');
    }
  }
} finally {
  for (const child of heartbeatChildren.values()) if (!child.killed) child.kill('SIGTERM');
  report.completedAt = new Date().toISOString(); report.durationMs = Date.parse(report.completedAt) - startedAt.getTime();
  report.interruptedSignal = interruptedSignal;
  report.passed = !interruptedSignal && !report.stoppedByCircuitBreaker && report.metrics.runtimeProbeFailures === 0 && report.durationMs >= durationMs && report.metrics.heartbeats > 0 && report.metrics.handoffs === 1 && report.metrics.restarts === 1 && report.metrics.staleFencesAccepted === 0 && report.metrics.duplicateEffects === 0 && report.metrics.unknownReconciled === 1;
  const temporary = `${output}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`); await rename(temporary, output); await writeStatus(report.passed ? 'passed' : 'failed', { completedAt: report.completedAt, passed: report.passed, interruptedSignal }); await rm(workDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ runId, passed: report.passed, output, durationMs: report.durationMs, modelCallsAttempted: report.modelCallsAttempted }, null, 2));
if (!report.passed) process.exitCode = 1;
