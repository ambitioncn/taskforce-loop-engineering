import { appendFile, copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

export class DurableJournal {
  constructor(directory) {
    this.directory = directory;
    this.logFile = path.join(directory, 'events.jsonl');
    this.snapshotFile = path.join(directory, 'snapshot.json');
  }

  async append(type, payload, transactionId = randomUUID()) {
    await mkdir(this.directory, { recursive: true });
    const previous = (await this.replay()).lastChecksum ?? null;
    const event = { version: 1, transactionId, type, payload, previous };
    event.checksum = digest(canonical(event));
    const handle = await open(this.logFile, 'a');
    try { await handle.write(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
    return event;
  }

  async replay(reducer = (state, event) => ({ ...state, [event.type]: event.payload }), initial = {}) {
    let raw = '';
    try { raw = await readFile(this.logFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state = initial; let lastChecksum = null; let count = 0;
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        if (index === lines.length - 1) break;
        throw new Error(`journal corruption at line ${index + 1}: ${error.message}`);
      }
      const checksum = event.checksum; const unsigned = { ...event }; delete unsigned.checksum;
      if (digest(canonical(unsigned)) !== checksum || event.previous !== lastChecksum) throw new Error(`journal checksum chain invalid at line ${index + 1}`);
      state = reducer(state, event); lastChecksum = checksum; count++;
    }
    return { state, count, lastChecksum };
  }

  async checkpoint(state) {
    await mkdir(this.directory, { recursive: true });
    const replay = await this.replay();
    const snapshot = { version: 1, eventCount: replay.count, lastChecksum: replay.lastChecksum, state };
    const temporary = `${this.snapshotFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
    const handle = await open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.snapshotFile);
    return snapshot;
  }

  async backup(destination) {
    await mkdir(destination, { recursive: true });
    for (const name of ['events.jsonl', 'snapshot.json']) {
      try { await copyFile(path.join(this.directory, name), path.join(destination, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  static async restore(backup, destination) {
    await mkdir(destination, { recursive: true });
    for (const name of ['events.jsonl', 'snapshot.json']) {
      try { await copyFile(path.join(backup, name), path.join(destination, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return new DurableJournal(destination).replay();
  }

  static async migrateV1(stateFile, directory) {
    const journal = new DurableJournal(directory);
    if ((await journal.replay()).count) return journal;
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    await journal.append('legacy_state_imported', { sourceVersion: state.version, state }, 'migration-v1');
    await journal.checkpoint(state); return journal;
  }
}

export function externalEffectBoundary({ status, idempotencyKey, upstreamEvidence }) {
  if (!idempotencyKey) throw new Error('external side effect requires idempotencyKey');
  if (status === 'accepted' && !upstreamEvidence) throw new Error('accepted side effect requires upstreamEvidence');
  if (!['reserved', 'in_flight', 'unknown', 'accepted', 'not_accepted'].includes(status)) throw new Error('invalid side effect status');
  return { status, idempotencyKey, upstreamEvidence: upstreamEvidence ?? null, replayable: ['reserved', 'not_accepted'].includes(status) };
}
