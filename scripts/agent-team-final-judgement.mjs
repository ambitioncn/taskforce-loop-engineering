#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const contractPath = path.resolve(option('--contract', 'docs/agent-team-terminal-contract.json'));
const backlogPath = path.resolve(option('--backlog', 'docs/agent-team-backlog.json'));
const evidenceOption = option('--evidence');
if (!evidenceOption) throw new Error('--evidence is required');
const evidencePath = path.resolve(evidenceOption);
const outputPath = option('--output');
const [contract, backlog, evidence] = await Promise.all([contractPath, backlogPath, evidencePath].map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
const runtimeNames = new Set(evidence.results?.filter((item) => item.available && item.task_probe?.passed).map((item) => item.runtime));
const checks = {
  terminal_contract_complete: contract.status === 'complete' && contract.requirements.every((item) => item.status === 'done'),
  backlog_terminal: backlog.items.every((item) => item.status === 'done'),
  real_not_simulated: evidence.kind === 'live_agent_team_task_conformance' && evidence.simulated === false,
  all_runtime_tasks_passed: evidence.passed === true && ['openclaw', 'codex-cli', 'claude-code'].every((runtime) => runtimeNames.has(runtime))
};
const passed = Object.values(checks).every(Boolean);
const judgement = { version: 1, project: contract.project, generated_at: new Date().toISOString(), passed, status: passed ? 'accepted' : 'needs_revision', checks, evidence: { contract: contractPath, backlog: backlogPath, live_runtime: evidencePath } };
if (outputPath) await writeFile(path.resolve(outputPath), `${JSON.stringify(judgement, null, 2)}\n`);
console.log(JSON.stringify(judgement, null, 2));
if (!passed) process.exitCode = 2;
