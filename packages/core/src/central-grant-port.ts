/**
 * Implementation-neutral Central Grant ports owned by Jigwright core.
 *
 * Domain code submits canonical facts and registered transition candidates
 * through these contracts. Human interaction, proof verification, persistence,
 * and transition execution remain optional composition responsibilities.
 */

export type CentralGrantDigest = `sha256:${string}`;

export type CentralGrantStateBindingV1 = Readonly<{
  kind: string;
  digest: CentralGrantDigest;
}>;

export type CentralGrantTransitionCandidateV1 = Readonly<{
  transitionId: string;
  parameters: unknown;
  allowedReasonCodes: readonly string[];
  reasonRequired: boolean;
  proposedReason: string;
}>;

export type CentralGrantRequestInputV1<TFacts = unknown> = Readonly<{
  sourceModuleId: string;
  failureCode: string;
  facts: TFacts;
  stateBinding: CentralGrantStateBindingV1;
  candidates: readonly CentralGrantTransitionCandidateV1[];
}>;

export type CentralGrantChallengeRefV1 = Readonly<{
  challengeId: string;
  challengeDigest: CentralGrantDigest;
}>;

export type CentralGrantChoiceV1 = Readonly<{
  choiceId: CentralGrantDigest;
  transitionId: string;
  parameters: unknown;
  parameterDigest: CentralGrantDigest;
  parameterSchemaDigest: CentralGrantDigest;
  consequenceDigest: CentralGrantDigest;
  resolutionKind: 'retry' | 'non-retry';
  allowedReasonCodes: readonly string[];
  reasonRequired: boolean;
  proposedReason: string;
}>;

export type CentralGrantChallengeV1<TFacts = unknown> = Readonly<{
  schemaVersion: 1;
  kind: 'grant-challenge.v1';
  challengeId: string;
  sourceModuleId: string;
  failureCode: string;
  facts: TFacts;
  factsDigest: CentralGrantDigest;
  stateBinding: CentralGrantStateBindingV1;
  choices: readonly CentralGrantChoiceV1[];
  issuedAt: string;
  expiresAt: string;
  challengeDigest: CentralGrantDigest;
}>;

/** The only domain-facing operation that may create a new challenge. */
export type CentralGrantRequestPortV1 = Readonly<{
  contractVersion: 'central-grant-request-port.v1';
  requestGrant(
    input: CentralGrantRequestInputV1,
  ): Promise<CentralGrantChallengeRefV1>;
}>;

/**
 * Trusted composition owns this lifecycle surface. Domain modules receive the
 * request port only, so they cannot collect a decision or execute an effect.
 */
export type CentralGrantChallengePortV1<
  TPresentation = unknown,
  TResult = unknown,
> = Readonly<{
  challengeContractVersion: 'central-grant-challenge-port.v1';
  inspectChallenge(challengeId: string): TPresentation;
  resolveChallenge(challengeId: string): Promise<TResult>;
  recoverChallenge(challengeId: string): Promise<TResult>;
}>;

/**
 * Code-owned transition metadata used to bind a challenge to one stable
 * implementation and its observed pre-state.
 */
export type CentralGrantTransitionDefinitionPortV1 = Readonly<{
  transitionId: string;
  parameterSchemaDigest: CentralGrantDigest;
  consequenceDigest: CentralGrantDigest;
  resolutionKind: 'retry' | 'non-retry';
  validateParameters(value: unknown): unknown;
  observeState(
    parameters: unknown,
  ): CentralGrantStateBindingV1 | Promise<CentralGrantStateBindingV1>;
}>;

export type CentralGrantTransitionRegistryPortV1 = Readonly<{
  contractVersion: 'central-grant-transition-registry-port.v1';
  resolve(transitionId: string): CentralGrantTransitionDefinitionPortV1;
}>;

/** Opaque reference consumed by core after an optional Grant composition ran. */
export type CentralGrantCompletedAuthorityRefV1 = Readonly<{
  contractVersion: 'central-grant-completed-authority-ref.v1';
  challengeId: string;
  challengeDigest: CentralGrantDigest;
  transitionId: string;
  operationId: string;
  terminalOutcomeDigest: CentralGrantDigest;
}>;
