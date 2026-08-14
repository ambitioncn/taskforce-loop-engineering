import assert from 'node:assert/strict'; import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path';
import { planIronmanUpgrade } from '../lib/upgrade-planner.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'loop-upgrade-'));
try {
  await mkdir(path.join(root, 'scripts/loops'), { recursive: true }); await writeFile(path.join(root, 'scripts/loops/ironman-dispatcher.mjs'), '// owner customization\n');
  const plan = await planIronmanUpgrade(root, [{ path: 'scripts/loops/ironman-dispatcher.mjs', content: '// generated\n' }, { path: 'configs/loops/queues/ironman.json', content: '{}\n' }]);
  assert.equal(plan.layout, 'custom_ironman'); assert.equal(plan.entries[0].action, 'preserve_customized'); assert.equal(plan.entries[1].action, 'create'); assert.equal(plan.readyToApply, false);
  console.log('upgrade planner self-test passed');
} finally { await rm(root, { recursive: true, force: true }); }
