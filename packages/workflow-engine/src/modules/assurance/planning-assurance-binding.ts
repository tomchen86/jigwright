import { isRecord } from '../../foundation/canonical-json/contract-values.ts';

export type PlanningAssuranceSummary = {
  applicabilityKind: 'sealed-investigation' | 'investigation-exemption';
  applicabilityDigest: string;
  applicabilityNodeId: string;
  investigationBaseline: { head: string; tree: string };
  planningGenerationId: string;
  planTargetDigest: string;
  reviewNodeId: string;
  reviewResultDigest: string;
  reviewDispositionNodeId: string | null;
  reviewRoleResultDigest: string;
  reviewRoleResultForm:
    | 'ordinary-provider'
    | 'granted-same-provider'
    | 'granted-role-context-sharing'
    | 'granted-caller-supplied'
    | 'direct-human-attestation';
  reviewOrchestration:
    'engine-spawned-provider' | 'caller-supplied' | 'direct-human-review';
  requiredIndependence: 'provider-independent' | 'session-independent';
  achievedIndependence:
    | 'provider-independent'
    | 'principal-independent'
    | 'session-independent'
    | 'none';
  degradationAuthorized: boolean;
  advisoryVerdict: 'advisory-approve' | 'advisory-reject';
};

export type PlanningAssuranceBinding = PlanningAssuranceSummary & {
  reviewGrantId: string | null;
  reviewGrantEnvelopeDigest: string | null;
  reviewGrantUseDigest: string | null;
  reviewGrantTransitionDigest: string | null;
  directHumanReviewAttestationDigest: string | null;
};

export function isPlanningAssuranceBinding(
  value: unknown,
): value is PlanningAssuranceBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'applicabilityKind',
      'applicabilityDigest',
      'applicabilityNodeId',
      'investigationBaseline',
      'planningGenerationId',
      'planTargetDigest',
      'reviewNodeId',
      'reviewResultDigest',
      'reviewDispositionNodeId',
      'reviewRoleResultDigest',
      'reviewRoleResultForm',
      'reviewOrchestration',
      'reviewGrantId',
      'reviewGrantEnvelopeDigest',
      'reviewGrantUseDigest',
      'reviewGrantTransitionDigest',
      'directHumanReviewAttestationDigest',
      'requiredIndependence',
      'achievedIndependence',
      'degradationAuthorized',
      'advisoryVerdict',
    ]) ||
    !['sealed-investigation', 'investigation-exemption'].includes(
      String(value.applicabilityKind),
    ) ||
    !isDigest(value.applicabilityDigest) ||
    !isDigest(value.applicabilityNodeId) ||
    !isRecord(value.investigationBaseline) ||
    !hasExactKeys(value.investigationBaseline, ['head', 'tree']) ||
    !isCommitHash(value.investigationBaseline.head) ||
    !isCommitHash(value.investigationBaseline.tree) ||
    !isDigest(value.planningGenerationId) ||
    !isDigest(value.planTargetDigest) ||
    !isDigest(value.reviewNodeId) ||
    !isDigest(value.reviewResultDigest) ||
    (value.reviewDispositionNodeId !== null &&
      !isDigest(value.reviewDispositionNodeId)) ||
    !isDigest(value.reviewRoleResultDigest) ||
    ![
      'ordinary-provider',
      'granted-same-provider',
      'granted-role-context-sharing',
      'granted-caller-supplied',
      'direct-human-attestation',
    ].includes(String(value.reviewRoleResultForm)) ||
    ![
      'engine-spawned-provider',
      'caller-supplied',
      'direct-human-review',
    ].includes(String(value.reviewOrchestration)) ||
    (value.reviewGrantId !== null && !isUuid(value.reviewGrantId)) ||
    !isNullableDigest(value.reviewGrantEnvelopeDigest) ||
    !isNullableDigest(value.reviewGrantUseDigest) ||
    !isNullableDigest(value.reviewGrantTransitionDigest) ||
    !isNullableDigest(value.directHumanReviewAttestationDigest) ||
    (value.requiredIndependence !== 'provider-independent' &&
      value.requiredIndependence !== 'session-independent') ||
    ![
      'provider-independent',
      'principal-independent',
      'session-independent',
      'none',
    ].includes(String(value.achievedIndependence)) ||
    typeof value.degradationAuthorized !== 'boolean' ||
    !['advisory-approve', 'advisory-reject'].includes(
      String(value.advisoryVerdict),
    )
  ) {
    return false;
  }
  const hasStandardGrant = [
    'granted-same-provider',
    'granted-caller-supplied',
    'direct-human-attestation',
  ].includes(String(value.reviewRoleResultForm));
  const hasDegradationAuthority =
    hasStandardGrant ||
    value.reviewRoleResultForm === 'granted-role-context-sharing';
  const grantRefs = [
    value.reviewGrantId,
    value.reviewGrantEnvelopeDigest,
    value.reviewGrantUseDigest,
    value.reviewGrantTransitionDigest,
  ];
  return (
    grantRefs.every((reference) =>
      hasStandardGrant ? reference !== null : reference === null,
    ) &&
    value.degradationAuthorized === hasDegradationAuthority &&
    (value.degradationAuthorized
      ? value.requiredIndependence === 'provider-independent' &&
        value.achievedIndependence !== 'provider-independent'
      : value.requiredIndependence === 'provider-independent'
        ? value.achievedIndependence === 'provider-independent'
        : value.achievedIndependence === 'provider-independent' ||
          value.achievedIndependence === 'session-independent') &&
    (value.reviewRoleResultForm === 'direct-human-attestation'
      ? value.directHumanReviewAttestationDigest !== null
      : value.directHumanReviewAttestationDigest === null)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isCommitHash(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}
