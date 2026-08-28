import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const EFFECT_TYPES = Object.freeze([
  'state_transition', 'human_gate', 'revision', 'action_reservation',
  'external_action', 'evidence', 'completion'
]);

const allowedTypes = new Set(EFFECT_TYPES);
const canonical = (value) => JSON.stringify(sort(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
}

export function typedEffect(type, payload, options = {}) {
  if (!allowedTypes.has(type)) throw new Error(`Unsupported effect type: ${type}`);
  if (payload === undefined) throw new Error('Effect payload is required.');
  const effect = {
    version: 1,
    type,
    key: options.key ?? hash(canonical({ type, payload })),
    payload: sort(payload)
  };
  effect.digest = hash(canonical(effect));
  return Object.freeze(effect);
}

export class TransactionalStateKernel {
  constructor(directory) {
    this.directory = directory;
    this.stateFile = path.join(directory, 'state.json');
    this.receiptFile = path.join(directory, 'receipts.jsonl');
    this.lockFile = path.join(directory, 'writer.lock');
  }

  async inspect() {
    return await readJson(this.stateFile, {
      version: 1, generation: 0, fencing_token: 0, status: 'initialized',
      state: {}, applied_effects: {}, receipts: [], last_receipt: null, completion: null
    });
  }

  async acquire(owner = `pid:${process.pid}`) {
    await mkdir(this.directory, { recursive: true });
    let handle;
    try { handle = await open(this.lockFile, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stale = await readJson(this.lockFile, null);
      const pid = Number(String(stale?.owner ?? '').match(/^pid:(\d+)$/)?.[1]);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) { try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; else throw probe; } }
      if (alive || !pid) throw new Error('Transactional writer lease is active or has an unverifiable owner.');
      await rm(this.lockFile, { force: true });
      handle = await open(this.lockFile, 'wx');
    }
    const current = await this.inspect();
    const lease = { owner, fencingToken: current.fencing_token + 1, generation: current.generation, handle };
    await handle.writeFile(JSON.stringify({ owner, fencing_token: lease.fencingToken }));
    return lease;
  }

  async release(lease) {
    await lease.handle.close();
    await rm(this.lockFile, { force: true });
  }

  async transact(input) {
    const lease = input.lease ?? await this.acquire(input.owner);
    const owned = !input.lease;
    try {
      const current = await this.inspect();
      if (lease.fencingToken <= current.fencing_token) throw new Error('Stale fencing token.');
      if (input.expectedGeneration !== undefined && input.expectedGeneration !== current.generation) {
        throw new Error(`CAS generation mismatch: expected ${input.expectedGeneration}, actual ${current.generation}.`);
      }
      const effects = (input.effects ?? []).map((effect) => typedEffect(effect.type, effect.payload, { key: effect.key }));
      const fresh = effects.filter((effect) => !current.applied_effects[effect.key]);
      const nextState = input.reduce ? await input.reduce(structuredClone(current.state), fresh) : current.state;
      const next = {
        ...current,
        generation: current.generation + 1,
        fencing_token: lease.fencingToken,
        status: input.status ?? current.status,
        state: nextState,
        applied_effects: { ...current.applied_effects },
        updated_at: new Date().toISOString()
      };
      const receipts = [];
      let previous = current.last_receipt;
      for (const effect of fresh) {
        const receipt = {
          version: 1, transaction_id: input.transactionId ?? randomUUID(),
          generation: next.generation, fencing_token: lease.fencingToken,
          effect_key: effect.key, effect_digest: effect.digest, effect_type: effect.type,
          previous, created_at: new Date().toISOString()
        };
        receipt.receipt = hash(canonical(receipt));
        previous = receipt.receipt;
        next.applied_effects[effect.key] = { receipt: receipt.receipt, generation: next.generation, effect };
        receipts.push(receipt);
      }
      next.last_receipt = previous;
      next.receipts = [...(current.receipts ?? []), ...receipts];
      if (input.complete) {
        const verdict = await input.complete.validate({ current, next, freshEffects: fresh });
        if (!verdict?.ok) throw new Error(`Completion fence rejected: ${verdict?.reason ?? 'validation failed'}`);
        next.status = 'completed';
        next.completion = { fenced_at_generation: next.generation, evidence: verdict.evidence ?? [], terminal_contract: input.complete.terminalContract ?? null };
      }
      await atomicWrite(this.stateFile, next);
      if (receipts.length) await writeFile(this.receiptFile, receipts.map((item) => JSON.stringify(item)).join('\n') + '\n', { flag: 'a' });
      return { state: next, receipts, replayed: effects.length - fresh.length };
    } finally { if (owned) await this.release(lease); }
  }

  async replayEffect(effect, execute) {
    const normalized = typedEffect(effect.type, effect.payload, { key: effect.key });
    const current = await this.inspect();
    const existing = current.applied_effects[normalized.key];
    if (existing) return { executed: false, replayed: true, receipt: existing.receipt };
    const outcome = await execute(normalized);
    const committed = await this.transact({
      expectedGeneration: current.generation,
      effects: [normalized],
      reduce: (state) => ({ ...state, effect_outcomes: { ...(state.effect_outcomes ?? {}), [normalized.key]: outcome } })
    });
    return { executed: true, replayed: false, outcome, receipt: committed.receipts[0]?.receipt };
  }

  async verifyReceiptChain() {
    const state = await this.inspect();
    let previous = null; let count = 0;
    for (const item of state.receipts ?? []) {
      const claimed = item.receipt; const unsigned = { ...item }; delete unsigned.receipt;
      if (item.previous !== previous || hash(canonical(unsigned)) !== claimed) throw new Error(`Receipt chain invalid at ${count + 1}.`);
      previous = claimed; count++;
    }
    if (state.last_receipt !== previous) throw new Error('Receipt head does not match state.');
    return { ok: true, count, head: previous };
  }
}
