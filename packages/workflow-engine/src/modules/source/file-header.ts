/**
 * Reads a file's responsibility and invariant bullets for document projections.
 *
 * Invariants:
 * - Only the leading documentation comment supplies file-level explanations.
 * - Invariant order matches one-based spec covers references; missing prose is not a gate.
 */

export type FileHeader = Readonly<{
  responsibility: string;
  invariants: readonly string[];
  startLine: number;
  endLine: number;
}>;

export function extractFileHeader(source: string): FileHeader | null {
  const match = /^\uFEFF?\/\*\*([\s\S]*?)\*\//.exec(source);
  if (match === null) return null;
  const lines = match[1]!
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, '').trim());
  const responsibilityLines: string[] = [];
  for (const line of lines.slice(lines.findIndex((line) => line !== ''))) {
    if (line === '' || /^(?:Invariants|Depends on|Failure modes):/.test(line))
      break;
    responsibilityLines.push(line);
  }
  const section = lines.indexOf('Invariants:');
  const invariants: string[] = [];
  if (section !== -1) {
    for (const line of lines.slice(section + 1)) {
      if (line === '') continue;
      if (/^[A-Z][A-Za-z ]*:/.test(line)) break;
      if (line.startsWith('- ')) {
        invariants.push(line.slice(2));
      } else if (invariants.length > 0) {
        invariants[invariants.length - 1] += ` ${line}`;
      }
    }
  }
  return Object.freeze({
    responsibility: responsibilityLines.join(' '),
    invariants: Object.freeze(invariants),
    startLine: 1,
    endLine: match[0].split('\n').length,
  });
}
