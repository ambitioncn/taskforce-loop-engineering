import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skill = await readFile(new URL('../skills/taskforce-loop-engineering/SKILL.md', import.meta.url), 'utf8');

for (const forbidden of ['ironman-task-runner', 'ironman-task-runner.mjs']) {
  assert.equal(skill.includes(forbidden), false, `distributed skill contains local dispatcher reference: ${forbidden}`);
}

for (const required of ['agent-tasks', 'scripts/loops/openclaw-loop.mjs', 'configs/loops/queues/']) {
  assert.equal(skill.includes(required), true, `distributed skill is missing generic integration guidance: ${required}`);
}

console.log('distribution skill self-test passed');
