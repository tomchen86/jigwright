/** Pure Markdown and shell command-surface recognition for reviewed planning assets. */

export function normalizeCommandSurface(content: string): string {
  const decoded = decodeHtmlEntities(content.normalize('NFKC'));
  const commentBodies = [...decoded.matchAll(/<!--([\s\S]*?)-->/g)].map(
    (match) => match[1] ?? '',
  );
  const withoutHtml =
    `${decoded.replaceAll(/<!--[\s\S]*?-->/g, '')}\n${commentBodies.join('\n')}`
      .replaceAll(/<\?[\s\S]*?\?>/g, '')
      .replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
      .replaceAll(/<![a-z][^>]*>/gi, '')
      .replaceAll(/<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, '')
      .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  return normalizeMarkdownReferenceLinks(withoutHtml)
    .replaceAll(/\\\r?\n/g, '')
    .replaceAll(/\\(?=[a-z0-9])/gi, '')
    .replaceAll(/["']/g, '')
    .replaceAll(/[*~]/g, '')
    .replaceAll(/[\u200B-\u200D\u2060\uFEFF]/g, '');
}

function normalizeMarkdownReferenceLinks(content: string): string {
  const normalizeLabel = (label: string): string =>
    label
      .replaceAll(/\r?\n[ \t]*(?:(?:>[ \t]?)+|(?:[-+*]|\d+[.)])[ \t]+)/g, ' ')
      .trim()
      .replaceAll(/\s+/g, ' ')
      .toLowerCase();
  const definitions = new Set(
    [...content.matchAll(/\[([^\]]{1,999})\]:/g)].map((match) =>
      normalizeLabel(match[1]!),
    ),
  );
  const fullReferences = content.replaceAll(
    /!?\[([^\]]*)\][ \t\r\n]*\[([^\]]*)\]/g,
    (match, label: string, reference: string) =>
      definitions.has(normalizeLabel(reference || label)) ? label : match,
  );
  return fullReferences.replaceAll(/!?\[([^\]]+)\]/g, (match, label: string) =>
    definitions.has(normalizeLabel(label)) ? label : match,
  );
}

export function findUnreviewedOpenSpecToken(content: string): boolean {
  for (const match of content.matchAll(/\bopenspec\b/gi)) {
    const index = match.index;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextNewline = content.indexOf('\n', index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const before = content.slice(lineStart, index);
    const after = content.slice(index + 'openspec'.length, lineEnd);

    if (before.endsWith('pnpm exec ')) {
      if (
        match[0] === 'openspec' &&
        isReviewedOpenSpecInvocation(
          content,
          lineStart,
          lineEnd,
          index - 'pnpm exec '.length,
        )
      ) {
        continue;
      }
      return true;
    }
    if (
      (before.endsWith('.') && after.startsWith('.yaml')) ||
      after.startsWith('-explore') ||
      after.startsWith('-propose') ||
      after.startsWith('/config.yaml') ||
      (/^\s*author:\s*$/.test(before) && after.trim().length === 0)
    ) {
      continue;
    }
    if (
      match[0] !== 'openspec' &&
      /^\s+(?:artifacts?|awareness|system|cli|lifecycle)\b/i.test(after)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function isReviewedOpenSpecInvocation(
  content: string,
  lineStart: number,
  lineEnd: number,
  invocationStart: number,
): boolean {
  let command: string;
  if (content[invocationStart - 1] === '`') {
    const closingBacktick = content.indexOf('`', invocationStart);
    if (closingBacktick === -1 || closingBacktick > lineEnd) {
      return false;
    }
    command = content.slice(invocationStart, closingBacktick);
  } else {
    if (content.slice(lineStart, invocationStart).trim().length !== 0) {
      return false;
    }
    command = content.slice(invocationStart, lineEnd);
  }
  command = command.replaceAll(/[ \t]+/g, ' ').trim();

  return [
    /^pnpm exec openspec$/,
    /^pnpm exec openspec list(?: --json)?$/,
    /^pnpm exec openspec status(?: --change)?(?: --json)?$/,
    /^pnpm exec openspec new change$/,
    /^pnpm exec openspec instructions(?: --change --json)?$/,
  ].some((pattern) => pattern.test(command));
}

function decodeHtmlEntities(content: string): string {
  return content
    .replaceAll(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, encoded: string) => {
      const hexadecimal = encoded[0]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(
        hexadecimal ? encoded.slice(1) : encoded,
        hexadecimal ? 16 : 10,
      );
      try {
        return Number.isSafeInteger(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      } catch {
        return entity;
      }
    })
    .replaceAll(
      /&(amp|apos|gt|lt|quot);/gi,
      (entity, name: string) =>
        ({
          amp: '&',
          apos: "'",
          gt: '>',
          lt: '<',
          quot: '"',
        })[name.toLowerCase()] ?? entity,
    );
}

export function hasCommandAdaptationSurface(content: string): boolean {
  return (
    findUnreviewedShellControl(content) ||
    findProtectedShellGlob(content) ||
    hasAdjacentInlineCode(content)
  );
}

function hasAdjacentInlineCode(content: string): boolean {
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      continue;
    }
    let searchFrom = 0;
    while (searchFrom < line.length) {
      const opening = line.indexOf('`', searchFrom);
      if (opening === -1) {
        break;
      }
      const closing = line.indexOf('`', opening + 1);
      if (closing === -1) {
        return true;
      }
      if (
        /[a-z0-9_./-]/i.test(line[opening - 1] ?? '') ||
        /[a-z0-9_/-]/i.test(line[closing + 1] ?? '') ||
        (line.slice(0, opening).trim().length === 0 &&
          line.slice(closing + 1).trim().length !== 0)
      ) {
        return true;
      }
      searchFrom = closing + 1;
    }
  }
  return false;
}

function findUnreviewedShellControl(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const markdownTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (
      /(?:&&|\|\||;|<<|>>|[<>]\()/.test(line) ||
      (line.includes('|') && !markdownTableRow)
    ) {
      return true;
    }
  }
  return false;
}

export function findProtectedShellGlob(content: string): boolean {
  for (const match of content.matchAll(/[^\s`"']+/g)) {
    let token = match[0].replace(/^[,;:]+|[,;:.]+$/g, '');
    if (token.startsWith('(') && token.endsWith(')') && token.includes('/')) {
      token = token.slice(1, -1);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      continue;
    }
    const basename = token.split('/').at(-1) ?? '';
    const groupedLiteral = collapseLiteralShellGroups(basename);
    const repeatedGroupLiteral = groupedLiteral?.replaceAll(/#+/g, '');
    const qualifierlessGlob = stripZshGlobQualifier(basename);
    if (
      (token.includes('/') && /[#~^]/.test(basename)) ||
      basename.startsWith('^') ||
      basename.includes('(#')
    ) {
      return true;
    }
    if (
      ['openspec', 'spectra', 'opsx'].some(
        (protectedName) =>
          (/[*?[]/.test(basename) &&
            shellGlobCanMatch(basename, protectedName)) ||
          (qualifierlessGlob !== null &&
            shellGlobCanMatch(qualifierlessGlob, protectedName)) ||
          groupedLiteral === protectedName ||
          repeatedGroupLiteral === protectedName,
      )
    ) {
      return true;
    }
  }
  return false;
}

function stripZshGlobQualifier(pattern: string): string | null {
  const match = /^(.*)\([^()\r\n]*\)$/.exec(pattern);
  const candidate = match?.[1];
  return candidate && /[*?[]/.test(candidate) ? candidate : null;
}

function collapseLiteralShellGroups(pattern: string): string | null {
  let collapsed = pattern.toLowerCase();
  while (/\([^()|]*\)/.test(collapsed)) {
    collapsed = collapsed.replaceAll(/\(([^()|]*)\)/g, '$1');
  }
  return collapsed === pattern.toLowerCase() || /[()]/.test(collapsed)
    ? null
    : collapsed;
}

function shellGlobCanMatch(pattern: string, literal: string): boolean {
  const candidate = pattern.toLowerCase();
  const expected = literal.toLowerCase();
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, literalIndex: number): boolean => {
    const key = `${patternIndex}:${literalIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let matched: boolean;
    if (patternIndex === candidate.length) {
      matched = literalIndex === expected.length;
    } else if (candidate[patternIndex] === '*') {
      matched =
        visit(patternIndex + 1, literalIndex) ||
        (literalIndex < expected.length &&
          visit(patternIndex, literalIndex + 1));
    } else if (literalIndex === expected.length) {
      matched = false;
    } else if (candidate[patternIndex] === '?') {
      matched = visit(patternIndex + 1, literalIndex + 1);
    } else if (candidate[patternIndex] === '[') {
      const closing = candidate.indexOf(']', patternIndex + 1);
      if (closing === -1) {
        matched = false;
      } else {
        const body = candidate.slice(patternIndex + 1, closing);
        const negated = body.startsWith('!') || body.startsWith('^');
        const choices = negated ? body.slice(1) : body;
        const included = shellCharacterClassIncludes(
          choices,
          expected[literalIndex]!,
        );
        matched =
          (negated ? !included : included) &&
          visit(closing + 1, literalIndex + 1);
      }
    } else {
      matched =
        candidate[patternIndex] === expected[literalIndex] &&
        visit(patternIndex + 1, literalIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function shellCharacterClassIncludes(
  choices: string,
  character: string,
): boolean {
  const code = character.codePointAt(0)!;
  for (let index = 0; index < choices.length; index += 1) {
    if (index + 2 < choices.length && choices[index + 1] === '-') {
      const lower = choices[index]!.codePointAt(0)!;
      const upper = choices[index + 2]!.codePointAt(0)!;
      if (lower <= code && code <= upper) {
        return true;
      }
      index += 2;
    } else if (choices[index] === character) {
      return true;
    }
  }
  return false;
}

export function containsUnreviewedPlanningEntryPoint(content: string): boolean {
  const commandSurface = normalizeCommandSurface(content);
  return (
    /\b(?:openspec|spectra|opsx)[a-z0-9_-]*/i.test(commandSurface) ||
    /\b(?:xargs|eval|printf|echo|base64|sed|corepack)\b/i.test(
      commandSurface,
    ) ||
    /\b(?:ba|z|da)?sh\s+-c\b/i.test(commandSurface) ||
    /\b(?:node|python\d*|perl|ruby|php|lua|bash|zsh|dash|sh)\b(?=\s+(?:-[a-z]|[<>]\())/i.test(
      commandSurface,
    ) ||
    /[$\\{}]/.test(content) ||
    hasCommandAdaptationSurface(commandSurface)
  );
}

export function findCommandLikeSpectraToken(content: string): boolean {
  for (const match of content.matchAll(/\bspectra\b/gi)) {
    const index = match.index;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextNewline = content.indexOf('\n', index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const before = content.slice(lineStart, index);
    const after = content.slice(index + 'spectra'.length, lineEnd);
    if (
      /historical name\s*$/i.test(before) &&
      /^\s+(?:also\s+)?appears only as prose[.]?\s*$/i.test(after)
    ) {
      continue;
    }
    return true;
  }
  return false;
}
