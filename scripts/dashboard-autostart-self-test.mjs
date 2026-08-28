#!/usr/bin/env node
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'loop-dashboard-autostart-'));
const mockSystemctl = path.join(root, 'systemctl.mjs');
const mockTailscale = path.join(root, 'tailscale.mjs');
const calls = path.join(root, 'calls.jsonl');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.SYSTEMCTL_CAPTURE = calls;
await writeFile(mockSystemctl, `#!/usr/bin/env node\nimport { appendFile } from 'node:fs/promises';\nawait appendFile(process.env.SYSTEMCTL_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
await chmod(mockSystemctl, 0o755);
await writeFile(mockTailscale, `#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') !== 'ip -4') process.exit(2);\nconsole.log('100.64.10.20');\n`);
await chmod(mockTailscale, 0o755);
const installer = new URL('./dashboard-autostart-install.mjs', import.meta.url).pathname;
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, [installer, '--root', root, '--port', '4174', '--systemctl-bin', mockSystemctl, '--confirm-install', '--json'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (result.code !== 0) throw new Error(result.stderr);
const report = JSON.parse(result.stdout);
if (report.status !== 'installed' || report.dashboard !== 'http://127.0.0.1:4174/') throw new Error('unexpected install report');
const unitDir = path.join(process.env.XDG_CONFIG_HOME, 'systemd', 'user');
const service = await readFile(path.join(unitDir, 'loop-engineering-dashboard.service'), 'utf8');
if (!service.includes('dashboard-serve') || !service.includes('--port 4174') || !service.includes('NoNewPrivileges=true')) throw new Error('dashboard service is incomplete');
for (const gateway of ['openclaw-gateway.service', 'hermes-gateway.service']) {
  const dropIn = await readFile(path.join(unitDir, `${gateway}.d`, 'loop-engineering-dashboard.conf'), 'utf8');
  if (!dropIn.includes('Wants=loop-engineering-dashboard.service') || !dropIn.includes('After=loop-engineering-dashboard.service')) throw new Error(`${gateway} is not wired to dashboard`);
}
if (!(await readFile(calls, 'utf8')).includes('["--user","daemon-reload"]')) throw new Error('systemd daemon was not reloaded');
const tailnetResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [installer, '--root', root, '--listen', 'tailscale', '--tailscale-bin', mockTailscale, '--port', '4174', '--systemctl-bin', mockSystemctl, '--confirm-install', '--json'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (tailnetResult.code !== 0) throw new Error(tailnetResult.stderr);
const tailnetReport = JSON.parse(tailnetResult.stdout);
if (tailnetReport.listen !== 'tailscale' || tailnetReport.dashboard !== 'http://100.64.10.20:4174/') throw new Error('unexpected Tailnet install report');
const tailnetService = await readFile(path.join(unitDir, 'loop-engineering-dashboard.service'), 'utf8');
if (!tailnetService.includes('--host 100.64.10.20') || !tailnetService.includes('--allow-non-loopback')) throw new Error('Tailnet dashboard service is incomplete');
console.log('dashboard autostart self-test passed');
