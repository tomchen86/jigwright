import crypto from 'node:crypto';

export function createRuntimeId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `${prefix}-${timestamp}-${crypto.randomUUID()}`;
}
