import {
  markdownHeadings,
  markdownLines,
  type MarkdownHeading,
} from '@jigwright/core/markdown-sections';

export type FixtureMarkdownOutlineV1 = Readonly<{
  headings: readonly MarkdownHeading[];
  visibleLines: readonly string[];
}>;

export function inspectFixtureMarkdown(
  markdown: string,
): FixtureMarkdownOutlineV1 {
  return {
    headings: markdownHeadings(markdown),
    visibleLines: markdownLines(markdown)
      .filter((line) => !line.fenced)
      .map((line) => line.text),
  };
}
