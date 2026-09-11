/** Permanent live-writer and package-source workflow namespace contracts. */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE } from '../src/modules/authority/authority-application-receipt.ts';
import { AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE } from '../src/modules/authority/authority-attestation.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/blind-survey-output.ts';
import {
  COLLABORATION_GRANT_POLICY,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import { HUMAN_REVOCATION_SIGNATURE_NAMESPACE } from '../src/modules/authority/human-revocation-contract.ts';
import { MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE } from '../src/modules/authority/maintainer-grant-v2-codec.ts';
import { ROLE_CONTEXT_SHARING_POLICY } from '../src/modules/authority/role-context-sharing-grant.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import { TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE } from '../src/modules/authority/task-revision-approval.ts';
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/task-strategy-implementation-output.ts';
import {
  repositoryRoot,
  ts,
  listRegularFiles,
} from './boundary-contract-fixture.ts';
import { scanWorkflowNamespaces } from './support/workflow-namespace-scan.ts';

test('workflow namespace scanner records folded namespaces and dynamic fragments', () => {
  const findings = scanWorkflowNamespaces(
    ts,
    'synthetic/namespaces.ts',
    [
      "const exact = 'expense-app.workflow.exact.v1';",
      "const folded = 'expense-app.workflow.' + 'folded.v1';",
      "const wrapped = ('expense-app.workflow.' as const) + 'wrapped.v1';",
      "const suffix = 'template.v1';",
      'const staticTemplate = `expense-app.workflow.${suffix}`;',
      'const dynamic = `expense-app.workflow.${kind}`;',
      "// const ignored = 'expense-app.workflow.comment.v1';",
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    findings.namespace.map((finding) => finding.normalizedValue).sort(),
    [
      'expense-app.workflow.',
      'expense-app.workflow.exact.v1',
      'expense-app.workflow.folded.v1',
      'expense-app.workflow.template.v1',
      'expense-app.workflow.wrapped.v1',
    ],
  );
});

test('every live workflow identity writer emits the neutral versioned namespace', () => {
  assert.deepEqual(
    {
      authorityApplicationReceipt:
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      authorityAttestation: AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
      blindSurvey: BLIND_SURVEY_OUTPUT_SCHEMA.id,
      collaborationPolicy: COLLABORATION_GRANT_POLICY.policyId,
      directHumanReview: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
      humanRevocation: HUMAN_REVOCATION_SIGNATURE_NAMESPACE,
      maintainerGrant: MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      roleContextSharingPolicy: ROLE_CONTEXT_SHARING_POLICY.policyId,
      taskDiffReview: TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id,
      taskDiffReviewContinuation:
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id,
      taskDiffReviewPolicy: TASK_DIFF_REVIEW_COLLABORATION_POLICY.policyId,
      taskRevisionApproval: TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
      taskStrategyImplementation: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.id,
    },
    {
      authorityApplicationReceipt: 'workflow.authority-application-receipt.v1',
      authorityAttestation: 'workflow.authority-attestation.v1',
      blindSurvey: 'workflow.blind-survey-output.v1',
      collaborationPolicy: 'workflow.collaboration-policy.v1',
      directHumanReview: 'workflow.direct-human-review.v1',
      humanRevocation: 'workflow.human-revocation.v1',
      maintainerGrant: 'workflow.maintainer-grant.v2',
      roleContextSharingPolicy: 'workflow.role-context-sharing-policy.v1',
      taskDiffReview: 'workflow.task-diff-review-output.v1',
      taskDiffReviewContinuation:
        'workflow.task-diff-review-continuation-output.v1',
      taskDiffReviewPolicy: 'workflow.collaboration-policy.task-diff-review.v1',
      taskRevisionApproval: 'workflow.task-revision-approval.v1',
      taskStrategyImplementation:
        'workflow.task-strategy-implementation-output.v1',
    },
  );
});

test('consumer-branded workflow identities are absent from package source', () => {
  const observed = new Map<string, string[]>();
  for (const packageEntry of fs.readdirSync(
    path.join(repositoryRoot, 'packages'),
    { withFileTypes: true },
  )) {
    if (!packageEntry.isDirectory()) continue;
    const sourceRoot = `packages/${packageEntry.name}/src`;
    if (
      !fs
        .statSync(path.join(repositoryRoot, sourceRoot), {
          throwIfNoEntry: false,
        })
        ?.isDirectory()
    ) {
      continue;
    }
    for (const file of listRegularFiles(repositoryRoot, sourceRoot)) {
      if (!/\.[cm]?[jt]s$/u.test(file)) continue;
      const findings = scanWorkflowNamespaces(
        ts,
        file,
        fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
        path.extname(file),
      ).namespace;
      if (findings.length > 0) {
        observed.set(
          file,
          findings.map(({ normalizedValue }) => normalizedValue).sort(),
        );
      }
    }
  }

  assert.deepEqual(
    Object.fromEntries(
      [...observed].sort(([left], [right]) => left.localeCompare(right)),
    ),
    {},
  );
});

test('workflow namespace folding respects lexical shadowing and cyclic const bindings', () => {
  const findings = scanWorkflowNamespaces(
    ts,
    'synthetic/namespace-scopes.ts',
    [
      "const brand = 'expense-app';",
      "const suffix = '.workflow.review.v1';",
      'const live = brand + suffix;',
      'function shadowed(brand: string) { return brand + suffix; }',
      "{ const brand = 'neutral'; const local = brand + suffix; }",
      'const first = second;',
      'const second = first;',
      'const cycle = first + suffix;',
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    findings.namespace.map(({ normalizedValue }) => normalizedValue),
    ['expense-app.workflow.review.v1'],
  );
});
