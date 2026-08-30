import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DECISIONS = new Set(['approve', 'reject', 'request_revision']);
const SOURCES = new Set(['card_button', 'bound_reply']);

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`missing_${name}`);
  return String(value);
}

function safe(value, name) {
  const text = required(value, name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,299}$/.test(text)) throw new Error(`invalid_${name}`);
  return text;
}

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function gateDir(root) { return path.join(root, 'runtime', 'loops', 'human-gates'); }
function gateFile(root, gateId) { return path.join(gateDir(root), 'gates', `${safe(gateId, 'gate_id')}.json`); }
function receiptFile(root, key) { return path.join(gateDir(root), 'receipts', `${digest(key)}.json`); }

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function lock(root, gateId, callback) {
  const lockFile = path.join(gateDir(root), 'locks', `${safe(gateId, 'gate_id')}.lock`);
  await mkdir(path.dirname(lockFile), { recursive: true });
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('gate_conflict_retry'); throw error; }
  try { return await callback(); }
  finally { await handle.close(); await rm(lockFile, { force: true }); }
}

function publicGate(gate) {
  return {
    gate_id: gate.gate_id, project: gate.project, task: gate.task, action: gate.action,
    reason: gate.reason, impact: gate.impact, risk: gate.risk, cost: gate.cost,
    evidence: gate.evidence, dashboard_url: gate.dashboard_url, expiry: gate.expiry,
    generation: gate.generation, status: gate.status, decisions: [...DECISIONS],
    confirmation_required: gate.confirmation_required,
    source_binding: gate.source_binding, source_bindings: gate.source_bindings,
    processed: gate.processed ?? null
  };
}

export async function createHumanGate(root, input, options = {}) {
  const gateId = safe(input.gate_id ?? `gate_${randomUUID()}`, 'gate_id');
  const now = options.now ?? new Date().toISOString();
  const risk = input.risk ?? { level: 'low', reasons: [] };
  const highRisk = input.confirmation_required ?? (
    ['high', 'critical'].includes(String(risk.level).toLowerCase()) ||
    Boolean(input.production || input.external_publish || input.irreversible || Number(input.cost?.amount ?? 0) >= Number(input.cost?.confirmation_threshold ?? Infinity))
  );
  const bindingsInput = input.source_bindings ?? [input.source_binding];
  const sourceBindings = bindingsInput.map((binding) => ({
    channel: required(binding?.channel, 'source_channel'), message_id: required(binding?.message_id, 'source_message_id'),
    reply_to: binding?.reply_to ? String(binding.reply_to) : String(binding?.message_id), adapter: binding?.adapter ?? null
  }));
  const gate = {
    version: 1, gate_id: gateId, project: required(input.project, 'project'), task: required(input.task, 'task'),
    action: required(input.action, 'action'), reason: required(input.reason, 'reason'), impact: required(input.impact, 'impact'),
    risk, cost: input.cost ?? { amount: 0, currency: 'CNY', budget: null }, evidence: input.evidence ?? [],
    dashboard_url: input.dashboard_url ?? null, expiry: required(input.expiry, 'expiry'), generation: Number(input.generation ?? 1),
    status: 'pending', confirmation_required: highRisk, confirmation: null,
    allowed_actors: (input.allowed_actors ?? []).map(String),
    source_binding: sourceBindings[0], source_bindings: sourceBindings,
    revision_history: [], created_at: now, updated_at: now
  };
  if (!Number.isInteger(gate.generation) || gate.generation < 1 || Number.isNaN(Date.parse(gate.expiry))) throw new Error('invalid_gate_generation_or_expiry');
  const file = gateFile(root, gateId);
  await mkdir(path.dirname(file), { recursive: true });
  try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(gate, null, 2)}\n`); await handle.close(); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('gate_already_exists'); throw error; }
  return publicGate(gate);
}

export async function getHumanGate(root, gateId) { return publicGate(await readJson(gateFile(root, gateId))); }

function validateBinding(gate, command, now) {
  if (!DECISIONS.has(command.decision)) throw new Error('invalid_decision');
  if (!SOURCES.has(command.event_type)) throw new Error('untrusted_event_type');
  if (Number(command.expected_generation) !== gate.generation) throw new Error('stale_generation');
  if (gate.status !== 'pending' && gate.status !== 'awaiting_confirmation') throw new Error('gate_already_processed');
  if (Date.parse(gate.expiry) <= Date.parse(now)) throw new Error('gate_expired');
  const actor = required(command.actor_id, 'actor_id');
  if (gate.allowed_actors.length && !gate.allowed_actors.includes(actor)) throw new Error('actor_unauthorized');
  const channel = required(command.source_channel, 'source_channel'); const messageId = required(command.source_message_id, 'source_message_id');
  const binding = (gate.source_bindings ?? [gate.source_binding]).find((item) => item.channel === channel && item.message_id === messageId);
  if (!binding) throw new Error((gate.source_bindings ?? [gate.source_binding]).some((item) => item.channel === channel) ? 'source_message_mismatch' : 'source_channel_mismatch');
  if (command.event_type === 'bound_reply' && required(command.reply_to, 'reply_to') !== binding.reply_to) throw new Error('reply_binding_mismatch');
  if (command.event_type === 'bound_reply' && required(command.gate_id, 'gate_id') !== gate.gate_id) throw new Error('reply_gate_id_required');
}

export async function executeGateCommand(root, command, options = {}) {
  const gateId = safe(command.gate_id, 'gate_id');
  const idempotencyKey = required(command.idempotency_key, 'idempotency_key');
  const priorFile = receiptFile(root, idempotencyKey);
  try { const prior = await readJson(priorFile); if (prior.command_fingerprint !== digest(command)) throw new Error('idempotency_key_reused'); return { ...prior, replayed: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return lock(root, gateId, async () => {
    try { const prior = await readJson(priorFile); if (prior.command_fingerprint !== digest(command)) throw new Error('idempotency_key_reused'); return { ...prior, replayed: true }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = gateFile(root, gateId); const gate = await readJson(file); const now = options.now ?? new Date().toISOString();
    validateBinding(gate, command, now);
    const before = gate.generation; let outcome;
    if (command.decision === 'approve' && gate.confirmation_required && gate.status !== 'awaiting_confirmation') {
      gate.status = 'awaiting_confirmation'; gate.generation += 1;
      gate.confirmation = { first_actor_id: command.actor_id, first_receipt_at: now };
      outcome = 'confirmation_required';
    } else if (command.decision === 'request_revision') {
      gate.revision_history.push({ generation: gate.generation, reason: required(command.reason, 'revision_reason'), actor_id: command.actor_id, at: now });
      gate.generation += 1; gate.status = 'pending'; gate.reason = command.reason;
      gate.processed = { decision: 'request_revision', actor_id: command.actor_id, at: now, superseded_generation: before };
      outcome = 'revision_created';
    } else {
      gate.status = command.decision === 'approve' ? 'approved' : 'rejected';
      gate.processed = { decision: command.decision, actor_id: command.actor_id, at: now, generation: before };
      outcome = gate.status;
    }
    gate.updated_at = now;
    const receipt = {
      version: 1, receipt_id: `receipt_${randomUUID()}`, gate_id: gateId, decision: command.decision, outcome,
      actor_id: command.actor_id, event_type: command.event_type, source_channel: command.source_channel,
      source_message_id: command.source_message_id, reply_to: command.reply_to ?? null,
      expected_generation: Number(command.expected_generation), resulting_generation: gate.generation,
      idempotency_key: idempotencyKey, command_fingerprint: digest(command), created_at: now, replayed: false
    };
    await atomicJson(file, gate);
    if (outcome === 'revision_created') await atomicJson(path.join(gateDir(root), 'revisions', `${gateId}.generation-${gate.generation}.json`), {
      version: 1, gate_id: gateId, amendment_type: 'request_revision', supersedes_generation: before,
      generation: gate.generation, reason: command.reason, actor_id: command.actor_id, source_receipt_id: receipt.receipt_id, created_at: now
    });
    await atomicJson(priorFile, receipt);
    return receipt;
  });
}

export function parseBoundReply(text) {
  const match = String(text ?? '').trim().match(/^\/(approve|reject|request_revision)\s+(gate_[a-zA-Z0-9._:-]+)(?:\s+(.+))?$/);
  if (!match) return null;
  return { decision: match[1], gate_id: match[2], reason: match[3] ?? null };
}

export function gateCard(gate) {
  const g = publicGate(gate);
  return { type: 'human_gate_card', title: `${g.project} · Human Gate`, fields: g, buttons: [...DECISIONS].map((decision) => ({ decision, gate_id: g.gate_id, expected_generation: g.generation, disabled: !['pending', 'awaiting_confirmation'].includes(g.status) })) };
}

export async function listHumanGates(root) {
  const dir = path.join(gateDir(root), 'gates');
  const names = (await import('node:fs/promises')).readdir(dir).catch(() => []);
  return Promise.all((await names).filter((name) => name.endsWith('.json')).sort().map(async (name) => publicGate(await readJson(path.join(dir, name)))));
}
