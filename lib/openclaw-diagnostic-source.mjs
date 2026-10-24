import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

async function executableIdentity(command, root) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Missing OpenClaw executable');
  const candidates = command.includes(path.sep)
    ? [path.resolve(root, command)]
    : String(process.env.PATH || '').split(path.delimiter).map((dir) => path.resolve(root, dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* try next PATH entry */ }
  }
  throw new Error('Cannot resolve OpenClaw executable');
}

// Bind discovery to the recorded installation and its unchanged generated callers.
export async function verifyDiagnosticRuntime(args) {
  const manifest = JSON.parse(await readFile(path.join(args.root, 'runtime/loop-engineering-openclaw-install.json'), 'utf8'));
  if (manifest.status !== 'installed') throw new Error('OpenClaw installation is incomplete');
  const selected = await executableIdentity(args.openclawBin, args.root);
  const installed = await executableIdentity(manifest.openclawBin, args.root);
  if (selected !== installed) throw new Error('Diagnostic OpenClaw CLI differs from installed CLI; select the installed executable or explicitly repair the integration');
  for (const file of ['scripts/loops/openclaw-loop-notify.mjs', 'scripts/loops/openclaw-loop-dispatch.mjs']) {
    const entry = manifest.managedFiles?.find((item) => item.path === file);
    const content = await readFile(path.join(args.root, file));
    if (!entry?.sha256 || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw new Error('Installed notifier/dispatcher differs from install manifest; repair the integration before diagnostics');
    }
  }
  // Preserve the recorded invocation name: symlink names can select profiles.
  return manifest.openclawBin;
}

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
    if (!channel.trim() || !Array.isArray(accounts)) throw new Error('Malformed OpenClaw channel account list');
    for (const account of accounts) {
      if (typeof account !== 'string' || !account.trim()) throw new Error('Malformed OpenClaw account entry');
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

// Diagnostic subprocesses must not inherit a stale higher-precedence route.
export function diagnosticEnvironment(env = process.env) {
  const clean = { ...env };
  delete clean.LOOP_HUMAN_INPUT_SOURCE;
  delete clean.LOOP_NOTIFICATION_SOURCE;
  return clean;
}
