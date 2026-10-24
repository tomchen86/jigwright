/**
 * Share supersession digest, timestamp, record, and immutable value helpers.
 *
 * Invariants:
 * - Digest bytes and value acceptance stay unchanged.
 * - Helpers perform no durable reads or writes.
 */

import crypto from 'node:crypto';

export function digestBuffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function digestText(value: string): string {
  return digestBuffer(Buffer.from(value, 'utf8'));
}

export function isTimestamp(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
