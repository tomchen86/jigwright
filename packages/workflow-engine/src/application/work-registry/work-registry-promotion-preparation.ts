/** Coordinates promotion preparation from required validated repository facts. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import path from 'node:path';
import type {
  WorkItemPromotionPreparationBindingV1,
  WorkItemPromotionSurveyBindingV1,
  WorkItemPromotionSurveyV1,
  WorkItemV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import {
  boundedText,
  changeIdentity,
  registryInvalid,
  workRegistryTextDigest,
} from '../../modules/governance-intake/work-registry-record.ts';

import type { WorkItemPromotionSurveyDeclarationV1 } from '../../modules/governance-intake/work-registry-contracts.ts';
import {
  isSurveySymbol,
  parsePromotionSurvey,
  promotionGrantStale,
  promotionNotRequiredBinding,
  promotionPreparationMatches,
  promotionSourceRefsDigest,
  promotionSurveyRequired,
} from '../../modules/governance-intake/work-registry-promotion-policy.ts';
import type { createWorkRegistryQueries } from './work-registry-queries.ts';
import type { WorkRegistryWriteRepository } from './work-registry-repository.ts';
export function createWorkRegistryPromotionPreparation(
  repository: WorkRegistryWriteRepository,
  queries: ReturnType<typeof createWorkRegistryQueries>,
  readSourceValue: (root: string, id: `SRC-${string}`) => GovernanceSourceV1,
  assertPromotionEligible: (root: string, item: WorkItemV1) => void,
) {
  const withWorkRegistryPromotionLockWhenAvailable = repository.withRegistry;
  const { showWorkItem, showWorkItemUnlocked } = queries;
  const assertChangeDirectory = repository.changeDirectory;
  const readOptionalPlainFile = repository.readRecordText;
  const listSymbolConsumers = repository.symbolConsumers;
  const promotionChangeDirectory = repository.promotionChangeDirectory;
  const ensureWorkItemPromotionChangeDirectoryUnlocked =
    repository.ensureChangeDirectory;
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
    const surveyedCommit = repository.currentCommit(repositoryRoot);
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
    repository.writeSurvey(surveyPath, survey);
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
          repository.writeSurvey(surveyPath, expected.surveyPreparation.survey);
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
    const changeTarget = repository.observeChangeTarget(changeDirectory);
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
    if (changeTarget.kind === 'existing-change') {
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

  function projectEmptyPromotionSurvey(
    repositoryRoot: string,
    item: WorkItemV1,
    changeId: string,
  ): WorkItemPromotionSurveyV1 {
    const surveyedCommit = repository.currentCommit(repositoryRoot);
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
    const currentHead = repository.currentCommit(repositoryRoot);
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
