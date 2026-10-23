export const DEFAULT_REQUIRES_HUMAN_ACTION_PATTERNS = [
  'INSTALL_FAILED_USER_RESTRICTED',
  'device unauthorized',
  'unauthorized',
  'offline',
  'more than one device',
  'no devices/emulators found',
  'Permission denied',
  'Operation not permitted',
  'user restricted',
  'requires human',
  'needs human',
  '需要人工',
  '需要用户确认',
  '等待人工',
  '权限未开',
  '用户取消',
  '用户限制'
];

export const DEFAULT_RECOVERABLE_RUNTIME_PATTERNS = [
  { category: 'context_overflow', pattern: 'context_length_exceeded', nonZeroOnly: true },
  { category: 'context_overflow', pattern: 'maximum context length', nonZeroOnly: true },
  { category: 'context_overflow', pattern: 'prompt is too long', nonZeroOnly: true },
  { category: 'incomplete_turn', pattern: '"kind": "incomplete_turn"' },
  { category: 'incomplete_turn', pattern: '"livenessState": "abandoned"' },
  // Free-text signatures can also appear in a successful task's own answer
  // (for example a task that implements rate limiting). Only the structured
  // runtime trailers above may override exitCode=0.
  { category: 'incomplete_turn', pattern: 'stopped before confirming the turn was complete', nonZeroOnly: true },
  // The OpenClaw embedded runner injects a recovery prompt when an assistant
  // turn completes its tool calls without a user-visible answer. A dispatch
  // that exits non-zero with this signature hit a session protocol failure,
  // not a task defect: classify it as a recoverable incomplete turn so the
  // runtime recovery path rotates the worker session and resumes.
  { category: 'incomplete_turn', pattern: 'did not produce a user-visible answer', nonZeroOnly: true },
  // OpenClaw closes websocket admission while the Gateway drains for a
  // restart. A worker launched inside that short window receives HTTP 503
  // before task execution begins. Exact non-zero admission/drain signatures
  // are runtime interruptions, not development failures.
  { category: 'gateway_restart', pattern: 'gateway websocket admission closed', nonZeroOnly: true },
  { category: 'gateway_restart', pattern: 'gateway is draining for restart', nonZeroOnly: true },
  { category: 'gateway_restart', pattern: 'unavailable during gateway restart', nonZeroOnly: true },
  { category: 'compaction_timeout', pattern: 'compaction timed out', nonZeroOnly: true },
  { category: 'compaction_timeout', pattern: 'transcript compaction failed', nonZeroOnly: true },
  { category: 'transport_error', pattern: 'connection reset', nonZeroOnly: true },
  { category: 'transport_error', pattern: 'socket hang up', nonZeroOnly: true },
  { category: 'transport_error', pattern: 'network error', nonZeroOnly: true },
  { category: 'rate_limit', pattern: 'rate limit', nonZeroOnly: true }
];

export function dispatchFailureClassification(result, retry = {}) {
  if (!result) {
    return {
      category: 'ok',
      requiresHumanAction: false,
      matchedPattern: null
    };
  }
  // Some embedded runtimes exit their wrapper successfully after the model
  // turn itself was abandoned. Inspect the structured trailer before trusting
  // exitCode=0 or the queue may accept partial work and replay a stale gate.
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.toLowerCase();
  const humanPatterns = retry.requiresHumanActionPatterns ?? DEFAULT_REQUIRES_HUMAN_ACTION_PATTERNS;
  const humanMatch = result.exitCode !== 0 && humanPatterns.find(pattern => output.includes(pattern.toLowerCase()));
  if (humanMatch) return { category: 'requires_human_action', requiresHumanAction: true, recoverableRuntime: false, matchedPattern: humanMatch };
  const runtimePatterns = retry.recoverableRuntimePatterns ?? DEFAULT_RECOVERABLE_RUNTIME_PATTERNS;
  const runtimeMatch = runtimePatterns.find((entry) => {
    const pattern = typeof entry === 'string' ? entry : entry.pattern;
    const nonZeroOnly = typeof entry === 'object' && entry !== null && entry.nonZeroOnly === true;
    return (!nonZeroOnly || result.exitCode !== 0)
      && output.includes(String(pattern ?? entry).toLowerCase());
  });
  if (runtimeMatch) {
    return {
      category: runtimeMatch.category ?? 'runtime_interruption',
      requiresHumanAction: false,
      recoverableRuntime: true,
      matchedPattern: runtimeMatch.pattern ?? runtimeMatch
    };
  }
  if (result.exitCode === 0) {
    return {
      category: 'ok',
      requiresHumanAction: false,
      matchedPattern: null
    };
  }
  if (result.timedOut) {
    return {
      category: 'timeout',
      requiresHumanAction: false,
      recoverableRuntime: true,
      matchedPattern: null
    };
  }
  const patterns = retry.requiresHumanActionPatterns ?? DEFAULT_REQUIRES_HUMAN_ACTION_PATTERNS;
  const matched = patterns.find((pattern) => output.includes(pattern.toLowerCase()));
  if (matched) {
    return {
      category: 'requires_human_action',
      requiresHumanAction: true,
      recoverableRuntime: false,
      matchedPattern: matched
    };
  }
  return {
    category: 'retryable_failure',
    requiresHumanAction: false,
    recoverableRuntime: false,
    matchedPattern: null
  };
}

