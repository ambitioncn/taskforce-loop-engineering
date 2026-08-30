import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectAction } from './action-reservations.mjs';
import { decideQuota } from './quota-runtime-decision.mjs';

const TODO_STATES = new Set(['runnable', 'blocked', 'claimed', 'handoff_pending', 'completed']);
const RISK = new Set(['low', 'medium', 'high', 'critical']);

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function id(value, label) {
  const result = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(result)) throw new Error(`${label} contains unsafe characters.`);
  return result;
}

function strings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of strings.`);
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function location(root) {
  const dir = path.join(root, 'runtime', 'loops', 'control-plane');
  return { dir, file: path.join(dir, 'state.json'), lock: path.join(dir, 'state.lock'), audit: path.join(dir, 'audit.jsonl') };
}

function emptyState() {
  return { version: 3, fencing_counter: 0, agents: {}, todos: {}, handoffs: {}, peer_messages: {}, conflicts: {}, wake_events: {}, quotas: {}, updated_at: null };
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
}

async function atomicWrite(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
}

async function acquire(lock, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
      else if (Date.now() >= deadline) throw new Error('Timed out acquiring control-plane mutex.');
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function transaction(root, operation) {
  const place = location(root);
  await mkdir(place.dir, { recursive: true });
  await acquire(place.lock);
  try {
    const state = await readState(place.file);
    state.version = Math.max(Number(state.version ?? 1), 3); state.agents ??= {}; state.todos ??= {}; state.handoffs ??= {}; state.peer_messages ??= {}; state.conflicts ??= {}; state.wake_events ??= {}; state.quotas ??= {};
    const result = await operation(state);
    if (result.changed) {
      state.updated_at = new Date().toISOString();
      await atomicWrite(place.file, state);
      if (result.event) await writeFile(place.audit, `${JSON.stringify(result.event)}\n`, { flag: 'a' });
    }
    return result.output;
  } finally { await rm(place.lock, { recursive: true, force: true }); }
}

function event(type, todo, extra = {}) {
  return { version: 1, event_id: randomUUID(), type, todo_id: todo.id, at: new Date().toISOString(), owner: todo.claim?.owner ?? null, fencing_token: todo.claim?.fencing_token ?? null, ...extra };
}

function normalizeAgent(input) {
  const authority = strings(input.authority_grants ?? input.authorityGrants, 'authority_grants');
  const maxConcurrent = Number(input.max_concurrent ?? input.maxConcurrent ?? 1000);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('max_concurrent must be a positive integer.');
  return {
    id: id(input.id ?? input.agent_id, 'agent id'), runtime: text(input.runtime ?? 'generic', 'runtime'),
    capabilities: strings(input.capabilities, 'capabilities'), authority_grants: authority,
    quota_grants: { ...(input.quota_grants ?? input.quotaGrants ?? {}) }, runtime_budget_limits: input.runtime_budget_limits ?? input.runtimeBudgetLimits,
    runtime_budget_spend: input.runtime_budget_spend ?? input.runtimeBudgetSpend, max_concurrent: maxConcurrent,
    wake: { mode: input.wake?.mode ?? 'inbox', target: input.wake?.target ?? null },
    status: input.status ?? 'available', metadata: input.metadata ?? {}, registered_at: new Date().toISOString()
  };
}

export async function registerAgent(root, input) {
  const agent = normalizeAgent(input);
  return transaction(root, async (state) => {
    const previous = state.agents[agent.id];
    state.agents[agent.id] = { ...agent, registered_at: previous?.registered_at ?? agent.registered_at, updated_at: new Date().toISOString() };
    return { changed: true, output: state.agents[agent.id], event: { version: 1, event_id: randomUUID(), type: previous ? 'agent_updated' : 'agent_registered', agent_id: agent.id, at: new Date().toISOString() } };
  });
}

function normalizeTodo(input) {
  const todoId = id(input.id, 'todo id');
  const risk = input.risk ?? 'low';
  if (!RISK.has(risk)) throw new Error(`Unsupported risk: ${risk}`);
  const priority = Number(input.priority ?? 0);
  const cost = Number(input.cost ?? input.cost_envelope?.amount ?? 0);
  if (!Number.isFinite(priority) || !Number.isFinite(cost) || cost < 0) throw new Error('priority and cost must be valid numbers.');
  const acceptance = input.acceptance_contract ?? input.acceptanceContract;
  if (!acceptance || typeof acceptance !== 'object') throw new Error('acceptance_contract is required.');
  const evidence = strings(input.evidence_requirements ?? input.evidenceRequirements, 'evidence_requirements');
  if (!evidence.length) throw new Error('evidence_requirements must not be empty.');
  const created = new Date().toISOString();
  return {
    version: 2, id: todoId, title: text(input.title, 'title'), project_id: input.project_id ?? input.projectId ?? null,
    dependencies: strings(input.dependencies, 'dependencies'), priority, risk, authority_class: text(input.authority_class ?? input.authorityClass ?? 'local', 'authority_class'),
    required_capabilities: strings(input.required_capabilities ?? input.requiredCapabilities, 'required_capabilities'), acceptance_contract: acceptance,
    evidence_requirements: evidence, cost_envelope: { quota: input.quota ?? input.cost_envelope?.quota ?? 'default', amount: cost },
    state: 'runnable', blocked_reasons: [], claim: null, handoff_id: null, parked: input.parked ?? null,
    authorization: input.authorization ?? null, idempotency_keys: strings(input.idempotency_keys ?? input.idempotencyKeys, 'idempotency_keys'),
    lineage: input.lineage ?? { root_todo_id: todoId, parent_todo_id: null }, context: input.context ?? {}, evidence: input.evidence ?? [],
    created_at: created, updated_at: created
  };
}

export async function createTodo(root, input) {
  const todo = normalizeTodo(input);
  return transaction(root, async (state) => {
    if (state.todos[todo.id]) throw new Error(`Todo already exists: ${todo.id}`);
    for (const dependency of todo.dependencies) if (dependency === todo.id) throw new Error('A todo cannot depend on itself.');
    state.todos[todo.id] = todo;
    return { changed: true, output: todo, event: event('todo_created', todo) };
  });
}

function capabilityEligible(agent, todo) { return todo.required_capabilities.every((item) => agent.capabilities.includes(item)); }
function authorityEligible(agent, todo) { return agent.authority_grants.includes('*') || agent.authority_grants.includes(todo.authority_class); }
function activeLoad(state, agentId) { return Object.values(state.todos).filter((todo) => ['claimed', 'handoff_pending'].includes(todo.state) && todo.claim?.owner === agentId).length; }

async function eligibility(root, state, todo, agent, now = Date.now()) {
  const reasons = [];
  if (!['runnable', 'blocked'].includes(todo.state)) reasons.push(`state:${todo.state}`);
  if (todo.parked && !['runnable', 'resumed'].includes(todo.parked.state)) reasons.push('parked_human_gate');
  const missing = todo.dependencies.filter((dep) => state.todos[dep]?.state !== 'completed');
  if (missing.length) reasons.push(`dependencies:${missing.join(',')}`);
  if (!capabilityEligible(agent, todo)) reasons.push('capability_mismatch');
  if (!authorityEligible(agent, todo)) reasons.push('authority_mismatch');
  if (agent.status !== 'available') reasons.push(`agent_status:${agent.status}`);
  if (activeLoad(state, agent.id) >= (agent.max_concurrent ?? 1)) reasons.push('agent_at_capacity');
  const quota = todo.cost_envelope.quota;
  const available = Number(agent.quota_grants?.[quota] ?? state.quotas?.[quota] ?? 0);
  const quotaDecision = decideQuota({
    has_work: true,
    limits: agent.runtime_budget_limits ?? { money_minor: available },
    spend: agent.runtime_budget_spend ?? {},
    request: todo.context?.runtime_budget_request ?? { money_minor: todo.cost_envelope.amount },
    lane_id: todo.context?.lane_id,
    lanes: todo.context?.lanes,
    external_condition_pending: todo.context?.external_condition_pending,
    repairable_error: todo.context?.repairable_error,
    can_wait_for_reset: todo.context?.can_wait_for_reset
  });
  if (quotaDecision.decision !== 'execute') reasons.push(quotaDecision.reason.startsWith('budget_exhausted:') ? 'quota_exhausted' : `quota_decision:${quotaDecision.decision}`);
  for (const key of todo.idempotency_keys) {
    const action = await inspectAction(root, key);
    if (action?.state === 'unknown') reasons.push(`action_reconciliation:${key}`);
    if (action?.state === 'claimed' && Date.parse(action.claim?.lease_expires_at ?? '') <= now) reasons.push(`action_reconciliation:${key}`);
  }
  return { eligible: reasons.length === 0, reasons, quota_decision: quotaDecision };
}

export async function matchTodo(root, input = {}) {
  const state = await readState(location(root).file);
  const requested = input.todo_id ?? input.todoId;
  const todos = requested ? [state.todos[id(requested, 'todo id')]].filter(Boolean) : Object.values(state.todos);
  const matches = [];
  for (const todo of todos.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const candidates = [];
    for (const agent of Object.values(state.agents)) {
      const check = await eligibility(root, state, todo, agent);
      const load = activeLoad(state, agent.id); const capacity = agent.max_concurrent ?? 1;
      const capabilitySurplus = agent.capabilities.filter((item) => !todo.required_capabilities.includes(item)).length;
      candidates.push({ agent_id: agent.id, runtime: agent.runtime, eligible: check.eligible, reasons: check.reasons, load, capacity, score: check.eligible ? (load / capacity) * 100 + capabilitySurplus : null, quota_decision: check.quota_decision });
    }
    candidates.sort((a, b) => (a.eligible === b.eligible ? 0 : a.eligible ? -1 : 1) || (a.score ?? Infinity) - (b.score ?? Infinity) || a.agent_id.localeCompare(b.agent_id));
    matches.push({ todo_id: todo.id, selected_agent_id: candidates.find((item) => item.eligible)?.agent_id ?? null, candidates });
  }
  return requested ? matches[0] ?? null : matches;
}

export async function wakeAgent(root, input) {
  const agentId = id(input.agent_id ?? input.agentId, 'agent id');
  return transaction(root, async (state) => {
    const agent = state.agents[agentId]; if (!agent) throw new Error(`Agent not registered: ${agentId}`);
    const todoId = id(input.todo_id ?? input.todoId, 'todo id'); if (!state.todos[todoId]) throw new Error(`Todo not found: ${todoId}`);
    const wakeId = id(input.wake_id ?? input.wakeId ?? `wake:${todoId}:${agentId}:${randomUUID()}`, 'wake id');
    const wake = { version: 1, id: wakeId, agent_id: agentId, todo_id: todoId, runtime: agent.runtime, mode: agent.wake?.mode ?? 'inbox', target: agent.wake?.target ?? null, reason: input.reason ?? 'matched_todo', state: 'pending', created_at: new Date().toISOString() };
    state.wake_events[wakeId] = wake;
    return { changed: true, output: wake, event: { version: 1, event_id: randomUUID(), type: 'agent_targeted_wake', agent_id: agentId, todo_id: todoId, wake_id: wakeId, at: wake.created_at } };
  });
}

export async function acknowledgeWake(root, input) {
  return transaction(root, async (state) => {
    const wake = state.wake_events[id(input.wake_id ?? input.wakeId, 'wake id')];
    if (!wake || wake.state !== 'pending') throw new Error('Pending wake not found.');
    if (wake.agent_id !== id(input.agent_id ?? input.agentId, 'agent id')) throw new Error('Only the targeted agent can acknowledge a wake.');
    wake.state = 'acknowledged'; wake.acknowledged_at = new Date().toISOString();
    return { changed: true, output: wake, event: { version: 1, event_id: randomUUID(), type: 'agent_wake_acknowledged', agent_id: wake.agent_id, todo_id: wake.todo_id, wake_id: wake.id, at: wake.acknowledged_at } };
  });
}

export async function sendPeerMessage(root, input) {
  return transaction(root, async (state) => {
    const from = id(input.from_agent_id ?? input.fromAgentId, 'from agent id'); const to = id(input.to_agent_id ?? input.toAgentId, 'to agent id');
    if (!state.agents[from] || !state.agents[to]) throw new Error('Both peer agents must be registered.');
    const todoId = id(input.todo_id ?? input.todoId, 'todo id'); if (!state.todos[todoId]) throw new Error(`Todo not found: ${todoId}`);
    const messageId = id(input.message_id ?? input.messageId ?? `peer:${todoId}:${randomUUID()}`, 'message id');
    const message = { version: 1, id: messageId, todo_id: todoId, from_agent_id: from, to_agent_id: to, kind: input.kind ?? 'collaboration', body: text(input.body, 'body'), evidence_refs: strings(input.evidence_refs ?? input.evidenceRefs, 'evidence_refs'), state: 'pending', created_at: new Date().toISOString() };
    state.peer_messages[messageId] = message;
    return { changed: true, output: message, event: { version: 1, event_id: randomUUID(), type: 'peer_message_created', message_id: messageId, todo_id: todoId, agent_id: to, at: message.created_at } };
  });
}

export async function resolveOwnershipConflict(root, input) {
  return transaction(root, async (state) => {
    const todo = state.todos[id(input.todo_id ?? input.todoId, 'todo id')]; if (!todo) throw new Error('Todo not found.');
    const winner = id(input.winner_agent_id ?? input.winnerAgentId, 'winner agent id'); if (!state.agents[winner]) throw new Error('Winner agent not registered.');
    const contenders = strings(input.contenders ?? [todo.claim?.owner, winner].filter(Boolean), 'contenders');
    const conflictId = id(input.conflict_id ?? input.conflictId ?? `conflict:${todo.id}:${randomUUID()}`, 'conflict id');
    const previous = todo.claim; const token = ++state.fencing_counter; const now = new Date();
    todo.state = 'claimed'; todo.claim = { owner: winner, fencing_token: token, claimed_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + Number(input.lease_ms ?? input.leaseMs ?? 60_000)).toISOString() }; todo.updated_at = now.toISOString();
    const conflict = { version: 1, id: conflictId, todo_id: todo.id, contenders, winner_agent_id: winner, previous_owner: previous?.owner ?? null, reason: text(input.reason, 'reason'), state: 'resolved', fencing_token: token, resolved_at: now.toISOString() };
    state.conflicts[conflictId] = conflict;
    const audit = event('ownership_conflict_resolved', todo, { conflict_id: conflictId, contenders, winner_agent_id: winner, previous_fencing_token: previous?.fencing_token ?? null }); todo.ownership_events = [...(todo.ownership_events ?? []), audit];
    return { changed: true, output: { conflict, todo }, event: audit };
  });
}

export async function teamWorkbench(root, input = {}) {
  const state = await readState(location(root).file); const now = Number(input.now ?? Date.now());
  const agents = Object.values(state.agents).map((agent) => ({ ...agent, load: activeLoad(state, agent.id), pending_wakes: Object.values(state.wake_events ?? {}).filter((wake) => wake.agent_id === agent.id && wake.state === 'pending').length, pending_messages: Object.values(state.peer_messages ?? {}).filter((message) => message.to_agent_id === agent.id && message.state === 'pending').length })).sort((a, b) => a.id.localeCompare(b.id));
  const todos = Object.values(state.todos); return { version: 1, generated_at: new Date(now).toISOString(), agents, todos, handoffs: Object.values(state.handoffs ?? {}), wake_events: Object.values(state.wake_events ?? {}), peer_messages: Object.values(state.peer_messages ?? {}), conflicts: Object.values(state.conflicts ?? {}), governance: { orphan_candidates: todos.filter((todo) => todo.claim && Date.parse(todo.claim.lease_expires_at) <= now).map((todo) => todo.id), ownership_conflicts: Object.values(state.conflicts ?? {}).filter((item) => item.state !== 'resolved').map((item) => item.id), unmatched_runnable: (await matchTodo(root)).filter((item) => !item.selected_agent_id).map((item) => item.todo_id) } };
}

export async function listTodos(root, options = {}) {
  const state = await readState(location(root).file);
  return Object.values(state.todos).filter((todo) => !options.state || todo.state === options.state).sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function inspectTodo(root, todoId) { return (await readState(location(root).file)).todos[id(todoId, 'todo id')] ?? null; }

export async function claimTodo(root, input) {
  const agentId = id(input.agent_id ?? input.agentId, 'agent id');
  const leaseMs = Number(input.lease_ms ?? input.leaseMs ?? 60_000);
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('lease_ms must be a positive integer.');
  return transaction(root, async (state) => {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`Agent not registered: ${agentId}`);
    const candidates = input.todo_id ?? input.todoId ? [state.todos[id(input.todo_id ?? input.todoId, 'todo id')]].filter(Boolean) : Object.values(state.todos);
    candidates.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const rejected = [];
    for (const todo of candidates) {
      const check = await eligibility(root, state, todo, agent);
      if (!check.eligible) { rejected.push({ todo_id: todo.id, reasons: check.reasons, quota_decision: check.quota_decision }); continue; }
      const now = new Date();
      const token = ++state.fencing_counter;
      todo.state = 'claimed'; todo.blocked_reasons = []; todo.updated_at = now.toISOString();
      todo.claim = { owner: agentId, fencing_token: token, claimed_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + leaseMs).toISOString() };
      const audit = event('todo_claimed', todo, { agent_id: agentId });
      todo.ownership_events = [...(todo.ownership_events ?? []), audit];
      return { changed: true, output: { claimed: true, todo, fencing_token: token }, event: audit };
    }
    return { changed: false, output: { claimed: false, reason: rejected[0]?.reasons?.[0] ?? 'no_eligible_todo', decision: rejected[0]?.quota_decision?.decision ?? 'silent', scheduler_hint: rejected[0]?.quota_decision?.scheduler_hint ?? null, rejected } };
  });
}

function assertClaim(todo, agentId, token) {
  if (!todo || todo.state !== 'claimed' || todo.claim?.owner !== agentId || todo.claim?.fencing_token !== Number(token)) throw new Error('Stale or invalid todo fencing token.');
  if (Date.parse(todo.claim.lease_expires_at) <= Date.now()) throw new Error('Todo lease has expired.');
}

export async function renewTodo(root, input) {
  return transaction(root, async (state) => {
    const todo = state.todos[id(input.todo_id ?? input.todoId, 'todo id')];
    assertClaim(todo, id(input.agent_id ?? input.agentId, 'agent id'), input.fencing_token ?? input.fencingToken);
    const leaseMs = Number(input.lease_ms ?? input.leaseMs ?? 60_000);
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('lease_ms must be a positive integer.');
    todo.claim.lease_expires_at = new Date(Date.now() + leaseMs).toISOString(); todo.updated_at = new Date().toISOString();
    const audit = event('todo_lease_renewed', todo);
    todo.ownership_events.push(audit);
    return { changed: true, output: todo, event: audit };
  });
}

export async function releaseTodo(root, input) {
  return transaction(root, async (state) => {
    const todo = state.todos[id(input.todo_id ?? input.todoId, 'todo id')];
    assertClaim(todo, id(input.agent_id ?? input.agentId, 'agent id'), input.fencing_token ?? input.fencingToken);
    const previous = todo.claim; todo.state = input.completed ? 'completed' : 'runnable'; todo.claim = null; todo.updated_at = new Date().toISOString();
    if (input.evidence) todo.evidence = [...todo.evidence, input.evidence];
    const audit = event(input.completed ? 'todo_completed' : 'todo_released', todo, { previous_owner: previous.owner, previous_fencing_token: previous.fencing_token, reason: input.reason ?? null });
    todo.ownership_events.push(audit);
    return { changed: true, output: todo, event: audit };
  });
}

export async function handoffTodo(root, input) {
  return transaction(root, async (state) => {
    const todo = state.todos[id(input.todo_id ?? input.todoId, 'todo id')];
    const source = id(input.agent_id ?? input.agentId, 'agent id');
    assertClaim(todo, source, input.fencing_token ?? input.fencingToken);
    const target = id(input.target_agent_id ?? input.targetAgentId, 'target agent id');
    if (!state.agents[target]) throw new Error(`Agent not registered: ${target}`);
    const targetCheck = await eligibility(root, { ...state, todos: { ...state.todos, [todo.id]: { ...todo, state: 'runnable' } } }, { ...todo, state: 'runnable' }, state.agents[target]);
    if (!targetCheck.eligible) throw new Error(`Target agent is ineligible: ${targetCheck.reasons.join(', ')}`);
    const handoffId = id(input.handoff_id ?? input.handoffId ?? `handoff:${todo.id}:${state.fencing_counter + 1}`, 'handoff id');
    const packet = { version: 1, id: handoffId, todo_id: todo.id, from_agent_id: source, to_agent_id: target, state: 'pending', created_at: new Date().toISOString(), lineage: todo.lineage, context: todo.context, evidence: todo.evidence, authorization: todo.authorization, idempotency_keys: todo.idempotency_keys, source_fencing_token: todo.claim.fencing_token };
    state.handoffs[handoffId] = packet; todo.state = 'handoff_pending'; todo.handoff_id = handoffId;
    const audit = event('handoff_created', todo, { handoff_id: handoffId, from_agent_id: source, to_agent_id: target }); todo.ownership_events.push(audit);
    return { changed: true, output: packet, event: audit };
  });
}

export async function decideHandoff(root, input) {
  return transaction(root, async (state) => {
    const packet = state.handoffs[id(input.handoff_id ?? input.handoffId, 'handoff id')];
    if (!packet || packet.state !== 'pending') throw new Error('Pending handoff not found.');
    const target = id(input.agent_id ?? input.agentId, 'agent id');
    if (packet.to_agent_id !== target) throw new Error('Only the target agent can decide a handoff.');
    const todo = state.todos[packet.todo_id];
    if (input.accept) {
      const check = await eligibility(root, { ...state, todos: { ...state.todos, [todo.id]: { ...todo, state: 'runnable' } } }, { ...todo, state: 'runnable' }, state.agents[target]);
      if (!check.eligible) throw new Error(`Target agent is no longer eligible: ${check.reasons.join(', ')}`);
      const token = ++state.fencing_counter; const now = new Date();
      todo.state = 'claimed'; todo.claim = { owner: target, fencing_token: token, claimed_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + Number(input.lease_ms ?? input.leaseMs ?? 60_000)).toISOString() };
      packet.state = 'accepted'; packet.decided_at = now.toISOString(); packet.target_fencing_token = token;
    } else {
      packet.state = 'rejected'; packet.decided_at = new Date().toISOString(); packet.reason = input.reason ?? null;
      if (todo.claim && Date.parse(todo.claim.lease_expires_at) > Date.now()) todo.state = 'claimed'; else { todo.state = 'runnable'; todo.claim = null; }
    }
    todo.handoff_id = null; todo.updated_at = new Date().toISOString();
    const audit = event(input.accept ? 'handoff_accepted' : 'handoff_rejected', todo, { handoff_id: packet.id, from_agent_id: packet.from_agent_id, to_agent_id: target }); todo.ownership_events.push(audit);
    return { changed: true, output: { packet, todo }, event: audit };
  });
}

export async function recoverTodos(root, input = {}) {
  return transaction(root, async (state) => {
    const results = []; const now = Number(input.now ?? Date.now()); const audits = [];
    for (const todo of Object.values(state.todos)) {
      if (!['claimed', 'handoff_pending'].includes(todo.state) || !todo.claim || Date.parse(todo.claim.lease_expires_at) > now) continue;
      if (todo.parked && !['runnable', 'resumed'].includes(todo.parked.state)) { results.push({ todo_id: todo.id, outcome: 'parked_not_recovered' }); continue; }
      const actionBlocks = [];
      for (const key of todo.idempotency_keys) { const action = await inspectAction(root, key); if (['claimed', 'unknown'].includes(action?.state)) actionBlocks.push(key); }
      const previous = todo.claim;
      if (actionBlocks.length) { todo.state = 'blocked'; todo.blocked_reasons = actionBlocks.map((key) => `action_reconciliation:${key}`); }
      else { todo.state = 'runnable'; todo.blocked_reasons = []; }
      todo.claim = null; todo.handoff_id = null; todo.updated_at = new Date(now).toISOString();
      const audit = event('todo_orphan_recovered', todo, { previous_owner: previous.owner, previous_fencing_token: previous.fencing_token, outcome: todo.state }); todo.ownership_events.push(audit); audits.push(audit);
      results.push({ todo_id: todo.id, outcome: todo.state, blocked_reasons: todo.blocked_reasons });
    }
    return { changed: results.length > 0, output: { recovered: results.length, results }, event: audits.length ? { version: 1, event_id: randomUUID(), type: 'recovery_batch', at: new Date().toISOString(), transitions: audits } : null };
  });
}

export async function importLegacyTodos(root, input = {}) {
  const queueRoot = path.join(root, 'runtime', 'loops'); const imported = [];
  for (const queue of await readdir(queueRoot, { withFileTypes: true }).catch(() => [])) {
    if (!queue.isDirectory() || queue.name === 'control-plane' || queue.name === 'action-reservations') continue;
    for (const subdir of ['inbox', 'waiting', 'active']) {
      const dir = path.join(queueRoot, queue.name, subdir);
      for (const file of await readdir(dir).catch(() => [])) {
        if (!file.endsWith('.json')) continue;
        const legacy = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        const legacyId = legacy.id ?? path.basename(file, '.json');
        try {
          const todo = await createTodo(root, { id: `legacy:${queue.name}:${legacyId}`, title: legacy.title ?? legacy.goal ?? legacyId, project_id: legacy.projectId ?? null, priority: legacy.priority ?? 0, risk: legacy.risk ?? 'medium', authority_class: legacy.authorityClass ?? 'local', required_capabilities: legacy.requiredCapabilities ?? ['loop-task'], dependencies: legacy.dependencies ?? [], acceptance_contract: legacy.acceptance_contract ?? { source: 'legacy', checks: legacy.checks ?? [] }, evidence_requirements: legacy.evidence_requirements ?? ['legacy-task-result'], quota: 'default', cost: 0, parked: subdir === 'waiting' ? (legacy.parked ?? { state: 'waiting_for_human' }) : null, context: { legacy_queue: queue.name, legacy_file: path.relative(root, path.join(dir, file)) }, lineage: legacy.lineage });
          imported.push(todo.id);
        } catch (error) { if (!String(error.message).startsWith('Todo already exists:')) throw error; }
      }
    }
  }
  return { imported: imported.length, todo_ids: imported };
}
