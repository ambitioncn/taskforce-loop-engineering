import { executeGateCommand, gateCard, getHumanGate, parseBoundReply } from './human-gate-command.mjs';

export async function renderGateForChannel(root, gateId) { return gateCard(await getHumanGate(root, gateId)); }

export async function handleChannelGateEvent(root, event, options = {}) {
  if (event.kind === 'card_button') {
    const receipt = await executeGateCommand(root, {
      gate_id: event.action?.gate_id, decision: event.action?.decision,
      expected_generation: event.action?.expected_generation, actor_id: event.actor_id,
      source_channel: event.channel, source_message_id: event.message_id, reply_to: event.reply_to ?? null,
      event_type: 'card_button', idempotency_key: event.event_id, reason: event.action?.reason
    }, options);
    return { ...receipt, synchronized_card: await renderGateForChannel(root, event.action?.gate_id) };
  }
  if (event.kind === 'message_reply' && event.reply_to) {
    const parsed = parseBoundReply(event.text); if (!parsed) return { outcome: 'ignored_untrusted_chat' };
    const receipt = await executeGateCommand(root, {
      ...parsed, expected_generation: event.expected_generation, actor_id: event.actor_id,
      source_channel: event.channel, source_message_id: event.card_message_id,
      reply_to: event.reply_to, event_type: 'bound_reply', idempotency_key: event.event_id
    }, options);
    return { ...receipt, synchronized_card: await renderGateForChannel(root, parsed.gate_id) };
  }
  const show = String(event.text ?? '').trim().match(/^\/show_gate\s+(gate_[a-zA-Z0-9._:-]+)$/);
  if (show) return { outcome: 'display_only', card: await renderGateForChannel(root, show[1]) };
  return { outcome: 'ignored_untrusted_chat' };
}

// Feishu callback feasibility mapping. It performs no network I/O.
export function normalizeFeishuGateEvent(payload, options = {}) {
  if (options.signatureVerified !== true) throw new Error('feishu_signature_unverified');
  if (payload?.event?.action?.value?.gate_id) return { kind: 'card_button', event_id: payload.header?.event_id, actor_id: payload.event.operator?.operator_id?.open_id, channel: 'feishu', message_id: payload.event.context?.open_message_id, action: payload.event.action.value };
  const message = payload?.event?.message;
  let text = message?.content;
  try { const parsed = JSON.parse(text); text = typeof parsed?.text === 'string' ? parsed.text : ''; } catch {}
  return { kind: message?.parent_id ? 'message_reply' : 'ordinary_message', event_id: payload.header?.event_id, actor_id: payload.event?.sender?.sender_id?.open_id, channel: 'feishu', card_message_id: message?.root_id, reply_to: message?.parent_id, text, expected_generation: payload.expected_generation };
}
