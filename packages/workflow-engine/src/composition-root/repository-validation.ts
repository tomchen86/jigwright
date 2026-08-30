import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  assertCommittedCheckoutDirectoryProjection,
  loadChangeContract,
  loadCommittedChangeContract,
  loadWorkflowConfig,
  type ChangeContract,
} from '../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { normalizeExactRepositoryPath } from '../foundation/repository-path/repository-path.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGitBuffer,
} from '../runtime/repository-transaction/git.ts';
import {
  validateManagedDocuments,
  type ManagedDocumentValidationContext,
} from '../runtime/managed-documents/validation/managed-documents.ts';
import { changeLifecycleRelativePath } from '../modules/lifecycle/change-routing.ts';

const OBJECT_ID = '[0-9a-f]{40}|[0-9a-f]{64}';
const MAX_COMMITTED_DOCUMENT_BYTES = 16 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const COMMITTED_DOCUMENT_PATHS = new Set([
  'workflow/document-policy.json',
  'docs/CURRENT_AND_NEXT_STEPS.md',
  'docs/work-registry/inventory.json',
  changeLifecycleRelativePath,
]);
const COMMITTED_WORKFLOW_PROJECTION = ['workflow'] as const;

export type RepositoryValidation = {
  repositoryRoot: string;
  changes: string[];
  documents: string[];
};

export function validateRepositoryState(cwd: string): RepositoryValidation {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const changes = listLiveChangeIds(git.repositoryRoot, config.changeRoot);
  for (const changeId of changes) {
    loadChangeContract(git.repositoryRoot, changeId);
  }
  return {
    repositoryRoot: git.repositoryRoot,
    changes,
    documents: validateManagedDocuments(git.repositoryRoot),
  };
}

/** CI-only immutable head validation; live lifecycle callers stay ref-bound. */
export function validateRepositoryStateAtCommit(
  cwd: string,
  commit: string,
): RepositoryValidation {
  const checkout = captureExactCommittedCheckout(cwd, commit);
  try {
    assertCommittedCheckoutDirectoryProjection({
      repositoryRoot: checkout.repositoryRoot,
      commit,
      directoryPaths: COMMITTED_WORKFLOW_PROJECTION,
    });
    const source = createCommittedRepositorySource(
      checkout.repositoryRoot,
      commit,
    );
    const committedConfig = source.readRequiredText('workflow/config.json');
    const changeRoot = parseCommittedChangeRoot(committedConfig);
    const checkoutConfigPath = path.join(
      checkout.repositoryRoot,
      'workflow/config.json',
    );
    if (fs.readFileSync(checkoutConfigPath, 'utf8') !== committedConfig) {
      throw committedCheckoutInvalid();
    }
    const liveConfig = loadWorkflowConfig(checkout.repositoryRoot);
    if (liveConfig.changeRoot !== changeRoot) {
      throw committedCheckoutInvalid();
    }

    const changes = source.listChangeIds(changeRoot);
    const contracts = changes.map((changeId) =>
      loadCommittedChangeContract(checkout.repositoryRoot, commit, changeId),
    );
    const documents = validateManagedDocuments(
      checkout.repositoryRoot,
      committedManagedDocumentContext(source, contracts),
    );
    assertCommittedCheckoutDirectoryProjection({
      repositoryRoot: checkout.repositoryRoot,
      commit,
      directoryPaths: COMMITTED_WORKFLOW_PROJECTION,
    });
    assertExactCommittedCheckoutUnchanged(checkout);
    return {
      repositoryRoot: checkout.repositoryRoot,
      changes,
      documents,
    };
  } catch (error) {
    assertCommittedCheckoutDirectoryProjection({
      repositoryRoot: checkout.repositoryRoot,
      commit,
      directoryPaths: COMMITTED_WORKFLOW_PROJECTION,
    });
    assertExactCommittedCheckoutUnchanged(checkout);
    throw error;
  }
}

function listLiveChangeIds(
  repositoryRoot: string,
  changeRoot: string,
): string[] {
  return fs
    .readdirSync(path.join(repositoryRoot, changeRoot), {
      withFileTypes: true,
    })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'archive' &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
}

type ExactCommittedCheckout = Readonly<{
  repositoryRoot: string;
  commit: string;
  fingerprint: string;
}>;

function captureExactCommittedCheckout(
  cwd: string,
  commit: string,
): ExactCommittedCheckout {
  try {
    const before = discoverRepository(cwd);
    assertExactNativeCommit(before.repositoryRoot, commit);
    if (before.head !== commit || before.statusEntries.length > 0) {
      throw new Error('checkout does not match');
    }
    const fingerprint = fingerprintWorkingState(
      before.repositoryRoot,
      commit,
      before.statusEntries,
    );
    const after = discoverRepository(before.repositoryRoot);
    if (
      after.head !== commit ||
      after.statusEntries.length > 0 ||
      fingerprintWorkingState(
        after.repositoryRoot,
        commit,
        after.statusEntries,
      ) !== fingerprint
    ) {
      throw new Error('checkout changed during observation');
    }
    return Object.freeze({
      repositoryRoot: before.repositoryRoot,
      commit,
      fingerprint,
    });
  } catch {
    throw committedCheckoutInvalid();
  }
}

function assertExactCommittedCheckoutUnchanged(
  expected: ExactCommittedCheckout,
): void {
  const observed = captureExactCommittedCheckout(
    expected.repositoryRoot,
    expected.commit,
  );
  if (observed.fingerprint !== expected.fingerprint) {
    throw committedCheckoutInvalid();
  }
}

type CommittedRepositorySource = Readonly<{
  readText: (relativePath: string) => string | undefined;
  readRequiredText: (relativePath: string) => string;
  listChangeIds: (changeRoot: string) => string[];
}>;

function createCommittedRepositorySource(
  repositoryRoot: string,
  commit: string,
): CommittedRepositorySource {
  assertExactNativeCommit(repositoryRoot, commit);
  const cache = new Map<string, string | undefined>();
  const readText = (relativePath: string): string | undefined => {
    const normalized = normalizeExactRepositoryPath(relativePath);
    if (normalized !== relativePath || relativePath.endsWith('/')) {
      throw committedCheckoutInvalid();
    }
    if (cache.has(relativePath)) return cache.get(relativePath);
    const value = readCommittedText(repositoryRoot, commit, relativePath);
    cache.set(relativePath, value);
    return value;
  };
  return Object.freeze({
    readText,
    readRequiredText(relativePath: string): string {
      const value = readText(relativePath);
      if (value === undefined) throw committedCheckoutInvalid();
      return value;
    },
    listChangeIds(changeRoot: string): string[] {
      return readCommittedChangeIds(repositoryRoot, commit, changeRoot);
    },
  });
}

function committedManagedDocumentContext(
  source: CommittedRepositorySource,
  contracts: readonly ChangeContract[],
): ManagedDocumentValidationContext {
  return Object.freeze({
    contracts: Object.freeze(
      contracts.map((contract) =>
        Object.freeze({
          changeId: contract.changeId,
          tasks: contract.tasks.map((task) => ({ ...task })),
        }),
      ),
    ),
    readText(relativePath: string): string | undefined {
      if (!COMMITTED_DOCUMENT_PATHS.has(relativePath)) {
        throw committedCheckoutInvalid();
      }
      return source.readText(relativePath);
    },
  });
}

function parseCommittedChangeRoot(source: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw committedCheckoutInvalid();
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    typeof (value as Record<string, unknown>).changeRoot !== 'string'
  ) {
    throw committedCheckoutInvalid();
  }
  const changeRoot = (value as Record<string, unknown>).changeRoot as string;
  const normalized = normalizeExactRepositoryPath(changeRoot);
  if (normalized !== changeRoot || changeRoot.endsWith('/')) {
    throw committedCheckoutInvalid();
  }
  return changeRoot;
}

function readCommittedChangeIds(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
): string[] {
  try {
    const rootListing = UTF8.decode(
      runGitBuffer(repositoryRoot, [
        'ls-tree',
        '-z',
        '--full-tree',
        commit,
        '--',
        `:(literal)${changeRoot}`,
      ]),
    );
    if (rootListing === '') {
      throw new Error('configured change root is absent from the commit tree');
    }
    const rootMatch = new RegExp(
      `^040000 tree (${OBJECT_ID})\\t${escapeRegExp(changeRoot)}\\0$`,
      'u',
    ).exec(rootListing);
    if (rootMatch === null) throw new Error('change root is not one tree');
    const children = UTF8.decode(
      runGitBuffer(repositoryRoot, ['ls-tree', '-z', rootMatch[1]!]),
    );
    if (children !== '' && !children.endsWith('\0')) {
      throw new Error('change tree listing is truncated');
    }
    const changeIds: string[] = [];
    for (const record of children.split('\0').filter(Boolean)) {
      const match = new RegExp(
        `^([0-7]{6}) (blob|tree|commit) (${OBJECT_ID})\\t([^/\\0]+)$`,
        'u',
      ).exec(record);
      if (match === null) throw new Error('change tree entry is malformed');
      const name = match[4]!;
      if (name === 'archive' || name.startsWith('.')) continue;
      if (match[1] === '160000') {
        throw new Error('active change cannot be a gitlink');
      }
      if (match[1] === '040000' && match[2] === 'tree') {
        changeIds.push(name);
      }
    }
    return changeIds.sort();
  } catch {
    throw committedCheckoutInvalid();
  }
}

function readCommittedText(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): string | undefined {
  try {
    const listing = UTF8.decode(
      runGitBuffer(repositoryRoot, [
        'ls-tree',
        '-z',
        '--full-tree',
        commit,
        '--',
        `:(literal)${relativePath}`,
      ]),
    );
    if (listing === '') return undefined;
    const match = new RegExp(
      `^100644 blob (${OBJECT_ID})\\t${escapeRegExp(relativePath)}\\0$`,
      'u',
    ).exec(listing);
    if (match === null) throw new Error('committed text is not 100644');
    const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', match[1]!]);
    if (bytes.length > MAX_COMMITTED_DOCUMENT_BYTES) {
      throw new Error('committed text exceeds its byte bound');
    }
    return UTF8.decode(bytes);
  } catch {
    throw committedCheckoutInvalid();
  }
}

function assertExactNativeCommit(repositoryRoot: string, commit: string): void {
  try {
    const objectFormat = runGitBuffer(repositoryRoot, [
      'rev-parse',
      '--show-object-format',
    ]);
    const pattern = objectFormat.equals(Buffer.from('sha1\n'))
      ? /^[0-9a-f]{40}$/u
      : objectFormat.equals(Buffer.from('sha256\n'))
        ? /^[0-9a-f]{64}$/u
        : null;
    if (pattern === null || !pattern.test(commit)) {
      throw new Error('commit is not a native full object ID');
    }
    const resolved = runGitBuffer(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${commit}^{commit}`,
    ]);
    if (!resolved.equals(Buffer.from(`${commit}\n`))) {
      throw new Error('commit does not resolve exactly');
    }
  } catch {
    throw committedCheckoutInvalid();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function committedCheckoutInvalid(): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_COMMITTED_CHECKOUT_INVALID',
    'Committed change replay requires one exact clean checkout that remains unchanged.',
    ExitCode.staleState,
  );
}
