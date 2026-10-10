import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './redaction.mjs';

export const PRODUCTION_EVIDENCE_VERSION = 1;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const redactEvidence = (value) => redact(value);
export const evidenceDigest = (value) => digest(value);

export function evaluateEvidence(report, baseline = null) {
  const thresholds = report.thresholds ?? {};
  const metrics = report.metrics ?? {};
  const checks = Object.entries(thresholds).map(([metric, rule]) => {
    const actual = Number(metrics[metric]);
    const passed = Number.isFinite(actual) && (rule.max === undefined || actual <= rule.max) && (rule.min === undefined || actual >= rule.min);
    return { metric, actual, ...rule, passed, attribution: passed ? null : rule.attribution ?? 'unattributed_threshold_failure' };
  });
  const previous = baseline?.metrics ?? {};
  const trend = Object.fromEntries(Object.keys(metrics).sort().filter((key) => Number.isFinite(Number(metrics[key])) && Number.isFinite(Number(previous[key]))).map((key) => [key, { baseline: Number(previous[key]), current: Number(metrics[key]), delta: Number(metrics[key]) - Number(previous[key]) }]));
  return { checks, trend, passed: checks.every((item) => item.passed) && (report.scenarios ?? []).every((item) => item.status === 'passed') && (report.compatibility ?? []).every((item) => item.status === 'passed') };
}

// A plain SHA-256 digest detects accidental corruption only: anyone who can
// edit the report can recompute it. With a key (option or
// LOOP_EVIDENCE_HMAC_KEY) the seal is an HMAC that cannot be forged without it.
const sealKey = (options) => options.key ?? process.env.LOOP_EVIDENCE_HMAC_KEY ?? null;
const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex');
const sameHex = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

export function sealEvidence(input, options = {}) {
  const report = redactEvidence({ ...input, schema: 'loop.production_trust_evidence', schema_version: PRODUCTION_EVIDENCE_VERSION });
  // The verdict is derived from the evidence, never taken on trust: a report
  // whose metrics fail their thresholds cannot be sealed as passed.
  if (Array.isArray(report.scenarios) && Array.isArray(report.compatibility)) {
    report.evaluation = evaluateEvidence(report, options.baseline ?? null);
    report.passed = report.passed !== false && report.evaluation.passed;
  }
  const unsigned = { ...report }; delete unsigned.integrity;
  const key = sealKey(options);
  return { ...report, integrity: key ? { algorithm: 'hmac-sha256', digest: hmac(key, unsigned) } : { algorithm: 'sha256', digest: digest(unsigned) } };
}

export function verifyEvidence(report, options = {}) {
  if (report?.schema !== 'loop.production_trust_evidence' || report.schema_version !== PRODUCTION_EVIDENCE_VERSION) return { valid: false, reason: 'unsupported_schema' };
  const unsigned = { ...report }; delete unsigned.integrity;
  const expected = report.integrity?.digest;
  if (report.integrity?.algorithm === 'hmac-sha256') {
    const key = sealKey(options);
    if (!key) return { valid: false, reason: 'hmac_key_required', expected, actual: null };
    const actual = hmac(key, unsigned);
    return { valid: sameHex(actual, expected), reason: sameHex(actual, expected) ? null : 'digest_mismatch', expected, actual, keyed: true };
  }
  const actual = digest(unsigned);
  return { valid: actual === expected, reason: actual === expected ? null : 'digest_mismatch', expected, actual, keyed: false };
}

export function publicEvidenceSummary(report) {
  const verification = verifyEvidence(report);
  const evaluated = evaluateEvidence(report).passed;
  return redactEvidence({ schema: 'loop.production_trust_public_summary', schema_version: 1, evidence_digest: report.integrity?.digest, integrity_algorithm: report.integrity?.algorithm ?? null, generated_at: report.generated_at, passed: Boolean(report.passed && evaluated && verification.valid), fixtures: report.compatibility.map(({ runtime, contract_version, status }) => ({ runtime, contract_version, status })), metrics: report.metrics, thresholds: report.thresholds, failures: report.evaluation.checks.filter((item) => !item.passed).map(({ metric, attribution }) => ({ metric, attribution })), limitations: report.limitations });
}

export async function writeEvidenceBundle(directory, report, options = {}) {
  const sealed = sealEvidence(report, options); const summary = publicEvidenceSummary(sealed);
  await mkdir(directory, { recursive: true });
  for (const [name, value] of [['evidence.json', sealed], ['public-summary.json', summary]]) {
    const file = path.join(directory, name); const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file);
  }
  return { report: sealed, summary };
}

export async function readAndVerifyEvidence(file, options = {}) { const report = JSON.parse(await readFile(file, 'utf8')); return { report, verification: verifyEvidence(report, options) }; }
