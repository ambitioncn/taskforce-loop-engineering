import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHumanGate, executeGateCommand, getHumanGate, parseBoundReply } from '../lib/human-gate-command.mjs';
import { handleChannelGateEvent, normalizeFeishuGateEvent, renderGateForChannel } from '../lib/human-gate-channel-adapter.mjs';
import { createDashboardServer } from '../lib/operator-dashboard.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-gate-command-'));
const base = { project: 'p', task: 't', action: 'deploy', reason: 'release', impact: 'production', risk: { level: 'high' }, cost: { amount: 10, currency: 'CNY', budget: 100 }, evidence: ['test'], dashboard_url: 'http://127.0.0.1:4174/', expiry: '2030-01-01T00:00:00.000Z', allowed_actors: ['owner'], source_bindings: [{ channel: 'feishu', message_id: 'card-1', reply_to: 'card-1', adapter: 'feishu' }, { channel: 'dashboard', message_id: 'gate-panel', reply_to: 'gate-panel', adapter: 'dashboard' }] };
const command = { gate_id: 'gate_high', decision: 'approve', expected_generation: 1, actor_id: 'owner', source_channel: 'feishu', source_message_id: 'card-1', event_type: 'card_button', idempotency_key: 'event-1' };
try {
  await createHumanGate(root, { ...base, gate_id: 'gate_high' });
  const card = await renderGateForChannel(root, 'gate_high');
  assert.deepEqual(card.buttons.map((x) => x.decision).sort(), ['approve', 'reject', 'request_revision']); assert.equal(card.fields.cost.budget, 100);
  const first = await executeGateCommand(root, command, { now: '2029-01-01T00:00:00.000Z' }); assert.equal(first.outcome, 'confirmation_required'); assert.equal(first.resulting_generation, 2);
  const replay = await executeGateCommand(root, command); assert.equal(replay.replayed, true); assert.equal(replay.receipt_id, first.receipt_id);
  await assert.rejects(executeGateCommand(root, { ...command, idempotency_key: 'event-stale' }, { now: '2029-01-01T00:00:02.000Z' }), /stale_generation/);
  assert.equal((await executeGateCommand(root, { ...command, expected_generation: 2, idempotency_key: 'event-2' }, { now: '2029-01-01T00:00:03.000Z' })).outcome, 'approved');
  await assert.rejects(executeGateCommand(root, { ...command, expected_generation: 2, idempotency_key: 'event-after' }), /gate_already_processed/);
  await createHumanGate(root, { ...base, gate_id: 'gate_low', action: 'local edit', risk: { level: 'low' }, confirmation_required: false });
  for (const bad of [{ actor_id: 'intruder' }, { source_channel: 'other' }, { source_message_id: 'forward' }, { event_type: 'natural_language' }]) await assert.rejects(executeGateCommand(root, { ...command, gate_id: 'gate_low', idempotency_key: `bad-${Object.keys(bad)[0]}`, ...bad }, { now: '2029-01-01T00:00:00.000Z' }), /(unauthorized|mismatch|untrusted)/);
  assert.equal((await handleChannelGateEvent(root, { kind: 'ordinary_message', text: '好的，同意第一个' })).outcome, 'ignored_untrusted_chat'); assert.equal(parseBoundReply('同意'), null); assert.equal(parseBoundReply('/approve gate_low').gate_id, 'gate_low');
  assert.equal((await handleChannelGateEvent(root, { kind: 'ordinary_message', text: '/show_gate gate_low' })).outcome, 'display_only');
  const revision = await handleChannelGateEvent(root, { kind: 'message_reply', event_id: 'rev-1', actor_id: 'owner', channel: 'feishu', card_message_id: 'card-1', reply_to: 'card-1', text: '/request_revision gate_low fix evidence', expected_generation: 1 }, { now: '2029-01-01T00:00:00.000Z' });
  assert.equal(revision.outcome, 'revision_created'); assert.equal((await getHumanGate(root, 'gate_low')).generation, 2);
  assert.equal(revision.synchronized_card.buttons.every((button) => button.expected_generation === 2), true);
  await createHumanGate(root, { ...base, gate_id: 'gate_expired', expiry: '2028-01-01T00:00:00.000Z', confirmation_required: false });
  await assert.rejects(executeGateCommand(root, { ...command, gate_id: 'gate_expired', idempotency_key: 'expired' }, { now: '2029-01-01T00:00:00.000Z' }), /gate_expired/);
  const feishuPayload = { header: { event_id: 'fs-1' }, event: { operator: { operator_id: { open_id: 'owner' } }, context: { open_message_id: 'card-1' }, action: { value: { gate_id: 'gate_high', decision: 'approve', expected_generation: 2 } } } };
  assert.throws(() => normalizeFeishuGateEvent(feishuPayload), /feishu_signature_unverified/);
  const feishu = normalizeFeishuGateEvent(feishuPayload, { signatureVerified: true }); assert.equal(feishu.kind, 'card_button');
  await createHumanGate(root, { ...base, gate_id: 'gate_race', confirmation_required: false });
  const raceBase = { ...command, gate_id: 'gate_race', decision: 'reject', expected_generation: 1 };
  const race = await Promise.allSettled([executeGateCommand(root, { ...raceBase, idempotency_key: 'race-a' }), executeGateCommand(root, { ...raceBase, idempotency_key: 'race-b' })]);
  assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1); assert.equal(race.filter((x) => x.status === 'rejected').length, 1);
  await createHumanGate(root, { ...base, gate_id: 'gate_cross', confirmation_required: false });
  const cross = await Promise.allSettled([
    executeGateCommand(root, { ...command, gate_id: 'gate_cross', idempotency_key: 'cross-feishu' }),
    executeGateCommand(root, { ...command, gate_id: 'gate_cross', source_channel: 'dashboard', source_message_id: 'gate-panel', idempotency_key: 'cross-dashboard' })
  ]);
  assert.equal(cross.filter((x) => x.status === 'fulfilled').length, 1);
  await createHumanGate(root, { ...base, gate_id: 'gate_http', confirmation_required: false });
  const server = await createDashboardServer(root, { host: '127.0.0.1', port: 0 });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/gate-commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gate_id: 'gate_http', decision: 'approve', expected_generation: 1, actor_id: 'owner', source_message_id: 'gate-panel', idempotency_key: 'http-1' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).outcome, 'approved');
    const gatesResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/gates`); assert.equal(gatesResponse.status, 200); assert.ok((await gatesResponse.json()).some((g) => g.gate_id === 'gate_http'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log('human-gate-command self-test: ok (unit, integration, replay, expiry, authorization, misrecognition, Feishu mapping, concurrency)');
} finally { await rm(root, { recursive: true, force: true }); }
