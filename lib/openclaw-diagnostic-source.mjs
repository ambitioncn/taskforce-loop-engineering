// Discover through the selected CLI/profile; never read or print channel credentials.
export async function diagnosticSources(args, run) {
  const result = await run(args.openclawBin, ['channels', 'list', '--json'], { cwd: args.root });
  if (result.code !== 0) throw new Error('Cannot discover OpenClaw channels for this profile');
  let chat;
  try { chat = JSON.parse(result.stdout).chat; } catch { throw new Error('Invalid OpenClaw channels JSON'); }
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw new Error('Missing OpenClaw chat channel inventory');
  const sources = [];
  for (const [channel, entry] of Object.entries(chat)) {
    if (args.sourceChannel && channel !== args.sourceChannel) continue;
    const accounts = Array.isArray(entry) ? entry : entry?.accounts;
    if (!Array.isArray(accounts)) continue;
    for (const account of accounts) {
      if (typeof account !== 'string' || !account.trim()) continue;
      if (args.sourceAccount && account !== args.sourceAccount) continue;
      sources.push({ channel, account, target: args.sourceTarget || diagnosticTarget(channel), reply_to: '1' });
    }
  }
  if (!sources.length) throw new Error('No matching configured IM channel/account; check the selected OpenClaw profile or --source-channel/--source-account');
  return sources;
}
function diagnosticTarget(channel) {
  if (channel === 'telegram') return '1';
  if (channel === 'discord') return 'channel:100000000000000001';
  if (channel === 'slack') return 'channel:C00000000000';
  if (channel === 'whatsapp' || channel === 'signal') return '+12025550100';
  if (channel === 'feishu') return 'user:loop-diagnostic-dry-run';
  return 'loop-diagnostic-dry-run';
}
