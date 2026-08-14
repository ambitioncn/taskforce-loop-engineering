import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateEvidence, publicEvidenceSummary, readAndVerifyEvidence, sealEvidence, verifyEvidence, writeEvidenceBundle } from '../lib/production-evidence.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'loop-evidence-'));
const draft = { generated_at: '2026-01-01T00:00:00.000Z', scenarios: Array.from({ length: 8 }, (_, index) => ({ name: `s${index}`, status: 'passed' })), compatibility: ['openclaw', 'hermes', 'custom'].map((runtime) => ({ runtime, contract_version: 1, status: 'passed' })), metrics: { errors: 0, latency_ms: 12 }, thresholds: { errors: { max: 0 }, latency_ms: { max: 20 } }, limitations: [], api_key: 'must-not-leak' };
draft.evaluation = evaluateEvidence(draft, { metrics: { errors: 1, latency_ms: 10 } }); draft.passed = draft.evaluation.passed;
assert.equal(draft.evaluation.trend.errors.delta, -1); assert.equal(draft.evaluation.trend.latency_ms.delta, 2);
const sealed = sealEvidence(draft); assert.equal(verifyEvidence(sealed).valid, true); assert.equal(sealed.api_key, '[REDACTED]');
const tampered = structuredClone(sealed); tampered.metrics.errors = 1; assert.equal(verifyEvidence(tampered).reason, 'digest_mismatch');
const summary = publicEvidenceSummary(sealed); assert.equal(summary.api_key, undefined); assert.equal(JSON.stringify(summary).includes('must-not-leak'), false);
await writeEvidenceBundle(root, draft); assert.equal((await readAndVerifyEvidence(path.join(root, 'evidence.json'))).verification.valid, true);
const stored = await readFile(path.join(root, 'public-summary.json'), 'utf8'); assert.equal(stored.includes('must-not-leak'), false);
await writeFile(path.join(root, 'baseline.json'), `${JSON.stringify(sealed)}\n`);
console.log(JSON.stringify({ status: 'ok', assertions: ['schema', 'threshold', 'baseline trend', 'tamper detection', 'secret redaction', 'public summary', 'round trip'] }));
