/**
 * Identifier and clock helpers.
 *
 * Record identifiers are UUIDv7-style values: a 48-bit millisecond timestamp
 * followed by random bits, with a per-process monotonic counter so that IDs
 * generated within the same millisecond still sort in creation order.
 * Sorting by ID is a convenience only; durable ordering of events comes from
 * the per-run `sequence` column in storage.
 */
import { randomBytes } from 'node:crypto';

let lastTimestampMs = 0;
let counter = 0;

/** Generate a UUIDv7-style identifier (RFC 9562 layout, variant 10xx). */
export function uuidv7(now: number = Date.now()): string {
  let timestamp = Math.max(0, Math.floor(now));
  if (timestamp <= lastTimestampMs) {
    timestamp = lastTimestampMs;
    counter += 1;
    if (counter > 0x0fff) {
      // Counter exhausted within one millisecond: borrow the next millisecond.
      timestamp = lastTimestampMs + 1;
      counter = 0;
    }
  } else {
    counter = randomBytes(2).readUInt16BE(0) & 0x07ff; // leave headroom for increments
  }
  lastTimestampMs = timestamp;

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  // version 7 in the high nibble of byte 6, counter in the remaining 12 bits
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  const random = randomBytes(8);
  random.copy(bytes, 8);
  // RFC variant: 10xx xxxx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** New identifier for any application record. */
export function newId(): string {
  return uuidv7();
}

/** Extract the millisecond timestamp embedded in a UUIDv7-style identifier. */
export function idTimestampMs(id: string): number | null {
  const compact = id.replace(/-/g, '');
  if (compact.length !== 32 || !/^[0-9a-f]+$/i.test(compact)) return null;
  return Number.parseInt(compact.slice(0, 12), 16);
}

/** Random opaque token, used for lock ownership and idempotency keys. */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** UTC ISO-8601 timestamp for persisted records. */
export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** Monotonic clock in milliseconds (not affected by wall-clock changes). */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Sequence allocator that never returns the same or a smaller number twice
 * within one process, even if callers pass a stale "last seen" value.
 */
export class MonotonicSequence {
  #last: number;

  constructor(start = 0) {
    this.#last = start;
  }

  get last(): number {
    return this.#last;
  }

  next(observed?: number): number {
    if (observed !== undefined && observed > this.#last) this.#last = observed;
    this.#last += 1;
    return this.#last;
  }
}
