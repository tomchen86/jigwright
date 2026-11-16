import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';

export function readJsonRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  return value as Record<string, unknown>;
}

export function recordField(
  value: unknown,
  field: string,
): Record<string, unknown> {
  assert.equal(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    true,
  );
  const fieldValue = (value as Record<string, unknown>)[field];
  assert.equal(
    typeof fieldValue === 'object' &&
      fieldValue !== null &&
      !Array.isArray(fieldValue),
    true,
  );
  return fieldValue as Record<string, unknown>;
}

export function recordDigest(
  record: Record<string, unknown>,
  digestField: string,
): `sha256:${string}` {
  const payload = { ...record };
  delete payload[digestField];
  return digest(canonicalJson(payload));
}

export function writeJsonRecord(
  filePath: string,
  record: Record<string, unknown>,
): void {
  fs.writeFileSync(filePath, `${canonicalJson(record)}\n`, { mode: 0o600 });
}

export function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
