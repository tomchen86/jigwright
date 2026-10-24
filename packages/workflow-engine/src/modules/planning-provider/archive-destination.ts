/**
 * Shared archive name and UTC calendar rules. Callers own clock observations,
 * invalid-input errors and lifecycle decisions.
 */
export function isArchiveUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Advance a caller-validated archive date without observing the clock. */
export function nextArchiveUtcDate(value: string): string {
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function isArchiveName(value: string, changeId: string): boolean {
  const escapedChangeId = changeId.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const match = new RegExp(
    '^(\\d{4}-\\d{2}-\\d{2})-' + escapedChangeId + '$',
  ).exec(value);
  return match !== null && isArchiveUtcDate(match[1]);
}
