import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createImplementationReconciliationService,
  type ReconciliationContext,
  type ReconciliationReport,
} from '../src/application/reconciliation/implementation-reconciliation.ts';
import {
  buildImplementationReconciliationRequirement,
  canonicalChangedRanges,
  productionSourcePath,
  readCurrentRequirementPayload,
  type ImplementationReconciliationRequest,
  type ReconciledLedgerProjection,
} from '../src/modules/why-knowledge/implementation-reconciliation.ts';

function fixture() {
  const events: string[] = [];
  const baseline = { head: '1'.repeat(40), tree: '2'.repeat(40) };
  const requirement = buildImplementationReconciliationRequirement({
    changeId: 'change',
    baseline,
    intent: {
      summary: 'Preserve result.',
      explicitPaths: ['packages/example/src/a.ts'],
    },
    whyOverlays: [
      {
        pathIdentity: { utf8: 'packages/example/src/a.ts' },
        protectedInvariant: 'Result is deterministic.',
      },
    ],
  });
  const range = { path: 'packages/example/src/a.ts', startLine: 1, endLine: 2 };
  let targetDigest = '5'.repeat(64);
  let report: ReconciliationReport | undefined;
  let projected = false;
  let sessions = [
    { state: 'active', changeId: 'change', sessionId: 'session' },
  ];
  let context: ReconciliationContext = {
    session: {
      sessionId: 'session',
      changeId: 'change',
      taskId: 'task',
      baseline,
      investigationBaseline: baseline,
      completionStarted: false,
    },
    readRequirement: () => ({
      requirementId: 'implementation-reconciliation',
      requirementDigest: '3'.repeat(64),
      investigationManifestDigest: '4'.repeat(64),
      requirement,
    }),
    deriveTarget: () => {
      events.push('target');
      return {
        digest: targetDigest,
        changedRanges: [range],
        productionPaths: [range.path],
      };
    },
    deriveTermDelta: () => ({
      schemaVersion: 1,
      kind: 'implementation-term-delta',
      baselineCommit: baseline.head,
      implementationTree: baseline.tree,
      knownTermIds: [],
      newTerms: [],
      scanEvidenceDigest: '6'.repeat(64),
      affectedGroups: [],
    }),
    readReport: () => {
      events.push('read-report');
      assert.ok(report);
      return report;
    },
    assertLedgerProjection: (value) => {
      if (!projected) throw Error('changed ledger');
      return value as ReconciledLedgerProjection;
    },
    projectLedger: () => {
      events.push('project-ledger');
      projected = true;
      return {
        schemaVersion: 1,
        kind: 'reconciled-semantic-ledger-projection',
        paths: ['workflow/semantic-ledger/index.json'],
        entryIds: ['entry'],
        indexDigest: '7'.repeat(64),
      };
    },
    writeReport: (value) => {
      events.push('write-report');
      report = value;
      return 'report';
    },
    persistReport: (reportId, projection) => {
      events.push('persist-pointer');
      context = {
        ...context,
        session: {
          ...context.session,
          implementationReconciliationReportId: reportId,
          ...(projection === null
            ? {}
            : { implementationReconciliationPaths: projection.paths }),
        },
      };
    },
  };
  const service = createImplementationReconciliationService({
    listSessions: () => sessions,
    inspect: () => 'inspection',
    context: () => context,
    withSessionOperation: (_cwd, _sessionId, operation) => {
      events.push('lock');
      try {
        return operation();
      } finally {
        events.push('unlock');
      }
    },
  });
  function request(): ImplementationReconciliationRequest {
    return {
      ...service.inspectImplementationReconciliation('.', 'change'),
      actualMutations: [
        {
          subjectId: requirement.plannedMutations[0]!.subjectId,
          disposition: 'existing-subject-changed',
          whatChanged: 'Implementation adjusted.',
          whyChanged: 'Keep deterministic output.',
          preservedInvariants: ['Result is deterministic.'],
          removedInvariants: [],
          ranges: [range],
        },
      ],
    };
  }
  return {
    service,
    events,
    request,
    requirement,
    stale: () => {
      targetDigest = '8'.repeat(64);
    },
    corruptLedger: () => {
      projected = false;
    },
    changeContext: (
      fn: (value: ReconciliationContext) => ReconciliationContext,
    ) => {
      context = fn(context);
    },
    changeReport: (
      fn: (value: ReconciliationReport) => ReconciliationReport,
    ) => {
      assert.ok(report);
      report = fn(report);
    },
    duplicateSession: () => {
      sessions = [...sessions, { ...sessions[0]!, sessionId: 'other' }];
    },
  };
}

const fails = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

test('pure authoring and range selection reject duplicate WHY and unreviewed paths', () => {
  const f = fixture();
  assert.deepEqual(readCurrentRequirementPayload(f.requirement), f.requirement);
  assert.equal(productionSourcePath('packages/example/src/a.ts', null), true);
  assert.equal(productionSourcePath('packages/example/test/a.ts', null), false);
  assert.equal(
    productionSourcePath('workflow/semantic-ledger/index.json', null),
    false,
  );
  assert.throws(() =>
    canonicalChangedRanges([{ path: '../a.ts', startLine: 1, endLine: 2 }]),
  );
  assert.throws(
    () =>
      buildImplementationReconciliationRequirement({
        changeId: 'change',
        baseline: f.requirement.baseline,
        intent: { summary: 'Change.', explicitPaths: ['a.ts'] },
        whyOverlays: ['a.ts', 'a.ts'].map((utf8) => ({
          pathIdentity: { utf8 },
          protectedInvariant: 'Keep result.',
        })),
      }),
    fails('IMPLEMENTATION_RECONCILIATION_INVALID'),
  );
});

test('in-memory service records ledger then immutable report then pointer under the session lock; exact repeat is idempotent', () => {
  const f = fixture();
  const request = f.request();
  f.events.length = 0;
  const first = f.service.recordImplementationReconciliation(
    '.',
    'change',
    request,
  );
  assert.deepEqual(f.events, [
    'lock',
    'target',
    'project-ledger',
    'write-report',
    'persist-pointer',
    'unlock',
  ]);
  assert.equal(Object.isFrozen(first.request), true);
  f.events.length = 0;
  assert.deepEqual(
    f.service.recordImplementationReconciliation('.', 'change', request),
    first,
  );
  assert.deepEqual(f.events, ['lock', 'target', 'read-report', 'unlock']);
  assert.deepEqual(
    f.service.assertCurrentImplementationReconciliation('inspection'),
    first,
  );
});

test('caller-modified engine bindings are rejected before projection or report writes', () => {
  const f = fixture();
  const request = f.request();
  f.events.length = 0;
  assert.throws(
    () =>
      f.service.recordImplementationReconciliation('.', 'change', {
        ...request,
        requirementDigest: '0'.repeat(64),
      }),
    fails('IMPLEMENTATION_RECONCILIATION_STALE'),
  );
  assert.deepEqual(f.events, ['lock', 'target', 'unlock']);
});

test('range partition and preservation of each planning invariant remain mandatory', () => {
  for (const mutation of [
    (r: ImplementationReconciliationRequest) => ({
      ...r.actualMutations[0]!,
      ranges: [{ path: 'packages/example/src/b.ts', startLine: 1, endLine: 2 }],
    }),
    (r: ImplementationReconciliationRequest) => ({
      ...r.actualMutations[0]!,
      preservedInvariants: [],
    }),
  ]) {
    const f = fixture();
    const r = f.request();
    assert.throws(
      () =>
        f.service.recordImplementationReconciliation('.', 'change', {
          ...r,
          actualMutations: [mutation(r)],
        }),
      fails('IMPLEMENTATION_RECONCILIATION_INVALID'),
    );
    assert.equal(f.events.includes('write-report'), false);
  }
});

test('only one term-review round may be recorded', () => {
  const f = fixture();
  const r = f.request();
  f.service.recordImplementationReconciliation('.', 'change', r);
  assert.throws(
    () =>
      f.service.recordImplementationReconciliation('.', 'change', {
        ...r,
        actualMutations: [
          { ...r.actualMutations[0]!, whatChanged: 'A different explanation.' },
        ],
      }),
    fails('IMPLEMENTATION_TERM_ESCALATION_REQUIRED'),
  );
});

test('gate rejects changed target bytes, ledger evidence and report verdict', () => {
  for (const [change, code] of [
    [
      (f: ReturnType<typeof fixture>) => f.stale(),
      'IMPLEMENTATION_RECONCILIATION_STALE',
    ],
    [
      (f: ReturnType<typeof fixture>) => f.corruptLedger(),
      'IMPLEMENTATION_RECONCILIATION_STALE',
    ],
    [
      (f: ReturnType<typeof fixture>) =>
        f.changeReport((r) => ({
          ...r,
          verdict: { ...r.verdict, reconciled: false },
        })),
      'IMPLEMENTATION_RECONCILIATION_CORRUPT',
    ],
  ] as const) {
    const f = fixture();
    f.service.recordImplementationReconciliation('.', 'change', f.request());
    change(f);
    assert.throws(
      () => f.service.assertCurrentImplementationReconciliation('inspection'),
      fails(code),
    );
  }
});

test('gate requires exact session projection paths and governing generation', () => {
  const f = fixture();
  f.service.recordImplementationReconciliation('.', 'change', f.request());
  f.changeContext((c) => ({
    ...c,
    session: { ...c.session, implementationReconciliationPaths: [] },
  }));
  assert.throws(
    () => f.service.assertCurrentImplementationReconciliation('inspection'),
    fails('IMPLEMENTATION_RECONCILIATION_CORRUPT'),
  );
  const g = fixture();
  g.changeContext((c) => ({
    ...c,
    session: {
      ...c.session,
      investigationBaseline: { head: '9'.repeat(40), tree: '9'.repeat(40) },
    },
  }));
  assert.throws(
    () => g.request(),
    fails('IMPLEMENTATION_RECONCILIATION_INVALID'),
  );
});

test('missing reconciliation is rejected; explicitly inapplicable requirement skips the gate', () => {
  const f = fixture();
  assert.throws(
    () => f.service.assertCurrentImplementationReconciliation('inspection'),
    fails('IMPLEMENTATION_RECONCILIATION_REQUIRED'),
  );
  f.changeContext((c) => ({ ...c, readRequirement: () => null }));
  assert.equal(
    f.service.assertCurrentImplementationReconciliation('inspection'),
    null,
  );
  assert.throws(
    () => f.request(),
    fails('IMPLEMENTATION_RECONCILIATION_NOT_APPLICABLE'),
  );
});

test('ambiguous active sessions and late recording perform no writes', () => {
  const f = fixture();
  f.duplicateSession();
  assert.throws(
    () => f.request(),
    fails('IMPLEMENTATION_RECONCILIATION_SESSION_REQUIRED'),
  );
  const g = fixture();
  const r = g.request();
  g.changeContext((c) => ({
    ...c,
    session: { ...c.session, completionStarted: true },
  }));
  assert.throws(
    () => g.service.recordImplementationReconciliation('.', 'change', r),
    fails('IMPLEMENTATION_RECONCILIATION_TOO_LATE'),
  );
  assert.equal(g.events.includes('write-report'), false);
});
