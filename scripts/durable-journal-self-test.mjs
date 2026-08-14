import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import path from 'node:path';
import { DurableJournal, externalEffectBoundary } from '../lib/durable-journal.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-journal-'));
try {
  const journal = new DurableJournal(path.join(root, 'state'));
  await journal.append('step_checkpointed', { step: 1 }, 'tx-1');
  await journal.append('step_checkpointed', { step: 2 }, 'tx-2');
  const replay = await journal.replay((state, event) => ({ step: event.payload.step }), {});
  assert.deepEqual(replay.state, { step: 2 }); assert.equal(replay.count, 2);
  await journal.checkpoint(replay.state);
  await writeFile(journal.logFile, `${await readFile(journal.logFile, 'utf8')}{"torn":`);
  assert.equal((await journal.replay()).count, 2);
  const backup = path.join(root, 'backup'); await journal.backup(backup);
  const restored = path.join(root, 'restored'); assert.equal((await DurableJournal.restore(backup, restored)).count, 2);
  const legacy = path.join(root, 'state.json'); await writeFile(legacy, '{"version":1,"runs":7}\n');
  const migrated = await DurableJournal.migrateV1(legacy, path.join(root, 'migrated'));
  assert.equal((await migrated.replay()).count, 1); await DurableJournal.migrateV1(legacy, path.join(root, 'migrated')); assert.equal((await migrated.replay()).count, 1);
  assert.equal(externalEffectBoundary({ status: 'unknown', idempotencyKey: 'task:step' }).replayable, false);
  assert.throws(() => externalEffectBoundary({ status: 'accepted', idempotencyKey: 'k' }), /upstreamEvidence/);
  console.log('durable journal self-test passed');
} finally { await rm(root, { recursive: true, force: true }); }
