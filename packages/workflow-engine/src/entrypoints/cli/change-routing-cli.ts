import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseChangeRoutingIntent,
  parseChangeRoutingReview,
} from '../../modules/lifecycle/change-routing.ts';
import {
  applyManagedChangeRoutingReview,
  inspectChangeRouting,
  prepareChangeRoutingReview,
} from '../../composition-root/change-routing-production.ts';
import { replaceTextAtomic } from '../../runtime/repository-transaction/atomic-text.ts';

export function dispatchChangeRoutingCommand(
  args: readonly string[],
  repositoryRoot: string,
):
  | Readonly<{ action: 'prepare'; output: string; reviewDigest: string }>
  | Readonly<{
      action: 'apply';
      sourceDigest: string;
      reviewDigest: string;
      reportPath: string;
      commitHash: string;
      replayed: boolean;
    }>
  | Readonly<{
      action: 'status';
      result: ReturnType<typeof inspectChangeRouting>;
    }> {
  if (
    args.length === 5 &&
    args[0] === 'prepare' &&
    args[1] === '--intent' &&
    args[3] === '--output'
  ) {
    const inputPath = path.resolve(repositoryRoot, args[2]!);
    const outputPath = path.resolve(repositoryRoot, args[4]!);
    const intent = parseChangeRoutingIntent(readJson(inputPath, 'intent'));
    const review = prepareChangeRoutingReview(repositoryRoot, intent);
    const bytes = `${JSON.stringify(review, null, 2)}\n`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    replaceTextAtomic(outputPath, bytes, {
      allowCreate: true,
      defaultMode: 0o644,
    });
    return {
      action: 'prepare',
      output: outputPath,
      reviewDigest: review.nextSourceDigest,
    };
  }
  if (args.length === 2 && args[0] === 'apply') {
    const reviewPath = path.resolve(repositoryRoot, args[1]!);
    const review = parseChangeRoutingReview(readJson(reviewPath, 'review'));
    const result = applyManagedChangeRoutingReview(repositoryRoot, review);
    return {
      action: 'apply',
      sourceDigest: result.sourceDigest,
      reviewDigest: result.reviewDigest,
      reportPath: result.reportPath,
      commitHash: result.commitHash,
      replayed: result.replayed,
    };
  }
  if (args.length === 1 && args[0] === 'status') {
    return {
      action: 'status',
      result: inspectChangeRouting(repositoryRoot),
    };
  }
  throw workflowError(
    'INVALID_USAGE',
    'Usage: jigwright route <prepare --intent <intent.json> --output <review.json>|apply <review.json>|status> [--json]',
    ExitCode.usage,
  );
}

function readJson(filePath: string, kind: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    throw workflowError(
      'CHANGE_ROUTING_INPUT_INVALID',
      `Change-routing ${kind} must be readable JSON.`,
      ExitCode.usage,
    );
  }
}
