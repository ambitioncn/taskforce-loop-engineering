import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  implementation: await readFile(new URL('../lib/operator-dashboard.mjs', import.meta.url), 'utf8'),
  tests: await readFile(new URL('./operator-dashboard-self-test.mjs', import.meta.url), 'utf8'),
  docs: await readFile(new URL('../docs/operator-dashboard.md', import.meta.url), 'utf8'),
  contract: await readFile(new URL('../docs/operator-workspace-project.md', import.meta.url), 'utf8'),
  schema: await readFile(new URL('../templates/operator-projection.schema.json', import.meta.url), 'utf8')
};

const criteria = [
  ['terminal contract', files.implementation, 'terminal_contract'],
  ['milestone status', files.implementation, 'milestones'],
  ['total project acceptance', files.implementation, 'terminal_accepted'],
  ['revision lineage', files.implementation, 'revision_lineage'],
  ['human gates', files.implementation, 'human_input_context.json'],
  ['reservations', files.implementation, 'action-reservations'],
  ['acceptance review', files.implementation, 'acceptance_review'],
  ['independent final judge', files.implementation, 'final_judge'],
  ['project detail endpoint', files.implementation, '/api/v1/projects/'],
  ['read-only HTTP methods', files.implementation, "request.method !== 'GET'"],
  ['loopback safety', files.implementation, 'allowNonLoopback'],
  ['redaction', files.implementation, '[REDACTED]'],
  ['persistent URL state', files.implementation, 'history.replaceState'],
  ['keyboard controls', files.implementation, "n.type='button'"],
  ['live status', files.implementation, 'aria-live'],
  ['responsive viewport', files.implementation, '@media(max-width:640px)'],
  ['empty state', files.implementation, 'No matching operational work'],
  ['error state', files.implementation, 'Unable to load workspace'],
  ['static export', files.implementation, "html('./projection.json')"],
  ['schema task workspaces', files.schema, 'task_workspaces'],
  ['security tests', files.tests, '%2e%2e%2fsecret'],
  ['large workspace test', files.tests, '500 task projection'],
  ['operator docs', files.docs, 'responsive'],
  ['terminal completion rule', files.contract, 'No single page, milestone, checkpoint'],
  ['three milestones', files.contract, 'Release hardening']
];

for (const [name, body, token] of criteria) assert.ok(body.includes(token), `${name} criterion missing: ${token}`);
console.log(JSON.stringify({ outcome: 'accept', checks: criteria.length, accepted: criteria.map(([name]) => name) }, null, 2));
