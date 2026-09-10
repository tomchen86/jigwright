/**
 * Defines and validates the provider output schema for an invocation-bound
 * blind survey.
 *
 * Invariants:
 * - Survey terms must have unique identities after normalization.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  type InvestigationTermKind,
} from '../investigation/domain/investigation-terms.ts';

// Keep this canonical schema self-contained: provider CLIs infer their supported
// dialect, while an external `$schema` URI can be rejected before model launch.
// The request digest, runtime schema, provider argv, and native validator must
// continue to bind these exact bytes.
export const BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'terms'],
  properties: {
    reference: { type: 'string', minLength: 1 },
    terms: {
      type: 'array',
      minItems: 1,
      maxItems: INVESTIGATION_LIMITS.maxSurveyTerms,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: {
            enum: ['literal-content', 'literal-path', 'symbol', 'config-key'],
          },
          value: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});

export const BLIND_SURVEY_OUTPUT_SCHEMA = Object.freeze({
  id: 'workflow.blind-survey-output.v1',
  version: 1,
  digest: sha256(canonicalJson(BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA)),
});

export function validateBlindSurveyOutput(
  value: unknown,
  invocationId: string,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    value.reference !== invocationId ||
    !Array.isArray(value.terms) ||
    value.terms.length < 1 ||
    value.terms.length > INVESTIGATION_LIMITS.maxSurveyTerms
  ) {
    return false;
  }
  const termIds = new Set<string>();
  try {
    for (const term of value.terms) {
      if (
        !isRecord(term) ||
        !hasExactKeys(term, ['kind', 'value']) ||
        typeof term.kind !== 'string' ||
        typeof term.value !== 'string'
      ) {
        return false;
      }
      const normalized = normalizeInvestigationTerm({
        kind: term.kind as InvestigationTermKind,
        value: term.value,
      });
      if (termIds.has(normalized.termId)) return false;
      termIds.add(normalized.termId);
    }
  } catch {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
