// authority plan records; repository effects remain bound by the public module.
import type {
  AuthorityPlanRecordsBindings,
  AuthorityPlanRecordsBindingsTypes,
} from './authority-plan.ts';
type AuthorityPlanRecord =
  AuthorityPlanRecordsBindingsTypes['AuthorityPlanRecord'];
declare const discoverRepository: AuthorityPlanRecordsBindingsTypes['discoverRepository'];
declare const investigationRuntimePaths: AuthorityPlanRecordsBindings['investigationRuntimePaths'];

export function createAuthorityPlanRecords(
  bindings: () => AuthorityPlanRecordsBindings,
) {
  function authorityPlanRuntime(
    repository: ReturnType<typeof discoverRepository>,
  ) {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const { loadWorkflowConfig, investigationRuntimePaths } = boundServices;

    const config = loadWorkflowConfig(repository.repositoryRoot);
    return investigationRuntimePaths(
      repository.gitCommonDirectory,
      config.runtimeDirectory,
    );
  }

  function withPlanLock<T>(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    planId: string,
    operation: () => T,
  ): T {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const { withPrivateRuntimeLock, path, planUnsafe } = boundServices;

    return withPrivateRuntimeLock(
      runtime,
      path.join(runtime.root, 'authority-plans', 'locks', `${planId}.lock`),
      operation,
      'AUTHORITY_PLAN_OPERATION_CONFLICT',
      planUnsafe,
    );
  }

  function appendRecord(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    value: Omit<AuthorityPlanRecord, 'recordDigest'>,
  ): AuthorityPlanRecord {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const {
      digest,
      createPrivateCanonicalJson,
      planUnsafe,
      readPrivateCanonicalJson,
    } = boundServices;

    const record: AuthorityPlanRecord = {
      ...structuredClone(value),
      recordDigest: digest({
        schema: 'authority-plan-record.v1',
        record: value,
      }),
    };
    createPrivateCanonicalJson(
      runtime,
      recordPath(runtime, record.planId, record.revision),
      record,
      planUnsafe,
      'AUTHORITY_PLAN_REVISION_CONFLICT',
    );
    return parseRecord(
      readPrivateCanonicalJson(
        runtime,
        recordPath(runtime, record.planId, record.revision),
        planUnsafe,
      ),
    );
  }

  function transition(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    current: AuthorityPlanRecord,
    patch: Partial<
      Pick<
        AuthorityPlanRecord,
        | 'state'
        | 'updatedAt'
        | 'localApplication'
        | 'relay'
        | 'attestation'
        | 'friction'
      >
    >,
  ): AuthorityPlanRecord {
    const { recordDigest: _currentRecordDigest, ...base } = current;
    return appendRecord(runtime, {
      ...base,
      ...structuredClone(patch),
      revision: current.revision + 1,
      previousRecordDigest: current.recordDigest,
    });
  }

  function readLatest(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    planId: string,
    allowMissing: boolean,
  ): AuthorityPlanRecord | null {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const {
      path,
      fs,
      assertPrivateInvestigationDirectory,
      planUnsafe,
      MAX_REVISIONS,
      REVISION_FILE,
      readPrivateCanonicalJson,
      canonicalJson,
    } = boundServices;

    const directory = path.join(
      runtime.root,
      'authority-plans',
      'records',
      planId,
    );
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stats === undefined) return null;
    assertPrivateInvestigationDirectory(runtime, directory, planUnsafe);
    const names = fs.readdirSync(directory).sort();
    if (
      names.length < 1 ||
      names.length > MAX_REVISIONS ||
      names.some((name) => !REVISION_FILE.test(name))
    ) {
      throw planUnsafe('Authority plan revision inventory is malformed.');
    }
    let previous: AuthorityPlanRecord | null = null;
    for (const [index, name] of names.entries()) {
      const match = REVISION_FILE.exec(name)!;
      if (Number(match[1]) !== index + 1) {
        throw planUnsafe('Authority plan revision sequence is incomplete.');
      }
      const record = parseRecord(
        readPrivateCanonicalJson(
          runtime,
          path.join(directory, name),
          planUnsafe,
        ),
      );
      if (
        record.planId !== planId ||
        record.revision !== index + 1 ||
        record.previousRecordDigest !== (previous?.recordDigest ?? null) ||
        (previous !== null &&
          (record.createdAt !== previous.createdAt ||
            record.baseCommit !== previous.baseCommit ||
            record.baseTree !== previous.baseTree ||
            record.branch !== previous.branch ||
            record.intentDigest !== previous.intentDigest ||
            canonicalJson(record.intent) !== canonicalJson(previous.intent) ||
            canonicalJson(record.preview) !== canonicalJson(previous.preview)))
      ) {
        throw planUnsafe('Authority plan revision lineage is inconsistent.');
      }
      previous = record;
    }
    if (previous === null && !allowMissing) throw planUnsafe();
    return previous;
  }

  function requireLatest(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    planId: string,
  ): AuthorityPlanRecord {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const { planError, ExitCode } = boundServices;

    const record = readLatest(runtime, planId, false);
    if (record === null) {
      throw planError(
        'AUTHORITY_PLAN_NOT_FOUND',
        `Authority plan ${planId} does not exist.`,
        ExitCode.usage,
      );
    }
    return record;
  }

  function parseRecord(value: unknown): AuthorityPlanRecord {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      PLAN_ID,
      SHA256,
      isExactTime,
      isManagedAuthorityPlanState,
      COMMIT_OID,
      planUnsafe,
      parseIntent,
      digest,
    } = boundServices;

    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'planId',
        'revision',
        'previousRecordDigest',
        'recordDigest',
        'createdAt',
        'updatedAt',
        'state',
        'branch',
        'baseCommit',
        'baseTree',
        'intentDigest',
        'intent',
        'preview',
        'localApplication',
        'relay',
        'attestation',
        'friction',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'authority-plan-record.v1' ||
      typeof value.planId !== 'string' ||
      !PLAN_ID.test(value.planId) ||
      typeof value.revision !== 'number' ||
      !Number.isInteger(value.revision) ||
      value.revision < 1 ||
      (value.previousRecordDigest !== null &&
        (typeof value.previousRecordDigest !== 'string' ||
          !SHA256.test(value.previousRecordDigest))) ||
      typeof value.recordDigest !== 'string' ||
      !SHA256.test(value.recordDigest) ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string' ||
      !isExactTime(value.createdAt) ||
      !isExactTime(value.updatedAt) ||
      !isManagedAuthorityPlanState(value.state) ||
      typeof value.branch !== 'string' ||
      typeof value.baseCommit !== 'string' ||
      !COMMIT_OID.test(value.baseCommit) ||
      typeof value.baseTree !== 'string' ||
      !COMMIT_OID.test(value.baseTree) ||
      typeof value.intentDigest !== 'string' ||
      !SHA256.test(value.intentDigest) ||
      !Array.isArray(value.preview) ||
      !isRecord(value.friction)
    ) {
      throw planUnsafe('Authority plan record is malformed.');
    }
    const intent = parseIntent(value.intent);
    const candidate = value as unknown as AuthorityPlanRecord;
    const { recordDigest, ...semantic } = candidate;
    if (
      digest(intent) !== value.intentDigest ||
      digest({ schema: 'authority-plan-record.v1', record: semantic }) !==
        recordDigest
    ) {
      throw planUnsafe('Authority plan record digest is invalid.');
    }
    return structuredClone(candidate);
  }

  function recordPath(
    runtime: ReturnType<typeof investigationRuntimePaths>,
    planId: string,
    revision: number,
  ): string {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const { path } = boundServices;

    return path.join(
      runtime.root,
      'authority-plans',
      'records',
      planId,
      `${revision.toString().padStart(6, '0')}.json`,
    );
  }

  function assertPlanId(value: string): string {
    const boundServices: AuthorityPlanRecordsBindings = bindings();
    const { PLAN_ID, planError, ExitCode } = boundServices;

    if (!PLAN_ID.test(value)) {
      throw planError(
        'AUTHORITY_PLAN_ID_INVALID',
        'Authority plan ID is invalid.',
        ExitCode.usage,
      );
    }
    return value;
  }
  return {
    authorityPlanRuntime,
    withPlanLock,
    appendRecord,
    transition,
    readLatest,
    requireLatest,
    assertPlanId,
  };
}
