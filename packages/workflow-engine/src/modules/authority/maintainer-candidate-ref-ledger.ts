/**
 * Validates and publishes the durable ref-generation ledger used to detect
 * stale candidate prestates.
 *
 * Invariants:
 * - `acceptApplyPrestate` rejects the ledger unless both its generation and
 *   current OID equal the approved prestate, catching an ABA return to the
 *   same OID at a different generation.
 * - A ledger's transition count must equal its generation, and the
 *   transitions must chain generations and OIDs through to the head OID.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  OBJECT_ID,
  candidateError,
  digest,
  exactTimestamp,
  validRef,
} from './maintainer-candidate-contracts.ts';
import type {
  CreateCandidateRefLedgerBindings,
  RefGenerationLedger,
  RefGenerationTransition,
} from './maintainer-candidate.ts';

export function createCandidateRefLedger({
  runtimePaths,
  withRepositoryLifecycleOperation,
}: CreateCandidateRefLedgerBindings) {
  function createRefGenerationLedger(
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

  function acceptApplyPrestate(
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

  function recordRefGenerationTransition(
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
      (input.nextOid === ledger.currentOid &&
        input.reason !== 'uncertain-cas') ||
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

  function ensureDurableRefGenerationLedger(
    gitCommonDirectory: string,
    ref: string,
    currentOid: string,
  ): RefGenerationLedger {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      const existing = readDurableRefGenerationLedger(
        gitCommonDirectory,
        ref,
        false,
      );
      if (existing) {
        if (existing.currentOid !== currentOid) {
          throw candidateError(
            'APPLY_REF_LEDGER_DIVERGED',
            'The protected ref ledger differs from the observed ref.',
          );
        }
        return existing;
      }
      const created = createRefGenerationLedger(ref, currentOid);
      writeDurableRefGenerationLedger(gitCommonDirectory, created, true);
      return created;
    });
  }

  function readDurableRefGenerationLedger(
    gitCommonDirectory: string,
    ref: string,
    required: true,
  ): RefGenerationLedger;

  function readDurableRefGenerationLedger(
    gitCommonDirectory: string,
    ref: string,
    required?: false,
  ): RefGenerationLedger | null;

  function readDurableRefGenerationLedger(
    gitCommonDirectory: string,
    ref: string,
    required = true,
  ): RefGenerationLedger | null {
    if (!path.isAbsolute(gitCommonDirectory) || !validRef(ref)) {
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'Durable ref ledger location or ref is invalid.',
      );
    }
    const target = durableRefLedgerPath(gitCommonDirectory, ref);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats) {
      if (!required) return null;
      throw candidateError(
        'APPLY_REF_LEDGER_MISSING',
        'The protected ref generation ledger is missing.',
      );
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'The protected ref generation ledger file is unsafe.',
      );
    }
    try {
      const raw = fs.readFileSync(target, 'utf8');
      const value = JSON.parse(raw) as RefGenerationLedger;
      if (
        raw !== `${canonicalJson(value)}\n` ||
        value.ref !== ref ||
        value.transitions.some(
          (transition, index) =>
            transition.fromGeneration !== index ||
            transition.toGeneration !== index + 1 ||
            (index === 0
              ? transition.fromOid !== value.transitions[0]!.fromOid
              : transition.fromOid !== value.transitions[index - 1]!.toOid) ||
            transition.at !==
              exactTimestamp(transition.at, 'ref transition time'),
        ) ||
        (value.transitions.length > 0 &&
          value.transitions.at(-1)!.toOid !== value.currentOid)
      ) {
        throw new Error('invalid ref ledger');
      }
      assertRefLedger(value);
      return value;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'APPLY_REF_LEDGER_INVALID'
      ) {
        throw error;
      }
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'The protected ref generation ledger is malformed.',
      );
    }
  }

  function recordDurableRefGenerationTransitionUnderLifecycleLock(
    gitCommonDirectory: string,
    input: {
      ref: string;
      expectedOid: string;
      expectedGeneration: number;
      nextOid: string;
      reason: RefGenerationTransition['reason'];
      at: string;
    },
    assertOwned: () => void,
  ): RefGenerationLedger {
    assertOwned();
    const current = readDurableRefGenerationLedger(
      gitCommonDirectory,
      input.ref,
      true,
    );
    const next = recordRefGenerationTransition(current, input);
    assertOwned();
    writeDurableRefGenerationLedger(gitCommonDirectory, next, false);
    assertOwned();
    return next;
  }

  function durableRefLedgerPath(
    gitCommonDirectory: string,
    ref: string,
  ): string {
    return path.join(
      runtimePaths(gitCommonDirectory, 'workflow-engine').root,
      'ref-generation-ledger',
      `${digest(ref)}.json`,
    );
  }

  function writeDurableRefGenerationLedger(
    gitCommonDirectory: string,
    ledger: RefGenerationLedger,
    create: boolean,
  ): void {
    assertRefLedger(ledger);
    const target = durableRefLedgerPath(gitCommonDirectory, ledger.ref);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const directoryStats = fs.lstatSync(directory);
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw candidateError(
        'APPLY_REF_LEDGER_INVALID',
        'The protected ref generation ledger directory is unsafe.',
      );
    }
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${canonicalJson(ledger)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (create) {
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
      } else {
        fs.renameSync(temporary, target);
      }
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
      fs.closeSync(directoryDescriptor);
    } catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw candidateError(
          'APPLY_REF_LEDGER_EXISTS',
          'The protected ref generation ledger was initialized concurrently.',
        );
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  function assertRefLedger(ledger: RefGenerationLedger): void {
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

  return {
    acceptApplyPrestate,
    createRefGenerationLedger,
    ensureDurableRefGenerationLedger,
    readDurableRefGenerationLedger,
    recordDurableRefGenerationTransitionUnderLifecycleLock,
    recordRefGenerationTransition,
  } as const;
}
