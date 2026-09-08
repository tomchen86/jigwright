/** Initial supervisor three-phase journal, durable publication, and terminal replay. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  bootstrapRepositoryIdentityInvalid,
  trustError,
  rawDigest,
  canonicalDigest,
  initialBootstrapJournalCorrupt,
  PRIVATE_FILE_MODE,
  supervisorAlreadyInitialized,
  deepFreeze,
  INITIAL_BOOTSTRAP_PHASE_FILES,
  supervisorCorrupt,
  bootstrapStateNotEmpty,
  bootstrapArtifactMismatch,
  PRIVATE_DIRECTORY_MODE,
  INITIAL_BOOTSTRAP_PHASES,
  supervisorNotTerminal,
  MAX_STATE_BYTES,
  isRecord,
  hasExactKeys,
  isCanonicalIso,
  isDigest,
  isNonEmptyTrimmed,
  verifyRecordDigest,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapRepositoryIdentity,
  BootstrapInitialSupervisorHooks,
  BootstrapControlPlaneSupervisorState,
  InitialControlPlaneSupervisorAnchorEvidence,
  BootstrapPaths,
  BootstrapRootNamespace,
  Sha256Digest,
  InitialSupervisorBootstrapJournalProgress,
  InitialSupervisorBootstrapPhase,
  InitialSupervisorProvenance,
  InitialSupervisorBootstrapJournalRecord,
  VerifiedBuiltInEngineClosure,
} from './control-plane-bootstrap-types.ts';
import {
  bootstrapInterventionStateRoot,
  bootstrapPaths,
  readSupervisor,
  publishExactPrivateFile,
  assertPrivateDirectory,
  fsyncDirectory,
  readExactPrivateFile,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';
import {
  captureInitialSupervisorProvenance,
  assertInitialSupervisorProvenanceUnchanged,
  exactBootstrapGitOutput,
  verifyBootstrapRepositoryIdentityAt,
  readBootstrapRemoteBaseOid,
  bootstrapCommitIsAncestor,
  readBootstrapGitBlob,
  readBootstrapHeadTree,
} from './control-plane-bootstrap-provenance.ts';
import {
  verifiedBuiltInEngineClosure,
  assertBuiltInClosureTrackedAtProvenance,
  createBuiltInControlPlaneEngineArtifact,
  assertMaterializedBuiltInClosure,
  materializeBuiltInClosure,
  assertBuiltInControlPlaneEngineArtifact,
  verifyClosureManifest,
  closureRepositoryPath,
  assertTrackedClosureInventory,
  assertWorkspaceDependencyClosure,
} from './control-plane-bootstrap-closure.ts';
import { verifiedProtectedCapabilityManifest } from './control-plane-bootstrap-protected.ts';
import {
  builtInSupervisorExecutableSource,
  runRestartProbe,
} from './control-plane-bootstrap-executable.ts';

/**
 * One-time sealed bootstrap for the repository-default E1 supervisor. The
 * mutable engine cannot supply artifact bytes, closure identity, repository
 * identity, or durable state. Re-entry is exact and byte-idempotent.
 */
export function initializeBuiltInControlPlaneSupervisor(
  storageRoot: string,
  packageRoot: string,
  identity: BootstrapRepositoryIdentity,
  now: Date = new Date(),
  hooks: BootstrapInitialSupervisorHooks = {},
): BootstrapControlPlaneSupervisorState {
  if (
    bootstrapInterventionStateRoot(identity.gitCommonDirectory) !== storageRoot
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) {
    throw trustError(
      'CONTROL_PLANE_SUPERVISOR_INVALID',
      'Initial supervisor timestamp is invalid.',
      10,
    );
  }
  const provenance = captureInitialSupervisorProvenance(identity, packageRoot);
  hooks.testAfterProvenanceCapture?.();
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  const closure = verifiedBuiltInEngineClosure(packageRoot);
  assertBuiltInClosureTrackedAtProvenance(
    identity.worktreeRoot,
    provenance,
    closure,
  );
  const protectedManifest = verifiedProtectedCapabilityManifest(
    identity.worktreeRoot,
    provenance.headOid,
  );
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  const paths = bootstrapPaths(storageRoot);
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      closure.manifestDigest,
      protectedManifest.manifestDigest,
      closure.manifest,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  const executableDigest = rawDigest(executableBytes);
  const engineArtifact = createBuiltInControlPlaneEngineArtifact(
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    executableDigest,
  );
  const artifactId = engineArtifact.artifactId;
  const executablePath = path.join(
    paths.artifacts,
    artifactId.slice('sha256:'.length),
    'engine',
  );
  const expectedArtifact = {
    artifactId,
    executableDigest,
    closureDigest: protectedManifest.manifestDigest,
    executablePath,
  };
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  ensureInitialStateRoot(paths.root);
  initialGlobalNamespaceState(paths, artifactId);
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  ensureInitialBootstrapJournalDirectory(paths);
  const journalProgress = assertInitialBootstrapJournalInventory(paths);
  const initializedAt = resolveInitialBootstrapTimestamp(
    paths,
    provenance,
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    expectedArtifact,
    timestamp.toISOString(),
  );
  const payload = {
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId: provenance.repositoryId,
    activeArtifact: expectedArtifact,
    generation: 1,
    transition: null,
    updatedAt: initializedAt,
  };
  const state: BootstrapControlPlaneSupervisorState = {
    ...payload,
    recordDigest: canonicalDigest(payload),
  };
  const journal = createInitialSupervisorBootstrapJournal(
    provenance,
    initializedAt,
    closure.manifestDigest,
    protectedManifest.manifestDigest,
    expectedArtifact,
    state.recordDigest,
  );
  assertExistingInitialBootstrapJournalRecords(paths, journal);

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.PREPARED);
  hooks.testAfterBootstrapPhase?.('PREPARED');

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  if (
    journalProgress.completedPhases >= 2 ||
    journalProgress.pendingPhase === 'ARTIFACT_MATERIALIZED' ||
    journalProgress.pendingPhase === 'SUPERVISOR_PUBLISHED'
  ) {
    assertMaterializedBuiltInClosure(
      paths,
      closure,
      protectedManifest.bootstrapRuntimeFiles,
      engineArtifact,
      executableBytes,
    );
  } else {
    materializeBuiltInClosure(
      paths,
      closure,
      protectedManifest,
      engineArtifact,
      executableBytes,
    );
  }
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.ARTIFACT_MATERIALIZED);
  hooks.testAfterBootstrapPhase?.('ARTIFACT_MATERIALIZED');

  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  if (
    journalProgress.completedPhases >= 3 ||
    journalProgress.pendingPhase === 'SUPERVISOR_PUBLISHED'
  ) {
    const alreadyPublished = readSupervisor(paths);
    if (canonicalJson(alreadyPublished) !== canonicalJson(state)) {
      throw initialBootstrapJournalCorrupt();
    }
  }
  publishExactPrivateFile(
    paths.supervisor,
    `${canonicalJson(state)}\n`,
    PRIVATE_FILE_MODE,
    supervisorAlreadyInitialized,
  );
  const persisted = readSupervisor(paths);
  if (canonicalJson(persisted) !== canonicalJson(state)) {
    throw supervisorAlreadyInitialized();
  }
  assertInitialSupervisorProvenanceUnchanged(identity, provenance);
  publishInitialBootstrapJournalPhase(paths, journal.SUPERVISOR_PUBLISHED);
  hooks.testAfterBootstrapPhase?.('SUPERVISOR_PUBLISHED');
  assertInitialBootstrapJournalComplete(paths, journal);
  assertBuiltInControlPlaneEngineArtifact(
    paths,
    persisted,
    engineArtifact,
    closure,
    protectedManifest,
  );
  runRestartProbe(paths, persisted);
  return deepFreeze(structuredClone(persisted));
}

/**
 * Return the immutable generation-one anchor only after independently
 * replaying the complete three-phase bootstrap journal. Successor producers
 * use this digest as the root of the append-only supervisor history; callers
 * cannot nominate or synthesize an anchor.
 */
export function readInitialControlPlaneSupervisorAnchorEvidence(
  storageRoot: string,
  expectedRepositoryId: string,
): InitialControlPlaneSupervisorAnchorEvidence {
  const paths = bootstrapPaths(storageRoot);
  const prepared = assertPromotionHasValidInitialBootstrapAnchor(
    paths,
    expectedRepositoryId,
  );
  const published = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.SUPERVISOR_PUBLISHED,
    ),
  );
  return deepFreeze({
    repositoryId: prepared.provenance.repositoryId,
    activeTrustCommit: prepared.provenance.headOid,
    publishedRecordDigest: published.recordDigest,
    supervisorRecordDigest: prepared.supervisorRecordDigest,
    generation: 1 as const,
    activeArtifact: {
      artifactId: prepared.activeArtifact.artifactId,
      executableDigest: prepared.activeArtifact.executableDigest,
      closureDigest: prepared.activeArtifact.closureDigest,
    },
    recordedAt: prepared.initializedAt,
  });
}

function classifyBootstrapRootEntry(
  paths: BootstrapPaths,
  entryName: string,
): BootstrapRootNamespace {
  const localNames = new Set([
    path.basename(paths.checkpoints),
    path.basename(paths.interventions),
    path.basename(paths.sidecarSessions),
    path.basename(paths.adoptions),
    path.basename(paths.localSessions),
    path.basename(paths.localArtifacts),
    'maintenance-grants',
    'intervention-engine-artifacts',
  ]);
  if (localNames.has(entryName)) return 'local';
  if (entryName === path.basename(paths.operations)) return 'operations';
  const globalNames = new Set([
    path.basename(paths.supervisor),
    `${path.basename(paths.supervisor)}.pending`,
    path.basename(paths.initialBootstrapJournal),
    path.basename(paths.artifacts),
    path.basename(paths.approvalCandidates),
    path.basename(paths.bundles),
    path.basename(paths.controlUpdates),
    path.basename(paths.supervisorHistory),
  ]);
  return globalNames.has(entryName) ? 'global' : 'unknown';
}

export function assertNoOrphanedGlobalControlPlaneState(
  paths: BootstrapPaths,
): void {
  const root = fs.lstatSync(paths.root, { throwIfNoEntry: false });
  if (root === undefined) return;
  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    const classification = classifyBootstrapRootEntry(paths, entry.name);
    const absolute = path.join(paths.root, entry.name);
    if (classification === 'local') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_STATE_UNSAFE');
      continue;
    }
    if (classification === 'operations') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_STATE_UNSAFE');
      if (fs.readdirSync(absolute).length === 0) continue;
    }
    throw supervisorCorrupt();
  }
}

function initialGlobalNamespaceState(
  paths: BootstrapPaths,
  expectedArtifactId: Sha256Digest,
): void {
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    const absolute = path.join(paths.root, entry.name);
    const classification = classifyBootstrapRootEntry(paths, entry.name);
    if (
      classification === 'global' &&
      [
        path.basename(paths.approvalCandidates),
        path.basename(paths.bundles),
        path.basename(paths.controlUpdates),
      ].includes(entry.name)
    ) {
      throw bootstrapStateNotEmpty();
    }
    if (entry.name === path.basename(paths.artifacts)) {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
      const children = fs.readdirSync(absolute);
      if (
        children.length > 1 ||
        (children.length === 1 &&
          children[0] !== expectedArtifactId.slice('sha256:'.length))
      ) {
        throw bootstrapArtifactMismatch();
      }
      continue;
    }
    if (entry.name === path.basename(paths.initialBootstrapJournal)) {
      assertPrivateDirectory(
        absolute,
        'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
      );
      continue;
    }
    if (
      entry.name === path.basename(paths.supervisor) ||
      entry.name === `${path.basename(paths.supervisor)}.pending`
    ) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw initialBootstrapJournalCorrupt();
      }
      continue;
    }
    if (classification === 'operations') {
      assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
      if (fs.readdirSync(absolute).length !== 0) throw bootstrapStateNotEmpty();
      continue;
    }
    if (classification !== 'local') throw bootstrapStateNotEmpty();
    assertPrivateDirectory(absolute, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
  }
}

function ensureInitialStateRoot(storageRoot: string): void {
  try {
    fs.mkdirSync(storageRoot, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
  } catch {
    throw trustError(
      'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE',
      'Initial control-plane state root could not be created safely.',
      12,
    );
  }
  assertPrivateDirectory(storageRoot, 'CONTROL_PLANE_BOOTSTRAP_STATE_UNSAFE');
}

function ensureInitialBootstrapJournalDirectory(paths: BootstrapPaths): void {
  const existing = fs.lstatSync(paths.initialBootstrapJournal, {
    throwIfNoEntry: false,
  });
  if (existing === undefined) {
    try {
      fs.mkdirSync(paths.initialBootstrapJournal, {
        mode: PRIVATE_DIRECTORY_MODE,
      });
      fsyncDirectory(paths.root);
    } catch {
      throw initialBootstrapJournalCorrupt();
    }
  }
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
}

function assertInitialBootstrapJournalInventory(
  paths: BootstrapPaths,
): InitialSupervisorBootstrapJournalProgress {
  const entries = fs.readdirSync(paths.initialBootstrapJournal, {
    withFileTypes: true,
  });
  const names = new Set(entries.map((entry) => entry.name));
  const allowed = new Set(
    Object.values(INITIAL_BOOTSTRAP_PHASE_FILES).flatMap((fileName) => [
      fileName,
      `${fileName}.pending`,
    ]),
  );
  if (
    entries.some(
      (entry) =>
        !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  let completed = 0;
  let pendingCount = 0;
  let pendingPhase: InitialSupervisorBootstrapPhase | null = null;
  for (let index = 0; index < INITIAL_BOOTSTRAP_PHASES.length; index += 1) {
    const fileName =
      INITIAL_BOOTSTRAP_PHASE_FILES[INITIAL_BOOTSTRAP_PHASES[index]];
    const hasFinal = names.has(fileName);
    const hasPending = names.has(`${fileName}.pending`);
    if (hasFinal && hasPending) throw initialBootstrapJournalCorrupt();
    if (hasFinal) {
      if (index !== completed || pendingCount !== 0) {
        throw initialBootstrapJournalCorrupt();
      }
      completed += 1;
    }
    if (hasPending) {
      if (index !== completed || pendingCount !== 0) {
        throw initialBootstrapJournalCorrupt();
      }
      pendingCount += 1;
      pendingPhase = INITIAL_BOOTSTRAP_PHASES[index];
    }
  }
  if (pendingCount > 1) throw initialBootstrapJournalCorrupt();

  const preparedExists =
    names.has(INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED) ||
    names.has(`${INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED}.pending`);
  if (!preparedExists) {
    if (
      fs.lstatSync(paths.artifacts, { throwIfNoEntry: false }) !== undefined ||
      fs.lstatSync(paths.supervisor, { throwIfNoEntry: false }) !== undefined ||
      fs.lstatSync(`${paths.supervisor}.pending`, {
        throwIfNoEntry: false,
      }) !== undefined
    ) {
      throw bootstrapStateNotEmpty();
    }
  }
  const artifactExists =
    fs.lstatSync(paths.artifacts, { throwIfNoEntry: false }) !== undefined;
  const supervisorExists =
    fs.lstatSync(paths.supervisor, { throwIfNoEntry: false }) !== undefined;
  const supervisorPendingExists =
    fs.lstatSync(`${paths.supervisor}.pending`, {
      throwIfNoEntry: false,
    }) !== undefined;
  if (
    (pendingPhase === 'PREPARED' &&
      (artifactExists || supervisorExists || supervisorPendingExists)) ||
    (completed < 2 && (supervisorExists || supervisorPendingExists))
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  return { completedPhases: completed, pendingPhase };
}

function resolveInitialBootstrapTimestamp(
  paths: BootstrapPaths,
  provenance: InitialSupervisorProvenance,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  requestedTimestamp: string,
): string {
  const preparedPath = path.join(
    paths.initialBootstrapJournal,
    INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED,
  );
  const candidatePath =
    fs.lstatSync(preparedPath, { throwIfNoEntry: false }) !== undefined
      ? preparedPath
      : fs.lstatSync(`${preparedPath}.pending`, { throwIfNoEntry: false }) !==
          undefined
        ? `${preparedPath}.pending`
        : null;
  if (candidatePath === null) return requestedTimestamp;
  const candidate = readInitialBootstrapJournalRecord(candidatePath);
  const initializedAt = candidate.initializedAt;
  const state = createInitialSupervisorState(
    provenance.repositoryId,
    activeArtifact,
    initializedAt,
  );
  const expected = createInitialBootstrapJournalRecord(
    'PREPARED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    state.recordDigest,
    null,
  );
  if (canonicalJson(candidate) !== canonicalJson(expected)) {
    throw initialBootstrapJournalCorrupt();
  }
  return initializedAt;
}

function createInitialSupervisorState(
  repositoryId: string,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  updatedAt: string,
): BootstrapControlPlaneSupervisorState {
  const payload = {
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId,
    activeArtifact,
    generation: 1,
    transition: null,
    updatedAt,
  };
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function createInitialSupervisorBootstrapJournal(
  provenance: InitialSupervisorProvenance,
  initializedAt: string,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  supervisorRecordDigest: Sha256Digest,
): Record<
  InitialSupervisorBootstrapPhase,
  InitialSupervisorBootstrapJournalRecord
> {
  const prepared = createInitialBootstrapJournalRecord(
    'PREPARED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    null,
  );
  const materialized = createInitialBootstrapJournalRecord(
    'ARTIFACT_MATERIALIZED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    prepared.recordDigest,
  );
  const published = createInitialBootstrapJournalRecord(
    'SUPERVISOR_PUBLISHED',
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    materialized.recordDigest,
  );
  return {
    PREPARED: prepared,
    ARTIFACT_MATERIALIZED: materialized,
    SUPERVISOR_PUBLISHED: published,
  };
}

function createInitialBootstrapJournalRecord(
  phase: InitialSupervisorBootstrapPhase,
  provenance: InitialSupervisorProvenance,
  initializedAt: string,
  builtInClosureDigest: Sha256Digest,
  protectedManifestDigest: Sha256Digest,
  activeArtifact: BootstrapControlPlaneSupervisorState['activeArtifact'],
  supervisorRecordDigest: Sha256Digest,
  previousPhaseDigest: Sha256Digest | null,
): InitialSupervisorBootstrapJournalRecord {
  const payload = {
    kind: 'initial-supervisor-bootstrap-journal.v1' as const,
    phase,
    provenance,
    initializedAt,
    builtInClosureDigest,
    protectedManifestDigest,
    activeArtifact,
    supervisorRecordDigest,
    previousPhaseDigest,
  };
  return { ...payload, recordDigest: canonicalDigest(payload) };
}

function publishInitialBootstrapJournalPhase(
  paths: BootstrapPaths,
  record: InitialSupervisorBootstrapJournalRecord,
): void {
  publishExactPrivateFile(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES[record.phase],
    ),
    `${canonicalJson(record)}\n`,
    PRIVATE_FILE_MODE,
    initialBootstrapJournalCorrupt,
  );
}

function assertExistingInitialBootstrapJournalRecords(
  paths: BootstrapPaths,
  expected: Record<
    InitialSupervisorBootstrapPhase,
    InitialSupervisorBootstrapJournalRecord
  >,
): void {
  for (const phase of INITIAL_BOOTSTRAP_PHASES) {
    const finalPath = path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES[phase],
    );
    const candidatePath =
      fs.lstatSync(finalPath, { throwIfNoEntry: false }) !== undefined
        ? finalPath
        : fs.lstatSync(`${finalPath}.pending`, { throwIfNoEntry: false }) !==
            undefined
          ? `${finalPath}.pending`
          : null;
    if (candidatePath === null) continue;
    const observed = readInitialBootstrapJournalRecord(candidatePath);
    if (canonicalJson(observed) !== canonicalJson(expected[phase])) {
      throw initialBootstrapJournalCorrupt();
    }
  }
}

function assertInitialBootstrapJournalComplete(
  paths: BootstrapPaths,
  expected: Record<
    InitialSupervisorBootstrapPhase,
    InitialSupervisorBootstrapJournalRecord
  >,
): void {
  assertInitialBootstrapJournalInventory(paths);
  const entries = fs.readdirSync(paths.initialBootstrapJournal).sort();
  const expectedNames = INITIAL_BOOTSTRAP_PHASES.map(
    (phase) => INITIAL_BOOTSTRAP_PHASE_FILES[phase],
  ).sort();
  if (canonicalJson(entries) !== canonicalJson(expectedNames)) {
    throw initialBootstrapJournalCorrupt();
  }
  for (const phase of INITIAL_BOOTSTRAP_PHASES) {
    const record = readInitialBootstrapJournalRecord(
      path.join(
        paths.initialBootstrapJournal,
        INITIAL_BOOTSTRAP_PHASE_FILES[phase],
      ),
    );
    if (canonicalJson(record) !== canonicalJson(expected[phase])) {
      throw initialBootstrapJournalCorrupt();
    }
  }
}

export function assertInitialBootstrapTerminalSelection(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  if (supervisor.generation !== 1) throw supervisorNotTerminal();
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
  const progress = assertInitialBootstrapJournalInventory(paths);
  if (progress.completedPhases !== 3 || progress.pendingPhase !== null) {
    throw supervisorNotTerminal();
  }
  const records = INITIAL_BOOTSTRAP_PHASES.map((phase) =>
    readInitialBootstrapJournalRecord(
      path.join(
        paths.initialBootstrapJournal,
        INITIAL_BOOTSTRAP_PHASE_FILES[phase],
      ),
    ),
  );
  const [prepared, materialized, published] = records;
  if (
    prepared.phase !== 'PREPARED' ||
    prepared.previousPhaseDigest !== null ||
    materialized.phase !== 'ARTIFACT_MATERIALIZED' ||
    materialized.previousPhaseDigest !== prepared.recordDigest ||
    published.phase !== 'SUPERVISOR_PUBLISHED' ||
    published.previousPhaseDigest !== materialized.recordDigest ||
    records.some(
      (record) =>
        canonicalJson(initialBootstrapStableRecord(record)) !==
        canonicalJson(initialBootstrapStableRecord(prepared)),
    ) ||
    prepared.supervisorRecordDigest !== supervisor.recordDigest ||
    prepared.provenance.repositoryId !== supervisor.repositoryId ||
    prepared.initializedAt !== supervisor.updatedAt ||
    prepared.protectedManifestDigest !==
      supervisor.activeArtifact.closureDigest ||
    canonicalJson(prepared.activeArtifact) !==
      canonicalJson(supervisor.activeArtifact)
  ) {
    throw supervisorNotTerminal();
  }

  const provenance = prepared.provenance;
  const packageSuffix = path.join('packages', 'workflow-engine');
  const worktreeRoot = path.dirname(path.dirname(provenance.packageRoot));
  if (
    provenance.packageRoot !== path.join(worktreeRoot, packageSuffix) ||
    provenance.remoteBaseOid !== provenance.headOid ||
    provenance.branchRef !==
      provenance.remoteBaseRef.replace(
        /^refs\/remotes\/origin\//,
        'refs/heads/',
      )
  ) {
    throw supervisorNotTerminal();
  }
  const gitCommonDirectory = fs.realpathSync(
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  );
  if (bootstrapInterventionStateRoot(gitCommonDirectory) !== paths.root) {
    throw supervisorNotTerminal();
  }
  const identity: BootstrapRepositoryIdentity = {
    gitCommonDirectory,
    worktreeRoot,
    branchRef: provenance.branchRef,
  };
  if (
    verifyBootstrapRepositoryIdentityAt(identity, provenance.headOid) !==
    supervisor.repositoryId
  ) {
    throw supervisorNotTerminal();
  }
  const trustedTreeOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    `${provenance.headOid}^{tree}`,
  ]);
  const remoteTip = readBootstrapRemoteBaseOid(
    worktreeRoot,
    provenance.remoteBaseRef,
  );
  if (
    trustedTreeOid !== provenance.treeOid ||
    !bootstrapCommitIsAncestor(worktreeRoot, provenance.headOid, remoteTip)
  ) {
    throw supervisorNotTerminal();
  }

  const storedManifestPath = path.join(
    paths.artifacts,
    supervisor.activeArtifact.artifactId.slice('sha256:'.length),
    'built-in-engine-closure.json',
  );
  const manifestBytes = readExactPrivateFile(
    storedManifestPath,
    PRIVATE_FILE_MODE,
    MAX_STATE_BYTES,
  );
  const committedManifestBytes = readBootstrapGitBlob(
    worktreeRoot,
    provenance.headOid,
    'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
  );
  if (
    !manifestBytes.equals(committedManifestBytes) ||
    rawDigest(manifestBytes) !== prepared.builtInClosureDigest
  ) {
    throw supervisorNotTerminal();
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw supervisorNotTerminal();
  }
  if (
    `${JSON.stringify(manifestValue, null, 2)}\n` !==
    manifestBytes.toString('utf8')
  ) {
    throw supervisorNotTerminal();
  }
  const manifest = verifyClosureManifest(manifestValue);
  const trustedTree = readBootstrapHeadTree(worktreeRoot, provenance.headOid);
  const closureFiles = manifest.files.map((entry) => {
    const repositoryPath = closureRepositoryPath(manifest, entry.path);
    const bytes = readBootstrapGitBlob(
      worktreeRoot,
      provenance.headOid,
      repositoryPath,
    );
    const treeEntry = trustedTree.find(
      (candidate) => candidate.path === repositoryPath,
    );
    if (
      treeEntry?.type !== 'blob' ||
      treeEntry.mode !== entry.mode ||
      rawDigest(bytes) !== entry.digest
    ) {
      throw supervisorNotTerminal();
    }
    return { ...entry, repositoryPath, bytes };
  });
  try {
    assertTrackedClosureInventory(manifest, trustedTree);
    assertWorkspaceDependencyClosure(manifest, closureFiles);
  } catch {
    throw supervisorNotTerminal();
  }
  const pinBytes = readBootstrapGitBlob(
    worktreeRoot,
    provenance.headOid,
    'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  ).toString('utf8');
  const pinnedDigests = [
    ...pinBytes.matchAll(/'((?:sha256:)[0-9a-f]{64})'/g),
  ].map((match) => match[1]);
  if (
    pinnedDigests.length !== 1 ||
    pinnedDigests[0] !== prepared.builtInClosureDigest
  ) {
    throw supervisorNotTerminal();
  }
  const protectedManifest = verifiedProtectedCapabilityManifest(
    worktreeRoot,
    provenance.headOid,
    false,
  );
  if (protectedManifest.manifestDigest !== prepared.protectedManifestDigest) {
    throw supervisorNotTerminal();
  }
  const closure: VerifiedBuiltInEngineClosure = {
    manifest,
    manifestBytes,
    manifestDigest: prepared.builtInClosureDigest,
    files: closureFiles,
  };
  const executableBytes = Buffer.from(
    builtInSupervisorExecutableSource(
      prepared.builtInClosureDigest,
      prepared.protectedManifestDigest,
      manifest,
      protectedManifest.bootstrapRuntimeFiles,
    ),
  );
  const artifact = createBuiltInControlPlaneEngineArtifact(
    prepared.builtInClosureDigest,
    prepared.protectedManifestDigest,
    rawDigest(executableBytes),
  );
  if (
    artifact.artifactId !== supervisor.activeArtifact.artifactId ||
    artifact.executableDigest !== supervisor.activeArtifact.executableDigest
  ) {
    throw supervisorNotTerminal();
  }
  assertMaterializedBuiltInClosure(
    paths,
    closure,
    protectedManifest.bootstrapRuntimeFiles,
    artifact,
    executableBytes,
  );
  if (
    readBootstrapRemoteBaseOid(worktreeRoot, provenance.remoteBaseRef) !==
    remoteTip
  ) {
    throw supervisorNotTerminal();
  }
}

function initialBootstrapStableRecord(
  record: InitialSupervisorBootstrapJournalRecord,
): Omit<
  InitialSupervisorBootstrapJournalRecord,
  'phase' | 'previousPhaseDigest' | 'recordDigest'
> {
  const {
    phase: _phase,
    previousPhaseDigest: _previous,
    recordDigest: _digest,
    ...stable
  } = record;
  return stable;
}

export function readInitialBootstrapJournalRecord(
  filePath: string,
): InitialSupervisorBootstrapJournalRecord {
  const value = readCanonicalPrivateRecord(
    filePath,
    initialBootstrapJournalCorrupt,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'builtInClosureDigest',
      'initializedAt',
      'kind',
      'phase',
      'previousPhaseDigest',
      'protectedManifestDigest',
      'provenance',
      'recordDigest',
      'supervisorRecordDigest',
    ]) ||
    value.kind !== 'initial-supervisor-bootstrap-journal.v1' ||
    !INITIAL_BOOTSTRAP_PHASES.includes(
      value.phase as InitialSupervisorBootstrapPhase,
    ) ||
    !isCanonicalIso(value.initializedAt) ||
    !isDigest(value.builtInClosureDigest) ||
    !isDigest(value.protectedManifestDigest) ||
    !isDigest(value.supervisorRecordDigest) ||
    (value.previousPhaseDigest !== null &&
      !isDigest(value.previousPhaseDigest)) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, [
      'branchRef',
      'headOid',
      'packageRoot',
      'remoteBaseOid',
      'remoteBaseRef',
      'repositoryId',
      'treeOid',
    ]) ||
    !isNonEmptyTrimmed(value.provenance.repositoryId) ||
    !isNonEmptyTrimmed(value.provenance.branchRef) ||
    !isNonEmptyTrimmed(value.provenance.remoteBaseRef) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
      String(value.provenance.remoteBaseOid),
    ) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.provenance.headOid)) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.provenance.treeOid)) ||
    !isNonEmptyTrimmed(value.provenance.packageRoot) ||
    !isRecord(value.activeArtifact) ||
    !verifyRecordDigest(value)
  ) {
    throw initialBootstrapJournalCorrupt();
  }
  return value as unknown as InitialSupervisorBootstrapJournalRecord;
}

export function assertPromotionHasValidInitialBootstrapAnchor(
  paths: BootstrapPaths,
  repositoryId: string,
): InitialSupervisorBootstrapJournalRecord {
  assertPrivateDirectory(
    paths.initialBootstrapJournal,
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
  );
  const prepared = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.PREPARED,
    ),
  );
  if (prepared.provenance.repositoryId !== repositoryId) {
    throw supervisorNotTerminal();
  }
  const initialSupervisor: BootstrapControlPlaneSupervisorState = {
    kind: 'control-plane-supervisor-state.v1',
    repositoryId,
    activeArtifact: prepared.activeArtifact,
    generation: 1,
    transition: null,
    updatedAt: prepared.initializedAt,
    recordDigest: prepared.supervisorRecordDigest,
  };
  assertInitialBootstrapTerminalSelection(paths, initialSupervisor);
  return prepared;
}
