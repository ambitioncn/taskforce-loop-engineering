#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const specs = [
  { runtime: 'openclaw', executable: process.env.LOOP_OPENCLAW_BIN ?? 'openclaw' },
  { runtime: 'codex-cli', executable: process.env.LOOP_CODEX_BIN ?? 'codex' },
  { runtime: 'claude-code', executable: process.env.LOOP_CLAUDE_BIN ?? 'claude' }
];
const runTasks = process.argv.includes('--run-tasks');
const taskToken = `LOOP_AGENT_TEAM_CONFORMANCE_${randomUUID()}`;
const prompt = `Return exactly this token and nothing else: ${taskToken}`;
const taskArgs = {
  openclaw: ['agent', '--agent', process.env.LOOP_OPENCLAW_AGENT ?? 'main', '--session-key', `agent:${process.env.LOOP_OPENCLAW_AGENT ?? 'main'}:loop-conformance-${randomUUID()}`, '--message', prompt, '--thinking', 'off', '--timeout', '120', '--json'],
  'codex-cli': ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', prompt],
  'claude-code': ['--print', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', '--model', process.env.LOOP_CLAUDE_MODEL ?? 'haiku', '--max-budget-usd', process.env.LOOP_CLAUDE_MAX_BUDGET_USD ?? '0.10', prompt]
};

function taskOutputMatches(runtime, stdout) {
  if (runtime === 'openclaw') {
    try {
      const parsed = JSON.parse(stdout);
      const texts = parsed?.result?.payloads?.map((item) => item.text).filter(Boolean) ?? [];
      return texts.length === 1 && texts[0].trim() === taskToken;
    } catch { return false; }
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) === taskToken;
}

const results = specs.map((spec) => {
  const probe = spawnSync(spec.executable, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const available = !probe.error && probe.status === 0;
  const result = { runtime: spec.runtime, executable: spec.executable, available, version: available ? (probe.stdout || probe.stderr).trim() : null, error: available ? null : (probe.error?.code ?? `exit_${probe.status}`), task_probe: null };
  if (available && runTasks) {
    const task = spawnSync(spec.executable, taskArgs[spec.runtime], { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const output = `${task.stdout ?? ''}\n${task.stderr ?? ''}`;
    const tokenMatches = output.split(taskToken).length - 1;
    const semanticMatch = taskOutputMatches(spec.runtime, task.stdout ?? '');
    result.task_probe = {
      attempted: true,
      passed: !task.error && task.status === 0 && semanticMatch,
      exit_status: task.status,
      signal: task.signal,
      token_match_count: tokenMatches,
      semantic_output_match: semanticMatch,
      error: task.error?.code ?? null,
      output_bytes: Buffer.byteLength(output)
    };
  }
  return result;
});
const unavailable = results.filter((item) => !item.available);
const failedTasks = runTasks ? results.filter((item) => !item.task_probe?.passed) : [];
const evidence = { version: 2, kind: runTasks ? 'live_agent_team_task_conformance' : 'live_agent_team_conformance_preflight', generated_at: new Date().toISOString(), passed: unavailable.length === 0 && failedTasks.length === 0, simulated: false, task_probe_requested: runTasks, task_contract: runTasks ? { operation: 'exact-token-response', external_delivery: false, filesystem_write_requested: false, unique_token: true } : null, results, next_action: unavailable.length ? 'install_or_bind_missing_runtime_executables_then_run_runtime_specific_task_probes' : failedTasks.length ? 'inspect_failed_runtime_task_probe' : runTasks ? 'run_full_regression_packaged_install_and_terminal_judgement' : 'rerun_with_--run-tasks' };
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) await writeFile(path.resolve(process.argv[outputIndex + 1]), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 2;
