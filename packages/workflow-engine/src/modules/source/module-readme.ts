/** Reads the one handwritten explanation without treating generated text as a decision. */
import { markdownLines } from '@jigwright/core/markdown-sections';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

const START = '<!-- jigwright:module-why -->';
const END = '<!-- /jigwright:module-why -->';

export function readModuleReadmeWhy(text: string): Readonly<{
  text: string;
  confirmedAtCommit: string;
}> | null {
  const lines = markdownLines(text).filter((line) => !line.fenced);
  const starts = lines.filter((line) => line.text === START);
  const ends = lines.filter((line) => line.text === END);
  if (starts.length > 1 || ends.length > 1)
    throw invalid('Duplicate handwritten why marker.');
  if (!starts.length && !ends.length) return null;
  const start = starts[0];
  const end = ends[0];
  if (!start || !end || end.start <= start.start)
    throw invalid('The handwritten why needs an opening and closing marker.');
  const body = text.slice(start.start + start.raw.length, end.start).trim();
  const confirmation =
    /(?:^|\r?\n)Confirmed at commit: `([0-9a-f]{40}|[0-9a-f]{64})`$/.exec(body);
  if (!confirmation)
    throw invalid('The handwritten why needs one full confirmation commit.');
  const prose = body.slice(0, confirmation.index).trim();
  if (!prose || /\r?\n\s*\r?\n/.test(prose))
    throw invalid('The handwritten why must be one paragraph.');
  return Object.freeze({ text: prose, confirmedAtCommit: confirmation[1]! });
}

function invalid(message: string) {
  return workflowError('MODULE_README_INVALID', message, ExitCode.verification);
}
