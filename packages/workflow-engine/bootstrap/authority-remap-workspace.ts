/** Isolated pinned worktrees, caller-state checks, and generated-output inventory. */
import fs from 'node:fs';
import path from 'node:path';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import { normalizeExactRepositoryPath } from '../src/runtime/session-workspace/paths.ts';
import {
  HARNESS_BOOTSTRAP_RUNTIME_ROOT,
  remapInvalid,
  HARNESS_BOOTSTRAP_OUTPUTS,
  comparePaths,
  assertUniquePaths,
  splitNul,
  decodeText,
  splitNulFields,
} from './authority-remap-mutations.ts';

export function listHarnessBootstrapOutputPaths(
  repositoryRoot: string,
): string[] {
  const runtimeRoot = path.join(repositoryRoot, HARNESS_BOOTSTRAP_RUNTIME_ROOT);
  const rootStats = fs.lstatSync(runtimeRoot, { throwIfNoEntry: false });
  if (
    rootStats === undefined ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    fs.realpathSync(runtimeRoot) !== runtimeRoot
  ) {
    throw remapInvalid(
      'Generated harness-bootstrap recovery runtime is missing or unsafe.',
    );
  }
  const outputs = [...HARNESS_BOOTSTRAP_OUTPUTS];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stats = fs.lstatSync(candidate);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        visit(candidate);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw remapInvalid(
          'Generated harness-bootstrap recovery runtime contains an unsafe entry.',
        );
      }
      const relative = path
        .relative(runtimeRoot, candidate)
        .split(path.sep)
        .join('/');
      const output = `${HARNESS_BOOTSTRAP_RUNTIME_ROOT}/${relative}`;
      if (normalizeExactRepositoryPath(output) !== output) {
        throw remapInvalid(
          'Generated harness-bootstrap recovery runtime contains an unsafe path.',
        );
      }
      outputs.push(output);
    }
  };
  visit(runtimeRoot);
  if (outputs.length === HARNESS_BOOTSTRAP_OUTPUTS.size) {
    throw remapInvalid(
      'Generated harness-bootstrap recovery runtime is empty.',
    );
  }
  outputs.sort(comparePaths);
  assertUniquePaths(outputs);
  return outputs;
}

export function assertGeneratedOutputsNotIgnored(
  repositoryRoot: string,
  outputPaths: ReadonlySet<string>,
): void {
  if (outputPaths.size === 0) return;
  const cachedPaths = new Set(
    splitNul(
      runGitBuffer(repositoryRoot, ['ls-files', '--cached', '-z', '--']),
    ).map((entry) => {
      const filePath = decodeText(entry, 'Git cached path');
      if (normalizeExactRepositoryPath(filePath) !== filePath) {
        throw remapInvalid('Git returned an unsafe cached path.');
      }
      return filePath;
    }),
  );
  const paths = [...outputPaths]
    .filter((filePath) => !cachedPaths.has(filePath))
    .sort(comparePaths);
  if (paths.length === 0) return;
  assertUniquePaths(paths);
  const output = runGitBuffer(
    repositoryRoot,
    [
      'check-ignore',
      '--no-index',
      '--verbose',
      '--non-matching',
      '-z',
      '--stdin',
    ],
    {
      input: Buffer.from(`${paths.join('\0')}\0`, 'utf8'),
      // check-ignore returns 1 when every --non-matching record is negative;
      // the exact four-field record count below still fails closed on errors.
      allowFailure: true,
    },
  );
  const fields = splitNulFields(output);
  if (fields.length !== paths.length * 4) {
    throw remapInvalid(
      'Git returned malformed generated-output ignore evidence.',
    );
  }
  for (let index = 0; index < paths.length; index += 1) {
    const offset = index * 4;
    const source = decodeText(fields[offset]!, 'Git ignore source');
    const line = decodeText(fields[offset + 1]!, 'Git ignore line');
    const pattern = decodeText(fields[offset + 2]!, 'Git ignore pattern');
    const observedPath = decodeText(
      fields[offset + 3]!,
      'Git ignored output path',
    );
    const expectedPath = paths[index]!;
    if (observedPath !== expectedPath) {
      throw remapInvalid(
        'Git returned mismatched generated-output ignore evidence.',
      );
    }
    const matched = source !== '' || line !== '' || pattern !== '';
    if (matched && (source === '' || line === '' || pattern === '')) {
      throw remapInvalid(
        'Git returned incomplete generated-output ignore evidence.',
      );
    }
    if (matched && !pattern.startsWith('!')) {
      throw remapInvalid(
        `Generated authority remap output ${expectedPath} is hidden by Git ignore rules.`,
      );
    }
  }
}

export function assertCallerState(
  repositoryRoot: string,
  moveCommit: string,
): void {
  assertNoCallerGitAttributeConfiguration(repositoryRoot);
  const hiddenIndexEntries = splitNul(
    runGitBuffer(repositoryRoot, ['ls-files', '-v', '-z', '--']),
  )
    .map((entry) => decodeText(entry, 'Git index flag entry'))
    .filter((entry) => {
      const tag = entry[0];
      return tag === 'S' || (tag !== undefined && tag >= 'a' && tag <= 'z');
    });
  if (hiddenIndexEntries.length > 0) {
    throw remapInvalid(
      'Authority remap materialization rejects caller hidden index flags.',
    );
  }
  const head = runGitBuffer(repositoryRoot, ['rev-parse', '--verify', 'HEAD'])
    .toString('ascii')
    .trim();
  if (head !== moveCommit) {
    throw remapInvalid(
      'Authority remap materialization requires caller HEAD to equal the exact move commit.',
    );
  }
  const status = runGitBuffer(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (status.length !== 0) {
    throw remapInvalid(
      'Authority remap materialization requires a clean caller index and worktree.',
    );
  }
}

function assertNoCallerGitAttributeConfiguration(repositoryRoot: string): void {
  const keys = splitNul(
    runGitBuffer(repositoryRoot, [
      'config',
      '--null',
      '--name-only',
      '--list',
      '--includes',
    ]),
  ).map((entry) => decodeText(entry, 'Git configuration key').toLowerCase());
  if (
    keys.some(
      (key) =>
        key.startsWith('filter.') ||
        key === 'core.attributesfile' ||
        key === 'core.autocrlf' ||
        key === 'core.eol' ||
        key === 'core.checkroundtripencoding',
    )
  ) {
    throw remapInvalid(
      'Authority remap materialization rejects caller Git attribute or filter configuration.',
    );
  }
  const informationAttributesValue = runGitBuffer(repositoryRoot, [
    'rev-parse',
    '--git-path',
    'info/attributes',
  ])
    .toString('utf8')
    .trim();
  const informationAttributes = path.isAbsolute(informationAttributesValue)
    ? informationAttributesValue
    : path.resolve(repositoryRoot, informationAttributesValue);
  const stats = fs.lstatSync(informationAttributes, { throwIfNoEntry: false });
  if (
    stats !== undefined &&
    (!stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size !== 0)
  ) {
    throw remapInvalid(
      'Authority remap materialization rejects caller info attributes.',
    );
  }
}

export function assertNoTrackedGitAttributes(
  repositoryRoot: string,
  commit: string,
): void {
  const paths = splitNul(
    runGitBuffer(repositoryRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      commit,
      '--',
    ]),
  );
  for (const encoded of paths) {
    const filePath = decodeText(encoded, 'Pinned Git tree path');
    if (filePath === '.gitattributes' || filePath.endsWith('/.gitattributes')) {
      throw remapInvalid(
        'Authority remap materialization rejects tracked .gitattributes because worktree transforms cannot prove pinned blob identity.',
      );
    }
  }
}

export function clonePinnedRepository(
  sourceRepository: string,
  targetRepository: string,
): void {
  runGitBuffer(path.dirname(targetRepository), [
    '-c',
    'core.hooksPath=/dev/null',
    'clone',
    '--quiet',
    '--no-local',
    '--no-checkout',
    '--',
    sourceRepository,
    targetRepository,
  ]);
  const gitDirectoryValue = runGitBuffer(targetRepository, [
    'rev-parse',
    '--git-dir',
  ])
    .toString('utf8')
    .trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue)
    ? gitDirectoryValue
    : path.resolve(targetRepository, gitDirectoryValue);
  if (
    fs.lstatSync(path.join(gitDirectory, 'objects/info/alternates'), {
      throwIfNoEntry: false,
    }) !== undefined
  ) {
    throw remapInvalid(
      'Isolated authority remap clone must not depend on caller object alternates.',
    );
  }
}

export function checkoutPinnedCommit(
  targetRepository: string,
  commit: string,
  expectedTree: string,
): void {
  runGitBuffer(targetRepository, [
    '-c',
    'core.hooksPath=/dev/null',
    'checkout',
    '--quiet',
    '--detach',
    '--force',
    commit,
    '--',
  ]);
  const head = runGitBuffer(targetRepository, ['rev-parse', '--verify', 'HEAD'])
    .toString('ascii')
    .trim();
  if (head !== commit) {
    throw remapInvalid('Isolated authority remap checkout is not pinned.');
  }
  const tree = runGitBuffer(targetRepository, [
    'rev-parse',
    '--verify',
    'HEAD^{tree}',
  ])
    .toString('ascii')
    .trim();
  if (tree !== expectedTree) {
    throw remapInvalid(
      'Isolated authority remap checkout tree does not match the pinned descriptor.',
    );
  }
}
