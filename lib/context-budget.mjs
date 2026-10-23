import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { open, realpath, writeFile } from 'node:fs/promises';

export const DEFAULT_CONTEXT_POLICY = Object.freeze({ softRatio: 0.60, hardRatio: 0.75, maxTicks: 3, maxHandoffBytes: 16384 });
export function contextPolicy(retry = {}) {
  const c = retry.contextBudget ?? {};
  const softRatio = c.softRatio ?? DEFAULT_CONTEXT_POLICY.softRatio;
  const hardRatio = c.hardRatio ?? DEFAULT_CONTEXT_POLICY.hardRatio;
  const maxTicks = retry.sessionMaxTicks ?? DEFAULT_CONTEXT_POLICY.maxTicks;
  if (![softRatio, hardRatio].every(x => typeof x === 'number' && Number.isFinite(x)) || !(0 < softRatio && softRatio < hardRatio && hardRatio < 1)) throw new Error('Invalid context budget ratios');
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 1) throw new Error('Invalid sessionMaxTicks');
  return { ...DEFAULT_CONTEXT_POLICY, softRatio, hardRatio, maxTicks };
}

// lastCallUsage is the final model request, never aggregate run usage. OpenClaw
// input excludes cacheRead; cacheWrite is not added (it may overlap input).
export function openClawContextUsage(envelope) {
  const meta = envelope?.result?.meta?.agentMeta ?? envelope?.meta?.agentMeta;
  const last = meta?.lastCallUsage;
  const capacity = meta?.contextTokens;
  const input = last?.input;
  const cacheRead = last?.cacheRead ?? 0;
  if (![capacity, input, cacheRead].every(x => Number.isSafeInteger(x) && x >= 0) || capacity === 0 || input + cacheRead === 0) return null;
  return { usedTokens: input + cacheRead, windowTokens: capacity, source: 'openclaw.lastCallUsage.input+cacheRead', measurement: 'last_prompt' };
}
export function contextRotation(usage, ticks, policy) {
  const known = usage && Number.isSafeInteger(usage.usedTokens) && usage.usedTokens > 0 && Number.isSafeInteger(usage.windowTokens) && usage.windowTokens > 0;
  const ratio = known ? usage.usedTokens / usage.windowTokens : null;
  const reason = ratio !== null && ratio >= policy.hardRatio ? 'context_hard_limit'
    : ratio !== null && ratio >= policy.softRatio ? 'context_soft_limit'
    : ticks >= policy.maxTicks ? 'bounded_tick_limit' : null;
  return { rotate: reason !== null, reason, ratio, telemetry: known ? 'last_prompt' : 'unavailable' };
}

export async function readBoundedJson(file, maxBytes = 16384) {
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, 'r');
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    return bytes <= maxBytes ? JSON.parse(buffer.subarray(0, bytes).toString('utf8')) : null;
  } catch { return null; }
  finally { await handle?.close(); }
}
export function validHandoff(value, { taskId, runId, generation, attempt }) {
  if (value?.version !== 1 || value.taskId !== taskId || value.runId !== runId || value.generation !== generation || value.attempt !== attempt || value.reason !== 'context_budget') return false;
  if (!['summary', 'nextAction', 'authority', 'checkpoint'].every(k => typeof value[k] === 'string' && value[k].trim())) return false;
  if (!['completed', 'remaining', 'evidence', 'pendingActions', 'blockers'].every(k => Array.isArray(value[k]) && value[k].every(x => typeof x === 'string'))) return false;
  return value.remaining.length > 0 && value.evidence.length > 0;
}
export function contextWorkerInstructions(env = process.env) {
  const policy = JSON.parse(env.LOOP_CONTEXT_POLICY || JSON.stringify(DEFAULT_CONTEXT_POLICY));
  return [
    'CONTEXT BUDGET: Work on one bounded objective this turn. Read only necessary file ranges. Keep each tool response around 8 KiB or less; put full logs in task artifacts and return paths plus short excerpts. This is a cooperative tool-output budget, not runtime enforcement.',
    'Read the resume manifest at ' + (env.LOOP_RESUME_FILE || '(unavailable)') + ' and only the latest relevant checkpoint; never reload entire session transcripts or all historical checkpoints.',
    'At approximately ' + Math.round(policy.softRatio * 100) + '% of the model context window, save a checkpoint and prepare handoff. At ' + Math.round(policy.hardRatio * 100) + '% stop new work and hand off. If live usage is unavailable, finish one small objective and checkpoint; do not invent token measurements.',
    'Before repeating an external/paid/destructive operation, verify its previous outcome using durable receipts/reservations; an uncertain outcome is a blocker, never permission to replay. Preserve existing human gates and amendment versions.',
    'If unfinished work needs a fresh session, first write a normal progress checkpoint (not ready_for_acceptance) with task_id and loop_run_id matching this run, then write JSON to ' + (env.LOOP_CONTEXT_HANDOFF_FILE || '(unavailable)') + ' and finish the turn. Never claim completion merely because you handed off.',
    'Handoff schema (max 16 KiB): ' + JSON.stringify({ version: 1, taskId: env.LOOP_TASK_ID, runId: env.LOOP_RUN_ID, generation: Number(env.LOOP_SESSION_GENERATION || 0), attempt: Number(env.LOOP_ATTEMPT || 1), reason: 'context_budget', checkpoint: 'path to the current progress checkpoint', summary: 'brief current state', completed: ['completed work'], remaining: ['remaining work'], evidence: ['checkpoint and verification paths'], nextAction: 'one concrete next step', authority: 'authorized scope and gates', pendingActions: ['uncertain external action receipts to reconcile, if any'], blockers: [] }),
    'Use blockers for missing authority or unresolved external actions; these must stop automatic continuation. Do not put secrets or full logs in handoff files.'
  ].join('\n');
}

// Capture CLI output outside the model conversation. The JSON parse buffer is
// bounded; oversized/non-JSON responses fall back to tick-based rotation.
export async function observeOpenClawWorker(child, env = process.env) {
  const prefix = env.LOOP_WORKER_OUTPUT_PREFIX;
  let capture = Buffer.alloc(0), overflow = false;
  let outTail = Buffer.alloc(0), errTail = Buffer.alloc(0);
  const streams = [];
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    if (prefix) {
      const log = createWriteStream(prefix + '.' + name + '.log', { mode: 0o600 });
      stream.pipe(log);
      log.on('error', () => { stream.unpipe(log); stream.resume(); });
      streams.push(finished(log).catch(error => error));
    }
    stream.on('data', chunk => {
      if (name === 'stdout') {
        outTail = Buffer.concat([outTail, chunk]).subarray(-16384);
        if (!overflow && capture.length + chunk.length <= 2 * 1024 * 1024) capture = Buffer.concat([capture, chunk]);
        else { overflow = true; capture = Buffer.alloc(0); }
      } else errTail = Buffer.concat([errTail, chunk]).subarray(-16384);
    });
  }
  const result = await new Promise(resolve => {
    child.on('error', error => resolve({ code: 1, error: error.message }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1) }));
  });
  const logErrors = (await Promise.all(streams)).filter(Boolean);
  if (logErrors.length) throw logErrors[0];
  let usage = null;
  if (!overflow) {
    try { usage = openClawContextUsage(JSON.parse(capture.toString('utf8'))); } catch { /* unknown */ }
  }
  if (env.LOOP_CONTEXT_USAGE_FILE) await writeFile(env.LOOP_CONTEXT_USAGE_FILE, JSON.stringify({
    version: 1, taskId: env.LOOP_TASK_ID, runId: env.LOOP_RUN_ID,
    generation: Number(env.LOOP_SESSION_GENERATION || 0), attempt: Number(env.LOOP_ATTEMPT || 1), usage
  }) + '\n', { mode: 0o600 });
  process.stdout.write(outTail);
  process.stderr.write(errTail);
  if (result.error) process.stderr.write(result.error + '\n');
  return result.code;
}

export async function handoffCheckpoint(value, { root, checkpointsDir, taskId, runId }) {
  try {
    const base = await realpath(checkpointsDir);
    const file = await realpath(path.resolve(root, value.checkpoint));
    const relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { valid: false };
    const cp = await readBoundedJson(file);
    if (!cp || cp.task_id !== taskId || cp.loop_run_id !== runId || !Array.isArray(cp.blockers)) return { valid: false };
    return { valid: true, blocked: cp.blockers.length > 0 || ['blocked', 'needs_human_input'].includes(cp.status) };
  } catch { return { valid: false }; }
}
