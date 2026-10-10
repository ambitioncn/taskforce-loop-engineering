import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Helpers shared by the OpenClaw and Hermes integration installers.

function locateBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const endIndex = text.indexOf(endMarker, start);
  if (endIndex === -1) throw new Error(`AGENTS.md has ${startMarker} without ${endMarker}; fix it by hand.`);
  const blockStart = text[start - 1] === '\n' ? start - 1 : start;
  let blockEnd = endIndex + endMarker.length;
  if (text[blockEnd] === '\n') blockEnd += 1;
  return { blockStart, blockEnd, existing: text.slice(blockStart, blockEnd) };
}

// Write the managed AGENTS.md block and return the exact block left in the
// file, which the manifest records so uninstall can remove it.
// - previousBlock: what this installer wrote last time (from its manifest).
//   An existing block that differs from it was edited by hand and is only
//   replaced with force.
// - Without a previous manifest, an existing block is kept unless force.
export async function applyManagedInstructions(file, block, { previousBlock, force = false, startMarker, endMarker }) {
  const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const found = locateBlock(text, startMarker, endMarker);
  if (!found) {
    await writeFile(file, `${text}${block}`);
    return block;
  }
  if (!force && previousBlock === undefined) return found.existing;
  if (!force && found.existing !== previousBlock) {
    throw new Error('The managed Loop Engineering block in AGENTS.md was edited by hand; restore it, remove it, or rerun with --force.');
  }
  await writeFile(file, `${text.slice(0, found.blockStart)}${block}${text.slice(found.blockEnd)}`);
  return block;
}

// Install the per-user dashboard unit unless it already serves another
// workspace. Returns the manifest record, including what to remove on
// uninstall.
export async function installDashboardUnlessShared({ root, listen, tailscaleBin, systemctlBin, run }) {
  const installer = fileURLToPath(new URL('./dashboard-autostart-install.mjs', import.meta.url));
  const args = [installer, '--root', root, '--listen', listen, '--tailscale-bin', tailscaleBin, '--systemctl-bin', systemctlBin, '--json'];
  const planned = await run(process.execPath, args, { cwd: root });
  if (planned.code !== 0) throw new Error(`Cannot plan Dashboard gateway autostart: ${(planned.stderr || planned.stdout).trim()}`);
  const plan = JSON.parse(planned.stdout);
  if (plan.conflict) return { listen, tailscaleBin, installed: false, skipped: plan.conflict };
  const installed = await run(process.execPath, [...args, '--confirm-install'], { cwd: root });
  if (installed.code !== 0) throw new Error(`Cannot install Dashboard gateway autostart: ${(installed.stderr || installed.stdout).trim()}`);
  const report = JSON.parse(installed.stdout);
  return {
    listen,
    tailscaleBin,
    installed: true,
    unit: 'loop-engineering-dashboard.service',
    service: report.service,
    serviceSha256: report.serviceSha256,
    dropIns: report.gatewayDropIns,
    dropInSha256: report.dropInSha256
  };
}
