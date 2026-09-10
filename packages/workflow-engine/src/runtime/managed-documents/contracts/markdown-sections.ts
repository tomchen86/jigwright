/**
 * Exposes shared Markdown headings and fence-aware lines to document
 * consumers.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  markdownHeadings,
  markdownLines,
  type MarkdownHeading,
  type MarkdownLine,
} from '@jigwright/core/markdown-sections';
