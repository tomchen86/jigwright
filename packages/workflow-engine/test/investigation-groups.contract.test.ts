import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { validateClosedEvidenceDag } from '../src/adapters/planning/investigation/evidence-currentness.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationGroupFacts,
  deriveInvestigationHitNodes,
  readInvestigationCoverageNode,
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
  readInvestigationHitNode,
  replayInvestigationGroupNodes,
  type DeclaredInvestigationRoot,
  type InvestigationGroupFacts,
  type ReviewedPathRelationship,
} from '../src/modules/investigation/domain/investigation-groups.ts';
import type { InvestigationScanFacts } from '../src/modules/investigation/domain/investigation-scanner.ts';
import { normalizeInvestigationTerm } from '../src/modules/investigation/domain/investigation-terms.ts';
import {
  MUTATION_CLASSES,
  classifyMutationPath,
  createMutationClassPolicy,
  type MutationClassPolicy,
} from '../src/modules/source/mutation-class-policy.ts';
import { isWorkflowError } from './fixture.ts';

const POLICY_DIGEST = '1'.repeat(64);
const TREE_DIGEST = '2'.repeat(64);

test('mutation classes remain explicit raw-path-safe grouping metadata', () => {
  const policy = mutationPolicy();
  const reordered = createMutationClassPolicy({
    rules: [...policy.rules].reverse(),
  });
  assert.equal(reordered.policyDigest, policy.policyDigest);
  assert.deepEqual(reordered.rules, policy.rules);
  assert.deepEqual(MUTATION_CLASSES, [
    'live',
    'prohibited',
    'generated',
    'mirror',
    'append-only',
    'immutable',
    'historical-reference',
  ]);

  for (const [filePath, expected] of [
    ['src/a.ts', 'live'],
    ['blocked/file.ts', 'prohibited'],
    ['generated/file.ts', 'generated'],
    ['mirror/file.ts', 'mirror'],
    ['CHANGELOG.md', 'append-only'],
    ['archive/file.md', 'immutable'],
    ['history/file.md', 'historical-reference'],
  ] as const) {
    assert.equal(
      classifyMutationPath(policy, pathIdentity(filePath)).mutationClass,
      expected,
    );
  }

  const rawPrefix = Buffer.concat([
    Buffer.from('blocked/'),
    Buffer.from([0xff]),
  ]);
  const rawPolicy = createMutationClassPolicy({
    rules: [
      ...policy.rules,
      {
        ruleId: 'raw-prohibited',
        mutationClass: 'prohibited',
        selector: {
          kind: 'raw-prefix',
          rawBase64: rawPrefix.toString('base64'),
        },
      },
    ],
  });
  assert.equal(
    classifyMutationPath(rawPolicy, {
      rawBase64: Buffer.concat([rawPrefix, Buffer.from('/secret.ts')]).toString(
        'base64',
      ),
      utf8: null,
    }).mutationClass,
    'prohibited',
  );

  const ambiguous = createMutationClassPolicy({
    rules: [
      ...policy.rules,
      {
        ruleId: 'overlapping-generated',
        mutationClass: 'generated',
        selector: { kind: 'path-prefix', path: 'blocked' },
      },
    ],
  });
  assert.throws(
    () => classifyMutationPath(ambiguous, pathIdentity('blocked/file.ts')),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );
  assert.throws(
    () =>
      classifyMutationPath(policy, {
        ...pathIdentity('src/a.ts'),
        utf8: 'src/spoofed.ts',
      }),
    (error) => isWorkflowError(error, 'MUTATION_CLASS_POLICY_INVALID'),
  );
});

test('current grouping facts are deterministic, conservative, and fail closed', () => {
  const context = groupingContext();
  const termA = investigationTerm('group-a');
  const termB = investigationTerm('group-b');
  const facts = scanFacts([
    {
      term: termA,
      hits: [
        hit('src/a.ts', 0),
        hit('src/b.ts', 1),
        hit('src/c.ts', 2),
        hit('blocked/file.ts', 3),
        hit('generated/file.ts', 4),
        hit('mirror/file.ts', 5),
        hit('CHANGELOG.md', 6),
        hit('archive/file.md', 7),
        hit('history/file.md', 8),
      ],
    },
    { term: termB, hits: [hit('src/a.ts', 0)] },
  ]);

  const grouped = deriveInvestigationGroupFacts({
    scanFacts: facts,
    ...context,
  });
  assert.equal(grouped.hits.length, 10);
  assert.equal(new Set(grouped.hits.map(({ hitKey }) => hitKey)).size, 10);
  assert.equal(
    grouped.hits.filter(({ path }) => path.utf8 === 'src/a.ts').length,
    2,
  );
  assert.deepEqual(
    [
      ...new Set(grouped.groups.map(({ selector }) => selector.mutationClass)),
    ].sort(),
    [...MUTATION_CLASSES].sort(),
  );
  const sharedLiveGroup = grouped.groups.find((group) =>
    group.hits.some(({ path }) => path.utf8 === 'src/b.ts'),
  );
  assert.ok(sharedLiveGroup);
  assert.deepEqual(sharedLiveGroup.hits.map(({ path }) => path.utf8).sort(), [
    'src/b.ts',
    'src/c.ts',
  ]);
  assert.equal(sharedLiveGroup.selector.rootId, 'source');
  assert.equal(sharedLiveGroup.selector.extension.utf8, '.ts');
  assert.equal(sharedLiveGroup.selector.relationshipId, null);

  const shuffled = deriveInvestigationGroupFacts({
    scanFacts: { ...facts, terms: [...facts.terms].reverse() },
    mutationPolicy: context.mutationPolicy,
    declaredRoots: [...context.declaredRoots].reverse(),
    reviewedRelationships: [...context.reviewedRelationships].reverse(),
  });
  assert.equal(canonicalJson(shuffled), canonicalJson(grouped));

  assert.throws(
    () =>
      deriveInvestigationGroupFacts({
        scanFacts: facts,
        ...context,
        declaredRoots: [
          ...context.declaredRoots,
          { rootId: 'duplicate-source', path: 'src' },
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  for (const reviewedRelationships of [
    [{ ...context.reviewedRelationships[0]!, kind: 'inferred' }],
    [{ ...context.reviewedRelationships[0]!, reference: '   ' }],
    [
      context.reviewedRelationships[0]!,
      reviewedRelationship(
        'generated-chain',
        'generated/file.ts',
        'generated/second.ts',
      ),
    ],
    [
      {
        ...context.reviewedRelationships[0]!,
        subjectPath: {
          ...context.reviewedRelationships[0]!.subjectPath,
          utf8: 'src/spoofed.ts',
        },
      },
    ],
  ]) {
    assert.throws(
      () =>
        deriveInvestigationGroupFacts({
          scanFacts: facts,
          mutationPolicy: context.mutationPolicy,
          declaredRoots: context.declaredRoots,
          reviewedRelationships,
        }),
      (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
    );
  }

  const collisionFacts = scanFacts([
    { term: termA, hits: [hit('src/a.ts', 0)] },
  ]);
  const relationshipCollisionA = deriveInvestigationGroupFacts({
    scanFacts: collisionFacts,
    mutationPolicy: context.mutationPolicy,
    declaredRoots: context.declaredRoots,
    reviewedRelationships: [
      reviewedRelationship('a+b', 'src/a.ts', 'generated/one.ts'),
      reviewedRelationship('c', 'src/a.ts', 'generated/two.ts'),
    ],
  });
  const relationshipCollisionB = deriveInvestigationGroupFacts({
    scanFacts: collisionFacts,
    mutationPolicy: context.mutationPolicy,
    declaredRoots: context.declaredRoots,
    reviewedRelationships: [
      reviewedRelationship('a', 'src/a.ts', 'generated/one.ts'),
      reviewedRelationship('b+c', 'src/a.ts', 'generated/two.ts'),
    ],
  });
  assert.notEqual(
    relationshipCollisionA.groups[0]?.selector.relationshipId,
    relationshipCollisionB.groups[0]?.selector.relationshipId,
  );

  assert.throws(
    () =>
      deriveInvestigationGroupFacts({
        scanFacts: scanFacts([{ term: termA, hits: [] }]),
        mutationPolicy: {
          policyDigest: context.mutationPolicy.policyDigest,
          rules: context.mutationPolicy.rules.map((rule) =>
            rule.ruleId === 'generated'
              ? { ...rule, mutationClass: 'prohibited' }
              : rule,
          ),
        },
        declaredRoots: context.declaredRoots,
        reviewedRelationships: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationGroupFacts({
        scanFacts: facts,
        ...context,
        reviewedRelationships: [
          ...context.reviewedRelationships,
          {
            relationshipId: 'ambiguous-mirror',
            kind: 'mirror',
            subjectPath: pathIdentity('src/b.ts'),
            counterpartPath: pathIdentity('mirror/file.ts'),
            reference: 'review:ambiguous',
          },
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () =>
      deriveInvestigationGroupFacts({
        scanFacts: scanFacts([
          {
            term: termA,
            hits: [
              hit('src/b.ts', 0, { objectId: 'a'.repeat(40) }),
              hit('src/c.ts', 1, {
                objectId: 'a'.repeat(40),
                contentSha256: 'b'.repeat(64),
              }),
            ],
          },
        ]),
        ...context,
        reviewedRelationships: [],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
});

test('zero-hit and unrelated terms preserve current grouping identities', () => {
  const context = groupingContext();
  const termA = investigationTerm('stable-a');
  const termB = investigationTerm('stable-b');
  const zero = investigationTerm('stable-zero');
  const first = deriveInvestigationGroupFacts({
    scanFacts: scanFacts([
      { term: termA, hits: [hit('src/a.ts', 0)] },
      { term: zero, hits: [] },
    ]),
    ...context,
  });
  assert.equal(
    first.hits.some(({ termId }) => termId === zero.termId),
    false,
  );
  assert.equal(
    first.groups.some(({ selector }) => selector.termId === zero.termId),
    false,
  );

  const expanded = deriveInvestigationGroupFacts({
    scanFacts: scanFacts([
      { term: termB, hits: [hit('generated/file.ts', 0)] },
      { term: zero, hits: [] },
      { term: termA, hits: [hit('src/a.ts', 0)] },
    ]),
    ...context,
  });
  assert.deepEqual(
    expanded.hits
      .filter(({ termId }) => termId === termA.termId)
      .map(({ hitKey }) => hitKey),
    first.hits.map(({ hitKey }) => hitKey),
  );
  assert.deepEqual(
    expanded.groups
      .filter(({ selector }) => selector.termId === termA.termId)
      .map(({ key }) => key),
    first.groups.map(({ key }) => key),
  );
});

test('historical replay primitives remain closed and truth-preserving', () => {
  const context = groupingContext();
  const term = investigationTerm('replay');
  const zero = investigationTerm('replay-zero');
  const hits = [hit('src/a.ts', 0), hit('src/b.ts', 1)];
  const facts = scanFacts([
    { term, hits },
    { term: zero, hits: [] },
  ]);
  const grouping = deriveInvestigationGroupFacts({
    scanFacts: facts,
    ...context,
  });
  const scanNodes = [scanNode(term.termId, hits), scanNode(zero.termId, [])];
  const hitNodes = deriveInvestigationHitNodes(scanNodes);
  const groupNodes = createHistoricalGroupFixtures(grouping, hitNodes);
  const dispositions = createInvestigationDispositionNodes({
    groupNodes,
    dispositions: groupNodes.map((node) => ({
      groupId: readInvestigationGroupNode(node).groupId,
      classification: 'load-bearing',
      rationale: 'The historical fixture remains load-bearing.',
      author: 'replay-test',
    })),
  });
  const inventory = inventoryNode();
  const coverage = createInvestigationCoverageNode({
    effectiveTermIds: [term.termId, zero.termId],
    scanNodes,
    inventoryNode: inventory,
    hitNodes,
    groupNodes,
    dispositionNodes: dispositions,
  });
  assert.deepEqual(readInvestigationCoverageNode(coverage).zeroHitTermIds, [
    zero.termId,
  ]);
  assert.equal(dispositions.length, groupNodes.length);
  for (const disposition of dispositions) {
    const output = readInvestigationDispositionNode(disposition);
    assert.ok(
      groupNodes.some(
        (node) => readInvestigationGroupNode(node).groupId === output.groupId,
      ),
    );
  }

  const records = groupNodes.map((node) => {
    const output = readInvestigationGroupNode(node);
    return {
      nodeId: node.nodeId,
      policyDigest: node.policyDigest,
      selector: output.selector,
      hitIds: output.hitIds,
      exceptions: output.exceptions,
    };
  });
  assert.deepEqual(
    replayInvestigationGroupNodes({ hitNodes, groups: records }).map(
      ({ nodeId }) => nodeId,
    ),
    groupNodes.map(({ nodeId }) => nodeId),
  );
  assert.throws(
    () =>
      replayInvestigationGroupNodes({
        hitNodes,
        groups: [
          { ...records[0]!, nodeId: 'f'.repeat(64) },
          ...records.slice(1),
        ],
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
  assert.throws(
    () =>
      replayInvestigationGroupNodes({
        hitNodes: hitNodes.slice(1),
        groups: records,
      }),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );

  const nodes = [
    ...scanNodes,
    inventory,
    ...hitNodes,
    ...groupNodes,
    ...dispositions,
    coverage,
  ];
  const forward = validateClosedEvidenceDag(nodes);
  const reverse = validateClosedEvidenceDag([...nodes].reverse());
  assert.deepEqual(reverse, forward);
  assert.equal(forward.topologicalNodeIds.at(-1), coverage.nodeId);
  assert.throws(
    () =>
      validateClosedEvidenceDag(
        nodes.filter(({ nodeId }) => nodeId !== hitNodes[0]!.nodeId),
      ),
    (error) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );

  const wrongTypedScan = createEvidenceNode({
    ...nodeInput(scanNodes[0]!),
    type: 'not-an-investigation-scan',
    output: scanNodes[0]!.output,
  });
  assert.throws(
    () => deriveInvestigationHitNodes([wrongTypedScan]),
    (error) => isWorkflowError(error, 'INVESTIGATION_GROUPS_INVALID'),
  );
});

function mutationPolicy(): MutationClassPolicy {
  return createMutationClassPolicy({
    rules: [
      {
        ruleId: 'prohibited',
        mutationClass: 'prohibited',
        selector: { kind: 'path-prefix', path: 'blocked' },
      },
      {
        ruleId: 'generated',
        mutationClass: 'generated',
        selector: { kind: 'path-prefix', path: 'generated' },
      },
      {
        ruleId: 'mirror',
        mutationClass: 'mirror',
        selector: { kind: 'path-prefix', path: 'mirror' },
      },
      {
        ruleId: 'append-only',
        mutationClass: 'append-only',
        selector: { kind: 'exact-path', path: 'CHANGELOG.md' },
      },
      {
        ruleId: 'immutable',
        mutationClass: 'immutable',
        selector: { kind: 'path-prefix', path: 'archive' },
      },
      {
        ruleId: 'historical',
        mutationClass: 'historical-reference',
        selector: { kind: 'path-prefix', path: 'history' },
      },
    ],
  });
}

function groupingContext(): {
  mutationPolicy: MutationClassPolicy;
  declaredRoots: DeclaredInvestigationRoot[];
  reviewedRelationships: ReviewedPathRelationship[];
} {
  return {
    mutationPolicy: mutationPolicy(),
    declaredRoots: [
      { rootId: 'repository', path: '' },
      { rootId: 'source', path: 'src' },
      { rootId: 'blocked', path: 'blocked' },
      { rootId: 'generated', path: 'generated' },
      { rootId: 'mirror', path: 'mirror' },
      { rootId: 'archive', path: 'archive' },
      { rootId: 'history', path: 'history' },
    ],
    reviewedRelationships: [
      {
        relationshipId: 'generated-source',
        kind: 'generated',
        subjectPath: pathIdentity('src/a.ts'),
        counterpartPath: pathIdentity('generated/file.ts'),
        reference: 'review:generated-source',
      },
      {
        relationshipId: 'mirror-source',
        kind: 'mirror',
        subjectPath: pathIdentity('src/a.ts'),
        counterpartPath: pathIdentity('mirror/file.ts'),
        reference: 'review:mirror-source',
      },
    ],
  };
}

function reviewedRelationship(
  relationshipId: string,
  subjectPath: string,
  counterpartPath: string,
): ReviewedPathRelationship {
  return {
    relationshipId,
    kind: 'generated',
    subjectPath: pathIdentity(subjectPath),
    counterpartPath: pathIdentity(counterpartPath),
    reference: `review:${relationshipId}`,
  };
}

function investigationTerm(value: string) {
  return {
    ...normalizeInvestigationTerm({ kind: 'literal-content', value }),
    provenance: [
      {
        source: 'main' as const,
        reference: `main:${value}`,
        rationale: `Investigate ${value}.`,
        expectedRelationship: `${value} may identify a current consumer.`,
      },
    ],
  };
}

function scanFacts(
  terms: Array<{
    term: ReturnType<typeof investigationTerm>;
    hits: Array<ReturnType<typeof hit>>;
  }>,
): InvestigationScanFacts {
  return {
    schemaVersion: 1,
    kind: 'investigation-scan-facts',
    treeDigest: TREE_DIGEST,
    policyDigest: POLICY_DIGEST,
    inventory: { treeDigest: TREE_DIGEST, skippedObjects: [] },
    terms,
  };
}

function createHistoricalGroupFixtures(
  grouping: InvestigationGroupFacts,
  hitNodes: EvidenceNode[],
): EvidenceNode[] {
  return grouping.groups
    .map((group) => {
      const expected = new Set(
        group.hits.map(({ hitKey: _hitKey, ...value }) => canonicalJson(value)),
      );
      const members = hitNodes
        .filter((node) => {
          const { hitId: _hitId, ...value } = readInvestigationHitNode(node);
          return expected.has(canonicalJson(value));
        })
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      assert.equal(members.length, group.hits.length);
      const provenanceParentNodeIds: Record<string, string> = {};
      const semanticParentResultDigests: Record<string, string> = {};
      members.forEach((member, index) => {
        provenanceParentNodeIds[`hit-${index}`] = member.nodeId;
        semanticParentResultDigests[`hit-${index}`] = member.resultDigest;
      });
      const selector = { selectorId: group.key, ...group.selector };
      return createEvidenceNode({
        type: 'investigation-group',
        nodeSchema: 'investigation.group.v1',
        evaluator: 'investigation-groups.v1',
        policyDigest: grouping.groupingPolicyDigest,
        exactInputDigests: {
          exceptions: sha256(
            canonicalJson({
              schema: 'investigation.group-exceptions.v1',
              exceptions: [],
            }),
          ),
          selector: group.key,
        },
        semanticParentResultDigests,
        provenanceParentNodeIds,
        outputSchema: 'investigation.group-output.v1',
        output: {
          groupId: group.key,
          selector,
          hitIds: members.map(({ nodeId }) => nodeId),
          hits: members.map(readInvestigationHitNode),
          sourceObjects: group.sourceObjects,
          exceptions: [],
        },
        runtimeMetadata: {},
      });
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function scanNode(
  termId: string,
  hits: Array<ReturnType<typeof hit>>,
): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-term-scan',
    nodeSchema: 'investigation.term-scan.v1',
    evaluator: 'investigation-scanner.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: { term: sha256(`term:${termId}`), tree: TREE_DIGEST },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.term-scan-output.v1',
    output: { termId, hits },
    runtimeMetadata: {},
  });
}

function inventoryNode(): EvidenceNode {
  return createEvidenceNode({
    type: 'investigation-tree-inventory',
    nodeSchema: 'investigation.tree-inventory.v1',
    evaluator: 'investigation-scanner.v1',
    policyDigest: POLICY_DIGEST,
    exactInputDigests: { tree: TREE_DIGEST },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'investigation.tree-inventory-output.v1',
    output: { skippedObjects: [] },
    runtimeMetadata: {},
  });
}

function hit(
  filePath: string,
  byteOffset: number,
  override: { objectId?: string; contentSha256?: string } = {},
) {
  return {
    path: pathIdentity(filePath),
    sourceObject: {
      objectId: override.objectId ?? sha1(`object:${filePath}`),
      objectType: 'blob',
      mode: '100644',
      byteSize: 128,
      contentSha256: override.contentSha256 ?? sha256(`content:${filePath}`),
      skipReason: null,
    },
    surface: 'content' as const,
    byteOffset,
    byteLength: 6,
  };
}

function pathIdentity(filePath: string): {
  rawBase64: string;
  utf8: string;
} {
  return {
    rawBase64: Buffer.from(filePath, 'utf8').toString('base64'),
    utf8: filePath,
  };
}

function nodeInput(node: EvidenceNode) {
  return {
    type: node.type,
    nodeSchema: node.nodeSchema,
    evaluator: node.evaluator,
    policyDigest: node.policyDigest,
    exactInputDigests: node.exactInputDigests,
    semanticParentResultDigests: node.semanticParentResultDigests,
    provenanceParentNodeIds: node.provenanceParentNodeIds,
    outputSchema: node.outputSchema,
    runtimeMetadata: node.runtimeMetadata,
  };
}

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
