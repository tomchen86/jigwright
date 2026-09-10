/**
 * Lexically extracts published names from declared source paths for
 * investigation search.
 *
 * Invariants:
 * - Only column-zero exports are considered, and results are unique, sorted
 *   and capped at the declared symbol limit.
 */

export const DECLARED_SYMBOL_LIMIT = 512;

const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';

/** `export function f`, `export const c`, `export class C`, `export type T` … */
const DECLARATION = new RegExp(
  `^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|type|interface|enum)\\s+(${IDENTIFIER})\\b`,
);

/** `export { a, b as c }` and `export { a } from './x'` alike. */
const EXPORT_LIST = /^export\s*\{([^}]*)\}/;

export function deriveDeclaredPathSymbols(content: string): string[] {
  const symbols = new Set<string>();
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    // Only column zero: an `export` inside a block is not something another
    // file can reach, and treating it as reachable would inflate the floor
    // with names no consumer can use.
    if (!line.startsWith('export')) continue;

    const declaration = DECLARATION.exec(line);
    if (declaration) {
      symbols.add(declaration[1]);
      continue;
    }
    const list = EXPORT_LIST.exec(line);
    if (!list) continue;
    for (const entry of list[1].split(',')) {
      // Both sides of a rename: the local name is what the definition is
      // called, the alias is what a consumer writes, and a search that misses
      // either one misses half the call sites.
      for (const name of entry.split(/\s+as\s+/)) {
        const identifier = name.trim().replace(/^type\s+/, '');
        if (new RegExp(`^${IDENTIFIER}$`).test(identifier)) {
          symbols.add(identifier);
        }
      }
    }
  }
  return [...symbols].sort().slice(0, DECLARED_SYMBOL_LIMIT);
}
