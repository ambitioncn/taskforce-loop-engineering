import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/isolated-verify.py');

export function validateIsolatedVerification(config) {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !Array.isArray(config.inputs) || !config.inputs.length ||
      config.inputs.some((name) => typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..'))) {
    throw new Error('worktree.isolatedVerification.inputs must be nonempty safe relative paths.');
  }
  if (config.runtimeFiles !== undefined && (!Array.isArray(config.runtimeFiles) ||
      config.runtimeFiles.some((name) => typeof name !== 'string' || !name.startsWith('/home/') ||
        name.split('/').includes('..') || path.normalize(name) !== name))) {
    throw new Error('worktree.isolatedVerification.runtimeFiles must be absolute /home files.');
  }
}

export async function runIsolatedVerification({ cwd, command, inputs, runtimeFiles = [], evidenceDir, timeoutMs, runCommand, shellQuote }) {
  const runnerHash = createHash('sha256').update(await readFile(runner)).digest('hex');
  const commandLine = ['python3', runner, '--root', cwd, '--inputs-json', JSON.stringify(inputs),
    '--runtime-files-json', JSON.stringify(runtimeFiles), '--command', command, '--evidence', evidenceDir,
    '--timeout', String(Math.max(1, Math.ceil((timeoutMs ?? 300000) / 1000)))].map(shellQuote).join(' ');
  const result = await runCommand(commandLine, { cwd, timeoutMs: (timeoutMs ?? 300000) + 10000 });
  let terminal = null;
  try { terminal = JSON.parse(await readFile(path.join(evidenceDir, 'terminal.json'), 'utf8')); } catch { /* no receipt is failure */ }
  const afterHash = createHash('sha256').update(await readFile(runner)).digest('hex');
  const accepted = result.exitCode === 0 && !result.timedOut && runnerHash === afterHash &&
    terminal?.version === 1 && terminal.status === 'passed' && terminal.command === command &&
    /^[0-9a-f]{64}$/.test(terminal.input_digest ?? '') && terminal.exit_code === 0 &&
    terminal.read_trace_verified === true && terminal.snapshot_unchanged === true &&
    terminal.source_unchanged === true && terminal.process_group_gone === true &&
    terminal.host_tools_unchanged === true && terminal.runtime_files_unchanged === true;
  return {
    ...result,
    exitCode: accepted ? 0 : 1,
    isolation: { status: accepted ? 'passed' : 'failed_or_unknown', evidenceDir,
      inputDigest: terminal?.input_digest ?? null, runnerSha256: runnerHash }
  };
}

export function isolatedEvidenceDir(base, index) {
  return path.join(base, `isolation-${index + 1}-${randomUUID()}`);
}
