import { productionChangeRoutingInspector } from '../src/composition-root/change-routing-observation-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderHandoff as renderHandoffWithContractReader } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { validateManagedDocuments } from '../src/composition-root/managed-documents-production.ts';
import {
  createFixtureRepository,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

test('current handoff-only managed documents still validate', () => {
  const repository = createFixtureRepository();
  try {
    writeDocumentPolicy(repository, {
      'docs/CURRENT_AND_NEXT_STEPS.md': {
        mode: 'generated',
        enforcement: 'active',
        transition: 'completion',
      },
    });
    renderHandoff(repository);

    assert.deepEqual(validateManagedDocuments(repository), [
      'docs/CURRENT_AND_NEXT_STEPS.md',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('retired active IssueLog policy fails generically without reading poisoned legacy issue data', () => {
  const repository = createFixtureRepository();
  const issueSourcePath = 'docs/issues/issues.yaml';
  const issueLogPath = 'docs/ISSUE_LOG.md';
  const sourcePoison = 'this retired source must never be read or changed\n';
  const targetPoison = 'this retired target must never be read or changed\n';
  try {
    writeDocumentPolicy(repository, {
      'docs/ISSUE_LOG.md': {
        mode: 'generated',
        enforcement: 'active',
      },
    });
    fs.mkdirSync(path.join(repository, 'docs/issues'), { recursive: true });
    fs.writeFileSync(path.join(repository, issueSourcePath), sourcePoison);
    fs.writeFileSync(path.join(repository, issueLogPath), targetPoison);

    let legacyIssueReads = 0;
    let validationError: unknown;
    try {
      validateManagedDocuments(repository, {
        contracts: [],
        readText(relativePath) {
          if (
            relativePath === issueSourcePath ||
            relativePath === issueLogPath
          ) {
            legacyIssueReads += 1;
          }
          return fs.readFileSync(path.join(repository, relativePath), 'utf8');
        },
      });
    } catch (error) {
      validationError = error;
    }

    assert.deepEqual(
      {
        unsupported: isWorkflowError(
          validationError,
          'UNSUPPORTED_ACTIVE_DOCUMENT_POLICY',
        ),
        legacyIssueReads,
        sourceAfterValidation: fs.readFileSync(
          path.join(repository, issueSourcePath),
          'utf8',
        ),
        targetAfterValidation: fs.readFileSync(
          path.join(repository, issueLogPath),
          'utf8',
        ),
      },
      {
        unsupported: true,
        legacyIssueReads: 0,
        sourceAfterValidation: sourcePoison,
        targetAfterValidation: targetPoison,
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('IssueLog adapter modules and tracked artifacts are absent', () => {
  for (const relativePath of [
    'packages/workflow-engine/src/adapters/consumer/repository/documents/issues.ts',
    'packages/workflow-engine/src/adapters/consumer/repository/documents/issue-renderer.ts',
    'docs/issues/issues.yaml',
    'docs/ISSUE_LOG.md',
  ]) {
    assert.equal(
      fs.existsSync(path.join(sourceRepositoryRoot, relativePath)),
      false,
      `${relativePath} must be retired`,
    );
  }
});

function writeDocumentPolicy(
  repository: string,
  documents: Record<string, Record<string, string>>,
): void {
  fs.writeFileSync(
    path.join(repository, 'workflow/document-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        enforcementMode: 'enforced',
        documents,
      },
      null,
      2,
    )}\n`,
  );
}
