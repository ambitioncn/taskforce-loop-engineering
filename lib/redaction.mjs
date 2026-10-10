// Shared credential redaction for evidence, ledgers and dashboard output.
// Keys are split into words (snake_case, kebab-case and camelCase), so
// accessToken, Authorization and openaiApiKey are caught.
// Words that mark a credential wherever they appear in a key.
const SENSITIVE_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'authorization', 'cookie', 'cookies', 'apikey', 'privatekey']);

function keyWords(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// "token" is a credential only as the final word (access_token, accessToken,
// id_token); counters and metrics such as max_tokens, token_count or
// stale_fencing_tokens_accepted are not, and fencing_token is an ordering
// counter that must stay visible.
export function sensitiveKey(key, extraWords = []) {
  const words = keyWords(key);
  if (!words.length) return false;
  if (words.length === 2 && words[0] === 'fencing' && words[1] === 'token') return false;
  if (words.at(-1) === 'token') return true;
  return words.some((word, index) => SENSITIVE_WORDS.has(word) || extraWords.includes(word)
    || (['api', 'private'].includes(word) && words[index + 1] === 'key'));
}

// Replace values under sensitive keys. Object keys are sorted when sortKeys
// is set, matching callers that hash the result.
export function redact(value, { key = '', sortKeys = false, extraWords = [] } = {}) {
  if (sensitiveKey(key, extraWords)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, { sortKeys, extraWords }));
  if (value && typeof value === 'object') {
    const names = sortKeys ? Object.keys(value).sort() : Object.keys(value);
    return Object.fromEntries(names.map((name) => [name, redact(value[name], { key: name, sortKeys, extraWords })]));
  }
  return value;
}
