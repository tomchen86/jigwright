/**
 * Hints when source code is newer than its leading explanation.
 *
 * Invariants:
 * - History is anchored to the README confirmation, never the mutable checkout HEAD.
 * - Missing history is informational; no hint certifies prose or gates development.
 */
import { extractFileHeader } from '../../../modules/source/file-header.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';
import { runGit } from '../../repository-transaction/git.ts';
import { readSystemDescriptionSnapshot } from '../../repository-transaction/system-description-snapshot.ts';

export function moduleHeaderHistory(
  repositoryRoot: string,
  current: SystemDescriptionSnapshot,
) {
  const baselines = new Map<string, SystemDescriptionSnapshot>();
  const orders = new Map<string, Map<string, number>>();
  return (file: string, confirmation: string): string => {
    try {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(confirmation))
        return 'History unavailable';
      const baseline =
        baselines.get(confirmation) ??
        readSystemDescriptionSnapshot(repositoryRoot, confirmation);
      baselines.set(confirmation, baseline);
      const before = baseline.readText(file);
      const after = current.readText(file);
      const header = before === undefined ? null : extractFileHeader(before);
      if (before === undefined || after === undefined || !header)
        return 'History unavailable';
      const prefix = /^\uFEFF?\/\*\*[\s\S]*?\*\//;
      const oldHeader = before.match(prefix)?.[0];
      const newHeader = after.match(prefix)?.[0];
      if (oldHeader !== newHeader) return 'Header changed since confirmation';
      if (before.slice(oldHeader!.length) !== after.slice(newHeader!.length))
        return 'Possibly stale';

      let order = orders.get(confirmation);
      if (!order) {
        order = new Map(
          runGit(repositoryRoot, [
            'rev-list',
            '--topo-order',
            confirmation,
            '--',
          ])
            .trim()
            .split('\n')
            .map((commit, rank) => [commit, rank]),
        );
        orders.set(confirmation, order);
      }
      const blame = runGit(repositoryRoot, [
        'blame',
        '--line-porcelain',
        confirmation,
        '--',
        file,
      ]);
      let headerRank = Infinity;
      let codeRank = Infinity;
      let rank = Infinity;
      let lineNumber = 0;
      for (const line of blame.split('\n')) {
        const record = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(
          line,
        );
        if (record) {
          rank = order.get(record[1]!) ?? Infinity;
          lineNumber = Number(record[2]);
        } else if (line.startsWith('\t') && line.trim() !== '') {
          if (lineNumber <= header.endLine)
            headerRank = Math.min(headerRank, rank);
          else codeRank = Math.min(codeRank, rank);
        }
      }
      if (!Number.isFinite(headerRank) || !Number.isFinite(codeRank))
        return 'History unavailable';
      return codeRank < headerRank
        ? 'Possibly stale'
        : 'No newer code observed';
    } catch {
      return 'History unavailable';
    }
  };
}
