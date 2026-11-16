/** Canonical survey values and permitted exact preparation transitions. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  WorkItemPromotionPreparationBindingV1,
  WorkItemPromotionSurveyBindingV1,
  WorkItemPromotionSurveyV1,
  WorkItemV1,
} from './work-registry-contracts.ts';
import {
  WORK_ITEM_FILE_MODE,
  boundedText,
  changeIdentity,
  hasExactKeys,
  isRecord,
  registryInvalid,
  workRegistryTextDigest,
} from './work-registry-record.ts';

export function promotionPreparationMatches(
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
    expected.changeTarget.directoryMode === actual.changeTarget.directoryMode &&
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
  if (expected.surveyPreparation.kind !== 'create-current-survey') return false;
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

export function promotionSourceRefsDigest(
  item: WorkItemV1,
): `sha256:${string}` {
  return workRegistryTextDigest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'work-registry-promotion-source-refs.v1',
      sourceRefs: item.sourceRefs,
    }),
  );
}

export function promotionNotRequiredBinding(
  item: WorkItemV1,
): Extract<WorkItemPromotionSurveyBindingV1, { kind: 'not-required' }> {
  return {
    schemaVersion: 1,
    kind: 'not-required',
    reason: 'pure-maintainer-sources',
    sourceRefsDigest: promotionSourceRefsDigest(item),
  };
}

export function isSurveySymbol(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 200 &&
    !/[\0\r\n]/u.test(value)
  );
}

export function parsePromotionSurvey(
  source: string,
): WorkItemPromotionSurveyV1 {
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

export function promotionSurveyRequired(message: string) {
  return workflowError(
    'WORK_REGISTRY_SURVEY_REQUIRED',
    message,
    ExitCode.conflict,
  );
}

export function promotionGrantStale(message: string) {
  return workflowError('WORK_REGISTRY_GRANT_STALE', message, ExitCode.conflict);
}
