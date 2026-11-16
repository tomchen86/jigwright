/** Exact publication contracts, receipt identities and terminal-state decisions. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { type ExternalEffectRepositoryServices } from './external-effect-grant-services.ts';
import {
  type ExternalEffectGitRefTarget,
  type ExternalEffectGrantInspection,
  type ExternalEffectTransitionOptions,
  type Sha256Digest,
} from './external-effect-grant.ts';
import { type MaintainerSignerProvider } from './maintainer-signer-port.ts';
export type PublishRunnerObservation = {
  externalReceiptId: string;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  poststateDigest: Sha256Digest;
  observedAt: string;
};

export type PublishRunnerRequest = {
  repositoryRoot: string;
  grantId: string;
  transactionId: string;
  idempotencyKey: string;
  target: ExternalEffectGitRefTarget;
  artifactDigest: Sha256Digest;
  prestateDigest: Sha256Digest;
  environment: NodeJS.ProcessEnv;
};

export type PublishRunnerOutcome =
  | { state: 'observed'; observation: PublishRunnerObservation }
  | { state: 'not-issued'; reason: string }
  | { state: 'unknown'; reason: string };

export type PublishRunnerQuery =
  | { state: 'observed'; observation: PublishRunnerObservation }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };

export type PublishRunner = {
  dispatch(request: PublishRunnerRequest): PublishRunnerOutcome;
  query?(request: PublishRunnerRequest): PublishRunnerQuery;
};

export type ExecutePublishOptions = {
  now?: Date;
  runner?: PublishRunner;
  signer?: MaintainerSignerProvider;
  onAuditRecord?: ExternalEffectTransitionOptions['onAuditRecord'];
  testAuditServiceHooks?: ExternalEffectTransitionOptions['testAuditServiceHooks'];
  environment?: NodeJS.ProcessEnv;
  testAfterDispatchIssued?: (request: PublishRunnerRequest) => void;
  testAfterRunnerResult?: (
    outcome: PublishRunnerOutcome | PublishRunnerQuery,
  ) => void;
};

export type ExecutePublishResult = {
  state:
    | 'consumed'
    | 'revoked'
    | 'expired'
    | 'failed'
    | 'manual-reconciliation'
    | 'reconciled-succeeded'
    | 'reconciled-rolled-back'
    | 'reconciled-failed';
  grantId: string;
  transactionId: string | null;
  replayed: boolean;
  observation: ExternalEffectGrantInspection['observation'];
};
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function publishArtifactDigest(sourceOid: string): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-artifact.v1',
      sourceOid: assertOid(sourceOid),
    }),
  );
}

export function publishPrestateDigest(
  expectedRemoteOid: string | null,
): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-prestate.v1',
      expectedRemoteOid:
        expectedRemoteOid === null ? null : assertOid(expectedRemoteOid),
    }),
  );
}

export function publishPoststateDigest(sourceOid: string): Sha256Digest {
  return digest(
    canonicalJson({
      kind: 'git-publish-poststate.v1',
      sourceOid: assertOid(sourceOid),
    }),
  );
}

export function assertRunnerObservation(
  inspection: ExternalEffectGrantInspection,
  observation: PublishRunnerObservation,
): void {
  if (
    !observation ||
    typeof observation.externalReceiptId !== 'string' ||
    observation.externalReceiptId.length < 1 ||
    observation.externalReceiptId.length > 512 ||
    observation.artifactDigest !== inspection.payload.artifactDigest ||
    observation.prestateDigest !== inspection.payload.prestateDigest ||
    inspection.payload.target.kind !== 'git-ref' ||
    observation.poststateDigest !==
      publishPoststateDigest(inspection.payload.target.sourceOid) ||
    typeof observation.observedAt !== 'string' ||
    new Date(Date.parse(observation.observedAt)).toISOString() !==
      observation.observedAt
  ) {
    throw workflowError(
      'PUBLISH_RECEIPT_INVALID',
      'Publish observation is not the exact signed artifact poststate.',
      ExitCode.verification,
    );
  }
}

export function assertPublishObservation(
  inspection: ExternalEffectGrantInspection,
): void {
  if (!inspection.observation) throw publishStateInvalid();
  assertRunnerObservation(inspection, inspection.observation);
}

export function terminalResult(
  inspection: ExternalEffectGrantInspection,
  replayed: boolean,
): ExecutePublishResult {
  if (!isTerminal(inspection)) throw publishStateInvalid();
  return {
    state: inspection.state,
    grantId: inspection.grantId,
    transactionId: inspection.transactionId,
    replayed,
    observation: inspection.observation,
  };
}

export function isTerminal(
  inspection: ExternalEffectGrantInspection,
): inspection is ExternalEffectGrantInspection & {
  state: ExecutePublishResult['state'];
} {
  return [
    'consumed',
    'revoked',
    'expired',
    'failed',
    'manual-reconciliation',
    'reconciled-succeeded',
    'reconciled-rolled-back',
    'reconciled-failed',
  ].includes(inspection.state);
}

export function requireTransactionId(
  inspection: ExternalEffectGrantInspection,
): string {
  if (!inspection.transactionId) throw publishStateInvalid();
  return inspection.transactionId;
}

export function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw publishStateInvalid();
  }
  return new Date(value.getTime());
}

export function assertOid(value: string): string {
  if (!COMMIT_OID.test(value)) {
    throw workflowError(
      'PUBLISH_GRANT_INVALID',
      'Publish commit identity is malformed.',
      ExitCode.guard,
    );
  }
  return value;
}

export function boundedReason(value: string): string {
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 1024 || /[\0\r]/.test(normalized)) {
    return 'Publish runner returned an invalid bounded failure reason.';
  }
  return normalized;
}

export function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function publishStateInvalid() {
  return workflowError(
    'PUBLISH_TRANSACTION_INVALID',
    'Publish grant is not in an exact executable or recoverable state.',
    ExitCode.guard,
  );
}
export function assertPublishGrantPayload(
  inspection: ExternalEffectGrantInspection,
): asserts inspection is ExternalEffectGrantInspection & {
  payload: ExternalEffectGrantInspection['payload'] & {
    target: ExternalEffectGitRefTarget;
  };
} {
  const { payload } = inspection;
  if (
    payload.effectKind !== 'publish-git-ref' ||
    payload.target.kind !== 'git-ref' ||
    payload.artifactDigest !==
      publishArtifactDigest(payload.target.sourceOid) ||
    payload.prestateDigest !==
      publishPrestateDigest(payload.target.expectedRemoteOid)
  ) {
    throw workflowError(
      'PUBLISH_GRANT_INVALID',
      'External effect grant does not describe one exact ordinary Git publish.',
      ExitCode.guard,
    );
  }
}

export type PublishRepositoryServices = Pick<
  ExternalEffectRepositoryServices,
  'discoverRepository' | 'resolveSourceOid'
> & { remoteUrl: (repositoryRoot: string, remoteName: string) => string };
export type PublishRunnerFactory = () => PublishRunner;
