import path from 'node:path';
import fs from 'node:fs';
import {
  type ChangeRoutingAuthorityPort,
  type ChangeRoutingContinuationGrantPort,
  type ChangeRoutingReview,
  parseChangeRoutingIntent,
  synthesizeSource,
  applyIntent,
  digestObservedRepositoryFacts,
  digestSource,
  type ChangeRoutingInspection,
  readyRecord,
  inspectObservedRoutingChange,
  buildChangeRoutingInspection,
  type ChangeRoutingAdmission,
  singleChangeRoutingAdmission,
  admissibleRoutingRole,
  routingAdmission,
  routingAdmissionRequired,
  type ObservedChange,
  archivedChangeId,
  routingInvalid,
  digestBytes,
  digestBuffer,
  type ChangeRoutingAuthorityFacts,
  type ChangeRoutingIntent,
  type ChangeLifecycleSource,
  requiredRoutingAuthorityChangeIds,
  type RoutingRecord,
  changeRoutingContinuationState,
  type ChangeRoutingContinuationAuthority,
  requiredContinuationAction,
  requireContinuationGrant,
  verifyCompletedContinuationGrantRecord,
  changeLifecycleRelativePath,
  parseChangeLifecycleSource,
  prettyJson,
} from '../../modules/lifecycle/change-routing.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { parseTasks } from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { discoverRepository } from '../repository-transaction/git.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { isRecord } from '@jigwright/core/contract-values';

export function prepareChangeRoutingReview(
  repositoryRoot: string,
  rawIntent: unknown,
  authorityPort: ChangeRoutingAuthorityPort,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingReview {
  const intent = parseChangeRoutingIntent(rawIntent);
  const snapshot = readSourceSnapshot(repositoryRoot);
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const continuationAuthority = authorizeContinuation(
    repositoryRoot,
    source,
    snapshot.digest,
    intent,
    observed,
    continuationGrantPort,
  );
  const nextSource = applyIntent(source, intent, observed);
  const authorityFacts = requiredRoutingAuthorityFacts(
    repositoryRoot,
    intent,
    nextSource,
    observed,
    authorityPort,
  );
  return Object.freeze({
    schemaVersion: 3 as const,
    kind: 'jigwright.change-routing-review.v3' as const,
    expectedSourceDigest: snapshot.digest,
    expectedRepositoryFactsDigest: digestObservedRepositoryFacts(observed),
    authorityFacts,
    continuationAuthority,
    intent,
    nextSource,
    nextSourceDigest: digestSource(nextSource),
  });
}

export function inspectChangeRouting(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): ChangeRoutingInspection {
  const snapshot = readSourceSnapshot(repositoryRoot);
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const records = new Map(
    source.records.map((record) => [record.changeId, record]),
  );
  const changes = observed.map((change) => {
    const record = records.get(change.changeId) ?? readyRecord(change.changeId);
    const runtimeState = observeRuntimeState(repositoryRoot, change.changeId);
    return inspectObservedRoutingChange(
      source,
      change,
      record,
      runtimeState,
      observed,
    );
  });
  return buildChangeRoutingInspection(snapshot, source, changes);
}

export function assertChangeRoutingAdmission(
  repositoryRoot: string,
  requestedChangeId: string,
  authorityPort: ChangeRoutingAuthorityPort,
): ChangeRoutingAdmission {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readSourceSnapshot(repositoryRoot);
  if (snapshot.source === null) {
    const structurallyObserved = observeChanges(repositoryRoot);
    const admission = singleChangeRoutingAdmission(structurallyObserved);
    if (admission !== null) return admission;
  }
  const observed = observeChanges(repositoryRoot, authorityPort);
  const source = snapshot.source ?? synthesizeSource(observed);
  const requested = observed.find((change) => change.changeId === changeId);
  const record =
    source.records.find((candidate) => candidate.changeId === changeId) ??
    readyRecord(changeId);
  const runtimeState = observeRuntimeState(repositoryRoot, changeId);
  const role = admissibleRoutingRole(
    source,
    requested,
    record,
    runtimeState,
    changeId,
  );
  if (role !== null) {
    if (requested!.authority === null) {
      authorityPort.loadCurrentAuthority(repositoryRoot, changeId);
    }
    return routingAdmission(source, role);
  }
  return routingAdmissionRequired(changeId);
}

export function observeChanges(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): readonly ObservedChange[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const changeRoot = path.join(repositoryRoot, config.changeRoot);
  const active = fs
    .readdirSync(changeRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'archive' &&
        // A directory holding nothing but `origin.json` is a promotion that
        // has not been proposed yet: it has reserved an identity and has no
        // tasks to route.
        !isUnproposedChangeReservation(path.join(changeRoot, entry.name)),
    )
    .map((entry) =>
      observeChange(
        repositoryRoot,
        path.join(changeRoot, entry.name),
        entry.name,
        false,
        authorityPort,
      ),
    );
  const archiveRoot = path.join(changeRoot, 'archive');
  const archiveStats = fs.lstatSync(archiveRoot, { throwIfNoEntry: false });
  const archived =
    archiveStats?.isDirectory() === true
      ? fs
          .readdirSync(archiveRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            observeChange(
              repositoryRoot,
              path.join(archiveRoot, entry.name),
              archivedChangeId(entry.name),
              true,
              authorityPort,
            ),
          )
      : [];
  return Object.freeze(
    [...active, ...archived].sort((left, right) =>
      left.changeId.localeCompare(right.changeId),
    ),
  );
}

function isUnproposedChangeReservation(directory: string): boolean {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return (
    entries.length === 1 &&
    entries[0]!.isFile() &&
    entries[0]!.name === 'origin.json'
  );
}

function observeChange(
  repositoryRoot: string,
  directory: string,
  changeId: string,
  archived: boolean,
  authorityPort?: ChangeRoutingAuthorityPort,
): ObservedChange {
  const tasksPath = path.join(directory, 'tasks.md');
  const tasksStats = fs.lstatSync(tasksPath, { throwIfNoEntry: false });
  if (
    !tasksStats?.isFile() ||
    tasksStats.isSymbolicLink() ||
    tasksStats.nlink !== 1
  ) {
    throw routingInvalid('Change task source is not a plain file.');
  }
  const bytes = fs.readFileSync(tasksPath, 'utf8');
  const tasks = parseTasks(bytes);
  const authorityArtifacts = observeRoutingFacts(directory);
  const completed = tasks.length > 0 && tasks.every((task) => task.completed);
  const authorityChecked = archived || completed || authorityPort !== undefined;
  const authority =
    archived || completed || authorityPort === undefined
      ? null
      : tryLoadCurrentRoutingAuthority(authorityPort, repositoryRoot, changeId);
  return Object.freeze({
    changeId: assertChangeId(changeId),
    archived,
    completed,
    authorityChecked,
    factsDigest: digestBytes(
      canonicalJson({ archived, artifacts: authorityArtifacts, authority }),
    ),
    authority,
    tasks: Object.freeze(tasks),
  });
}

function observeRoutingFacts(directory: string): readonly Readonly<{
  path: string;
  mode: '100644' | '100755';
  digest: string;
}>[] {
  const facts: Array<{
    path: string;
    mode: '100644' | '100755';
    digest: string;
  }> = [];
  const visit = (current: string): void => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const artifactPath = path.join(current, entry.name);
      const stats = fs.lstatSync(artifactPath);
      if (stats.isSymbolicLink()) {
        throw routingInvalid('Routing authority input cannot be a symlink.');
      }
      if (stats.isDirectory()) {
        visit(artifactPath);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw routingInvalid('Routing authority input is not a plain file.');
      }
      facts.push({
        path: path.relative(directory, artifactPath).split(path.sep).join('/'),
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        digest: digestBuffer(fs.readFileSync(artifactPath)),
      });
    }
  };
  visit(directory);
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
}

function tryLoadCurrentRoutingAuthority(
  authorityPort: ChangeRoutingAuthorityPort,
  repositoryRoot: string,
  changeId: string,
): ChangeRoutingAuthorityFacts | null {
  try {
    return authorityPort.loadCurrentAuthority(repositoryRoot, changeId);
  } catch {
    return null;
  }
}

export function requiredRoutingAuthorityFacts(
  repositoryRoot: string,
  intent: ChangeRoutingIntent,
  nextSource: ChangeLifecycleSource,
  observed: readonly ObservedChange[],
  authorityPort: ChangeRoutingAuthorityPort,
): readonly ChangeRoutingAuthorityFacts[] {
  return Object.freeze(
    requiredRoutingAuthorityChangeIds(intent, nextSource).map((changeId) => {
      const current = observed.find(
        (change) => change.changeId === changeId,
      )?.authority;
      return (
        current ?? authorityPort.loadCurrentAuthority(repositoryRoot, changeId)
      );
    }),
  );
}

export function observeChangeRoutingContinuationState(
  repositoryRoot: string,
  requestedChangeId: string,
): Readonly<{
  kind: 'change-routing-continuation';
  digest: `sha256:${string}`;
  sourceDigest: `sha256:${string}`;
  record: RoutingRecord;
}> {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readSourceSnapshot(repositoryRoot);
  return changeRoutingContinuationState(snapshot, changeId);
}

export function authorizeContinuation(
  repositoryRoot: string,
  source: ChangeLifecycleSource,
  sourceDigest: string | null,
  intent: ChangeRoutingIntent,
  observed: readonly ObservedChange[],
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingContinuationAuthority | null {
  const action = requiredContinuationAction(source, intent, observed);
  if (action === null) return null;
  if (action.grantChallengeId === undefined) {
    const continuation = observeChangeRoutingContinuationState(
      repositoryRoot,
      action.changeId,
    );
    requireContinuationGrant(sourceDigest, continuation, action);
  }
  return verifyCompletedContinuationGrant(
    repositoryRoot,
    action.changeId,
    action.grantChallengeId,
    continuationGrantPort,
  );
}

function verifyCompletedContinuationGrant(
  repositoryRoot: string,
  changeId: string,
  challengeId: string,
  continuationGrantPort: ChangeRoutingContinuationGrantPort,
): ChangeRoutingContinuationAuthority {
  const observed = observeChangeRoutingContinuationState(
    repositoryRoot,
    changeId,
  );
  const record = continuationGrantPort.readGrantRecord(
    repositoryRoot,
    challengeId,
  );
  return verifyCompletedContinuationGrantRecord(changeId, observed, record);
}

export function readSourceSnapshot(repositoryRoot: string): Readonly<{
  source: ChangeLifecycleSource | null;
  digest: string | null;
}> {
  const sourcePath = path.join(repositoryRoot, changeLifecycleRelativePath);
  const stats = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stats) return { source: null, digest: null };
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw routingInvalid('Controlled lifecycle source is not a plain file.');
  }
  const bytes = fs.readFileSync(sourcePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw routingInvalid('Controlled lifecycle source is not valid JSON.');
  }
  const source = parseChangeLifecycleSource(value);
  if (bytes !== prettyJson(source)) {
    throw routingInvalid(
      'Controlled lifecycle source bytes are not canonical.',
    );
  }
  return { source, digest: digestBytes(bytes) };
}

function observeRuntimeState(
  repositoryRoot: string,
  changeId: string,
): 'revising' | 'recovery-required' | null {
  try {
    const git = discoverRepository(repositoryRoot);
    const config = loadWorkflowConfig(repositoryRoot);
    const runtime = runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const sessionDirectory = runtime.sessions;
    const sessionStats = fs.lstatSync(sessionDirectory, {
      throwIfNoEntry: false,
    });
    if (sessionStats?.isDirectory()) {
      for (const entry of fs.readdirSync(sessionDirectory).sort()) {
        if (!entry.endsWith('.json')) continue;
        const value = JSON.parse(
          fs.readFileSync(path.join(sessionDirectory, entry), 'utf8'),
        ) as unknown;
        if (
          isRecord(value) &&
          value.changeId === changeId &&
          value.state === 'revising'
        ) {
          return 'revising';
        }
      }
    }
    const transactionDirectory = path.join(
      runtime.root,
      'open-task',
      'transactions',
    );
    const transactionStats = fs.lstatSync(transactionDirectory, {
      throwIfNoEntry: false,
    });
    if (transactionStats?.isDirectory()) {
      for (const entry of fs.readdirSync(transactionDirectory).sort()) {
        if (!entry.endsWith('.json')) continue;
        let value: unknown;
        try {
          value = JSON.parse(
            fs.readFileSync(path.join(transactionDirectory, entry), 'utf8'),
          ) as unknown;
        } catch {
          return 'recovery-required';
        }
        if (
          isRecord(value) &&
          value.changeId === changeId &&
          value.phase !== 'completed' &&
          typeof value.sessionId === 'string'
        ) {
          const sessionPath = path.join(
            runtime.sessions,
            `${value.sessionId}.json`,
          );
          if (!fs.existsSync(sessionPath)) return 'recovery-required';
        }
      }
    }
  } catch {
    return 'recovery-required';
  }
  return null;
}
