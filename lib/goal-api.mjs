import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TransactionalStateKernel } from './transactional-state-kernel.mjs';

const goalDir = (root, id) => path.join(root, 'runtime', 'loops', 'goals', id);
const requireId = (id) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id ?? '')) throw new Error('Goal id is invalid.');
  return id;
};

export async function initGoal(root, input) {
  const id = requireId(input.id);
  if (typeof input.goal !== 'string' || input.goal.trim().length < 8) throw new Error('Goal must be a meaningful string.');
  const directory = goalDir(root, id); await mkdir(directory, { recursive: true });
  const contract = { version: 1, id, goal: input.goal, terminal_contract: input.terminalContract ?? null, created_at: new Date().toISOString() };
  const file = path.join(directory, 'goal.json');
  await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  return statusGoal(root, id);
}

export async function statusGoal(root, id) {
  requireId(id); const directory = goalDir(root, id);
  const contract = JSON.parse(await readFile(path.join(directory, 'goal.json'), 'utf8'));
  const kernel = new TransactionalStateKernel(path.join(directory, 'kernel'));
  return { contract, runtime: await kernel.inspect(), receipt_chain: await kernel.verifyReceiptChain() };
}

export async function runGoal(root, id, input = {}) {
  requireId(id); const directory = goalDir(root, id);
  await readFile(path.join(directory, 'goal.json'), 'utf8');
  const kernel = new TransactionalStateKernel(path.join(directory, 'kernel'));
  return kernel.transact({
    expectedGeneration: input.expectedGeneration,
    effects: input.effects ?? [{ type: 'state_transition', key: `run:${input.triggerId ?? 'manual'}`, payload: { trigger: input.triggerId ?? 'manual' } }],
    status: input.status ?? 'running',
    reduce: input.reduce ?? ((state, effects) => ({ ...state, last_effects: effects.map((item) => item.key) })),
    complete: input.complete
  });
}

export async function reviewGoal(root, id, review) {
  if (!['accept', 'revise', 'wait'].includes(review.decision)) throw new Error('Review decision must be accept, revise, or wait.');
  return runGoal(root, id, {
    expectedGeneration: review.expectedGeneration,
    effects: [{
      type: review.decision === 'wait' ? 'human_gate' : review.decision === 'revise' ? 'revision' : 'evidence',
      key: review.key ?? `review:${review.decision}:${review.revision ?? 0}`,
      payload: review
    }],
    status: review.decision === 'wait' ? 'waiting_for_human' : review.decision === 'revise' ? 'revision_pending' : 'accepted'
  });
}

export async function doctorGoal(root, id) {
  try { const status = await statusGoal(root, id); return { ok: true, id, generation: status.runtime.generation, receipt_chain: status.receipt_chain }; }
  catch (error) { return { ok: false, id, error: error.message }; }
}

export const Goal = Object.freeze({ init: initGoal, run: runGoal, status: statusGoal, review: reviewGoal, doctor: doctorGoal });
