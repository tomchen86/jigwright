/**
 * Defines repository-scoped GitHub App token requests and authenticates
 * returned leases.
 *
 * Invariants:
 * - Lease receipts must match the requested repository, permissions and
 *   token bytes within the allowed validity window.
 */
import crypto from 'node:crypto';

export type GitHubAppTokenMintRequestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'github-app-token-mint-request.v1';
  requestDigest: `sha256:${string}`;
  appId: string;
  installationId: string;
  repository: Readonly<{ owner: string; name: string }>;
  permissions: Readonly<{
    contents: 'write';
    pullRequests: 'write';
    metadata: 'read';
  }>;
  requestedAt: string;
  expiresNoLaterThan: string;
}>;

export type GitHubAppTokenMintReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: 'github-app-token-mint-receipt.v1';
  requestDigest: `sha256:${string}`;
  repository: Readonly<{ owner: string; name: string }>;
  permissions: GitHubAppTokenMintRequestV1['permissions'];
  tokenDigest: `sha256:${string}`;
  issuedAt: string;
  expiresAt: string;
  receiptDigest: `sha256:${string}`;
}>;

export type GitHubAppTokenLeaseV1 = Readonly<{
  token: string;
  receipt: GitHubAppTokenMintReceiptV1;
}>;

/**
 * Reviewed secret boundary. A host adapter may mint one repository-scoped,
 * short-lived installation token; this package deliberately supplies no
 * production implementation or credential reader.
 */
export type GitHubAppTokenMinterPortV1 = Readonly<{
  contractVersion: 'github-app-token-minter.v1';
  mint(
    request: GitHubAppTokenMintRequestV1,
  ): GitHubAppTokenLeaseV1 | Promise<GitHubAppTokenLeaseV1>;
}>;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_TOKEN_TTL_MS = 60 * 60_000;
const MIN_REMAINING_TTL_MS = 60_000;

export function createGitHubAppTokenMintRequest(
  input: Readonly<{
    appId: string;
    installationId: string;
    repository: Readonly<{ owner: string; name: string }>;
    permissions: GitHubAppTokenMintRequestV1['permissions'];
    requestedAt: string;
    expiresNoLaterThan: string;
  }>,
): GitHubAppTokenMintRequestV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: 'github-app-token-mint-request.v1' as const,
    ...input,
  };
  return assertGitHubAppTokenMintRequest({
    ...body,
    requestDigest: digest(canonicalJson(body)),
  });
}

export function authenticateGitHubAppTokenLease(
  request: GitHubAppTokenMintRequestV1,
  value: unknown,
  now = new Date(),
): GitHubAppTokenLeaseV1 {
  request = assertGitHubAppTokenMintRequest(request);
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw tokenLeaseInvalid();
  if (
    !isRecord(value) ||
    !exactKeys(value, ['token', 'receipt']) ||
    typeof value.token !== 'string' ||
    value.token.length < 16 ||
    value.token.length > 4096 ||
    /[\r\n\0]/.test(value.token) ||
    !isRecord(value.receipt) ||
    !exactKeys(value.receipt, [
      'schemaVersion',
      'kind',
      'requestDigest',
      'repository',
      'permissions',
      'tokenDigest',
      'issuedAt',
      'expiresAt',
      'receiptDigest',
    ])
  ) {
    throw tokenLeaseInvalid();
  }
  const receipt = value.receipt;
  const issuedAt = exactTimestamp(receipt.issuedAt);
  const expiresAt = exactTimestamp(receipt.expiresAt);
  const requestedAt = exactTimestamp(request.requestedAt);
  const expiresNoLaterThan = exactTimestamp(request.expiresNoLaterThan);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'github-app-token-mint-receipt.v1' ||
    receipt.requestDigest !== request.requestDigest ||
    canonicalJson(receipt.repository) !== canonicalJson(request.repository) ||
    canonicalJson(receipt.permissions) !== canonicalJson(request.permissions) ||
    receipt.tokenDigest !== digest(value.token) ||
    issuedAt === null ||
    expiresAt === null ||
    requestedAt === null ||
    expiresNoLaterThan === null ||
    issuedAt < requestedAt - 30_000 ||
    issuedAt > nowTime + 30_000 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_TOKEN_TTL_MS ||
    expiresAt > expiresNoLaterThan ||
    expiresAt < nowTime + MIN_REMAINING_TTL_MS ||
    typeof receipt.receiptDigest !== 'string' ||
    !SHA256.test(receipt.receiptDigest)
  ) {
    throw tokenLeaseInvalid();
  }
  const { receiptDigest, ...receiptBody } = receipt;
  if (receiptDigest !== digest(canonicalJson(receiptBody))) {
    throw tokenLeaseInvalid();
  }
  return Object.freeze({
    token: value.token,
    receipt: Object.freeze(structuredClone(receipt)),
  }) as GitHubAppTokenLeaseV1;
}

function assertGitHubAppTokenMintRequest(
  value: unknown,
): GitHubAppTokenMintRequestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'requestDigest',
      'appId',
      'installationId',
      'repository',
      'permissions',
      'requestedAt',
      'expiresNoLaterThan',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'github-app-token-mint-request.v1' ||
    typeof value.requestDigest !== 'string' ||
    !SHA256.test(value.requestDigest) ||
    typeof value.appId !== 'string' ||
    !NUMERIC_ID.test(value.appId) ||
    typeof value.installationId !== 'string' ||
    !NUMERIC_ID.test(value.installationId) ||
    !isRecord(value.repository) ||
    !exactKeys(value.repository, ['owner', 'name']) ||
    typeof value.repository.owner !== 'string' ||
    !OWNER.test(value.repository.owner) ||
    typeof value.repository.name !== 'string' ||
    !REPOSITORY.test(value.repository.name) ||
    !isExactPermissions(value.permissions)
  ) {
    throw tokenRequestInvalid();
  }
  const requestedAt = exactTimestamp(value.requestedAt);
  const expiresNoLaterThan = exactTimestamp(value.expiresNoLaterThan);
  if (
    requestedAt === null ||
    expiresNoLaterThan === null ||
    expiresNoLaterThan <= requestedAt ||
    expiresNoLaterThan - requestedAt > MAX_TOKEN_TTL_MS
  ) {
    throw tokenRequestInvalid();
  }
  const { requestDigest, ...body } = value;
  if (requestDigest !== digest(canonicalJson(body)))
    throw tokenRequestInvalid();
  return Object.freeze(structuredClone(value)) as GitHubAppTokenMintRequestV1;
}

function isExactPermissions(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ['contents', 'pullRequests', 'metadata']) &&
    value.contents === 'write' &&
    value.pullRequests === 'write' &&
    value.metadata === 'read'
  );
}

function exactTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function tokenRequestInvalid(): TypeError {
  return new TypeError('GITHUB_APP_TOKEN_MINT_REQUEST_INVALID');
}

function tokenLeaseInvalid(): TypeError {
  return new TypeError('GITHUB_APP_TOKEN_LEASE_INVALID');
}
