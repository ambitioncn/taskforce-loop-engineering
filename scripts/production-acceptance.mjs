import { spawn } from 'node:child_process';
const commands = [
  ['node', ['scripts/runtime-adapter-contract-self-test.mjs']], ['node', ['scripts/durable-journal-self-test.mjs']],
  ['node', ['scripts/upgrade-planner-self-test.mjs']], ['node', ['scripts/production-soak.mjs']],
  ['node', ['scripts/async-acceptance-refresh-self-test.mjs']], ['node', ['examples/safe-canary.mjs']]
];
for (const [command, args] of commands) await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'inherit' }); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))); });
console.log('production trust acceptance passed');
