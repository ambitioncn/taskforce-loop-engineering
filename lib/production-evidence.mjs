import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PRODUCTION_EVIDENCE_VERSION = 1;
const SECRET = /(^|_)(secret|token|password|credential|api[_-]?key|private[_-]?key)(_|$)/i;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const redactEvidence = (value, key = '') => SECRET.test(key) ? '[REDACTED]' : Array.isArray(value) ? value.map((item) => redactEvidence(item)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactEvidence(item, name)])) : value;
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
  return { checks, trend, passed: checks.every((item) => item.passed) && report.scenarios.every((item) => item.status === 'passed') && report.compatibility.every((item) => item.status === 'passed') };
}

export function sealEvidence(input) {
  const report = redactEvidence({ ...input, schema: 'loop.production_trust_evidence', schema_version: PRODUCTION_EVIDENCE_VERSION });
  const unsigned = { ...report, integrity: undefined };
  delete unsigned.integrity;
  return { ...report, integrity: { algorithm: 'sha256', digest: digest(unsigned) } };
}

export function verifyEvidence(report) {
  if (report?.schema !== 'loop.production_trust_evidence' || report.schema_version !== PRODUCTION_EVIDENCE_VERSION) return { valid: false, reason: 'unsupported_schema' };
  const unsigned = { ...report }; delete unsigned.integrity;
  const actual = digest(unsigned); const expected = report.integrity?.digest;
  return { valid: actual === expected, reason: actual === expected ? null : 'digest_mismatch', expected, actual };
}

export function publicEvidenceSummary(report) {
  const verification = verifyEvidence(report);
  return redactEvidence({ schema: 'loop.production_trust_public_summary', schema_version: 1, evidence_digest: report.integrity?.digest, generated_at: report.generated_at, passed: report.passed && verification.valid, fixtures: report.compatibility.map(({ runtime, contract_version, status }) => ({ runtime, contract_version, status })), metrics: report.metrics, thresholds: report.thresholds, failures: report.evaluation.checks.filter((item) => !item.passed).map(({ metric, attribution }) => ({ metric, attribution })), limitations: report.limitations });
}

export async function writeEvidenceBundle(directory, report) {
  const sealed = sealEvidence(report); const summary = publicEvidenceSummary(sealed);
  await mkdir(directory, { recursive: true });
  for (const [name, value] of [['evidence.json', sealed], ['public-summary.json', summary]]) {
    const file = path.join(directory, name); const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file);
  }
  return { report: sealed, summary };
}

export async function readAndVerifyEvidence(file) { const report = JSON.parse(await readFile(file, 'utf8')); return { report, verification: verifyEvidence(report) }; }
