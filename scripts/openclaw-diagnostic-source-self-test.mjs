import assert from 'node:assert/strict';
import { diagnosticSources } from '../lib/openclaw-diagnostic-source.mjs';
const args = { root: '/tmp', openclawBin: 'profile-cli' };
const inventory = { telegram: ['personal'], feishu: { accounts: ['main', 'other'] }, slack: { accounts: ['team'] }, discord: [], signal: { accounts: ['phone'] } };
const run = async (bin, argv) => {
  assert.equal(bin, 'profile-cli');
  assert.deepEqual(argv, ['channels', 'list', '--json']);
  return { code: 0, stdout: JSON.stringify({ chat: inventory }) };
};
assert.equal((await diagnosticSources(args, run)).length, 5);
assert.deepEqual(await diagnosticSources({ ...args, sourceChannel: 'telegram' }, run), [{ channel: 'telegram', account: 'personal', target: '1', reply_to: '1' }]);
assert.equal((await diagnosticSources({ ...args, sourceAccount: 'other', sourceTarget: 'custom-target' }, run))[0].target, 'custom-target');
for (const selection of [{ sourceChannel: 'absent' }, { sourceAccount: 'missing' }]) await assert.rejects(diagnosticSources({ ...args, ...selection }, run), /No matching/);
for (const result of [{ code: 1 }, { code: 0, stdout: 'not json' }, { code: 0, stdout: '{}' }, { code: 0, stdout: '{"chat":{}}' }]) await assert.rejects(diagnosticSources(args, async () => result));
console.log('diagnostic source selection: passed');

for (const broken of [null, {}, 'accounts', { accounts: 'bad' }, ['personal', 42], ['personal', ''], ['personal', '   '], ['personal', null]]) {
  const mixed = async () => ({ code: 0, stdout: JSON.stringify({ chat: { telegram: ['personal'], slack: broken } }) });
  await assert.rejects(diagnosticSources(args, mixed), /Malformed/);
  await assert.rejects(diagnosticSources({ ...args, sourceAccount: 'personal' }, mixed), /Malformed/);
  assert.equal((await diagnosticSources({ ...args, sourceChannel: 'telegram' }, mixed)).length, 1);
  await assert.rejects(diagnosticSources({ ...args, sourceChannel: 'slack' }, mixed), /Malformed/);
}
const empty = async () => ({ code: 0, stdout: JSON.stringify({ chat: { telegram: ['personal'], slack: [] } }) });
assert.equal((await diagnosticSources(args, empty)).length, 1);
await assert.rejects(diagnosticSources({ ...args, sourceChannel: 'slack' }, empty), /No matching/);
console.log('mixed-validity inventory regression: passed');
