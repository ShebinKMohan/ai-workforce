/**
 * Redaction for human-readable output and exports.
 *
 * A key is sensitive when it is *credential-shaped*, judged on its words
 * (split on `_`, `-`, `.`, whitespace and camelCase): `password`, `secret`,
 * `authorization`, `credential`, `cookie`, `passphrase`, `bearer`, `apikey`
 * anywhere; `token` as the last word (`accessToken`, `GITHUB_TOKEN`, but not
 * `inputTokens` or `tokenCount`); `key` as the last word only after a
 * qualifier such as `api`, `access`, `private` or `secret` (`apiKey`,
 * `OPENAI_API_KEY`, but not `idempotencyKey`, `keyPath` or `hotkeys`).
 * Ordinary words that merely contain a sensitive substring (`author`,
 * `authentication`, `monkey`) are never masked, so readiness reports, usage
 * figures and git metadata stay readable.
 *
 * Free text is scrubbed for bearer tokens, `KEY=value` / `KEY: value` pairs
 * whose key is sensitive by the same rule, credentials embedded in URLs and
 * well-known credential prefixes. The database keeps raw values only where
 * the coordinator needs them; every report, event projection and terminal
 * line passes through here first.
 */

export const REDACTED = '[REDACTED]';

/** Words that make a key sensitive wherever they appear. */
const SENSITIVE_ANYWHERE = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'secrets', 'credential', 'credentials', 'authorization', 'bearer', 'cookie', 'cookies', 'apikey']);
/** Words that make a key sensitive only as its final word. */
const SENSITIVE_TRAILING = new Set(['token']);
/** Words that make a trailing `key` sensitive (`api key`, `private key`, ...). */
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'signing', 'encryption', 'ssh', 'service', 'license', 'master', 'security', 'session', 'client', 'consumer', 'app', 'auth', 'deploy', 'account', 'gpg', 'pgp']);

/** Split an identifier into lower-case words: `AWS_SECRET_ACCESS_KEY` and `awsSecretAccessKey` both give [aws, secret, access, key]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (words.length === 0) return false;
  if (words.some((word) => SENSITIVE_ANYWHERE.has(word))) return true;
  const last = words[words.length - 1]!;
  if (SENSITIVE_TRAILING.has(last)) return true;
  if (last === 'key' && words.length >= 2 && KEY_QUALIFIERS.has(words[words.length - 2]!)) return true;
  return false;
}

const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
// KEY=value or KEY: value; the key is checked with isSensitiveKey in the replacer, so ordinary words never match by substring.
const ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g;
// scheme://user:password@host
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
// Well-known credential prefixes that may appear without a key name
const KNOWN_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g;

function redactAssignments(text: string): string {
  const pattern = new RegExp(ASSIGNMENT_PATTERN.source, 'g');
  let out = '';
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [whole, key, sep] = match as unknown as [string, string, string, string];
    if (isSensitiveKey(key)) {
      out += `${text.slice(copied, match.index)}${key}${sep}${REDACTED}`;
      copied = match.index + whole.length;
    } else {
      // Not a secret: keep the value, but resume scanning at its start so `note: API_TOKEN=x` still catches the inner pair.
      pattern.lastIndex = match.index + key.length + sep.length;
    }
  }
  return out + text.slice(copied);
}

export function redactText(text: string): string {
  return redactAssignments(text.replace(BEARER_PATTERN, (_m, word: string) => `${word} ${REDACTED}`))
    .replace(URL_CREDENTIAL_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}@`)
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
