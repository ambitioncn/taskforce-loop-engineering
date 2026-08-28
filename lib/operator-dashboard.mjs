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
    const terminalContract = await json(path.join(base, 'terminal-contract.json'), warnings, root);
    const completion = await json(path.join(base, 'completion', 'latest.json'), warnings, root);
    const milestones = (backlog?.tasks ?? backlog?.items ?? (Array.isArray(backlog) ? backlog : [])).map((item, index) => ({
      id: item.id ?? `milestone-${index + 1}`, title: item.title ?? item.task ?? `Milestone ${index + 1}`,
      status: item.status ?? 'pending', acceptance: item.acceptance ?? [], evidence: item.evidence ?? []
    }));
    const accepted = completion?.terminalAccepted === true || terminalContract?.terminalState?.accepted === true;
    result.push(clean({
      id, goal: intake?.goal ?? intake?.brief ?? null, brief: intake?.brief ?? null, queue: intake?.queue ?? null,
      status: accepted ? 'completed' : completion?.status ?? terminalContract?.status ?? 'active', terminal_accepted: accepted,
      project_summary: { completed_milestones: milestones.filter((item) => ['completed', 'accepted'].includes(item.status)).length, total_milestones: milestones.length, unmet: completion?.unmet ?? terminalContract?.unmet ?? [], blockers: completion?.blockers ?? terminalContract?.blockers ?? [] },
      terminal_contract: terminalContract ? { status: terminalContract.status ?? null, terminal_state: terminalContract.terminalState ?? null, milestone_rule: terminalContract.milestoneRule ?? null, completion_rule: terminalContract.completionRule ?? null, requirements: terminalContract.requirements ?? [], residual_risks: terminalContract.residualRisks ?? [] } : null,
      acceptance: intake?.acceptance ?? null, milestones, completion: completion ?? null,
      evidence_links: [intake && relativeLink(root, path.join(base, 'intake', 'latest.json')), backlog && relativeLink(root, path.join(base, 'backlog', 'initial.json')), terminalContract && relativeLink(root, path.join(base, 'terminal-contract.json')), completion && relativeLink(root, path.join(base, 'completion', 'latest.json'))].filter(Boolean)
    }));
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function taskWorkspaces(root, warnings) {
  const loops = path.join(root, 'runtime', 'loops'); const result = [];
  for (const queue of (await dirs(loops)).filter((name) => !['control-plane', 'action-reservations', 'execution-ledger', 'projects'].includes(name))) {
    const tasksRoot = path.join(loops, queue, 'tasks');
    for (const taskId of await dirs(tasksRoot)) {
      const base = path.join(tasksRoot, taskId);
      const [contract, finalJudgement, humanContext, amendment] = await Promise.all([
        json(path.join(base, 'task_contract.json'), warnings, root), json(path.join(base, 'final_judgement.json'), warnings, root),
        json(path.join(base, 'human_input_context.json'), warnings, root), json(path.join(base, 'amendments', 'latest.json'), warnings, root)
      ]);
      const checkpoints = []; const reviews = [];
      for (const file of await files(path.join(base, 'checkpoints'))) { const item = await json(file, warnings, root); if (item) checkpoints.push({ ...clean(item), evidence_link: relativeLink(root, file) }); }
      for (const file of await files(path.join(base, 'reviews'))) { const item = await json(file, warnings, root); if (item) reviews.push({ ...clean(item), evidence_link: relativeLink(root, file) }); }
      if (!contract && !checkpoints.length && !finalJudgement) continue;
      const projectIds = [...new Set(checkpoints.map((item) => item.project_id).filter(Boolean))];
      const timeline = [
        ...checkpoints.map((item) => ({ type: 'checkpoint', at: item.created_at ?? null, id: item.checkpoint_id, status: item.status, summary: item.summary, revision_of: item.revises_checkpoint_id ?? null, amendment_version: item.amendment_version ?? 0, evidence_link: item.evidence_link })),
        ...reviews.map((item) => {
          const failed = Array.isArray(item.failed) ? item.failed : item.failed == null ? [] : [item.failed];
          const passed = Array.isArray(item.passed) ? item.passed : item.passed == null ? [] : [item.passed];
          return { type: 'acceptance_review', at: item.created_at ?? null, id: item.checkpoint_id, status: item.status, summary: failed.map(String).join('; ') || passed.slice(0, 2).map(String).join('; '), evidence_link: item.evidence_link };
        }),
        ...(finalJudgement ? [{ type: 'final_judge', at: finalJudgement.created_at ?? null, id: 'final_judgement', status: finalJudgement.outcome, summary: (finalJudgement.reasons ?? []).join('; '), evidence_link: relativeLink(root, path.join(base, 'final_judgement.json')) }] : [])
      ].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.type.localeCompare(b.type));
      result.push(clean({ id: taskId, queue, title: contract?.title ?? taskId, scope: contract?.task_scope ?? null, project_ids: projectIds, amendment_version: amendment?.version ?? amendment?.amendment_version ?? 0, final_judgement: finalJudgement?.outcome ?? null, gates: humanContext?.gates ?? [], revision_lineage: checkpoints.map((item) => ({ checkpoint_id: item.checkpoint_id, milestone_id: item.milestone_id ?? item.checkpoint_id, revises_checkpoint_id: item.revises_checkpoint_id ?? null, sequence: item.sequence ?? null, status: item.status })), timeline, evidence_links: [relativeLink(root, path.join(base, 'task_contract.json'))].filter(Boolean) }));
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildOperatorProjection(root, options = {}) {
  const resolved = path.resolve(root); const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid projection time.');
  const warnings = []; const before = await stat(path.join(resolved, 'runtime', 'loops')).catch(() => null);
  const [control, reservations, steps, queueList, projectList, taskList, trustEvidence] = await Promise.all([controlPlane(resolved, warnings, now.getTime()), actions(resolved, warnings, now.getTime()), executionSteps(resolved, warnings, now.getTime()), legacyQueues(resolved, warnings, now.getTime()), projects(resolved, warnings), taskWorkspaces(resolved, warnings), productionEvidence(resolved, warnings)]);
  const newest = [control.updated_at, ...control.todos.map((item) => item.updated_at), ...reservations.map((item) => item.updated_at), ...steps.map((item) => item.updated_at), ...queueList.flatMap((queue) => queue.tasks.map((item) => item.updated_at))].filter(Boolean).sort().at(-1) ?? null;
  const counts = Object.fromEntries([...STATES].map((state) => [state, 0]));
  for (const item of [...control.todos, ...queueList.flatMap((queue) => queue.tasks)]) counts[item.state] += 1;
  const after = await stat(path.join(resolved, 'runtime', 'loops')).catch(() => null);
  if (before && after && before.mtimeMs !== after.mtimeMs) warnings.push({ code: 'concurrent_update', artifact: 'runtime/loops', message: 'Artifacts changed while the projection was read; refresh recommended.' });
  const projectsWithTasks = projectList.map((project) => ({ ...project, tasks: taskList.filter((task) => task.project_ids.includes(project.id)) }));
  return clean({ schema_version: DASHBOARD_SCHEMA_VERSION, generated_at: now.toISOString(), source: { root: resolved, read_only: true, newest_artifact_at: newest, freshness_seconds: newest ? Math.max(0, Math.floor((now.getTime() - Date.parse(newest)) / 1000)) : null }, health: { status: warnings.length ? 'degraded' : 'ok', warnings }, overview: { counts, queue_count: queueList.length, project_count: projectList.length, task_workspace_count: taskList.length, todo_count: control.todos.length, action_count: reservations.length, step_count: steps.length, reconciliation_required_steps: steps.filter((item) => item.state === 'reconciliation_required').length, production_trust: trustEvidence?.passed ? 'passed' : trustEvidence ? 'failed' : 'not_generated' }, projects: projectsWithTasks, task_workspaces: taskList, queues: queueList, todos: control.todos, agents: control.agents, handoffs: control.handoffs, gates: [...control.todos.filter((item) => ['parked', 'waiting_for_human', 'waiting_for_external_condition', 'timed_out_or_escalated'].includes(item.state)).map((item) => ({ todo_id: item.id, state: item.state, gate: item.gate, next_action: item.next_action })), ...taskList.flatMap((task) => task.gates.map((gate) => ({ task_id: task.id, ...gate })))], actions: reservations, execution_steps: steps, production_evidence: trustEvidence, cost: { quotas: control.quotas, requested_total: control.todos.reduce((sum, item) => sum + Number(item.cost?.amount ?? 0), 0) } });
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

function html(dataUrl = '/api/v1/overview?') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loop Engineering Workspace</title><style>:root{color-scheme:dark;--bg:#091018;--panel:#111c28;--line:#26384b;--muted:#91a5b8;--accent:#77d6c9}*{box-sizing:border-box}body{font:14px/1.5 ui-sans-serif,system-ui;margin:0;background:var(--bg);color:#eef6fb}header{position:sticky;top:0;z-index:2;padding:1rem clamp(1rem,4vw,3rem);background:#091018ee;border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}h1,h2,h3,p{margin:.2rem 0}.eyebrow,.muted{color:var(--muted)}main{padding:1.25rem clamp(1rem,4vw,3rem);display:grid;gap:1rem}.stats,.projects,.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.8rem}.card{background:linear-gradient(150deg,#142230,#0d1822);border:1px solid var(--line);border-radius:14px;padding:1rem;min-width:0}.stat strong{font-size:1.65rem}.bar{height:7px;background:#223141;border-radius:9px;overflow:hidden;margin:.75rem 0}.bar i{display:block;height:100%;background:var(--accent)}.pill{display:inline-block;padding:.15rem .5rem;border-radius:1rem;background:#24384a;color:#d9edf8}.ok{color:#7ee2a8}.warn{color:#ffcf70}button,input,select{padding:.65rem;background:#111d29;color:inherit;border:1px solid #3a5268;border-radius:8px}button.project{width:100%;text-align:left;font:inherit}button.project[aria-pressed=true]{border-color:var(--accent)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.6rem;border-bottom:1px solid var(--line);vertical-align:top}.scroll{overflow:auto}.timeline{border-left:2px solid var(--line);padding-left:1rem}.event{margin:.65rem 0}.project{cursor:pointer}.project:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}#detail:empty{display:none}.empty{padding:1rem;text-align:center;color:var(--muted)}@media(max-width:640px){header{position:static}.desktop{display:none}td,th{min-width:120px}.split{grid-template-columns:1fr}input,select{width:100%;margin-top:.4rem}}</style></head><body><header><div class="eyebrow">READ-ONLY OPERATOR WORKSPACE</div><h1>Loop Engineering</h1><p id="health" role="status" aria-live="polite">Loading durable artifacts…</p></header><main><section class="stats" id="stats" aria-label="Workspace summary"></section><section aria-labelledby="projects-title"><h2 id="projects-title">Projects</h2><p class="muted">Project completion is separate from milestone completion.</p><div class="projects" id="projects"></div></section><section class="card" id="detail" tabindex="-1" aria-live="polite"></section><section class="card"><div class="split"><div><h2>Operational queue</h2><p class="muted">Human gates, reservations and reconciliation remain visible and immutable here.</p></div><div><label>Search <input id="q" placeholder="Task, owner or action"></label><label>State <select id="s"><option value="">All states</option></select></label></div></div><div class="scroll"><table><thead><tr><th>State</th><th>Task</th><th class="desktop">Owner</th><th>Next action</th></tr></thead><tbody id="rows"></tbody></table></div></section></main><script>const dataUrl=${JSON.stringify(dataUrl)},initial=new URLSearchParams(location.search);const states=['runnable','active','parked','waiting_for_human','waiting_for_external_condition','timed_out_or_escalated','reconciliation_required','blocked','completed','failed'];s.innerHTML+=states.map(x=>'<option>'+x+'</option>').join('');q.value=initial.get('q')??'';s.value=initial.get('state')??'';let selected=initial.get('project'),model=null;const el=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text??'';if(cls)n.className=cls;return n};function syncUrl(){if(dataUrl.startsWith('./'))return;const p=new URLSearchParams();if(q.value)p.set('q',q.value);if(s.value)p.set('state',s.value);if(selected)p.set('project',selected);history.replaceState(null,'','?'+p)}function projectDetail(p,focus=false){selected=p.id;detail.replaceChildren();detail.append(el('h2',p.id),el('p',p.goal,'muted'));const c=p.terminal_contract;if(c){detail.append(el('h3','Terminal contract'),el('p',c.terminal_state?.userVisibleOutcome??'No user-visible outcome recorded'),el('p',c.milestone_rule??'','warn'))}detail.append(el('h3','Milestones'));const list=el('div');for(const m of p.milestones??[])list.append(el('p',(m.status??'pending')+' · '+m.title));detail.append(list,el('h3','Gates & reservations'));const operational=el('div');const gates=(p.tasks??[]).flatMap(x=>x.gates??[]);operational.append(el('p',(gates.length?gates.length+' human/external gate(s)':'No project gates')+' · '+model.actions.length+' workspace reservation(s)','muted'));detail.append(operational,el('h3','Acceptance & final judge timeline'));const tl=el('div',null,'timeline');const events=(p.tasks??[]).flatMap(x=>x.timeline??[]);if(!events.length)tl.append(el('p','No acceptance events yet.','empty'));for(const t of events)tl.append(el('div',(t.at??'undated')+' · '+t.type+' · '+t.status+' — '+(t.summary??''),'event'));detail.append(tl);syncUrl();drawProjects();if(focus)detail.focus()}function drawProjects(){projects.replaceChildren(...model.projects.map(p=>{const n=el('button',null,'card project');n.type='button';n.setAttribute('aria-pressed',String(selected===p.id));const done=p.project_summary?.completed_milestones??0,total=p.project_summary?.total_milestones??0;n.append(el('span',p.terminal_accepted?'PROJECT ACCEPTED':String(p.status).toUpperCase(),p.terminal_accepted?'pill ok':'pill'),el('h3',p.id),el('p',p.goal,'muted'));const b=el('div',null,'bar'),i=el('i');i.style.width=(total?done/total*100:0)+'%';b.append(i);n.append(b,el('p',done+' / '+total+' milestones'));n.onclick=()=>projectDetail(p,true);return n}));if(!model.projects.length)projects.append(el('p','No project artifacts found.','card empty'))}async function draw(){try{const params=new URLSearchParams({q:q.value,state:s.value});const response=await fetch(dataUrl+(dataUrl.includes('?')?params:''));if(!response.ok)throw new Error('HTTP '+response.status);model=await response.json();health.textContent=model.health.status+' · generated '+new Date(model.generated_at).toLocaleString()+' · source is read-only';stats.replaceChildren(...[['Projects',model.overview.project_count],['Task workspaces',model.overview.task_workspace_count],['Human gates',model.gates.length],['Reservations',model.overview.action_count]].map(([k,v])=>{const n=el('div',null,'card stat');n.append(el('div',k,'muted'),el('strong',v));return n}));drawProjects();const all=[...model.todos,...model.queues.flatMap(x=>x.tasks)];rows.replaceChildren(...all.map(x=>{const tr=el('tr');for(const [v,c] of [[x.state,''],[x.title,''],[x.owner??'—','desktop'],[x.next_action??'—','']])tr.append(el('td',String(v),c));return tr}));if(!all.length){const td=el('td','No matching operational work.','empty');td.colSpan=4;const tr=el('tr');tr.append(td);rows.append(tr)}const chosen=model.projects.find(p=>p.id===selected);if(chosen)projectDetail(chosen)}catch(error){health.textContent='Unable to load workspace · '+error.message;health.className='warn'}}q.oninput=()=>{syncUrl();draw()};s.onchange=()=>{syncUrl();draw()};addEventListener('popstate',()=>location.reload());draw()</script></body></html>`;
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
      else if (url.pathname === '/api/v1/projects') body = projection.projects;
      else if (url.pathname.startsWith('/api/v1/projects/')) body = projection.projects.find((item) => item.id === safeId(decodeURIComponent(url.pathname.slice('/api/v1/projects/'.length)))) ?? null;
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
  await writeFile(path.join(target, 'index.html'), html('./projection.json'));
  return { schema_version: DASHBOARD_SCHEMA_VERSION, output_dir: target, files: ['index.html', 'projection.json'], read_only_source: true };
}
