import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DASHBOARD_SCHEMA_VERSION = '1.0.0';
const SENSITIVE = /(^|_)(secret|token|password|credential|api[_-]?key|private[_-]?key|provider)(_|$)/i;
const STATES = new Set(['runnable', 'active', 'parked', 'waiting_for_human', 'waiting_for_external_condition', 'timed_out_or_escalated', 'reconciliation_required', 'blocked', 'completed', 'failed']);

function clean(value, key = '') {
  if (SENSITIVE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((name) => [name, clean(value[name], name)]));
  return value;
}

function safeId(value) {
  const result = String(value ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,299}$/.test(result)) throw new Error('Unsafe dashboard identifier.');
  return result;
}

function relativeLink(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null;
}

async function json(file, warnings, root) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      if (attempt === 0) continue;
      warnings.push({ code: 'malformed_artifact', artifact: relativeLink(root, file), message: String(error.message).split('\n')[0] });
      return null;
    }
  }
}

async function dirs(dir) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).map((item) => item.name).sort();
}

async function files(dir, suffix = '.json') {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((item) => item.isFile() && item.name.endsWith(suffix)).map((item) => path.join(dir, item.name)).sort();
}

function normalizedState(item, location, nowMs) {
  const raw = String(item.state ?? item.status ?? '').toLowerCase();
  if (raw === 'unknown' || item.reconciliation?.required) return 'reconciliation_required';
  if (raw === 'claimed' || raw === 'running' || raw === 'active' || location === 'active') {
    if (item.claim?.lease_expires_at && Date.parse(item.claim.lease_expires_at) <= nowMs) return 'reconciliation_required';
    return 'active';
  }
  if (['completed', 'accepted', 'settled', 'released', 'success', 'succeeded'].includes(raw) || location === 'completed') return 'completed';
  if (['failed', 'error', 'cancelled', 'goal_unreachable'].includes(raw) || location === 'failed') return 'failed';
  if (raw.includes('timeout') || raw.includes('escalat')) return 'timed_out_or_escalated';
  const parked = item.parked ?? item.wait ?? (location === 'waiting' ? item : null);
  const wait = String(parked?.state ?? parked?.kind ?? raw).toLowerCase();
  if (wait.includes('human')) return 'waiting_for_human';
  if (wait.includes('external') || wait.includes('condition')) return 'waiting_for_external_condition';
  if (parked || location === 'waiting' || raw === 'parked') return 'parked';
  if (raw === 'blocked' || item.blocked_reasons?.length) return 'blocked';
  if (raw === 'handoff_pending') return 'active';
  return 'runnable';
}

function todoProjection(todo, nowMs) {
  const state = normalizedState(todo, null, nowMs);
  return clean({
    id: String(todo.id), title: todo.title ?? todo.goal ?? String(todo.id), project_id: todo.project_id ?? todo.projectId ?? null,
    state, source_version: todo.version ?? 1, priority: Number(todo.priority ?? 0), risk: todo.risk ?? null,
    authority: todo.authority_class ?? todo.authorization?.scope ?? null, required_capabilities: todo.required_capabilities ?? [],
    owner: todo.claim?.owner ?? null, lease: todo.claim ? { fencing_token: todo.claim.fencing_token ?? null, claimed_at: todo.claim.claimed_at ?? null, expires_at: todo.claim.lease_expires_at ?? null, expired: Date.parse(todo.claim.lease_expires_at ?? '') <= nowMs } : null,
    gate: todo.parked ?? null, blocked_reasons: todo.blocked_reasons ?? [], lineage: todo.lineage ?? null,
    acceptance: todo.acceptance_contract ?? null, evidence: todo.evidence ?? [], evidence_requirements: todo.evidence_requirements ?? [],
    cost: todo.cost_envelope ?? null, idempotency_keys: todo.idempotency_keys ?? [], next_action: state === 'reconciliation_required' ? 'reconcile_unknown_action_or_expired_lease' : state === 'waiting_for_human' ? 'await_human_response' : state === 'waiting_for_external_condition' ? 'verify_external_condition' : state === 'runnable' ? 'claim_todo' : null,
    created_at: todo.created_at ?? null, updated_at: todo.updated_at ?? null
  });
}

async function controlPlane(root, warnings, nowMs) {
  const file = path.join(root, 'runtime', 'loops', 'control-plane', 'state.json');
  const state = await json(file, warnings, root);
  if (!state) return { todos: [], agents: [], handoffs: [], quotas: {} };
  return {
    todos: Object.values(state.todos ?? {}).map((todo) => todoProjection(todo, nowMs)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    agents: Object.values(state.agents ?? {}).map(clean).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    handoffs: Object.values(state.handoffs ?? {}).map(clean).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id))),
    quotas: clean(state.quotas ?? {}), updated_at: state.updated_at ?? null, source_version: state.version ?? 1
  };
}

async function actions(root, warnings, nowMs) {
  const dir = path.join(root, 'runtime', 'loops', 'action-reservations');
  const result = [];
  for (const file of await files(dir)) {
    const item = await json(file, warnings, root);
    if (!item) continue;
    const state = normalizedState(item, null, nowMs);
    result.push(clean({ idempotency_key: item.idempotency_key, kind: item.kind, state, reservation_state: item.state, request_fingerprint: item.request_fingerprint, authorization: item.authorization, owner: item.claim?.owner ?? null, lease: item.claim ? { fencing_token: item.claim.fencing_token, expires_at: item.claim.lease_expires_at, expired: Date.parse(item.claim.lease_expires_at ?? '') <= nowMs } : null, reconciliation: item.reconciliation, settlement: item.settlement, release: item.release, created_at: item.created_at, updated_at: item.updated_at }));
  }
  return result.sort((a, b) => String(a.idempotency_key).localeCompare(String(b.idempotency_key)));
}

async function executionSteps(root, warnings, nowMs) {
  const result = [];
  for (const file of await files(path.join(root, 'runtime', 'loops', 'execution-ledger', 'steps'))) {
    const item = await json(file, warnings, root); if (!item) continue;
    result.push(clean({ step_id: item.step_id, kind: item.kind, state: normalizedState(item, null, nowMs), status: item.status, input_fingerprint: item.input_fingerprint, attempt: item.attempt, lineage: item.lineage, lease: item.lease, checkpoint_count: item.checkpoints?.length ?? 0, outcome: item.outcome, evidence: item.evidence, reconciliation: item.reconciliation, updated_at: item.updated_at }));
  }
  return result.sort((a, b) => a.step_id.localeCompare(b.step_id));
}

async function productionEvidence(root, warnings) {
  const file = path.join(root, '.production-evidence', 'public-summary.json');
  try { return clean(await json(file, warnings, root)); } catch { return null; }
}

async function legacyQueues(root, warnings, nowMs) {
  const loops = path.join(root, 'runtime', 'loops');
  const excluded = new Set(['control-plane', 'action-reservations', 'execution-ledger', 'projects']);
  const queues = [];
  for (const name of (await dirs(loops)).filter((item) => !excluded.has(item))) {
    const base = path.join(loops, name); const counts = Object.fromEntries([...STATES].map((state) => [state, 0])); const tasks = [];
    for (const location of ['inbox', 'active', 'waiting', 'completed', 'failed']) {
      for (const file of await files(path.join(base, location))) {
        const item = await json(file, warnings, root); if (!item) continue;
        const state = normalizedState(item, location, nowMs); counts[state] += 1;
        tasks.push(clean({ id: String(item.id ?? path.basename(file, '.json')), title: item.title ?? item.goal ?? item.task ?? path.basename(file, '.json'), state, queue: name, location, project_id: item.project_id ?? item.projectId ?? null, owner: item.owner ?? item.claim?.owner ?? null, gate: item.parked ?? item.wait ?? null, next_wake: item.next_wake_at ?? item.nextWakeAt ?? item.parked?.next_check_at ?? null, next_action: item.next_action ?? item.nextAction ?? null, risk: item.risk ?? null, evidence_links: [relativeLink(root, file)].filter(Boolean), updated_at: item.updated_at ?? item.created_at ?? null }));
      }
    }
    const stateFile = path.join(base, 'state.json'); const state = await json(stateFile, warnings, root);
    queues.push({ id: name, counts, tasks: tasks.sort((a, b) => a.id.localeCompare(b.id)), scheduler: clean(state), source_version: state?.version ?? 1 });
  }
  return queues;
}

async function projects(root, warnings) {
  const result = [];
  const runtime = path.join(root, 'runtime', 'loops', 'projects');
  for (const id of await dirs(runtime)) {
    const base = path.join(runtime, id);
    const intake = await json(path.join(base, 'intake', 'latest.json'), warnings, root);
    const backlog = await json(path.join(base, 'backlog', 'initial.json'), warnings, root);
    const completion = await json(path.join(base, 'completion', 'latest.json'), warnings, root);
    result.push(clean({ id, goal: intake?.goal ?? intake?.brief ?? null, queue: intake?.queue ?? null, status: completion?.status ?? (completion ? 'completed' : 'active'), acceptance: intake?.acceptance ?? null, backlog: backlog?.tasks ?? backlog?.items ?? backlog ?? null, evidence_links: [intake && relativeLink(root, path.join(base, 'intake', 'latest.json')), backlog && relativeLink(root, path.join(base, 'backlog', 'initial.json')), completion && relativeLink(root, path.join(base, 'completion', 'latest.json'))].filter(Boolean) }));
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildOperatorProjection(root, options = {}) {
  const resolved = path.resolve(root); const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid projection time.');
  const warnings = []; const before = await stat(path.join(resolved, 'runtime', 'loops')).catch(() => null);
  const [control, reservations, steps, queueList, projectList, trustEvidence] = await Promise.all([controlPlane(resolved, warnings, now.getTime()), actions(resolved, warnings, now.getTime()), executionSteps(resolved, warnings, now.getTime()), legacyQueues(resolved, warnings, now.getTime()), projects(resolved, warnings), productionEvidence(resolved, warnings)]);
  const newest = [control.updated_at, ...control.todos.map((item) => item.updated_at), ...reservations.map((item) => item.updated_at), ...steps.map((item) => item.updated_at), ...queueList.flatMap((queue) => queue.tasks.map((item) => item.updated_at))].filter(Boolean).sort().at(-1) ?? null;
  const counts = Object.fromEntries([...STATES].map((state) => [state, 0]));
  for (const item of [...control.todos, ...queueList.flatMap((queue) => queue.tasks)]) counts[item.state] += 1;
  const after = await stat(path.join(resolved, 'runtime', 'loops')).catch(() => null);
  if (before && after && before.mtimeMs !== after.mtimeMs) warnings.push({ code: 'concurrent_update', artifact: 'runtime/loops', message: 'Artifacts changed while the projection was read; refresh recommended.' });
  return clean({ schema_version: DASHBOARD_SCHEMA_VERSION, generated_at: now.toISOString(), source: { root: resolved, read_only: true, newest_artifact_at: newest, freshness_seconds: newest ? Math.max(0, Math.floor((now.getTime() - Date.parse(newest)) / 1000)) : null }, health: { status: warnings.length ? 'degraded' : 'ok', warnings }, overview: { counts, queue_count: queueList.length, project_count: projectList.length, todo_count: control.todos.length, action_count: reservations.length, step_count: steps.length, reconciliation_required_steps: steps.filter((item) => item.state === 'reconciliation_required').length, production_trust: trustEvidence?.passed ? 'passed' : trustEvidence ? 'failed' : 'not_generated' }, projects: projectList, queues: queueList, todos: control.todos, agents: control.agents, handoffs: control.handoffs, gates: control.todos.filter((item) => ['parked', 'waiting_for_human', 'waiting_for_external_condition', 'timed_out_or_escalated'].includes(item.state)).map((item) => ({ todo_id: item.id, state: item.state, gate: item.gate, next_action: item.next_action })), actions: reservations, execution_steps: steps, production_evidence: trustEvidence, cost: { quotas: control.quotas, requested_total: control.todos.reduce((sum, item) => sum + Number(item.cost?.amount ?? 0), 0) } });
}

export function filterProjection(projection, options = {}) {
  const query = String(options.query ?? '').toLowerCase(); const state = options.state;
  const match = (item) => (!state || item.state === state) && (!query || JSON.stringify(item).toLowerCase().includes(query));
  return { ...projection, todos: projection.todos.filter(match), queues: projection.queues.map((queue) => ({ ...queue, tasks: queue.tasks.filter(match) })), actions: projection.actions.filter(match) };
}

export function dashboardHealth(projection, options = {}) {
  const maxAge = Number(options.maxAgeSeconds ?? 3600);
  const stale = projection.source.freshness_seconds !== null && projection.source.freshness_seconds > maxAge;
  return { schema_version: DASHBOARD_SCHEMA_VERSION, status: projection.health.status === 'ok' && !stale ? 'ok' : 'degraded', read_only: true, stale, freshness_seconds: projection.source.freshness_seconds, warnings: projection.health.warnings };
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Loop Engineering Operator Dashboard</title><style>body{font:14px system-ui;margin:2rem;background:#10151c;color:#e8edf2}input,select{padding:.55rem;background:#18222e;color:inherit;border:1px solid #445}table{width:100%;border-collapse:collapse;margin-top:1rem}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #344}.pill{padding:.2rem .5rem;border-radius:1rem;background:#25364a}a{color:#78b7ff}</style></head><body><h1>Loop Engineering</h1><p id="health">Loading read-only projection…</p><input id="q" placeholder="Search"><select id="s"><option value="">All states</option></select><table><thead><tr><th>State</th><th>Task</th><th>Owner</th><th>Next action</th></tr></thead><tbody id="rows"></tbody></table><script>const states=['runnable','active','parked','waiting_for_human','waiting_for_external_condition','timed_out_or_escalated','reconciliation_required','blocked','completed','failed'];s.innerHTML+=states.map(x=>'<option>'+x+'</option>').join('');async function draw(){const p=new URLSearchParams({q:q.value,state:s.value});const d=await fetch('/api/v1/overview?'+p).then(r=>r.json());health.textContent=d.health.status+' · '+d.overview.todo_count+' typed todos · '+d.overview.queue_count+' queues';const all=[...d.todos,...d.queues.flatMap(x=>x.tasks)];rows.replaceChildren(...all.map(x=>{const tr=document.createElement('tr');for(const v of [x.state,x.title,x.owner??'—',x.next_action??'—']){const td=document.createElement('td');td.textContent=String(v);tr.append(td)}return tr}))}q.oninput=draw;s.onchange=draw;draw()</script></body></html>`;
}

function loopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }

export async function createDashboardServer(root, options = {}) {
  const host = options.host ?? '127.0.0.1'; const port = Number(options.port ?? 0);
  if (!loopback(host) && options.allowNonLoopback !== true) throw new Error('Non-loopback dashboard bind requires --allow-non-loopback.');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); return response.end(); }
      if (url.pathname.includes('..') || /%2e/i.test(request.url)) { response.writeHead(400); return response.end('unsafe path'); }
      if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff' }); return response.end(request.method === 'HEAD' ? '' : html()); }
      const projection = await buildOperatorProjection(root);
      let body;
      if (url.pathname === '/api/v1/overview') body = filterProjection(projection, { query: url.searchParams.get('q'), state: url.searchParams.get('state') });
      else if (url.pathname === '/api/v1/health') body = dashboardHealth(projection, { maxAgeSeconds: url.searchParams.get('max_age_seconds') ?? 3600 });
      else if (url.pathname === '/api/v1/todos') body = filterProjection(projection, { query: url.searchParams.get('q'), state: url.searchParams.get('state') }).todos;
      else if (url.pathname.startsWith('/api/v1/todos/')) body = projection.todos.find((item) => item.id === safeId(decodeURIComponent(url.pathname.slice('/api/v1/todos/'.length)))) ?? null;
      else if (url.pathname === '/api/v1/actions') body = projection.actions;
      else { response.writeHead(404); return response.end('not found'); }
      response.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(request.method === 'HEAD' ? '' : `${JSON.stringify(body)}\n`);
    } catch (error) { response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); response.end(`${JSON.stringify({ error: 'projection_failed', message: String(error.message) })}\n`); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

export async function exportDashboard(root, outputDir, options = {}) {
  const target = path.resolve(outputDir); const projection = await buildOperatorProjection(root, options);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'projection.json'), `${JSON.stringify(projection, null, 2)}\n`);
  await writeFile(path.join(target, 'index.html'), html().replace("fetch('/api/v1/overview?'+p)", "fetch('./projection.json')"));
  return { schema_version: DASHBOARD_SCHEMA_VERSION, output_dir: target, files: ['index.html', 'projection.json'], read_only_source: true };
}
