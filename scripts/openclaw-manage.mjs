#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function parseArgs(argv) {
  const out = { root: process.cwd(), action: 'uninstall-plan', json: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--action') out.action = argv[++i];
    else if (arg === '--confirm-uninstall' || arg === '--confirm-upgrade') out.confirm = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('Usage: loop-engineering-openclaw-manage --action upgrade-plan|upgrade|uninstall-plan|uninstall [--root workspace] [--confirm-upgrade|--confirm-uninstall] [--json]'); return; }
  if (!['upgrade-plan', 'upgrade', 'uninstall-plan', 'uninstall'].includes(args.action)) throw new Error('Unsupported action.');
  if (args.action === 'uninstall' && !args.confirm) throw new Error('uninstall requires --confirm-uninstall.');
  if (args.action === 'upgrade' && !args.confirm) throw new Error('upgrade requires --confirm-upgrade.');
  const manifestFile = path.join(args.root, 'runtime', 'loop-engineering-openclaw-install.json');
  if (!await exists(manifestFile)) throw new Error('OpenClaw integration manifest not found; refusing unmanaged removal.');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const files = [];
  for (const entry of manifest.managedFiles || []) {
    const file = path.join(args.root, entry.path);
    const present = await exists(file);
    const current = present ? await readFile(file, 'utf8') : '';
    files.push({ path: entry.path, present, clean: present && sha256(current) === entry.sha256 });
  }
  const agentsFile = path.join(args.root, manifest.managedInstructions?.path || 'AGENTS.md');
  const agentsText = await exists(agentsFile) ? await readFile(agentsFile, 'utf8') : '';
  const block = manifest.managedInstructions?.content || '';
  const instructionsClean = Boolean(block) && sha256(block) === manifest.managedInstructions?.sha256 && agentsText.includes(block);
  const modified = files.filter((item) => item.present && !item.clean).map((item) => item.path);
  const plan = { version: 1, action: args.action, readOnly: args.action.endsWith('-plan'), queue: manifest.queue, workerAgent: manifest.workerAgent, files, instructionsClean, modified, retained: manifest.retainedOnUninstall || [], ready: modified.length === 0 && instructionsClean };
  if (args.action === 'uninstall') {
    if (!plan.ready) throw new Error(`Refusing uninstall because managed content changed: ${[...modified, ...(!instructionsClean ? ['AGENTS.md managed block'] : [])].join(', ')}`);
    for (const item of files) if (item.present && item.clean) await rm(path.join(args.root, item.path), { force: true });
    await writeFile(agentsFile, agentsText.replace(block, ''));
    await rm(manifestFile, { force: true });
    plan.status = 'uninstalled'; plan.readOnly = false;
  } else if (args.action === 'upgrade') {
    if (!plan.ready) throw new Error(`Refusing upgrade because managed content changed: ${[...modified, ...(!instructionsClean ? ['AGENTS.md managed block'] : [])].join(', ')}`);
    const installer = new URL('./openclaw-install.mjs', import.meta.url).pathname;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [installer, '--root', args.root, '--queue', manifest.queue, '--worker-agent', manifest.workerAgent, '--openclaw-bin', manifest.openclawBin || 'openclaw', '--confirm-install', '--force', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) throw new Error(`upgrade installer failed: ${result.stderr || result.stdout}`);
    plan.status = 'upgraded'; plan.readOnly = false;
  } else plan.status = plan.ready ? 'ready' : 'review_required';
  console.log(args.json ? JSON.stringify(plan, null, 2) : `OpenClaw integration ${args.action}: ${plan.status}\nmodified: ${modified.join(', ') || 'none'}\nretained: ${plan.retained.join(', ') || 'none'}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
