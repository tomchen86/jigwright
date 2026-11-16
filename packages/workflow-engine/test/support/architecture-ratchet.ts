/** Compare Git source snapshots with the current scanner, never historical executable code. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRepositoryDependencies,
  readRepositoryDependencyGraph,
  type ArchitectureProblem,
} from './repository-dependency-graph.ts';

// Owner-reviewed consolidation anchor. Once main contains it, ordinary Git bases advance.
const CONSOLIDATION_ANCHOR = 'f966222a9fac330821274c35a985b245fe690e19';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function selectArchitectureBase(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
  anchor = CONSOLIDATION_ANCHOR,
): { base: string; head: string; reason: string } {
  const head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  const ancestor = (before: string, after: string): boolean => {
    const result = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', before, after],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error(
        `Cannot compare architecture history: ${result.error ?? result.stderr}`,
      );
    return result.status === 0;
  };
  const commit = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ||
      /^0+$/.test(value)
    )
      throw new Error('Architecture base must identify an existing Git commit');
    return git(root, 'rev-parse', '--verify', `${value}^{commit}`);
  };
  let base: string;
  let reason: string;
  const eventName = environment.GITHUB_EVENT_NAME;
  if (
    eventName === 'pull_request' ||
    eventName === 'pull_request_target' ||
    eventName === 'push'
  ) {
    if (!environment.GITHUB_EVENT_PATH)
      throw new Error('Architecture check requires the GitHub event payload');
    const event = JSON.parse(
      fs.readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'),
    );
    if (eventName === 'push') {
      base = commit(event.before);
      if (!ancestor(base, head))
        throw new Error('Architecture push base is not an ancestor of HEAD');
      reason = 'push before';
    } else {
      base = git(
        root,
        'merge-base',
        head,
        commit(event.pull_request?.base?.sha),
      );
      reason = 'PR merge-base';
    }
  } else {
    const main = ['refs/remotes/origin/main', 'refs/heads/main'].find(
      (ref) =>
        spawnSync('git', ['show-ref', '--verify', '--quiet', ref], {
          cwd: root,
        }).status === 0,
    );
    if (!main)
      throw new Error(
        'Architecture check requires origin/main or local main history',
      );
    base = git(root, 'merge-base', head, main);
    reason = `merge-base ${main}`;
    if (base === head) {
      base = git(root, 'rev-parse', '--verify', 'HEAD^1');
      reason = 'main first parent';
    }
  }
  const bootstrap = commit(anchor);
  if (!ancestor(bootstrap, head))
    throw new Error(
      'Architecture candidate does not contain the reviewed consolidation anchor',
    );
  if (!ancestor(bootstrap, base)) {
    base = bootstrap;
    reason = 'reviewed consolidation anchor';
  }
  if (base === head)
    throw new Error(
      'Architecture base equals HEAD; check a candidate commit after the consolidation anchor',
    );
  return { base, head, reason };
}

export function readArchitectureBaseGraph(root: string, base: string) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'architecture-base-'),
  );
  try {
    const archive = path.join(temporary, 'source.tar');
    const snapshot = path.join(temporary, 'source');
    fs.mkdirSync(snapshot);
    execFileSync(
      'git',
      ['archive', '--format=tar', `--output=${archive}`, base],
      { cwd: root },
    );
    execFileSync('tar', ['-xf', archive, '-C', snapshot]);
    return readRepositoryDependencyGraph(snapshot);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Existing relationships may disappear; a different relationship never cancels a new one. */
export function architectureRegressions(
  root: string,
  baseline: readonly ArchitectureProblem[],
  candidate: readonly ArchitectureProblem[],
): ArchitectureProblem[] {
  const key = ({ rule, from, to }: ArchitectureProblem) =>
    JSON.stringify([rule, from, to ?? null]);
  const existing = new Set(baseline.map(key));
  const reader = readRepositoryDependencies(root);
  const pure = new Map<string, boolean>();
  const regressions = new Map<string, ArchitectureProblem>();
  for (const problem of candidate) {
    if (!pure.has(problem.from))
      pure.set(problem.from, reader.read(path.join(root, problem.from)).pure);
    const strict =
      pure.get(problem.from) ||
      problem.rule.startsWith('unresolved-') ||
      problem.rule === 'unclassified-source-layer' ||
      problem.rule === 'workspace-export-resolution-mismatch';
    if (strict || !existing.has(key(problem)))
      regressions.set(key(problem), problem);
  }
  return [...regressions.values()];
}
