/**
 * Parses authority plan mutations and checks, applies or recovers their
 * worktree effects.
 *
 * Invariants:
 * - Mutation paths in an authority plan must be sorted and unique.
 */
// authority plan worktree; repository effects remain bound by the public module.
import type {
  AuthorityPlanWorktreeBindings,
  AuthorityPlanWorktreeBindingsTypes,
} from './authority-plan.ts';
import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';

type AuthorityPlanIntent =
  AuthorityPlanWorktreeBindingsTypes['AuthorityPlanIntent'];
type AuthorityPlanMutation =
  AuthorityPlanWorktreeBindingsTypes['AuthorityPlanMutation'];
type CandidateExternalEffect =
  AuthorityPlanWorktreeBindingsTypes['CandidateExternalEffect'];
type MaintainerEvidenceWaiver =
  AuthorityPlanWorktreeBindingsTypes['MaintainerEvidenceWaiver'];
type AuthorityPlanPreviewEntry =
  AuthorityPlanWorktreeBindingsTypes['AuthorityPlanPreviewEntry'];
type AuthorityPlanRecord =
  AuthorityPlanWorktreeBindingsTypes['AuthorityPlanRecord'];
type ApprovalResult = AuthorityPlanWorktreeBindingsTypes['ApprovalResult'];
type AuthorityPlanLocalApplication =
  AuthorityPlanWorktreeBindingsTypes['AuthorityPlanLocalApplication'];
type AuthorityAttestationRelayProjection =
  AuthorityPlanWorktreeBindingsTypes['AuthorityAttestationRelayProjection'];

export function createAuthorityPlanWorktree(
  bindings: () => AuthorityPlanWorktreeBindings,
) {
  function parseIntent(value: unknown): AuthorityPlanIntent {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      MAX_MUTATIONS,
      planInvalid,
      assertChangeId,
      assertTaskId,
      canonicalJson,
    } = boundServices;

    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'taskId',
        'profileId',
        'reason',
        'message',
        'mutations',
        'externalEffects',
        'evidenceWaivers',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'authority-plan-intent.v1' ||
      typeof value.changeId !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.profileId !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.profileId) ||
      typeof value.reason !== 'string' ||
      value.reason.trim() !== value.reason ||
      value.reason.length < 12 ||
      value.reason.length > 500 ||
      typeof value.message !== 'string' ||
      value.message.trim() !== value.message ||
      value.message.length < 1 ||
      value.message.includes('\n') ||
      !Array.isArray(value.mutations) ||
      value.mutations.length < 1 ||
      value.mutations.length > MAX_MUTATIONS ||
      !Array.isArray(value.externalEffects) ||
      !Array.isArray(value.evidenceWaivers)
    ) {
      throw planInvalid('Authority plan intent is malformed.');
    }
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    const mutations = value.mutations.map(parseMutation);
    const paths = mutations.map((mutation) => mutation.path);
    if (
      new Set(paths).size !== paths.length ||
      canonicalJson(paths) !== canonicalJson([...paths].sort())
    ) {
      throw planInvalid(
        'Authority plan mutation paths must be sorted and unique.',
      );
    }
    const externalEffects = value.externalEffects.map(parseExternalEffect);
    const evidenceWaivers = value.evidenceWaivers.map(parseEvidenceWaiver);
    return structuredClone({
      schemaVersion: 1,
      kind: 'authority-plan-intent.v1',
      changeId: value.changeId,
      taskId: value.taskId,
      profileId: value.profileId,
      reason: value.reason,
      message: value.message,
      mutations,
      externalEffects,
      evidenceWaivers,
    });
  }

  function parseMutation(value: unknown): AuthorityPlanMutation {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      SHA256,
      MAX_CONTENT_BYTES,
      planInvalid,
      normalizeExactRepositoryPath,
    } = boundServices;

    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['path', 'expectedBeforeSha256', 'content']) ||
      typeof value.path !== 'string' ||
      (value.expectedBeforeSha256 !== null &&
        (typeof value.expectedBeforeSha256 !== 'string' ||
          !SHA256.test(value.expectedBeforeSha256))) ||
      (value.content !== null && typeof value.content !== 'string') ||
      (typeof value.content === 'string' &&
        Buffer.byteLength(value.content, 'utf8') > MAX_CONTENT_BYTES)
    ) {
      throw planInvalid('Authority plan mutation is malformed.');
    }
    return {
      path: normalizeExactRepositoryPath(value.path),
      expectedBeforeSha256: value.expectedBeforeSha256,
      content: value.content,
    };
  }

  function parseExternalEffect(value: unknown): CandidateExternalEffect {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { isRecord, hasExactKeys, planInvalid } = boundServices;

    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'effectType',
        'targetDigest',
        'authorizationDigest',
        'resultDigest',
      ]) ||
      typeof value.effectType !== 'string' ||
      typeof value.targetDigest !== 'string' ||
      (value.authorizationDigest !== null &&
        typeof value.authorizationDigest !== 'string') ||
      (value.resultDigest !== null && typeof value.resultDigest !== 'string')
    ) {
      throw planInvalid('Authority plan external effect is malformed.');
    }
    return {
      effectType: value.effectType,
      targetDigest: value.targetDigest,
      authorizationDigest: value.authorizationDigest,
      resultDigest: value.resultDigest,
    };
  }

  function parseEvidenceWaiver(value: unknown): MaintainerEvidenceWaiver {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { isRecord, hasExactKeys, planInvalid } = boundServices;

    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['checkId', 'reason']) ||
      typeof value.checkId !== 'string' ||
      typeof value.reason !== 'string'
    ) {
      throw planInvalid('Authority plan evidence waiver is malformed.');
    }
    return { checkId: value.checkId, reason: value.reason };
  }

  function previewMutation(
    repositoryRoot: string,
    mutation: AuthorityPlanMutation,
  ): AuthorityPlanPreviewEntry {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const {
      assertPolicyPathInsideRepository,
      path,
      fs,
      planInvalid,
      digestBytes,
      planError,
      ExitCode,
    } = boundServices;

    assertPolicyPathInsideRepository(repositoryRoot, mutation.path);
    const target = path.join(repositoryRoot, mutation.path);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stats !== undefined && !stats.isFile()) {
      throw planInvalid(
        `Authority plan target is not a regular file: ${mutation.path}`,
      );
    }
    const before = stats === undefined ? null : fs.readFileSync(target, 'utf8');
    const beforeSha256 = before === null ? null : digestBytes(before);
    if (beforeSha256 !== mutation.expectedBeforeSha256) {
      throw planError(
        'AUTHORITY_PLAN_WORKTREE_CHANGED',
        `Authority plan precondition changed for ${mutation.path}.`,
        ExitCode.staleState,
      );
    }
    const afterSha256 =
      mutation.content === null ? null : digestBytes(mutation.content);
    if (beforeSha256 === afterSha256) {
      throw planInvalid(`Authority plan mutation is a no-op: ${mutation.path}`);
    }
    return {
      path: mutation.path,
      beforeSha256,
      afterSha256,
      unifiedDiff: unifiedDiff(mutation.path, before, mutation.content),
    };
  }

  function unifiedDiff(
    filePath: string,
    before: string | null,
    after: string | null,
  ): string {
    const beforeLines =
      before === null ? [] : before.replace(/\n$/, '').split('\n');
    const afterLines =
      after === null ? [] : after.replace(/\n$/, '').split('\n');
    return [
      `--- ${before === null ? '/dev/null' : `a/${filePath}`}`,
      `+++ ${after === null ? '/dev/null' : `b/${filePath}`}`,
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      ...beforeLines.map((line) => `-${line}`),
      ...afterLines.map((line) => `+${line}`),
      '',
    ].join('\n');
  }

  function assertPreparedWorktree(
    repositoryRoot: string,
    record: AuthorityPlanRecord,
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const {
      discoverRepository,
      planError,
      ExitCode,
      canonicalJson,
      planUnsafe,
    } = boundServices;

    const current = discoverRepository(repositoryRoot);
    if (
      current.branch !== record.branch ||
      current.head !== record.baseCommit ||
      current.tree !== record.baseTree ||
      current.statusEntries.length !== 0
    ) {
      throw planError(
        'AUTHORITY_PLAN_WORKTREE_CHANGED',
        'The authority-plan worktree changed after dry-run preparation.',
        ExitCode.staleState,
      );
    }
    for (const mutation of record.intent.mutations) {
      const preview = previewMutation(repositoryRoot, mutation);
      const expected = record.preview.find(
        (entry) => entry.path === mutation.path,
      );
      if (
        expected === undefined ||
        canonicalJson(preview) !== canonicalJson(expected)
      ) {
        throw planUnsafe(
          'Authority plan preview no longer matches its exact input.',
        );
      }
    }
  }

  function assertApplyingWorktree(
    repositoryRoot: string,
    record: AuthorityPlanRecord,
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { discoverRepository, planError, ExitCode, canonicalJson } =
      boundServices;

    const current = discoverRepository(repositoryRoot);
    if (
      current.branch !== record.branch ||
      current.head !== record.baseCommit
    ) {
      throw planError(
        'AUTHORITY_PLAN_WORKTREE_CHANGED',
        'Authority plan local application moved to a different branch or base.',
        ExitCode.staleState,
      );
    }
    if (current.statusEntries.length === 0) return;
    const changed = listWorkingTreePaths(repositoryRoot);
    const expected = record.intent.mutations.map((mutation) => mutation.path);
    if (canonicalJson(changed) !== canonicalJson(expected)) {
      throw planError(
        'AUTHORITY_PLAN_WORKTREE_CHANGED',
        'Authority plan local application contains unrelated worktree changes.',
        ExitCode.staleState,
      );
    }
    for (const mutation of record.intent.mutations) {
      assertResultBytes(repositoryRoot, mutation);
    }
  }

  function applyMutations(
    repositoryRoot: string,
    mutations: readonly AuthorityPlanMutation[],
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { path, assertPolicyPathInsideRepository, fs } = boundServices;

    for (const mutation of mutations) {
      const target = path.join(repositoryRoot, mutation.path);
      assertPolicyPathInsideRepository(repositoryRoot, mutation.path);
      if (mutation.content === null) {
        fs.rmSync(target);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, mutation.content, 'utf8');
      }
    }
  }

  function restoreMutations(
    repositoryRoot: string,
    record: AuthorityPlanRecord,
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { path, fs, runGit } = boundServices;

    for (const mutation of record.intent.mutations) {
      const target = path.join(repositoryRoot, mutation.path);
      if (mutation.expectedBeforeSha256 === null) {
        fs.rmSync(target, { force: true });
      } else {
        const before = readFileAtRevision(
          repositoryRoot,
          record.baseCommit,
          `${mutation.path}`,
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, before, 'utf8');
      }
    }
    runGit(repositoryRoot, [
      'reset',
      '--quiet',
      record.baseCommit,
      '--',
      ...record.intent.mutations.map((mutation) => mutation.path),
    ]);
  }

  function normalizeApplication(
    repositoryRoot: string,
    record: AuthorityPlanRecord,
    result: ApprovalResult,
  ): AuthorityPlanLocalApplication {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { discoverRepository, COMMIT_OID, planUnsafe } = boundServices;

    const current = discoverRepository(repositoryRoot);
    if (
      result.commitHash !== current.head ||
      result.resultTree !== current.tree ||
      !COMMIT_OID.test(result.commitHash) ||
      !COMMIT_OID.test(result.resultTree)
    ) {
      throw planUnsafe(
        'Local authority result does not match the current commit.',
      );
    }
    const recovered = recoverLocalApplication(repositoryRoot, record);
    if (recovered.grantId !== result.grantId) {
      throw planUnsafe(
        'Local authority result grant does not match its commit.',
      );
    }
    return {
      grantId: result.grantId,
      sessionId: result.sessionId ?? null,
      commitHash: result.commitHash,
      resultTree: result.resultTree,
      tagRef: result.tagRef,
      publishCommand: result.publishCommand,
      attestationRelayCommand: result.attestationRelayCommand,
      applicationReceiptTagRef: result.applicationReceiptTagRef,
    };
  }

  function recoverLocalApplication(
    repositoryRoot: string,
    record: AuthorityPlanRecord,
  ): AuthorityPlanLocalApplication {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const {
      discoverRepository,
      runGit,
      parseManagedTrailers,
      canonicalJson,
      planError,
      ExitCode,
      parseMaintainerPolicy,
      authorityTagPublishCommand,
    } = boundServices;

    const current = discoverRepository(repositoryRoot);
    const parent = runGit(
      repositoryRoot,
      ['rev-parse', `${current.head}^`],
      true,
    ).trim();
    const changed = runGit(repositoryRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      current.head,
    ])
      .split('\n')
      .filter(Boolean)
      .sort();
    const expected = record.intent.mutations.map((mutation) => mutation.path);
    const message = runGit(repositoryRoot, [
      'show',
      '-s',
      '--format=%B',
      current.head,
    ]).trimEnd();
    let trailers;
    try {
      trailers = parseManagedTrailers(message);
    } catch {
      trailers = undefined;
    }
    if (
      current.branch !== record.branch ||
      parent !== record.baseCommit ||
      canonicalJson(changed) !== canonicalJson(expected) ||
      trailers?.kind !== 'authority' ||
      trailers.changeId !== record.intent.changeId
    ) {
      throw planError(
        'AUTHORITY_PLAN_RECOVERY_INVALID',
        'Current HEAD is not the exact authority commit planned by this round.',
        ExitCode.guard,
      );
    }
    for (const mutation of record.intent.mutations) {
      assertResultBytes(repositoryRoot, mutation);
    }
    const grantId = trailers.grantId;
    const tagCandidates = runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/tags',
    ])
      .split('\n')
      .filter((ref) => ref.endsWith(grantId))
      .filter(
        (ref) => !ref.includes('application') && !ref.includes('attestation'),
      )
      .sort();
    const tagRef =
      tagCandidates[0] ?? `refs/tags/workflow-authority/${grantId}`;
    const basePolicy = parseMaintainerPolicy(
      JSON.parse(
        readFileAtRevision(
          repositoryRoot,
          record.baseCommit,
          'workflow/maintainer-policy.json',
        ),
      ),
    );
    return {
      grantId,
      sessionId: null,
      commitHash: current.head,
      resultTree: current.tree,
      tagRef,
      publishCommand: authorityTagPublishCommand(
        basePolicy.repository.origin,
        tagRef,
      ),
      attestationRelayCommand: `pnpm workflow maintainer attestation-relay --original ${current.head} --json`,
      applicationReceiptTagRef: `refs/tags/workflow-authority-application/${grantId}`,
    };
  }

  function assertResultBytes(
    repositoryRoot: string,
    mutation: AuthorityPlanMutation,
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { path, fs, planUnsafe } = boundServices;

    const target = path.join(repositoryRoot, mutation.path);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (mutation.content === null) {
      if (stats !== undefined)
        throw planUnsafe('Deleted authority-plan path reappeared.');
      return;
    }
    if (
      !stats?.isFile() ||
      fs.readFileSync(target, 'utf8') !== mutation.content
    ) {
      throw planUnsafe(`Authority-plan result differs at ${mutation.path}.`);
    }
  }

  function listWorkingTreePaths(repositoryRoot: string): string[] {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { runGit } = boundServices;

    const tracked = runGit(repositoryRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      'HEAD',
      '--',
    ])
      .split('\n')
      .filter(Boolean);
    const untracked = runGit(repositoryRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
      .split('\n')
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  function assertRelay(
    record: AuthorityPlanRecord,
    relay: AuthorityAttestationRelayProjection,
  ): void {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { COMMIT_OID, planUnsafe } = boundServices;

    if (
      relay.grantId !== record.localApplication?.grantId ||
      relay.originalCommit !== record.localApplication.commitHash ||
      relay.originalCommit === relay.mainCommit ||
      !COMMIT_OID.test(relay.originalCommit) ||
      !COMMIT_OID.test(relay.mainCommit)
    ) {
      throw planUnsafe(
        'Attestation relay does not match the local authority result.',
      );
    }
  }

  function observeRemoteRef(
    repositoryRoot: string,
    ref: string,
  ): string | null {
    const boundServices: AuthorityPlanWorktreeBindings = bindings();
    const { runGit, planUnsafe, COMMIT_OID } = boundServices;

    const line = runGit(
      repositoryRoot,
      ['ls-remote', '--refs', 'origin', ref],
      true,
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (line.length === 0) return null;
    if (line.length !== 1)
      throw planUnsafe('Remote authority ref is ambiguous.');
    const [oid, observedRef] = line[0]!.split('\t');
    if (!oid || !COMMIT_OID.test(oid) || observedRef !== ref) {
      throw planUnsafe('Remote authority ref is malformed.');
    }
    return oid;
  }
  return {
    parseIntent,
    previewMutation,
    assertPreparedWorktree,
    assertApplyingWorktree,
    applyMutations,
    restoreMutations,
    normalizeApplication,
    recoverLocalApplication,
    assertRelay,
    observeRemoteRef,
  };
}
