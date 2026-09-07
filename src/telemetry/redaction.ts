/**
 * Redaction for human-readable output and exports.
 *
 * Environment keys matching TOKEN|SECRET|KEY|PASSWORD|AUTH are masked, and
 * bearer-like tokens or `KEY=value` pairs inside free text are replaced.
 * The database keeps raw values only where the coordinator needs them; every
 * report, event projection and terminal line passes through here first.
 */

export const SENSITIVE_KEY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|AUTH/i;
export const REDACTED = '[REDACTED]';

const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
// KEY=value or KEY: value where KEY looks like a sensitive identifier; quoted or bare values
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
// Well-known credential prefixes that may appear without a key name
const KNOWN_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactText(text: string): string {
  return text
    .replace(BEARER_PATTERN, (_m, word: string) => `${word} ${REDACTED}`)
    .replace(ASSIGNMENT_PATTERN, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(KNOWN_TOKEN_PATTERN, REDACTED);
}

export function redactEnv<T extends Readonly<Record<string, string | undefined>>>(env: T): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined ? undefined : isSensitiveKey(key) ? REDACTED : redactText(value);
  }
  return out;
}

/** Deep-redact any JSON-like value: sensitive keys are masked, strings are scrubbed. */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 64) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, depth + 1)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && member !== null && member !== undefined ? REDACTED : redactValue(member, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** JSON.stringify with redaction applied first. */
export function redactedJson(value: unknown, indent?: number): string {
  return JSON.stringify(redactValue(value), null, indent);
}
