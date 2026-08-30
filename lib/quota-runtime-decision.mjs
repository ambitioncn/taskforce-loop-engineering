import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const QUOTA_DECISIONS = Object.freeze(['execute', 'wait', 'ask', 'self-repair', 'silent']);
export const BUDGET_DIMENSIONS = Object.freeze(['tokens', 'time_ms', 'money_minor', 'rounds']);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const vector = (value = {}) => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, Math.max(0, finite(value[key]))]));
const plus = (left, right) => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, left[key] + right[key]]));
const remaining = (limits, spend) => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, Math.max(0, limits[key] - spend[key])]));
const exceeds = (request, available) => BUDGET_DIMENSIONS.filter((key) => request[key] > available[key]);

function schedulerHint(decision, input = {}) {
  const delays = { execute: 0, 'self-repair': 0, ask: null, silent: null, wait: Math.max(1_000, finite(input.retry_after_ms, 30_000)) };
  return {
    action: decision,
    eligible_at: delays[decision] === null ? null : new Date(Date.now() + delays[decision]).toISOString(),
    retry_after_ms: delays[decision],
    wake_on: decision === 'ask' ? ['human_gate_resolved'] : decision === 'silent' ? ['new_work', 'budget_reset'] : decision === 'wait' ? ['timer', 'budget_reset', 'lane_change'] : []
  };
}

export function decideQuota(input = {}) {
  const limits = vector(input.limits);
  const spend = vector(input.spend);
  const request = vector(input.request);
  const available = remaining(limits, spend);
  const exhausted = exceeds(request, available);
  const lanes = Array.isArray(input.lanes) ? input.lanes : [];
  const selected = input.lane_id ? lanes.find((lane) => lane.id === input.lane_id) : lanes[0];
  const fallback = lanes.find((lane) => lane.id !== selected?.id && lane.safe_fallback === true && lane.audited === true && lane.state === 'runnable');
  let decision = 'execute'; let reason = 'budget_available'; let lane = selected?.id ?? null;

  if (!input.has_work) { decision = 'silent'; reason = 'no_work'; }
  else if (input.repairable_error) { decision = 'self-repair'; reason = 'repairable_runtime_error'; }
  else if (selected?.state === 'waiting_for_human' && fallback) { decision = 'execute'; reason = 'audited_safe_fallback'; lane = fallback.id; }
  else if (selected?.state === 'waiting_for_human') { decision = 'ask'; reason = 'human_gate_required'; }
  else if (input.external_condition_pending) { decision = 'wait'; reason = 'external_condition_pending'; }
  else if (exhausted.length) { decision = input.can_wait_for_reset === false ? 'ask' : 'wait'; reason = `budget_exhausted:${exhausted.join(',')}`; }

  return { version: 1, decision, reason, lane_id: lane, limits, spend, request, remaining: available, scheduler_hint: schedulerHint(decision, input) };
}

function ledgerPath(root) { return path.join(root, 'runtime', 'loops', 'quota', 'ledger.json'); }
async function readLedger(root) { try { return JSON.parse(await readFile(ledgerPath(root), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { version: 1, spend: vector(), entries: [] }; throw error; } }

export async function readQuotaLedger(root) { return readLedger(root); }

export async function recordVerifiedSliceSpend(root, input = {}) {
  if (input.status !== 'completed' || input.verified !== true) return { recorded: false, reason: 'slice_not_completed_and_verified' };
  const amount = vector(input.spend);
  const ledger = await readLedger(root);
  const sliceId = String(input.slice_id ?? '').trim();
  if (!sliceId) throw new Error('slice_id is required.');
  if (ledger.entries.some((entry) => entry.slice_id === sliceId)) return { recorded: false, reason: 'slice_already_recorded', ledger };
  const entry = { id: randomUUID(), slice_id: sliceId, spend: amount, completed_at: input.completed_at ?? new Date().toISOString(), evidence: input.evidence ?? null };
  ledger.spend = plus(vector(ledger.spend), amount); ledger.entries.push(entry);
  const file = ledgerPath(root); await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' }); await rename(temp, file);
  return { recorded: true, entry, ledger };
}
