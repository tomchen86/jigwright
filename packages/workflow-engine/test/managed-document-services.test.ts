import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HandoffDocumentOperations } from '../src/modules/projection/handoff.ts';
import { createManagedDocumentServices } from '../src/runtime/managed-documents/validation/managed-documents.ts';

const handoffPath = 'docs/CURRENT_AND_NEXT_STEPS.md';
const policy = JSON.stringify({
  schemaVersion: 1,
  enforcementMode: 'active',
  documents: {
    [handoffPath]: {
      mode: 'generated',
      enforcement: 'active',
      transition: 'completion',
    },
  },
});
function forbidden(): never {
  throw new Error('unexpected handoff operation');
}
function operations(
  overrides: Partial<HandoffDocumentOperations>,
): HandoffDocumentOperations {
  return {
    projectHandoff: forbidden,
    projectHandoffForTaskProjection: forbidden,
    renderHandoffForChange: forbidden,
    validateHandoff: forbidden,
    ...overrides,
  };
}

test('managed validation consumes each supplied snapshot and propagates handoff failure unchanged', () => {
  const reads: string[] = [];
  const contracts = [{ changeId: 'demo', tasks: [] }];
  const readText = (file: string) => {
    reads.push(file);
    return policy;
  };
  const failure = new Error('current handoff changed');
  let validations = 0;
  const documents = createManagedDocumentServices(
    operations({
      validateHandoff(root, context) {
        assert.equal(root, '/not-a-checkout');
        assert.equal(context?.contracts, contracts);
        assert.equal(context?.readText, readText);
        if (++validations === 2) throw failure;
      },
    }),
  );
  assert.equal(validations, 0);
  assert.deepEqual(reads, []);
  assert.deepEqual(
    documents.validateManagedDocuments('/not-a-checkout', {
      contracts,
      readText,
    }),
    [handoffPath],
  );
  assert.throws(
    () =>
      documents.validateManagedDocuments('/not-a-checkout', {
        contracts,
        readText,
      }),
    (error) => error === failure,
  );
  assert.deepEqual(reads, [
    'workflow/document-policy.json',
    'workflow/document-policy.json',
  ]);
  assert.equal(validations, 2);
});

test('completion projection observes each call, distinguishes prospective tasks and applies only on refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-documents-'));
  try {
    fs.mkdirSync(path.join(root, 'workflow'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'workflow/document-policy.json'), policy);
    const file = path.join(root, handoffPath);
    fs.writeFileSync(file, 'before');
    let generation = 0;
    const documents = createManagedDocumentServices(
      operations({
        projectHandoff(observedRoot) {
          assert.equal(observedRoot, root);
          return `current-${++generation}`;
        },
        projectHandoffForTaskProjection(observedRoot, changeId, tasks) {
          assert.equal(observedRoot, root);
          assert.equal(changeId, 'demo');
          return tasks;
        },
      }),
    );
    assert.deepEqual(documents.planCompletionDocuments(root), [
      { path: handoffPath, before: 'before', after: 'current-1' },
    ]);
    assert.deepEqual(
      documents.planCompletionDocuments(root, {
        changeId: 'demo',
        tasks: 'projected',
      }),
      [{ path: handoffPath, before: 'before', after: 'projected' }],
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'before');
    assert.deepEqual(documents.refreshCompletionDocuments(root), [
      { path: handoffPath, before: 'before', after: 'current-2' },
    ]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'current-2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planning refresh supplies the explicit change and accepts the renderer already applying its exact result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-planning-'));
  try {
    fs.mkdirSync(path.join(root, 'workflow'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'workflow/document-policy.json'), policy);
    const file = path.join(root, handoffPath);
    fs.writeFileSync(file, 'before');
    const documents = createManagedDocumentServices(
      operations({
        renderHandoffForChange(observedRoot, changeId) {
          assert.equal(observedRoot, root);
          assert.equal(changeId, 'chosen-change');
          fs.writeFileSync(file, 'rendered');
          return 'rendered';
        },
      }),
    );
    assert.deepEqual(
      documents.refreshPlanningDocuments(root, 'chosen-change', undefined),
      [{ path: handoffPath, before: 'before', after: 'rendered' }],
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'rendered');
    assert.deepEqual(
      documents.refreshPlanningDocuments(root, 'chosen-change', undefined),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
