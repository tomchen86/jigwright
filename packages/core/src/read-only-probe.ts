export const READ_ONLY_PROBE_CONTRACT_VERSION =
  'jigwright.read-only-probe.v1' as const;

export const READ_ONLY_PROBE_KINDS_V1 = [
  'repository-head',
  'repository-dirty-state',
  'runtime-version',
  'adapter-version',
  'binary-exists',
  'file-read',
  'validator-error',
  'execution-limits',
  'lease-state',
  'attempt-lineage',
  'dependency-availability',
] as const;

export type ReadOnlyProbeKindV1 = (typeof READ_ONLY_PROBE_KINDS_V1)[number];

export type ReadOnlyProbeRequestV1 = {
  kind: ReadOnlyProbeKindV1;
  target?: string;
  timeoutMs: number;
};

export class ReadOnlyProbeCodecError extends TypeError {
  readonly code = 'READ_ONLY_PROBE_INVALID';

  constructor() {
    super('Read-only probe request is invalid.');
    this.name = 'ReadOnlyProbeCodecError';
  }
}

const READ_ONLY_PROBE_KIND_SET = new Set<ReadOnlyProbeKindV1>(
  READ_ONLY_PROBE_KINDS_V1,
);
const TARGET_REQUIRED_KINDS = new Set<ReadOnlyProbeKindV1>([
  'binary-exists',
  'file-read',
  'validator-error',
  'dependency-availability',
]);

/**
 * Admit only the bounded, effect-free probe vocabulary shared by execution
 * hosts. Presentation and exit-code mapping remain caller-owned.
 */
export function assertReadOnlyProbeRequestV1(
  input: unknown,
): Readonly<ReadOnlyProbeRequestV1> {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, ['kind', 'target', 'timeoutMs']) ||
    typeof input.kind !== 'string' ||
    !READ_ONLY_PROBE_KIND_SET.has(input.kind as ReadOnlyProbeKindV1) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    (input.timeoutMs as number) < 1 ||
    (input.timeoutMs as number) > 30_000
  ) {
    throw new ReadOnlyProbeCodecError();
  }

  const kind = input.kind as ReadOnlyProbeKindV1;
  const requiresTarget = TARGET_REQUIRED_KINDS.has(kind);
  if (
    requiresTarget !== Object.hasOwn(input, 'target') ||
    (requiresTarget &&
      (typeof input.target !== 'string' ||
        input.target.length === 0 ||
        Buffer.byteLength(input.target, 'utf8') > 1_024))
  ) {
    throw new ReadOnlyProbeCodecError();
  }
  if (kind === 'file-read' && !isSafeRepositoryRelativePath(input.target)) {
    throw new ReadOnlyProbeCodecError();
  }
  if (
    kind === 'binary-exists' &&
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(input.target as string)
  ) {
    throw new ReadOnlyProbeCodecError();
  }
  if (
    kind === 'validator-error' &&
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(input.target as string)
  ) {
    throw new ReadOnlyProbeCodecError();
  }
  if (
    kind === 'dependency-availability' &&
    !/^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/.test(
      input.target as string,
    )
  ) {
    throw new ReadOnlyProbeCodecError();
  }

  const probe: ReadOnlyProbeRequestV1 = {
    kind,
    timeoutMs: input.timeoutMs as number,
  };
  if (requiresTarget) {
    probe.target = input.target as string;
  }
  return deepFreeze(probe);
}

function isSafeRepositoryRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.normalize('NFC') &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
