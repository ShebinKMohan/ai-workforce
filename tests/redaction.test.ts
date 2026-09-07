import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, redactText, redactValue } from '../src/telemetry/redaction.js';

describe('redaction masks credential-shaped keys only', () => {
  it('keeps readiness, usage, idempotency and git metadata fields readable', () => {
    for (const key of ['authentication', 'inputTokens', 'outputTokens', 'idempotencyKey', 'author', 'authorDate', 'keyPath', 'hotkeys', 'tokenCount', 'maxTokens', 'sessionId', 'monkey', 'primaryKey', 'sha256']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
    const readiness = redactValue({ authentication: 'unknown', ready: 'verified_ready', usage: { inputTokens: 1234, outputTokens: 56, status: 'measured' }, idempotencyKey: 'fake:s1:abc:7', author: 'Jane Doe' });
    expect(readiness).toEqual({ authentication: 'unknown', ready: 'verified_ready', usage: { inputTokens: 1234, outputTokens: 56, status: 'measured' }, idempotencyKey: 'fake:s1:abc:7', author: 'Jane Doe' });
  });

  it('masks passwords, tokens, api keys, secrets and authorization headers in any casing', () => {
    for (const key of ['API_TOKEN', 'apiKey', 'OPENAI_API_KEY', 'x-api-key', 'AWS_SECRET_ACCESS_KEY', 'password', 'PASSWD', 'clientSecret', 'SECRET_KEY_BASE', 'accessToken', 'GITHUB_TOKEN', 'token', 'Authorization', 'Proxy-Authorization', 'Set-Cookie', 'privateKey', 'credentials', 'passphrase']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    expect(redactValue({ env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop', PATH: '/usr/bin' }, headers: { Authorization: 'Bearer abc.def.ghi', Accept: 'json' } })).toEqual({
      env: { GITHUB_TOKEN: REDACTED, PATH: '/usr/bin' },
      headers: { Authorization: REDACTED, Accept: 'json' },
    });
  });

  it('scrubs KEY=value pairs, bearer tokens, url credentials and known prefixes inside text without touching ordinary words', () => {
    expect(redactText('author: Jane Doe; the key: fix login; monkey=1; tokenCount=42')).toBe('author: Jane Doe; the key: fix login; monkey=1; tokenCount=42');
    expect(redactText('Rotate the key: API_TOKEN=abc123secretvalue now')).toBe(`Rotate the key: API_TOKEN=${REDACTED} now`);
    expect(redactText('note: password="hunter two" user=bob')).toBe(`note: password=${REDACTED} user=bob`);
    expect(redactText('--api-key=sk-live-1234567890 --model gpt')).toBe(`--api-key=${REDACTED} --model gpt`);
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redactText('DATABASE_URL=postgres://app:s3cr3t@db.local:5432/app')).toBe(`DATABASE_URL=postgres://app:${REDACTED}@db.local:5432/app`);
    expect(redactText('leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ in log')).toBe(`leaked ${REDACTED} in log`);
    expect(redactText('started at 2026-09-07T11:16:40.000Z sha256: 9b6f732c')).toBe('started at 2026-09-07T11:16:40.000Z sha256: 9b6f732c');
  });
});
