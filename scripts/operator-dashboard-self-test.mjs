import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOperatorProjection, createDashboardServer, dashboardHealth, exportDashboard, filterProjection } from '../lib/operator-dashboard.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-dashboard-'));
const loops = path.join(root, 'runtime', 'loops');
await mkdir(path.join(loops, 'control-plane'), { recursive: true });
await mkdir(path.join(loops, 'action-reservations'), { recursive: true });
await mkdir(path.join(loops, 'legacy', 'waiting'), { recursive: true });
await mkdir(path.join(loops, 'legacy', 'active'), { recursive: true });
await mkdir(path.join(loops, 'projects', 'p3', 'intake'), { recursive: true });
const now = '2026-08-13T16:00:00.000Z';
const control = {
  version: 2, updated_at: now, quotas: { credits: 9 }, agents: { a: { id: 'a', capabilities: ['code'], authority_grants: ['local'], provider_token: 'never-show' } },
  handoffs: { h: { id: 'h', todo_id: 'leased', from_agent_id: 'a', to_agent_id: 'b', state: 'pending', created_at: now } },
  todos: {
    human: { version: 2, id: 'human', title: '<img src=x onerror=alert(1)>', state: 'runnable', priority: 2, risk: 'medium', authority_class: 'local', required_capabilities: [], acceptance_contract: { checks: ['ok'] }, evidence_requirements: ['test'], cost_envelope: { quota: 'credits', amount: 2 }, parked: { state: 'waiting_for_human', gate_id: 'g1', secret_input: 'hide' }, blocked_reasons: [], claim: null, lineage: { root_todo_id: 'human' }, evidence: [], idempotency_keys: [], created_at: now, updated_at: now },
    leased: { version: 2, id: 'leased', title: 'Lease expired', state: 'claimed', priority: 1, authority_class: 'local', required_capabilities: [], acceptance_contract: {}, evidence_requirements: ['lease'], cost_envelope: { quota: 'credits', amount: 3 }, claim: { owner: 'a', fencing_token: 7, claimed_at: '2026-08-13T15:00:00.000Z', lease_expires_at: '2026-08-13T15:01:00.000Z' }, blocked_reasons: [], lineage: {}, evidence: [], idempotency_keys: ['paid:x'], created_at: now, updated_at: now }
  }
};
await writeFile(path.join(loops, 'control-plane', 'state.json'), JSON.stringify(control));
await writeFile(path.join(loops, 'action-reservations', 'x.json'), JSON.stringify({ version: 1, idempotency_key: 'paid:x', kind: 'paid_api', state: 'unknown', request: { api_key: 'hide', prompt: '<script>x</script>' }, request_fingerprint: 'abc', authorization: { scope: 'paid', credential: 'hide' }, claim: null, reconciliation: { required: true, reason: 'stale_lease' }, created_at: now, updated_at: now }));
await writeFile(path.join(loops, 'legacy', 'waiting', 'vps.json'), JSON.stringify({ id: 'vps', title: 'VPS down', parked: { kind: 'external_condition', next_check_at: '2026-08-13T17:00:00.000Z' }, provider: 'hidden' }));
await writeFile(path.join(loops, 'legacy', 'active', 'bad.json'), '{broken');
await writeFile(path.join(loops, 'projects', 'p3', 'intake', 'latest.json'), JSON.stringify({ version: 1, goal: 'Operator dashboard', token: 'hidden' }));

const before = await stat(path.join(loops, 'control-plane', 'state.json'));
const first = await buildOperatorProjection(root, { now });
const second = await buildOperatorProjection(root, { now });
const after = await stat(path.join(loops, 'control-plane', 'state.json'));
assert.deepEqual(first, second, 'fixed-time projections are deterministic');
assert.equal(before.mtimeMs, after.mtimeMs, 'projection does not mutate source state');
assert.equal(first.todos.find((item) => item.id === 'human').state, 'waiting_for_human');
assert.equal(first.todos.find((item) => item.id === 'leased').state, 'reconciliation_required');
assert.equal(first.actions[0].state, 'reconciliation_required');
assert.equal(first.queues[0].tasks[0].state, 'waiting_for_external_condition');
assert.equal(first.agents[0].provider_token, '[REDACTED]');
assert.equal(first.todos[0].gate.secret_input, '[REDACTED]');
assert.equal(JSON.stringify(first).includes('never-show'), false);
assert.equal(JSON.stringify(first).includes('hidden'), false);
assert.equal(first.health.status, 'degraded');
assert.equal(filterProjection(first, { state: 'waiting_for_human', query: 'img' }).todos.length, 1);
assert.equal(dashboardHealth(first, { maxAgeSeconds: 1 }).stale, false);

const output = path.join(root, 'export');
await exportDashboard(root, output, { now });
assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /projection\.json/);
assert.equal(JSON.parse(await readFile(path.join(output, 'projection.json'), 'utf8')).schema_version, '1.0.0');
await assert.rejects(() => createDashboardServer(root, { host: '0.0.0.0' }), /requires --allow-non-loopback/);

const server = await createDashboardServer(root, { host: '127.0.0.1', port: 0 });
const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
try {
  const overview = await fetch(`${base}/api/v1/overview?state=waiting_for_human`).then((response) => response.json());
  assert.equal(overview.todos.length, 1);
  const detail = await fetch(`${base}/api/v1/todos/human`).then((response) => response.json());
  assert.match(detail.title, /onerror/);
  const page = await fetch(base).then((response) => response.text());
  assert.doesNotMatch(page, /<img src=x/);
  assert.equal((await fetch(`${base}/api/v1/todos/%2e%2e%2fsecret`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/overview`, { method: 'POST' })).status, 405);
} finally { await new Promise((resolve) => server.close(resolve)); }

// Large queue stays dependency-light and completes within a generous local budget.
await mkdir(path.join(loops, 'large', 'inbox'), { recursive: true });
await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(path.join(loops, 'large', 'inbox', `${i}.json`), JSON.stringify({ id: `bulk-${i}`, title: `Task ${i}`, state: 'runnable' }))));
const started = performance.now(); const large = await buildOperatorProjection(root, { now });
assert.equal(large.queues.find((queue) => queue.id === 'large').tasks.length, 500);
assert.ok(performance.now() - started < 5000, '500 task projection should finish under 5 seconds');

console.log(JSON.stringify({ status: 'ok', assertions: 'empty-compatible, legacy, malformed, deterministic, read-only, P0 gates, P1 reconciliation, P2 lease/handoff, redaction, XSS, traversal, bind safety, export, restart-safe server, large queue performance' }));
