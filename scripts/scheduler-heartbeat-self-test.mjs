#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  doctorReport,
  enqueueTask,
  queueSchedulerTick,
  writeJson
} from '../lib/core.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-scheduler-heartbeat-'));
const queue = 'required-scheduler';
await mkdir(path.join(root, 'configs', 'loops', 'queues'), { recursive: true });
await writeJson(path.join(root, 'configs', 'loops', 'queues', `${queue}.json`), {
  queue,
  dispatcher: '/bin/true',
  scheduler: {
    required: true,
    heartbeatMaxAge: '5m',
    initialInterval: '1m',
    minInterval: '1m',
    maxInterval: '4h'
  }
});
await enqueueTask(root, { queue, title: 'heartbeat smoke', task: 'remain queued' });

const missing = await doctorReport(root);
const missingCheck = missing.checks.find((check) => check.id === `queue:${queue}:scheduler-heartbeat`);
assert.equal(missingCheck?.ok, false);
assert.equal(missingCheck?.detail?.code, 'scheduler_missing');

await queueSchedulerTick(root, {
  queue,
  scheduler: { initialInterval: '1m', minInterval: '1m', maxInterval: '4h' },
  planOnly: true,
  forceDue: true
});
const healthy = await doctorReport(root);
const healthyCheck = healthy.checks.find((check) => check.id === `queue:${queue}:scheduler-heartbeat`);
assert.equal(healthyCheck?.ok, true);
assert.equal(healthyCheck?.detail?.code, 'scheduler_healthy');

await rm(root, { recursive: true, force: true });
console.log('scheduler heartbeat self-test passed');
