/** Promotion survey and exact preparation bindings, before the durable promotion transaction. Git and canonical record access are bound by the registry facade. */
import {
  registryInvalid,
  changeIdentity,
  boundedText,
  workRegistryTextDigest,
  WORK_ITEM_FILE_MODE,
  isRecord,
  hasExactKeys,
} from './work-registry-record.ts';
import path from 'node:path';
import { canonicalJson } from '@jigwright/core/canonical-json';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  repositoryConsumerPath,
  repositoryWorkRegistryConfiguration,
} from '../repository-consumer/repository-consumer-config.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type {
  WorkRegistryPromotionPreparationBindings,
  WorkItemPromotionSurveyDeclarationV1,
  WorkItemPromotionSurveyV1,
  WorkItemPromotionSurveyBindingV1,
  WorkItemPromotionPreparationBindingV1,
  WorkItemPromotionChangeEntryV1,
  WorkItemV1,
} from './work-registry.ts';

export function createWorkRegistryPromotionPreparation(
  bindings: WorkRegistryPromotionPreparationBindings,
) {
  const {
    withWorkRegistryPromotionLockWhenAvailable,
    showWorkItem,
    assertPromotionEligible,
    assertChangeDirectory,
    runGit,
    replaceCanonicalFile,
    readOptionalPlainFile,
    showWorkItemUnlocked,
    readSourceValue,
  } = bindings;

  function prepareWorkItemPromotionSurvey(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
    declaration: WorkItemPromotionSurveyDeclarationV1,
  ): { survey: WorkItemPromotionSurveyV1; relativePath: string } {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      prepareWorkItemPromotionSurveyUnlocked(
        repositoryRoot,
        requestedId,
        requestedChangeId,
        declaration,
      ),
    );
  }

  function prepareWorkItemPromotionSurveyUnlocked(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
    declaration: WorkItemPromotionSurveyDeclarationV1,
  ): { survey: WorkItemPromotionSurveyV1; relativePath: string } {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
      throw registryInvalid(
        'Promotion survey is only valid for an agent-authored premise.',
      );
    }
    const changeId = changeIdentity(requestedChangeId);
    const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
    if (
      declaration.schemaVersion !== 1 ||
      !Array.isArray(declaration.symbols) ||
      declaration.symbols.some((symbol) => !isSurveySymbol(symbol)) ||
      new Set(declaration.symbols).size !== declaration.symbols.length ||
      (declaration.emptyReason !== null &&
        boundedText(declaration.emptyReason, 500, 'survey reason') !==
          declaration.emptyReason) ||
      (declaration.symbols.length === 0 && declaration.emptyReason === null) ||
      (declaration.symbols.length > 0 && declaration.emptyReason !== null)
    ) {
      throw registryInvalid('Promotion survey declaration is invalid.');
    }
    const surveyedCommit = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40,64}$/.test(surveyedCommit)) {
      throw registryInvalid('Promotion survey commit is invalid.');
    }
    const symbols = [...declaration.symbols].sort().map((symbol) => ({
      symbol,
      consumerPaths: listSymbolConsumers(
        repositoryRoot,
        surveyedCommit,
        symbol,
      ),
    }));
    const survey: WorkItemPromotionSurveyV1 = {
      schemaVersion: 1,
      workItemId: item.id,
      changeId,
      surveyedCommit,
      symbols,
      emptyReason: declaration.emptyReason,
    };
    const surveyPath = path.join(changeDirectory, 'survey.json');
    replaceCanonicalFile(surveyPath, survey);
    return {
      survey,
      relativePath: path
        .relative(repositoryRoot, surveyPath)
        .replaceAll(path.sep, '/'),
    };
  }

  function ensureWorkItemPromotionSurveyBinding(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      ensureWorkItemPromotionSurveyBindingUnlocked(
        repositoryRoot,
        requestedId,
        requestedChangeId,
      ),
    );
  }

  function ensureWorkItemPromotionChangeDirectory(
    repositoryRoot: string,
    requestedChangeId: string,
  ): string {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      ensureWorkItemPromotionChangeDirectoryUnlocked(
        repositoryRoot,
        changeIdentity(requestedChangeId),
      ),
    );
  }

  function observeWorkItemPromotionPreparationBinding(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionPreparationBindingV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      observeWorkItemPromotionPreparationBindingUnlocked(
        repositoryRoot,
        requestedId,
        requestedChangeId,
      ),
    );
  }

  function prepareWorkItemPromotionFromBinding(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
    expected: WorkItemPromotionPreparationBindingV1,
  ): WorkItemPromotionSurveyBindingV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
      const actual = observeWorkItemPromotionPreparationBindingUnlocked(
        repositoryRoot,
        requestedId,
        requestedChangeId,
      );
      if (!promotionPreparationMatches(expected, actual)) {
        throw promotionGrantStale(
          'Work Registry promotion preparation changed after authorization.',
        );
      }
      const changeId = changeIdentity(requestedChangeId);
      const changeDirectory = ensureWorkItemPromotionChangeDirectoryUnlocked(
        repositoryRoot,
        changeId,
      );
      if (expected.surveyPreparation.kind === 'create-current-survey') {
        const surveyPath = path.join(changeDirectory, 'survey.json');
        const existing = readOptionalPlainFile(surveyPath);
        const expectedBytes = `${canonicalJson(expected.surveyPreparation.survey)}\n`;
        if (existing === null) {
          replaceCanonicalFile(surveyPath, expected.surveyPreparation.survey);
        } else if (existing !== expectedBytes) {
          throw promotionGrantStale(
            'Work Registry promotion survey changed after authorization.',
          );
        }
      }
      const item = showWorkItemUnlocked(repositoryRoot, requestedId);
      return observePromotionSurveyBinding(
        repositoryRoot,
        changeDirectory,
        item,
        changeId,
      );
    });
  }

  function workItemPromotionPreparationMatches(
    expected: WorkItemPromotionPreparationBindingV1,
    actual: WorkItemPromotionPreparationBindingV1,
  ): boolean {
    return promotionPreparationMatches(expected, actual);
  }

  function observeWorkItemPromotionPreparationBindingUnlocked(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionPreparationBindingV1 {
    const item = showWorkItemUnlocked(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    const sourceRefsDigest = promotionSourceRefsDigest(item);
    const changeDirectory = promotionChangeDirectory(repositoryRoot, changeId);
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (
      stats !== undefined &&
      (!stats.isDirectory() || stats.isSymbolicLink())
    ) {
      throw registryInvalid('Promotion change directory is unsafe.');
    }
    const existingEntries =
      stats === undefined
        ? null
        : snapshotPromotionChangeEntries(changeDirectory);
    const stableStats = fs.lstatSync(changeDirectory, {
      throwIfNoEntry: false,
    });
    if (
      (stats === undefined) !== (stableStats === undefined) ||
      (stats !== undefined &&
        stableStats !== undefined &&
        (!stableStats.isDirectory() ||
          stableStats.isSymbolicLink() ||
          stats.dev !== stableStats.dev ||
          stats.ino !== stableStats.ino ||
          stats.mode !== stableStats.mode ||
          stats.mtimeMs !== stableStats.mtimeMs))
    ) {
      throw registryInvalid(
        'Promotion change directory changed during inspection.',
      );
    }
    const originEntry = existingEntries?.find(
      (entry) => entry.path === 'origin.json',
    );
    if (originEntry?.kind === 'directory') {
      throw registryInvalid('Promotion change origin is unsafe.');
    }
    const changeTarget =
      stats === undefined
        ? ({ kind: 'absent-change' } as const)
        : ({
            kind: 'existing-change' as const,
            directoryMode: stableStats!.mode & 0o777,
            entries: existingEntries!,
            originDigest: originEntry?.digest ?? null,
          } as const);
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
      return {
        schemaVersion: 1,
        changeTarget,
        sourceRefsDigest,
        surveyPreparation: {
          kind: 'not-required',
          binding: promotionNotRequiredBinding(item),
        },
      };
    }
    if (stats !== undefined) {
      const source = readOptionalPlainFile(
        path.join(changeDirectory, 'survey.json'),
      );
      if (source !== null) {
        return {
          schemaVersion: 1,
          changeTarget,
          sourceRefsDigest,
          surveyPreparation: {
            kind: 'current-survey',
            binding: {
              schemaVersion: 1,
              kind: 'current-survey',
              digest: assertPromotionSurveyCurrent(
                repositoryRoot,
                changeDirectory,
                item,
                changeId,
              ),
            },
          },
        };
      }
    }
    const survey = projectEmptyPromotionSurvey(repositoryRoot, item, changeId);
    return {
      schemaVersion: 1,
      changeTarget,
      sourceRefsDigest,
      surveyPreparation: {
        kind: 'create-current-survey',
        binding: {
          schemaVersion: 1,
          kind: 'current-survey',
          digest: workRegistryTextDigest(`${canonicalJson(survey)}\n`),
        },
        survey,
      },
    };
  }

  function promotionPreparationMatches(
    expected: WorkItemPromotionPreparationBindingV1,
    actual: WorkItemPromotionPreparationBindingV1,
  ): boolean {
    if (
      expected.schemaVersion !== actual.schemaVersion ||
      expected.sourceRefsDigest !== actual.sourceRefsDigest
    ) {
      return false;
    }
    const exact = canonicalJson(expected) === canonicalJson(actual);
    if (exact) return true;
    if (
      expected.changeTarget.kind === 'existing-change' &&
      actual.changeTarget.kind === 'existing-change' &&
      expected.surveyPreparation.kind === 'create-current-survey' &&
      (actual.surveyPreparation.kind === 'create-current-survey' ||
        actual.surveyPreparation.kind === 'current-survey') &&
      expected.changeTarget.directoryMode ===
        actual.changeTarget.directoryMode &&
      expected.changeTarget.originDigest === actual.changeTarget.originDigest &&
      canonicalJson(expected.surveyPreparation.binding) ===
        canonicalJson(actual.surveyPreparation.binding)
    ) {
      const preparedEntries = [
        ...expected.changeTarget.entries,
        {
          path: 'survey.json',
          kind: 'file' as const,
          mode: WORK_ITEM_FILE_MODE,
          digest: expected.surveyPreparation.binding.digest,
        },
      ].sort((left, right) => left.path.localeCompare(right.path));
      if (
        canonicalJson(actual.changeTarget.entries) ===
        canonicalJson(preparedEntries)
      ) {
        return true;
      }
    }
    if (
      expected.changeTarget.kind !== 'absent-change' ||
      actual.changeTarget.kind !== 'existing-change' ||
      actual.changeTarget.directoryMode !== 0o755 ||
      actual.changeTarget.originDigest !== null
    ) {
      return false;
    }
    if (expected.surveyPreparation.kind === 'not-required') {
      return (
        actual.changeTarget.entries.length === 0 &&
        actual.surveyPreparation.kind === 'not-required' &&
        canonicalJson(expected.surveyPreparation.binding) ===
          canonicalJson(actual.surveyPreparation.binding)
      );
    }
    if (expected.surveyPreparation.kind !== 'create-current-survey')
      return false;
    const expectedSurveyEntry = {
      path: 'survey.json',
      kind: 'file' as const,
      mode: WORK_ITEM_FILE_MODE,
      digest: expected.surveyPreparation.binding.digest,
    };
    if (
      canonicalJson(actual.changeTarget.entries) !== canonicalJson([]) &&
      canonicalJson(actual.changeTarget.entries) !==
        canonicalJson([expectedSurveyEntry])
    ) {
      return false;
    }
    return (
      (actual.surveyPreparation.kind === 'create-current-survey' ||
        actual.surveyPreparation.kind === 'current-survey') &&
      canonicalJson(expected.surveyPreparation.binding) ===
        canonicalJson(actual.surveyPreparation.binding)
    );
  }

  function snapshotPromotionChangeEntries(
    changeDirectory: string,
  ): readonly WorkItemPromotionChangeEntryV1[] {
    const entries: WorkItemPromotionChangeEntryV1[] = [];
    const visit = (directory: string, prefix: string): void => {
      const beforeDirectory = fs.lstatSync(directory);
      if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
        throw registryInvalid('Promotion change entry is unsafe.');
      }
      const names = fs.readdirSync(directory).sort();
      for (const name of names) {
        const entryPath = path.join(directory, name);
        const relativePath = prefix ? `${prefix}/${name}` : name;
        const stats = fs.lstatSync(entryPath);
        if (stats.isSymbolicLink()) {
          throw registryInvalid('Promotion change entry is unsafe.');
        }
        if (stats.isDirectory()) {
          entries.push({
            path: relativePath,
            kind: 'directory',
            mode: stats.mode & 0o777,
          });
          visit(entryPath, relativePath);
        } else if (stats.isFile()) {
          if (stats.nlink !== 1) {
            throw registryInvalid('Promotion change entry is unsafe.');
          }
          entries.push({
            path: relativePath,
            kind: 'file',
            mode: stats.mode & 0o777,
            digest: stablePromotionFileDigest(entryPath, stats),
          });
        } else {
          throw registryInvalid('Promotion change entry is unsafe.');
        }
      }
      const afterDirectory = fs.lstatSync(directory);
      if (
        !afterDirectory.isDirectory() ||
        afterDirectory.isSymbolicLink() ||
        beforeDirectory.dev !== afterDirectory.dev ||
        beforeDirectory.ino !== afterDirectory.ino ||
        beforeDirectory.mode !== afterDirectory.mode ||
        beforeDirectory.mtimeMs !== afterDirectory.mtimeMs ||
        canonicalJson(fs.readdirSync(directory).sort()) !== canonicalJson(names)
      ) {
        throw registryInvalid(
          'Promotion change directory changed during inspection.',
        );
      }
    };
    visit(changeDirectory, '');
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  function stablePromotionFileDigest(
    filePath: string,
    before: fs.Stats,
  ): `sha256:${string}` {
    const bytes = fs.readFileSync(filePath);
    const after = fs.lstatSync(filePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw registryInvalid(
        'Promotion change entry changed during inspection.',
      );
    }
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  }

  function projectEmptyPromotionSurvey(
    repositoryRoot: string,
    item: WorkItemV1,
    changeId: string,
  ): WorkItemPromotionSurveyV1 {
    const surveyedCommit = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40,64}$/.test(surveyedCommit)) {
      throw registryInvalid('Promotion survey commit is invalid.');
    }
    return {
      schemaVersion: 1,
      workItemId: item.id,
      changeId,
      surveyedCommit,
      symbols: [],
      emptyReason:
        'The agent-authored premise declares no structured repository symbols.',
    };
  }

  function promotionChangeDirectory(
    repositoryRoot: string,
    changeId: string,
  ): string {
    return path.join(
      repositoryConsumerPath(
        repositoryRoot,
        repositoryWorkRegistryConfiguration(repositoryRoot).changeOriginRoot,
      ),
      changeId,
    );
  }

  function ensureWorkItemPromotionChangeDirectoryUnlocked(
    repositoryRoot: string,
    changeId: string,
  ): string {
    const changeDirectory = promotionChangeDirectory(repositoryRoot, changeId);
    const parent = path.dirname(changeDirectory);
    const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
      throw registryInvalid('Promotion change root is unsafe or unavailable.');
    }
    const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
    if (stats === undefined) {
      fs.mkdirSync(changeDirectory, { mode: 0o755 });
      fs.chmodSync(changeDirectory, 0o755);
    } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw registryInvalid('Promotion change directory is unsafe.');
    }
    return changeDirectory;
  }

  function promotionSourceRefsDigest(item: WorkItemV1): `sha256:${string}` {
    return workRegistryTextDigest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'work-registry-promotion-source-refs.v1',
        sourceRefs: item.sourceRefs,
      }),
    );
  }

  function promotionNotRequiredBinding(
    item: WorkItemV1,
  ): Extract<WorkItemPromotionSurveyBindingV1, { kind: 'not-required' }> {
    return {
      schemaVersion: 1,
      kind: 'not-required',
      reason: 'pure-maintainer-sources',
      sourceRefsDigest: promotionSourceRefsDigest(item),
    };
  }

  function ensureWorkItemPromotionSurveyBindingUnlocked(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    const changeDirectory = assertChangeDirectory(repositoryRoot, changeId);
    if (
      workItemRequiresPromotionSurvey(repositoryRoot, item) &&
      readOptionalPlainFile(path.join(changeDirectory, 'survey.json')) === null
    ) {
      prepareWorkItemPromotionSurveyUnlocked(
        repositoryRoot,
        item.id,
        changeId,
        {
          schemaVersion: 1,
          symbols: [],
          emptyReason:
            'The agent-authored premise declares no structured repository symbols.',
        },
      );
    }
    return observePromotionSurveyBinding(
      repositoryRoot,
      changeDirectory,
      item,
      changeId,
    );
  }

  function observeWorkItemPromotionSurveyBinding(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      observeWorkItemPromotionSurveyBindingUnlocked(
        repositoryRoot,
        requestedId,
        requestedChangeId,
      ),
    );
  }

  function observeWorkItemPromotionSurveyBindingUnlocked(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    const item = showWorkItem(repositoryRoot, requestedId);
    assertPromotionEligible(repositoryRoot, item);
    const changeId = changeIdentity(requestedChangeId);
    return observePromotionSurveyBinding(
      repositoryRoot,
      assertChangeDirectory(repositoryRoot, changeId),
      item,
      changeId,
    );
  }

  function readWorkItemPromotionSurveyBinding(
    repositoryRoot: string,
    requestedId: string,
    requestedChangeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () => {
      const item = showWorkItem(repositoryRoot, requestedId);
      const changeId = changeIdentity(requestedChangeId);
      return observePromotionSurveyBinding(
        repositoryRoot,
        assertChangeDirectory(repositoryRoot, changeId),
        item,
        changeId,
      );
    });
  }

  function isSurveySymbol(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value, 'utf8') <= 200 &&
      !/[\0\r\n]/u.test(value)
    );
  }

  function listSymbolConsumers(
    repositoryRoot: string,
    commit: string,
    symbol: string,
  ): string[] {
    const output = runGit(
      repositoryRoot,
      ['grep', '-l', '-z', '-F', '-e', symbol, commit, '--', '.'],
      true,
    );
    const prefix = `${commit}:`;
    return output
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        if (!entry.startsWith(prefix)) {
          throw registryInvalid(
            'Promotion survey returned an invalid consumer path.',
          );
        }
        const relativePath = entry.slice(prefix.length);
        if (
          path.isAbsolute(relativePath) ||
          path.posix.normalize(relativePath) !== relativePath ||
          relativePath.startsWith('../') ||
          relativePath.includes('\\')
        ) {
          throw registryInvalid('Promotion survey consumer path is invalid.');
        }
        return relativePath;
      })
      .sort();
  }

  function assertPromotionSurveyCurrent(
    repositoryRoot: string,
    changeDirectory: string,
    item: WorkItemV1,
    changeId: string,
  ): `sha256:${string}` {
    const surveyPath = path.join(changeDirectory, 'survey.json');
    const source = readOptionalPlainFile(surveyPath);
    if (source === null) {
      throw promotionSurveyRequired(
        'Promotion requires a current premise survey.',
      );
    }
    const survey = parsePromotionSurvey(source);
    if (survey.workItemId !== item.id || survey.changeId !== changeId) {
      throw registryInvalid('Promotion survey is invalid.');
    }
    const currentHead = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    if (survey.surveyedCommit !== currentHead) {
      throw promotionSurveyRequired(
        'Promotion survey is stale for the current repository head.',
      );
    }
    const currentSymbols = survey.symbols.map(({ symbol }) => ({
      symbol,
      consumerPaths: listSymbolConsumers(
        repositoryRoot,
        survey.surveyedCommit,
        symbol,
      ),
    }));
    if (canonicalJson(survey.symbols) !== canonicalJson(currentSymbols)) {
      throw promotionSurveyRequired(
        'Promotion survey consumer facts do not match the surveyed Git commit.',
      );
    }
    return workRegistryTextDigest(source);
  }

  function observePromotionSurveyBinding(
    repositoryRoot: string,
    changeDirectory: string,
    item: WorkItemV1,
    changeId: string,
  ): WorkItemPromotionSurveyBindingV1 {
    if (!workItemRequiresPromotionSurvey(repositoryRoot, item)) {
      return {
        schemaVersion: 1,
        kind: 'not-required',
        reason: 'pure-maintainer-sources',
        sourceRefsDigest: workRegistryTextDigest(
          canonicalJson({
            schemaVersion: 1,
            kind: 'work-registry-promotion-source-refs.v1',
            sourceRefs: item.sourceRefs,
          }),
        ),
      };
    }
    return {
      schemaVersion: 1,
      kind: 'current-survey',
      digest: assertPromotionSurveyCurrent(
        repositoryRoot,
        changeDirectory,
        item,
        changeId,
      ),
    };
  }

  function workItemRequiresPromotionSurvey(
    repositoryRoot: string,
    item: WorkItemV1,
  ): boolean {
    return item.sourceRefs.some(
      (sourceRef) =>
        readSourceValue(repositoryRoot, sourceRef).semanticAuthor === 'agent',
    );
  }

  function parsePromotionSurvey(source: string): WorkItemPromotionSurveyV1 {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw registryInvalid('Promotion survey is invalid.');
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'changeId',
        'emptyReason',
        'schemaVersion',
        'surveyedCommit',
        'symbols',
        'workItemId',
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.workItemId !== 'string' ||
      !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.workItemId) ||
      typeof value.changeId !== 'string' ||
      changeIdentity(value.changeId) !== value.changeId ||
      typeof value.surveyedCommit !== 'string' ||
      !/^[0-9a-f]{40,64}$/.test(value.surveyedCommit) ||
      !Array.isArray(value.symbols) ||
      value.symbols.some(
        (entry) =>
          !isRecord(entry) ||
          !hasExactKeys(entry, ['consumerPaths', 'symbol']) ||
          !isSurveySymbol(entry.symbol) ||
          !Array.isArray(entry.consumerPaths) ||
          entry.consumerPaths.some((consumer) => typeof consumer !== 'string'),
      ) ||
      (value.emptyReason !== null &&
        (typeof value.emptyReason !== 'string' ||
          boundedText(value.emptyReason, 500, 'survey reason') !==
            value.emptyReason)) ||
      (value.symbols.length === 0 && value.emptyReason === null) ||
      (value.symbols.length > 0 && value.emptyReason !== null)
    ) {
      throw registryInvalid('Promotion survey is invalid.');
    }
    const survey = value as unknown as WorkItemPromotionSurveyV1;
    const symbols = survey.symbols.map(({ symbol }) => symbol);
    if (
      new Set(symbols).size !== symbols.length ||
      JSON.stringify(symbols) !== JSON.stringify([...symbols].sort()) ||
      source !== `${canonicalJson(survey)}\n`
    ) {
      throw registryInvalid('Promotion survey is invalid.');
    }
    return survey;
  }

  function promotionSurveyRequired(message: string) {
    return workflowError(
      'WORK_REGISTRY_SURVEY_REQUIRED',
      message,
      ExitCode.conflict,
    );
  }

  function promotionGrantStale(message: string) {
    return workflowError(
      'WORK_REGISTRY_GRANT_STALE',
      message,
      ExitCode.conflict,
    );
  }

  return {
    prepareWorkItemPromotionSurvey,
    ensureWorkItemPromotionSurveyBinding,
    ensureWorkItemPromotionChangeDirectory,
    observeWorkItemPromotionPreparationBinding,
    prepareWorkItemPromotionFromBinding,
    workItemPromotionPreparationMatches,
    observeWorkItemPromotionSurveyBinding,
    readWorkItemPromotionSurveyBinding,
    observePromotionSurveyBinding,
    promotionGrantStale,
  };
}
