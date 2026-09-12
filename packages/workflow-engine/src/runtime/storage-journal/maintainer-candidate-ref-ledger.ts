/** Durable ref-generation reads and atomic lifecycle-locked publication. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  candidateError,
  digest,
  exactTimestamp,
  validRef,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import {
  createRefGenerationLedger,
  acceptApplyPrestate,
  recordRefGenerationTransition,
  assertRefLedger,
  type RefGenerationLedger,
  type RefGenerationTransition,
} from '../../modules/authority/maintainer-candidate-ref-ledger.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../session-workspace/session-store.ts';
export function ensureDurableRefGenerationLedger(
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

export function readDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  required: true,
): RefGenerationLedger;
export function readDurableRefGenerationLedger(
  gitCommonDirectory: string,
  ref: string,
  required?: false,
): RefGenerationLedger | null;
export function readDurableRefGenerationLedger(
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

export function recordDurableRefGenerationTransitionUnderLifecycleLock(
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

function durableRefLedgerPath(gitCommonDirectory: string, ref: string): string {
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
