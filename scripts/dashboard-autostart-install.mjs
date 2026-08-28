#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = { root: process.cwd(), listen: 'localhost', host: null, port: 4174, tailscaleBin: 'tailscale', systemctlBin: 'systemctl', confirmInstall: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') out.root = path.resolve(argv[++i]);
    else if (arg === '--listen') out.listen = argv[++i];
    else if (arg === '--host') out.host = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--tailscale-bin') out.tailscaleBin = argv[++i];
    else if (arg === '--systemctl-bin') out.systemctlBin = argv[++i];
    else if (arg === '--confirm-install') out.confirmInstall = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['localhost', 'tailscale'].includes(out.listen)) throw new Error('--listen must be localhost or tailscale.');
  if (out.host && out.listen === 'tailscale') throw new Error('--host cannot be combined with --listen tailscale.');
  if (out.host && !['127.0.0.1', '::1', 'localhost'].includes(out.host)) throw new Error('--host only accepts a loopback address; use --listen tailscale for Tailnet access.');
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
  return out;
}

function systemdEscapePath(value) {
  return [...value].map((character) => {
    if (/[A-Za-z0-9_/:.\-]/.test(character)) return character;
    return `\\x${character.codePointAt(0).toString(16).padStart(2, '0')}`;
  }).join('');
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: loop-engineering-dashboard-autostart-install --root <workspace> [--listen localhost|tailscale] [--port 4174] [--tailscale-bin tailscale] [--confirm-install] [--json]');
  process.exit(0);
}

const packageRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(packageRoot, 'bin', 'loop-engineering.mjs');
const userSystemdDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
const dashboardUnit = 'loop-engineering-dashboard.service';
const gatewayUnits = ['openclaw-gateway.service', 'hermes-gateway.service'];
const servicePath = path.join(userSystemdDir, dashboardUnit);
const host = args.listen === 'localhost' ? (args.host || '127.0.0.1') : await (async () => {
  const result = await run(args.tailscaleBin, ['ip', '-4']);
  if (result.code !== 0) throw new Error(`Cannot resolve Tailscale IPv4 address: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  const addresses = result.stdout.split(/\s+/).filter(Boolean);
  if (addresses.length !== 1 || !/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(addresses[0])) throw new Error(`Expected exactly one Tailscale IPv4 address, received: ${addresses.join(', ') || 'none'}`);
  return addresses[0];
})();
const nonLoopback = args.listen === 'tailscale' ? ' --allow-non-loopback' : '';
const service = `[Unit]\nDescription=Taskforce Loop Engineering read-only project workspace\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscapePath(args.root)}\nExecStart=${systemdEscapePath(process.execPath)} ${systemdEscapePath(cli)} dashboard-serve --root ${systemdEscapePath(args.root)} --host ${host} --port ${args.port}${nonLoopback}\nRestart=on-failure\nRestartSec=3s\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
const dropIn = `[Unit]\nWants=${dashboardUnit}\nAfter=${dashboardUnit}\n`;
const report = {
  status: args.confirmInstall ? 'installed' : 'plan_only',
  listen: args.listen,
  host,
  dashboard: `http://${host}:${args.port}/`,
  readOnly: true,
  service: servicePath,
  gatewayDropIns: gatewayUnits.map((unit) => path.join(userSystemdDir, `${unit}.d`, 'loop-engineering-dashboard.conf')),
  writesEnabled: args.confirmInstall
};

if (args.confirmInstall) {
  await mkdir(userSystemdDir, { recursive: true });
  await writeFile(servicePath, service);
  for (const unit of gatewayUnits) {
    const directory = path.join(userSystemdDir, `${unit}.d`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'loop-engineering-dashboard.conf'), dropIn);
  }
  const reload = await run(args.systemctlBin, ['--user', 'daemon-reload']);
  if (reload.code !== 0) throw new Error(`Cannot reload user systemd units: ${(reload.stderr || reload.stdout).trim()}`);
}

console.log(args.json ? JSON.stringify(report, null, 2) : `${report.status}: ${report.dashboard}\nservice: ${report.service}\ngateways: ${gatewayUnits.join(', ')}`);
