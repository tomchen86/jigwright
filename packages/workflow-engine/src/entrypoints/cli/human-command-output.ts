/**
 * Presents command observations as readable text while JSON retains exact records.
 *
 * Invariants:
 * - Original wording is printed without rewriting whitespace or embedded identifiers.
 * - Rendering does not infer completion, approval or a passed check.
 */
const OPAQUE =
  /^(?:SRC-[a-f0-9]{64}|FND-[A-Za-z0-9-]{16,}|WORK-[A-Za-z0-9]{26}|sha(?:256|512):\S+|[a-f0-9]{40,64})$/u;
const INTERNAL =
  /^(?:schemaVersion|before|after|sourceRefs|.*(?:Digest|Digests|Hash|Hashes|Oid|Oids)|head|tree)$/u;
const WORDING = new Set([
  'text',
  'originalText',
  'message',
  'description',
  'summary',
  'reason',
  'question',
  'title',
  'label',
  'usage',
]);
const WRAPPERS = new Set(['result', 'source', 'error', 'details']);

export function renderHumanCommandResult(
  result: Readonly<Record<string, unknown>>,
): string {
  const heading =
    typeof result.command === 'string' ? label(result.command) : 'Jigwright';
  const body = Object.entries(result)
    .filter(([key]) => key !== 'command' && key !== 'ok')
    .flatMap(([key, value]) => render(value, key));
  return [
    heading,
    '',
    ...(body.length > 0
      ? body
      : ['Use --json to inspect the recorded result.']),
    '',
  ].join('\n');
}

function render(value: unknown, key: string): string[] {
  if (value === null || value === undefined || INTERNAL.test(key)) return [];
  if (typeof value === 'string') {
    if (value === '') return [];
    if (WORDING.has(key)) return [value, ''];
    if (OPAQUE.test(value) || (key === 'kind' && /\.v[0-9]+$/.test(value)))
      return [];
    if (key === 'command' || key === 'recovery') return [`Run: ${value}`, ''];
    return [`${label(key)}: ${value}`];
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return [
      `${label(key)}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}`,
    ];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((entry) => typeof entry === 'string')) {
      const values = value.filter((entry) => !OPAQUE.test(entry));
      return values.length === 0 ? [] : [`${label(key)}: ${values.join(', ')}`];
    }
    const rows = value.flatMap((entry) => [...render(entry, ''), '']);
    return rows.some((row) => row !== '') ? [label(key), ...rows] : [];
  }
  if (typeof value === 'object') {
    const rows = Object.entries(value).flatMap(([field, entry]) =>
      render(entry, field),
    );
    return rows.length === 0
      ? []
      : [...(key === '' || WRAPPERS.has(key) ? [] : [label(key)]), ...rows];
  }
  return [];
}

function label(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
