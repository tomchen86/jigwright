/**
 * Reads the handwritten module explanation and its confirmation marker.
 *
 * Invariants:
 * - A marked explanation requires exactly one paragraph, paired markers and
 *   a full confirmation commit.
 */
import { markdownLines } from '@jigwright/core/markdown-sections';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const START =
  /^<!-- jigwright:module-why(?: confirmed=([0-9a-f]{40}|[0-9a-f]{64}))? -->$/;
const END = '<!-- /jigwright:module-why -->';
/**
 * The confirmation used to sit in visible prose. It is read from the marker
 * now so no reader meets a raw digest, and the retired form stays readable
 * because every confirmation commit points at a tree that still uses it.
 */
const RETIRED_CONFIRMATION =
  /(?:^|\r?\n)Confirmed at commit: `([0-9a-f]{40}|[0-9a-f]{64})`$/;

export function readModuleReadmeWhy(text: string): Readonly<{
  text: string;
  confirmedAtCommit: string;
}> | null {
  const lines = markdownLines(text).filter((line) => !line.fenced);
  const starts = lines.filter((line) => START.test(line.text));
  const ends = lines.filter((line) => line.text === END);
  if (starts.length > 1 || ends.length > 1)
    throw invalid('Duplicate handwritten why marker.');
  if (!starts.length && !ends.length) return null;
  const start = starts[0];
  const end = ends[0];
  if (!start || !end || end.start <= start.start)
    throw invalid('The handwritten why needs an opening and closing marker.');
  const body = text.slice(start.start + start.raw.length, end.start).trim();
  const retired = RETIRED_CONFIRMATION.exec(body);
  const confirmedAtCommit = START.exec(start.text)?.[1] ?? retired?.[1];
  if (!confirmedAtCommit)
    throw invalid('The handwritten why needs one full confirmation commit.');
  const prose = (retired ? body.slice(0, retired.index) : body).trim();
  if (!prose || /\r?\n\s*\r?\n/.test(prose))
    throw invalid('The handwritten why must be one paragraph.');
  return Object.freeze({ text: prose, confirmedAtCommit });
}

function invalid(message: string) {
  return workflowError('MODULE_README_INVALID', message, ExitCode.verification);
}
