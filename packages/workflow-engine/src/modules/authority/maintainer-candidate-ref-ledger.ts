/** Canonical ref-generation state and prestate rules. */
import {
  OBJECT_ID,
  candidateError,
  exactTimestamp,
  validRef,
} from './maintainer-candidate-contracts.ts';
export type RefGenerationTransition = {
  fromOid: string;
  toOid: string;
  fromGeneration: number;
  toGeneration: number;
  reason:
    'apply' | 'rollback' | 'external-sync' | 'promotion' | 'uncertain-cas';
  at: string;
};
export type RefGenerationLedger = {
  schemaVersion: 1;
  ref: string;
  currentOid: string;
  generation: number;
  transitions: RefGenerationTransition[];
};
export function createRefGenerationLedger(
  ref: string,
  currentOid: string,
): RefGenerationLedger {
  if (!validRef(ref) || !OBJECT_ID.test(currentOid)) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger identity is invalid.',
    );
  }
  return {
    schemaVersion: 1,
    ref,
    currentOid,
    generation: 0,
    transitions: [],
  };
}

export function acceptApplyPrestate(
  ledger: RefGenerationLedger,
  expectedOid: string,
  expectedGeneration: number,
): void {
  assertRefLedger(ledger);
  if (ledger.generation !== expectedGeneration) {
    throw candidateError(
      'APPLY_REF_GENERATION_MISMATCH',
      'The managed ref moved since approval, including an ABA transition.',
    );
  }
  if (ledger.currentOid !== expectedOid) {
    throw candidateError(
      'APPLY_REF_OID_MISMATCH',
      'The managed ref object ID differs from the approved prestate.',
    );
  }
}

export function recordRefGenerationTransition(
  ledger: RefGenerationLedger,
  input: {
    expectedOid: string;
    expectedGeneration: number;
    nextOid: string;
    reason: RefGenerationTransition['reason'];
    at: string;
  },
): RefGenerationLedger {
  assertRefLedger(ledger);
  acceptApplyPrestate(ledger, input.expectedOid, input.expectedGeneration);
  const at = exactTimestamp(input.at, 'ref transition time');
  if (
    !OBJECT_ID.test(input.nextOid) ||
    (input.nextOid === ledger.currentOid && input.reason !== 'uncertain-cas') ||
    ![
      'apply',
      'rollback',
      'external-sync',
      'promotion',
      'uncertain-cas',
    ].includes(input.reason)
  ) {
    throw candidateError(
      'APPLY_REF_TRANSITION_INVALID',
      'Ref generation transition is malformed or a no-op.',
    );
  }
  const transition: RefGenerationTransition = {
    fromOid: ledger.currentOid,
    toOid: input.nextOid,
    fromGeneration: ledger.generation,
    toGeneration: ledger.generation + 1,
    reason: input.reason,
    at,
  };
  return {
    ...ledger,
    currentOid: input.nextOid,
    generation: ledger.generation + 1,
    transitions: [...ledger.transitions, transition],
  };
}

export function assertRefLedger(ledger: RefGenerationLedger): void {
  if (
    ledger.schemaVersion !== 1 ||
    !validRef(ledger.ref) ||
    !OBJECT_ID.test(ledger.currentOid) ||
    !Number.isSafeInteger(ledger.generation) ||
    ledger.generation < 0 ||
    !Array.isArray(ledger.transitions) ||
    ledger.transitions.length !== ledger.generation
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger is malformed.',
    );
  }
  for (let index = 0; index < ledger.transitions.length; index += 1) {
    const transition = ledger.transitions[index]!;
    const previous = index === 0 ? undefined : ledger.transitions[index - 1];
    if (
      !OBJECT_ID.test(transition.fromOid) ||
      !OBJECT_ID.test(transition.toOid) ||
      transition.fromGeneration !== index ||
      transition.toGeneration !== index + 1 ||
      (previous !== undefined && previous.toOid !== transition.fromOid) ||
      ![
        'apply',
        'rollback',
        'external-sync',
        'promotion',
        'uncertain-cas',
      ].includes(transition.reason) ||
      (transition.fromOid === transition.toOid &&
        transition.reason !== 'uncertain-cas') ||
      exactTimestamp(transition.at, 'ref transition time') !== transition.at
    ) {
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'Ref generation ledger transition history is malformed.',
      );
    }
  }
  if (
    ledger.transitions.length > 0 &&
    ledger.transitions.at(-1)!.toOid !== ledger.currentOid
  ) {
    throw candidateError(
      'APPLY_REF_LEDGER_INVALID',
      'Ref generation ledger head differs from its transition history.',
    );
  }
}

export type RefGenerationRecords = {
  ensureDurableRefGenerationLedger: (
    gitCommonDirectory: string,
    ref: string,
    currentOid: string,
  ) => RefGenerationLedger;
  readDurableRefGenerationLedger: {
    (
      gitCommonDirectory: string,
      ref: string,
      required: true,
    ): RefGenerationLedger;
    (
      gitCommonDirectory: string,
      ref: string,
      required?: false,
    ): RefGenerationLedger | null;
  };
  recordDurableRefGenerationTransitionUnderLifecycleLock: (
    gitCommonDirectory: string,
    input: Parameters<typeof recordRefGenerationTransition>[1] & {
      ref: string;
    },
    assertOwned: () => void,
  ) => RefGenerationLedger;
};
