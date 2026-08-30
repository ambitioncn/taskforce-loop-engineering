import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const distributedSkillUrl = new URL('../skills/taskforce-loop-engineering/SKILL.md', import.meta.url);
const workspaceSkillUrl = new URL('../../../skills/taskforce-loop-engineering/SKILL.md', import.meta.url);
const skill = await readFile(distributedSkillUrl, 'utf8');

for (const forbidden of ['ironman-task-runner', 'ironman-task-runner.mjs']) {
  assert.equal(skill.includes(forbidden), false, `distributed skill contains local dispatcher reference: ${forbidden}`);
}

for (const required of ['agent-tasks', 'scripts/loops/openclaw-loop.mjs', 'scripts/loops/openclaw-loop-gate.mjs', 'configs/loops/queues/', 'feishu_signature_unverified', 'ignored_untrusted_chat', 'Dashboard and chat']) {
  assert.equal(skill.includes(required), true, `distributed skill is missing generic integration guidance: ${required}`);
}

try {
  await access(workspaceSkillUrl);
  const workspaceSkill = await readFile(workspaceSkillUrl, 'utf8');
  assert.equal(workspaceSkill, skill, 'workspace taskforce-loop-engineering skill drifted from the distributed skill');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log('distribution skill self-test passed');
