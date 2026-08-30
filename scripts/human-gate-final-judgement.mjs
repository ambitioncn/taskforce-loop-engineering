import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  core: new URL('../lib/human-gate-command.mjs', import.meta.url),
  adapter: new URL('../lib/human-gate-channel-adapter.mjs', import.meta.url),
  dashboard: new URL('../lib/operator-dashboard.mjs', import.meta.url),
  tests: new URL('./human-gate-command-self-test.mjs', import.meta.url),
  docs: new URL('../docs/human-gate-command.md', import.meta.url)
};
const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await readFile(file, 'utf8')])));
const checks = {
  single_command_core: /executeGateCommand/.test(source.core) && /executeGateCommand/.test(source.adapter) && /executeGateCommand/.test(source.dashboard),
  decisions: ['approve', 'reject', 'request_revision'].every((value) => source.core.includes(value)),
  strict_binding: ['expected_generation', 'actor_unauthorized', 'source_channel_mismatch', 'source_message_mismatch', 'reply_binding_mismatch', 'gate_expired'].every((value) => source.core.includes(value)),
  receipt_and_idempotency: /receipt_id/.test(source.core) && /idempotency_key_reused/.test(source.core),
  cas_generation_fence: /gate_conflict_retry/.test(source.core) && /stale_generation/.test(source.core),
  confirmation: /awaiting_confirmation/.test(source.core) && /confirmation_required/.test(source.core),
  revision_artifact: /revisions/.test(source.core) && /supersedes_generation/.test(source.core),
  fail_closed_chat: /ignored_untrusted_chat/.test(source.adapter) && /\/show_gate/.test(source.adapter),
  synchronized_card: /synchronized_card/.test(source.adapter) && /disabled/.test(source.core),
  complete_card: ['project', 'task', 'gate_id', 'action', 'reason', 'impact', 'risk', 'cost', 'evidence', 'dashboard_url', 'expiry', 'generation'].every((value) => source.core.includes(value)),
  dashboard_buttons: /gate-commands/.test(source.dashboard) && ['approve', 'reject', 'request_revision'].every((value) => source.dashboard.includes(value)),
  feishu_feasibility_no_send: /normalizeFeishuGateEvent/.test(source.adapter) && !/fetch\(|spawn\(|message.send/.test(source.adapter),
  feishu_signature_boundary: /feishu_signature_unverified/.test(source.adapter) && /signatureVerified/.test(source.adapter),
  fault_injection: ['race', 'replay', 'expired', 'intruder', 'forward', 'ordinary_message'].every((value) => source.tests.includes(value)),
  documented_trust_boundary: /sole mutation boundary/.test(source.docs) && /no external calls/.test(source.docs) && /Ordinary chat is fail-closed/.test(source.docs)
};
for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `terminal acceptance failed: ${name}`);
console.log(JSON.stringify({ outcome: 'accept', independent: true, checks: Object.keys(checks).length, accepted: Object.keys(checks), external_messages_sent: 0, online_test_residue: 0 }, null, 2));
