import {
  parseDispositions,
  SYSTEM_DOCUMENT_DISPOSITION_TRANSITION,
} from '../src/modules/source/document-disposition.ts';
import { matchesSystemDocumentGrantReceipt } from '../src/modules/authority/system-document-disposition.ts';
import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
} from '../src/modules/authority/grant-core.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  NOW,
  CHALLENGE_ID,
  OPERATION_ID,
  digest,
} from './grant-coordinator-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectSystemDocumentObligations,
  assessSystemDocumentDispositions,
} from '../src/modules/source/document-disposition.ts';
import type { SystemDescriptionSnapshot } from '../src/modules/source/spec-ownership.ts';
import { specDeltaChangesContract } from '@jigwright/openspec-adapter/archive-projection';

function snapshot(files: Record<string, string>): SystemDescriptionSnapshot {
  return {
    listPaths: () => Object.keys(files),
    readText: (file) => files[file],
  };
}

function managedReadme(text: string): string {
  return `<!-- jigwright:module-why -->\n${text}\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n`;
}

test('a module without a README does not acquire an unrelated ancestor README obligation', () => {
  const tree = snapshot({
    'README.md': 'Repository overview',
    'src/modules/a/spec.md': 'Module contract',
    'src/modules/a/README.md':
      'Ordinary README without a handwritten why section.',
    'src/modules/a/code.ts': 'code',
  });
  assert.deepEqual(
    collectSystemDocumentObligations(tree, tree, [
      'src/modules/a/code.ts',
      'src/modules/a/README.md',
    ]).map(({ path }) => path),
    ['src/modules/a/spec.md'],
  );
});

test('containment asks both inherited contracts across a module move and document deletion', () => {
  const before = snapshot({
    'src/spec.md': 'Parent',
    'src/modules/a/spec.md': 'A',
    'src/modules/a/README.md': managedReadme('Why A'),
    'src/modules/a/code.ts': 'code',
  });
  const after = snapshot({
    'src/spec.md': 'Parent',
    'src/modules/b/README.md': managedReadme('Why B'),
    'src/modules/b/code.ts': 'code',
  });
  const obligations = collectSystemDocumentObligations(before, after, [
    'src/modules/a/code.ts',
    'src/modules/b/code.ts',
    'src/modules/a/spec.md',
  ]);
  assert.deepEqual(
    obligations.map(({ path }) => path),
    [
      'src/modules/a/README.md',
      'src/modules/a/spec.md',
      'src/modules/b/README.md',
      'src/spec.md',
    ],
  );
  assert.ok(
    obligations.find(({ path }) => path === 'src/modules/a/spec.md')
      ?.afterDigest === null,
  );
});

test('document dispositions distinguish confirmation, actual updates, and explicit later work', () => {
  const before = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': managedReadme('Why'),
    'src/a.ts': 'before',
  });
  const after = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': managedReadme('Updated why'),
    'src/a.ts': 'after',
  });
  const obligations = collectSystemDocumentObligations(before, after, [
    'src/a.ts',
  ]);
  assert.equal(
    assessSystemDocumentDispositions(obligations, []).missing.length,
    2,
  );
  assert.deepEqual(
    assessSystemDocumentDispositions(obligations, [
      { path: 'src/spec.md', disposition: 'still-valid' },
      { path: 'src/README.md', disposition: 'updated' },
    ]),
    { missing: [], invalid: [] },
  );
  assert.equal(
    assessSystemDocumentDispositions(obligations, [
      { path: 'src/spec.md', disposition: 'updated' },
    ]).invalid.length,
    1,
  );
  assert.equal(
    assessSystemDocumentDispositions(obligations, [
      { path: 'src/spec.md', disposition: 'later' },
    ]).invalid.length,
    1,
  );
  assert.equal(
    assessSystemDocumentDispositions(obligations, [
      { path: 'src/spec.md', disposition: 'later', reason: 'Follow up' },
    ]).invalid.length,
    0,
  );
  assert.equal(
    assessSystemDocumentDispositions(obligations, [
      {
        path: 'src/spec.md',
        disposition: 'later',
        reason: 'Follow up',
        followUpRef: `FND-${'a'.repeat(64)}`,
      },
    ]).invalid.length,
    0,
  );
});

test('README generated text and confirmation alone do not count as a why update', () => {
  const readme = (why: string, commit: string, generated: string) =>
    `# Module\n<!-- jigwright:module-why -->\n${why}\nConfirmed at commit: \`${commit.repeat(40)}\`\n<!-- /jigwright:module-why -->\n${generated}\n`;
  const before = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': readme('Original reason.', 'a', 'Old files'),
  });
  const after = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': readme('Original reason.', 'b', 'New files'),
  });
  const documents = collectSystemDocumentObligations(before, after, [
    'src/README.md',
  ]);
  const readmeDocument = documents.find(({ kind }) => kind === 'readme')!;
  assert.notEqual(readmeDocument.beforeDigest, readmeDocument.afterDigest);
  assert.equal(readmeDocument.contentChanged, false);
  assert.equal(
    assessSystemDocumentDispositions(
      [readmeDocument],
      [{ path: 'src/README.md', disposition: 'updated' }],
    ).invalid.length,
    1,
  );
  const updated = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': readme('Revised reason.', 'b', 'New files'),
  });
  assert.equal(
    collectSystemDocumentObligations(before, updated, ['src/README.md']).find(
      ({ kind }) => kind === 'readme',
    )!.contentChanged,
    true,
  );
  const malformed = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': '<!-- jigwright:module-why -->\nMissing closing marker',
  });
  assert.equal(
    collectSystemDocumentObligations(before, malformed, ['src/README.md']).find(
      ({ kind }) => kind === 'readme',
    )!.contentChanged,
    false,
  );
});

test('a planned delta must change a real contract and is distinct from an empty or identical delta', () => {
  const requirement =
    '### Requirement: Existing\nThe system SHALL keep the behavior.\n';
  const base = `# Contract\n## Requirements\n${requirement}`;
  assert.equal(
    specDeltaChangesContract(
      'demo',
      base,
      `## MODIFIED Requirements\n${requirement}`,
    ),
    false,
  );
  assert.equal(
    specDeltaChangesContract(
      'demo',
      base,
      `## MODIFIED Requirements\n${requirement.replace('keep', 'update')}`,
    ),
    true,
  );
  assert.equal(
    specDeltaChangesContract(
      'demo',
      base,
      '## REMOVED Requirements\n### Requirement: Existing\n',
    ),
    true,
  );
  assert.throws(() =>
    specDeltaChangesContract('demo', base, '## MODIFIED Requirements\n'),
  );
  assert.throws(() =>
    specDeltaChangesContract(
      'demo',
      base,
      '## REMOVED Requirements\n### Requirement: Missing\n',
    ),
  );
});

test('a removed or unreadable handwritten explanation cannot be confirmed as still valid', () => {
  const before = snapshot({
    'src/spec.md': 'Contract',
    'src/README.md': managedReadme('Keep the design reason.'),
    'src/a.ts': 'before',
  });
  for (const current of [
    '# Module\nGenerated file table only.\n',
    '<!-- jigwright:module-why -->\nMissing closing marker',
  ]) {
    const after = snapshot({
      'src/spec.md': 'Contract',
      'src/README.md': current,
      'src/a.ts': 'after',
    });
    const documents = collectSystemDocumentObligations(before, after, [
      'src/a.ts',
      'src/README.md',
    ]).filter(({ kind }) => kind === 'readme');
    assert.equal(documents.length, 1);
    assert.equal(
      assessSystemDocumentDispositions(documents, [
        { path: 'src/README.md', disposition: 'still-valid' },
      ]).invalid.length,
      1,
    );
    assert.deepEqual(
      assessSystemDocumentDispositions(documents, [
        {
          path: 'src/README.md',
          disposition: 'later',
          reason: 'Restore the explanation in the follow-up.',
        },
      ]),
      { missing: [], invalid: [] },
    );
  }
});

test('disposition parser preserves entries while rejecting malformed decisions', () => {
  const entry = { path: 'src/spec.md', disposition: 'still-valid' as const };
  const input = [entry];
  const parsed = parseDispositions(input);
  assert.notEqual(parsed, input);
  assert.equal(parsed[0], entry);
  for (const value of [
    null,
    [{}],
    [{ ...entry, extra: true }],
    [{ ...entry, reason: ' ' }],
    [{ ...entry, disposition: 'approved' }],
  ]) {
    assert.throws(() => parseDispositions(value), {
      code: 'SYSTEM_DOCUMENT_REVIEW_INVALID',
    });
  }
});

test('completed document Grant receipt matches candidate, operation, approval and report exactly', () => {
  const parameters = { candidateDigest: digest('a') };
  const stateBinding = {
    kind: 'system-document-candidate.v1',
    digest: digest('b'),
  };
  const registry = createTransitionRegistry([
    {
      transitionId: SYSTEM_DOCUMENT_DISPOSITION_TRANSITION,
      parameterSchemaDigest: digest('c'),
      consequenceDigest: digest('d'),
      resolutionKind: 'non-retry',
      allowedApprovalMethods: ['human-presence'],
      validateParameters(value) {
        assert.deepEqual(value, parameters);
        return parameters;
      },
      renderTrustedChoice() {
        return {
          title: 'Defer exact documents',
          consequences: ['Record skipped-by-grant.'],
        };
      },
      observeState() {
        return stateBinding;
      },
      async execute() {
        return { outcome: 'completed', details: { reportId: 'report' } };
      },
    },
  ]);
  const challenge = createGrantChallenge(
    {
      sourceModuleId: 'system-documents',
      failureCode: 'system-documents.disposition-required',
      facts: {},
      stateBinding,
      candidates: [
        {
          transitionId: SYSTEM_DOCUMENT_DISPOSITION_TRANSITION,
          parameters,
          allowedReasonCodes: ['defer-documents'],
          reasonRequired: true,
          proposedReason: 'Defer these exact documents.',
        },
      ],
    },
    registry,
    {
      challengeId: CHALLENGE_ID,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    },
  );
  const approvalSubject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: 'defer-documents',
      reason: 'Defer these exact documents.',
      sessionNonce: 'n'.repeat(32),
    },
    { now: NOW },
  );
  const record: Parameters<typeof matchesSystemDocumentGrantReceipt>[0] = {
    challenge,
    operationId: OPERATION_ID,
    approvalSubject,
    outcome: { outcome: 'completed', details: { reportId: 'report' } },
  };
  const binding = {
    challengeId: CHALLENGE_ID,
    operationId: OPERATION_ID,
    approvalSubjectDigest: approvalSubjectDigest(approvalSubject),
  };
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      record,
      'report',
      parameters.candidateDigest,
      binding,
    ),
    true,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      record,
      'other-report',
      parameters.candidateDigest,
      binding,
    ),
    false,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(record, 'report', digest('e'), binding),
    false,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      record,
      'report',
      parameters.candidateDigest,
      { ...binding, operationId: 'other-operation' },
    ),
    false,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      record,
      'report',
      parameters.candidateDigest,
      { ...binding, approvalSubjectDigest: digest('f') },
    ),
    false,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      {
        ...record,
        outcome: { outcome: 'failed', details: record.outcome.details },
      },
      'report',
      parameters.candidateDigest,
      binding,
    ),
    false,
  );
  assert.equal(
    matchesSystemDocumentGrantReceipt(
      {
        ...record,
        challenge: { ...challenge, choices: [] },
        get operationId(): string {
          return assert.fail('later receipt field was read');
        },
      },
      'report',
      parameters.candidateDigest,
      binding,
    ),
    false,
  );
});
