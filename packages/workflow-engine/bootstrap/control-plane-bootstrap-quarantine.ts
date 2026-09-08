/** Independent Recovery Authority inventory and launch fences. */
import fs from 'node:fs';
import path from 'node:path';
import {
  recoveryQuarantineStateCorrupt,
  PRIVATE_DIRECTORY_MODE,
  RECOVERY_QUARANTINE_HISTORY_DIRECTORY,
  RECOVERY_QUARANTINE_GRANT_ID,
  sha256Hex,
  isDigest,
  RECOVERY_QUARANTINE_CLAIM_FILE,
  isNonEmptyTrimmed,
  isCanonicalIso,
  PRIVATE_FILE_MODE,
  isRecord,
  hasExactKeys,
  canonicalDigest,
} from './control-plane-bootstrap-values.ts';
import type { BootstrapRecoveryQuarantineMarker } from './control-plane-bootstrap-types.ts';
import {
  bootstrapInterventionStateRoot,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';

/**
 * Recovery Authority state is deliberately disjoint from the swappable
 * intervention/control-plane store. The Git common directory is the only
 * caller input; neither an engine nor an argv value can redirect the fence.
 */
export function bootstrapRecoveryAuthorityStateRoot(
  gitCommonDirectory: string,
): string {
  return path.join(
    path.dirname(bootstrapInterventionStateRoot(gitCommonDirectory)),
    'recovery-authority-state',
  );
}

/**
 * Read the quarantine marker without importing any swappable src/ module.
 * A genuinely absent canonical root means "not quarantined". Every present
 * byte is inventoried and verified as private canonical Recovery Authority
 * state before marker absence can be trusted.
 *
 * This is only the production launch fence. Recovery Authority provisioning
 * and quarantine enter/release remain substrate APIs until separately sealed
 * harness commands are implemented; this reader does not manufacture either
 * transition.
 */
export function resolveRecoveryQuarantineMarker(
  gitCommonDirectory: string,
): BootstrapRecoveryQuarantineMarker | null {
  const inventory = recoveryAuthorityRootInventory(gitCommonDirectory);
  if (inventory === null) return null;
  const { storageRoot, rootEntries } = inventory;
  const quarantineRoot = path.join(storageRoot, 'recovery-quarantine');
  if (!rootEntries.some((entry) => entry.name === 'recovery-quarantine')) {
    return null;
  }
  return readRecoveryQuarantineInventory(quarantineRoot);
}

/**
 * Presence of the append-only restored-root subtree is itself a bootstrap
 * fence. Bootstrap deliberately does not interpret the swappable substrate's
 * deeper records here: any present private directory keeps ordinary workflow
 * execution fail closed until a separately pinned operational channel exists.
 */
export function resolveRecoveryOperationalTrustRootFence(
  gitCommonDirectory: string,
): boolean {
  const inventory = recoveryAuthorityRootInventory(gitCommonDirectory);
  return (
    inventory?.rootEntries.some(
      (entry) => entry.name === 'recovery-operational-trust-root',
    ) ?? false
  );
}

function recoveryAuthorityRootInventory(
  gitCommonDirectory: string,
): { storageRoot: string; rootEntries: fs.Dirent[] } | null {
  const storageRoot = bootstrapRecoveryAuthorityStateRoot(gitCommonDirectory);
  const stateParent = path.dirname(storageRoot);
  const parent = fs.lstatSync(stateParent, { throwIfNoEntry: false });
  if (parent === undefined) return null;
  assertRecoveryDirectory(stateParent, false);
  const root = fs.lstatSync(storageRoot, { throwIfNoEntry: false });
  if (root === undefined) return null;
  assertRecoveryDirectory(storageRoot, true);

  const rootEntries = recoveryDirectoryEntries(storageRoot);
  for (const entry of rootEntries) {
    if (
      entry.name !== 'recovery-authority' &&
      entry.name !== 'recovery-quarantine' &&
      entry.name !== 'recovery-operational-trust-root'
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    assertRecoveryDirectory(path.join(storageRoot, entry.name), true);
  }
  if (rootEntries.some((entry) => entry.name === 'recovery-authority')) {
    assertRecoveryAuthorityInventory(
      path.join(storageRoot, 'recovery-authority'),
    );
  }
  return { storageRoot, rootEntries };
}

function assertRecoveryDirectory(
  directory: string,
  requirePrivateMode: boolean,
): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (requirePrivateMode && (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) ||
    (currentUid !== undefined && stats.uid !== currentUid) ||
    fs.realpathSync(directory) !== directory
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
}

function recoveryDirectoryEntries(directory: string): fs.Dirent[] {
  assertRecoveryDirectory(directory, true);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()),
    )
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function assertRecoveryAuthorityInventory(directory: string): void {
  const entries = recoveryDirectoryEntries(directory);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== 'descriptor.json' ||
    !entries[0].isFile()
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  readRecoveryDigestRecord(
    path.join(directory, 'descriptor.json'),
    'harness-recovery-authority.v1',
    'descriptorDigest',
    [
      'allowedDomains',
      'auditLedger',
      'createdAt',
      'descriptorDigest',
      'generation',
      'kind',
      'repositoryIdentity',
      'repositoryIdentityDigest',
      'sealedRuntime',
      'signer',
    ],
  );
}

function readRecoveryQuarantineInventory(
  directory: string,
): BootstrapRecoveryQuarantineMarker | null {
  const entries = recoveryDirectoryEntries(directory);
  const allowed = new Set(['active-marker.json', 'grants', 'release-claims']);
  if (
    entries.length === 0 ||
    entries.some((entry) => !allowed.has(entry.name))
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const grantsEntry = byName.get('grants');
  const claimsEntry = byName.get('release-claims');
  if (
    !grantsEntry?.isDirectory() ||
    !claimsEntry?.isDirectory() ||
    (byName.has('active-marker.json') &&
      !byName.get('active-marker.json')?.isFile())
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const histories = readRecoveryGrantHistories(path.join(directory, 'grants'));
  readRecoveryReleaseClaims(path.join(directory, 'release-claims'));
  if (!byName.has('active-marker.json')) return null;
  const marker = readRecoveryQuarantineMarkerRecord(
    path.join(directory, 'active-marker.json'),
  );
  const enter = histories.get(marker.enterGrantId);
  if (
    enter === undefined ||
    enter.operation !== 'enter-quarantine' ||
    enter.markerDigest !== marker.markerDigest
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return marker;
}

function readRecoveryGrantHistories(
  directory: string,
): Map<string, { operation: string; markerDigest: string }> {
  const histories = new Map<
    string,
    { operation: string; markerDigest: string }
  >();
  const directories = recoveryDirectoryEntries(directory);
  if (directories.length === 0) throw recoveryQuarantineStateCorrupt();
  for (const entry of directories) {
    if (
      !entry.isDirectory() ||
      !RECOVERY_QUARANTINE_HISTORY_DIRECTORY.test(entry.name)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    const grantDirectory = path.join(directory, entry.name);
    const files = recoveryDirectoryEntries(grantDirectory);
    const expectedFiles = [
      'audit-ack.json',
      'audit.json',
      'receipt.json',
      'reservation.json',
      'terminal.json',
    ];
    if (
      files.length !== expectedFiles.length ||
      files.some(
        (file, index) => !file.isFile() || file.name !== expectedFiles[index],
      )
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    const reservation = readRecoveryDigestRecord(
      path.join(grantDirectory, 'reservation.json'),
      'recovery-quarantine-reservation.v1',
      'reservationDigest',
      [
        'envelope',
        'envelopeDigest',
        'grantId',
        'kind',
        'operation',
        'reservationDigest',
        'reservedAt',
      ],
    );
    const receipt = readRecoveryDigestRecord(
      path.join(grantDirectory, 'receipt.json'),
      'recovery-quarantine-receipt.v1',
      'receiptDigest',
      [
        'authorityDescriptorDigest',
        'authorityGeneration',
        'completedAt',
        'externalAuditRoot',
        'grantId',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'recoveryRuntimeDigest',
        'repositoryId',
        'result',
      ],
    );
    const terminal = readRecoveryDigestRecord(
      path.join(grantDirectory, 'terminal.json'),
      'recovery-quarantine-terminal.v1',
      'terminalDigest',
      [
        'consumedAt',
        'envelopeDigest',
        'grantId',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'state',
        'terminalDigest',
      ],
    );
    const audit = readRecoveryDigestRecord(
      path.join(grantDirectory, 'audit.json'),
      'recovery-quarantine-audit.v1',
      'recordDigest',
      [
        'authorityDescriptorDigest',
        'authorityGeneration',
        'enterEnvelopeDigest',
        'envelopeDigest',
        'event',
        'externalAuditRoot',
        'grantId',
        'humanSigner',
        'kind',
        'markerDigest',
        'operation',
        'receiptDigest',
        'recordDigest',
        'recordId',
        'recordedAt',
        'recoveryRuntimeDigest',
        'repositoryId',
        'signerFingerprint',
        'terminalDigest',
      ].filter((key) => key !== 'enterEnvelopeDigest'),
    );
    const acknowledgement = readRecoveryDigestRecord(
      path.join(grantDirectory, 'audit-ack.json'),
      'recovery-quarantine-audit-ack.v1',
      'acknowledgementDigest',
      [
        'acknowledgedAt',
        'acknowledgementDigest',
        'grantId',
        'kind',
        'recordDigest',
        'recordId',
      ],
    );
    const grantId = reservation.grantId;
    const operation = reservation.operation;
    const markerDigest = receipt.markerDigest;
    if (
      typeof grantId !== 'string' ||
      !RECOVERY_QUARANTINE_GRANT_ID.test(grantId) ||
      sha256Hex(grantId) !== entry.name ||
      (operation !== 'enter-quarantine' &&
        operation !== 'release-quarantine') ||
      !isDigest(markerDigest) ||
      receipt.grantId !== grantId ||
      terminal.grantId !== grantId ||
      audit.grantId !== grantId ||
      acknowledgement.grantId !== grantId ||
      receipt.operation !== operation ||
      terminal.operation !== operation ||
      audit.operation !== operation ||
      terminal.state !== 'consumed' ||
      terminal.receiptDigest !== receipt.receiptDigest ||
      terminal.markerDigest !== markerDigest ||
      audit.receiptDigest !== receipt.receiptDigest ||
      audit.terminalDigest !== terminal.terminalDigest ||
      audit.markerDigest !== markerDigest ||
      acknowledgement.recordId !== audit.recordId ||
      acknowledgement.recordDigest !== audit.recordDigest ||
      histories.has(grantId)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
    histories.set(grantId, { operation, markerDigest });
  }
  return histories;
}

function readRecoveryReleaseClaims(directory: string): void {
  for (const entry of recoveryDirectoryEntries(directory)) {
    if (!entry.isFile() || !RECOVERY_QUARANTINE_CLAIM_FILE.test(entry.name)) {
      throw recoveryQuarantineStateCorrupt();
    }
    const claim = readRecoveryDigestRecord(
      path.join(directory, entry.name),
      'recovery-quarantine-release-claim.v1',
      'claimDigest',
      [
        'claimDigest',
        'claimedAt',
        'kind',
        'markerDigest',
        'releaseEnvelopeDigest',
        'releaseGrantId',
      ],
    );
    if (
      !isDigest(claim.markerDigest) ||
      `${claim.markerDigest.slice('sha256:'.length)}.json` !== entry.name ||
      typeof claim.releaseGrantId !== 'string' ||
      !RECOVERY_QUARANTINE_GRANT_ID.test(claim.releaseGrantId)
    ) {
      throw recoveryQuarantineStateCorrupt();
    }
  }
}

function readRecoveryQuarantineMarkerRecord(
  filePath: string,
): BootstrapRecoveryQuarantineMarker {
  const value = readRecoveryDigestRecord(
    filePath,
    'recovery-quarantine-marker.v1',
    'markerDigest',
    [
      'authorityDescriptorDigest',
      'authorityGeneration',
      'enterEnvelopeDigest',
      'enterGrantId',
      'enteredAt',
      'externalAuditRoot',
      'kind',
      'markerDigest',
      'recoveryRuntimeDigest',
      'repositoryId',
    ],
  );
  if (
    !isNonEmptyTrimmed(value.repositoryId) ||
    !isDigest(value.authorityDescriptorDigest) ||
    !Number.isSafeInteger(value.authorityGeneration) ||
    Number(value.authorityGeneration) < 1 ||
    !isDigest(value.recoveryRuntimeDigest) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.resolve(value.externalAuditRoot) !== value.externalAuditRoot ||
    typeof value.enterGrantId !== 'string' ||
    !RECOVERY_QUARANTINE_GRANT_ID.test(value.enterGrantId) ||
    !isDigest(value.enterEnvelopeDigest) ||
    !isCanonicalIso(value.enteredAt) ||
    !isDigest(value.markerDigest)
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  return value as unknown as BootstrapRecoveryQuarantineMarker;
}

function readRecoveryDigestRecord(
  filePath: string,
  expectedKind: string,
  digestField: string,
  exactKeys: readonly string[],
): Record<string, unknown> {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  const currentUid = process.getuid?.();
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== PRIVATE_FILE_MODE ||
    (currentUid !== undefined && before.uid !== currentUid) ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const value = readCanonicalPrivateRecord(
    filePath,
    recoveryQuarantineStateCorrupt,
  );
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    !isRecord(value) ||
    !hasExactKeys(value, [...exactKeys]) ||
    value.kind !== expectedKind ||
    !isDigest(value[digestField])
  ) {
    throw recoveryQuarantineStateCorrupt();
  }
  const payload = { ...value };
  delete payload[digestField];
  if (canonicalDigest(payload) !== value[digestField]) {
    throw recoveryQuarantineStateCorrupt();
  }
  return value;
}
