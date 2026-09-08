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
  const responsibility = lines.find((line) => line !== '') ?? '';
  const section = lines.indexOf('Invariants:');
  const invariants: string[] = [];
  if (section !== -1) {
    for (const line of lines.slice(section + 1)) {
      if (line === '') continue;
      if (!line.startsWith('- ') || line.slice(2).trim() === '') break;
      invariants.push(line.slice(2));
    }
  }
  return Object.freeze({
    responsibility: responsibility === 'Invariants:' ? '' : responsibility,
    invariants: Object.freeze(invariants),
    startLine: 1,
    endLine: match[0].split('\n').length,
  });
}
