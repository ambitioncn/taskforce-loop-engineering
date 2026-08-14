import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function exists(file) { try { await access(file); return true; } catch { return false; } }

export async function planIronmanUpgrade(root, desired = []) {
  const manifestFile = path.join(root, 'runtime', 'loop-engineering-openclaw-install.json');
  const manifest = await exists(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : null;
  const known = new Map((manifest?.managedFiles ?? []).map((item) => [item.path, item.sha256]));
  const entries = [];
  for (const item of desired) {
    const target = path.join(root, item.path); const present = await exists(target);
    const current = present ? await readFile(target, 'utf8') : null;
    const managedClean = present && known.has(item.path) && known.get(item.path) === sha256(current);
    const customized = present && !managedClean;
    entries.push({ path: item.path, present, customized, action: !present ? 'create' : managedClean ? 'replace_managed' : 'preserve_customized', desiredSha256: sha256(item.content), currentSha256: present ? sha256(current) : null });
  }
  return {
    version: 1, layout: manifest ? 'managed' : desired.some((item) => item.path.includes('ironman')) ? 'custom_ironman' : 'unmanaged',
    readOnly: true, entries, destructive: false, readyToApply: entries.every((item) => !item.customized),
    backupRequired: entries.some((item) => item.present), rollback: { strategy: 'restore_byte_exact_backup', requiredBeforeApply: true }
  };
}
