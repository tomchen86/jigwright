/** Reads the bounded public conformance corpus and delegates exact validation to core. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWorkflowConformanceVectorsV2,
  workflowConformanceVectorsUrl,
  type WorkflowConformanceVectorsV2,
} from '@jigwright/core/conformance-vectors';

export function loadWorkflowConformanceVectorsV2(
  options: Readonly<{ vectorPath?: string }> = {},
): WorkflowConformanceVectorsV2 {
  const requestedPath = path.resolve(
    options.vectorPath ?? fileURLToPath(workflowConformanceVectorsUrl()),
  );
  const stats = fs.lstatSync(requestedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size === 0 ||
    stats.size > 1024 * 1024
  ) {
    throw new Error(
      'Workflow conformance vectors must be a bounded plain file.',
    );
  }
  let source: string;
  try {
    source = fs.readFileSync(requestedPath, 'utf8');
  } catch (error) {
    throw new Error('Workflow conformance vectors are malformed JSON.', {
      cause: error,
    });
  }
  return parseWorkflowConformanceVectorsV2(source);
}
