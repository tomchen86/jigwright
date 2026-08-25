import path from 'node:path';

export type InvalidOpenSpecPayloadFactoryV1 = () => Error;

export type OpenSpecValidationPayloadContextV1 = Readonly<{
  repositoryRoot: string;
  expectedType: 'change' | 'spec';
  expectedId?: string;
}>;

export type OpenSpecValidationPayloadV1 = {
  valid: boolean;
  items: Array<{
    id: string;
    type: 'change' | 'spec';
    valid: boolean;
    issues: Array<Record<string, unknown>>;
  }>;
  root: { path: string; source: 'nearest' };
};

/**
 * Validate the pinned OpenSpec `validate --json` payload without owning the
 * caller's presentation, exit-code, or transition policy.
 */
export function parseOpenSpecValidationPayloadV1(
  value: unknown,
  context: OpenSpecValidationPayloadContextV1,
  invalid: InvalidOpenSpecPayloadFactoryV1,
): OpenSpecValidationPayloadV1 {
  const payload = record(value, invalid);
  const root = parseRoot(payload.root, context.repositoryRoot, invalid);
  if (!Array.isArray(payload.items)) {
    throw invalid();
  }
  const items = payload.items.map((entry) => {
    const item = record(entry, invalid);
    const id = safeIdentifier(item.id, invalid);
    if (
      item.type !== context.expectedType ||
      typeof item.valid !== 'boolean' ||
      !Array.isArray(item.issues) ||
      typeof item.durationMs !== 'number' ||
      !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 0
    ) {
      throw invalid();
    }
    const issues = item.issues.map((issue) => parseIssue(issue, invalid));
    if (item.valid !== !issues.some(({ level }) => level === 'ERROR')) {
      throw invalid();
    }
    return {
      id,
      type: context.expectedType,
      valid: item.valid,
      issues,
    };
  });
  assertUnique(
    items.map(({ id }) => id),
    invalid,
  );
  if (
    (context.expectedId !== undefined &&
      (items.length !== 1 || items[0]?.id !== context.expectedId)) ||
    items.length === 0
  ) {
    throw invalid();
  }
  const summary = record(payload.summary, invalid);
  const totals = record(summary.totals, invalid);
  const byType = record(summary.byType, invalid);
  const typeTotals = record(byType[context.expectedType], invalid);
  const passed = items.filter(({ valid }) => valid).length;
  if (
    totals.items !== items.length ||
    totals.passed !== passed ||
    totals.failed !== items.length - passed ||
    Object.keys(byType).length !== 1 ||
    typeTotals.items !== items.length ||
    typeTotals.passed !== passed ||
    typeTotals.failed !== items.length - passed ||
    payload.version !== '1.0'
  ) {
    throw invalid();
  }
  return { valid: passed === items.length, items, root };
}

function parseRoot(
  value: unknown,
  repositoryRoot: string,
  invalid: InvalidOpenSpecPayloadFactoryV1,
): { path: string; source: 'nearest' } {
  const root = record(value, invalid);
  if (
    root.path !== repositoryRoot ||
    root.source !== 'nearest' ||
    Object.keys(root).some((key) => !['path', 'source'].includes(key))
  ) {
    throw invalid();
  }
  return { path: repositoryRoot, source: 'nearest' };
}

function parseIssue(
  value: unknown,
  invalid: InvalidOpenSpecPayloadFactoryV1,
): Record<string, unknown> {
  const issue = record(value, invalid);
  if (
    !['ERROR', 'WARNING', 'INFO'].includes(String(issue.level)) ||
    !isSafeDiagnosticPath(issue.path) ||
    !isSafeDiagnosticMessage(issue.message) ||
    !optionalPositiveInteger(issue.line) ||
    !optionalPositiveInteger(issue.column) ||
    Object.keys(issue).some(
      (key) => !['level', 'path', 'message', 'line', 'column'].includes(key),
    )
  ) {
    throw invalid();
  }
  return issue;
}

function safeIdentifier(
  value: unknown,
  invalid: InvalidOpenSpecPayloadFactoryV1,
): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw invalid();
  }
  return value;
}

function assertUnique(
  values: string[],
  invalid: InvalidOpenSpecPayloadFactoryV1,
): void {
  if (new Set(values).size !== values.length) {
    throw invalid();
  }
}

function record(
  value: unknown,
  invalid: InvalidOpenSpecPayloadFactoryV1,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid();
  }
  return value as Record<string, unknown>;
}

function isSafeDiagnosticPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value === value.trim() &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !hasControlCharacter(value) &&
    value
      .split('/')
      .every(
        (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
      )
  );
}

function isSafeDiagnosticMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_384 &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    );
  });
}

function optionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined || (Number.isSafeInteger(value) && Number(value) > 0)
  );
}
