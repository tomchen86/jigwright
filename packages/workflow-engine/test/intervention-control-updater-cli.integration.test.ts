import { controlPlanePromotionBootstrapObservations } from './control-plane-promotion-fixture.ts';
import { bootstrapInterventionStateRoot } from '../bootstrap/control-plane-trust.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { produceControlPlaneApprovalCandidateV3 } from '../src/application/control-plane/control-plane-promotion-producer.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import {
  canonicalControlPlaneGrantPayloadV3,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  controlPlaneCandidateDigest,
  controlPlaneIndependentReviewAttestationDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ControlPlaneTaskMandateBinding,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import {
  controlPlaneApprovalCandidatePath,
  executeControlPlanePromotion,
  initializeControlPlaneSupervisorState,
  persistControlPlaneApprovalCandidateV3,
  readControlPlaneSupervisorState,
  type ControlPlaneApprovalSummaryV3,
  type ControlPlaneTaskMandateValidationPhase,
  type ControlPlaneUpdaterAuditRecord,
} from '../src/application/control-plane/intervention-control-updater.ts';
import {
  controlPlaneUpdaterUsage,
  dispatchProductionControlPlaneUpdaterCommand,
} from '../src/entrypoints/cli/intervention-control-updater-cli.ts';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
  CONTROL_PLANE_FIXTURE_REVIEWER,
  controlPlaneFixtureUpdaterDependencies,
  setupControlPlaneProducerFixture,
} from './control-plane-promotion-fixture.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');
const CURRENT_NOW = new Date('2026-08-10T10:05:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function setupProductionCandidate() {
  const fixture = await setupControlPlaneProducerFixture();
  try {
    const reviewCalls = { present: 0, human: 0, sign: 0 };
    const produced = produceControlPlaneApprovalCandidateV3(
      fs.realpathSync(fixture.repository),
      fixture.stateRoot,
      fixture.frozen.candidateBundleDigest,
      {
        bootstrapObservations: controlPlanePromotionBootstrapObservations,
        candidateArtifacts: controlPlaneCandidateArtifacts,
        now: () => new Date('2026-08-10T10:03:00.000Z'),
        reviewSigner: fixture.signing.signer(
          CONTROL_PLANE_FIXTURE_REVIEWER,
          reviewCalls,
        ),
        verifyHumanSignature: fixture.signing.verifier,
        presentReviewSummary() {
          reviewCalls.present += 1;
        },
      },
    );
    return { ...fixture, produced, reviewCalls };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

type ProductionValue = Awaited<ReturnType<typeof setupProductionCandidate>>;

function productionApprovalArgv(value: ProductionValue): string[] {
  return [
    'approve-and-apply',
    value.produced.candidate.candidateId,
    '--task',
    value.frozen.mandateBinding.mandateTaskId,
  ];
}

function productionApprovalDependencies(
  value: ProductionValue,
  options: {
    tty?: boolean;
    signerIdentity?: string;
    grantSignature?: string;
    afterAtomicSwitch?: () => void;
    resolveMandate?: () => ControlPlaneTaskMandateBinding;
    revalidateMandate?: (
      binding: ControlPlaneTaskMandateBinding,
      phase: ControlPlaneTaskMandateValidationPhase,
      call: number,
    ) => void;
  } = {},
) {
  const audit: ControlPlaneUpdaterAuditRecord[] = [];
  const summaries: ControlPlaneApprovalSummaryV3[] = [];
  const signedPayloads: string[] = [];
  const signerCalls = { present: 0, identity: 0, sign: 0 };
  const providerCalls = { human: 0, sign: 0 };
  const mandateCalls = { resolve: 0, revalidate: 0 };
  const mandatePhases: ControlPlaneTaskMandateValidationPhase[] = [];
  const providerSigner = value.signing.signer(
    CONTROL_PLANE_FIXTURE_GRANT_SIGNER,
    providerCalls,
  );
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerCalls.present += 1;
      if (options.tty === false) {
        throw workflowError(
          'CONTROL_PLANE_APPROVAL_TTY_REQUIRED',
          'Control-plane approval requires a controlling terminal.',
          ExitCode.unsafeEnvironment,
        );
      }
      providerSigner.assertHumanPresent();
    },
    identity() {
      signerCalls.identity += 1;
      return options.signerIdentity ?? CONTROL_PLANE_FIXTURE_GRANT_SIGNER;
    },
    sign(payload: string, namespace?: string) {
      signerCalls.sign += 1;
      assert.equal(namespace, CONTROL_PLANE_SIGNATURE_NAMESPACE_V3);
      signedPayloads.push(payload);
      return options.grantSignature ?? providerSigner.sign(payload, namespace);
    },
    verify(payload, signature, identity, namespace) {
      return providerSigner.verify(payload, signature, identity, namespace);
    },
  };
  const baseDependencies = controlPlaneFixtureUpdaterDependencies(
    value.frozen,
    signer,
    value.signing.verifier,
    summaries,
    CURRENT_NOW,
  );
  const mandateBinding = structuredClone(
    value.produced.candidate.mandateBinding,
  );
  return {
    audit,
    summaries,
    signedPayloads,
    signerCalls,
    providerCalls,
    mandateCalls,
    mandatePhases,
    dependencies: {
      ...baseDependencies,
      auditSink: {
        append(record: ControlPlaneUpdaterAuditRecord) {
          const existing = audit.find(
            ({ recordId }) => recordId === record.recordId,
          );
          if (existing) assert.deepEqual(existing, record);
          else audit.push(record);
        },
      },
      resolveTaskMandateBinding(parentTaskId: string) {
        mandateCalls.resolve += 1;
        assert.equal(parentTaskId, mandateBinding.parentTaskId);
        return structuredClone(options.resolveMandate?.() ?? mandateBinding);
      },
      revalidateTaskMandateBinding(
        binding: ControlPlaneTaskMandateBinding,
        phase: ControlPlaneTaskMandateValidationPhase,
      ) {
        mandateCalls.revalidate += 1;
        mandatePhases.push(phase);
        baseDependencies.revalidateTaskMandateBinding(binding);
        options.revalidateMandate?.(binding, phase, mandateCalls.revalidate);
      },
      ...(options.afterAtomicSwitch
        ? { testHooks: { afterAtomicSwitch: options.afterAtomicSwitch } }
        : {}),
    },
  };
}

function snapshotTree(root: string): string {
  const entries: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stats = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        entries.push(`d ${relative} ${(stats.mode & 0o777).toString(8)}`);
        visit(absolute);
      } else {
        entries.push(
          `f ${relative} ${(stats.mode & 0o777).toString(8)} ${digest(
            fs.readFileSync(absolute),
          )}`,
        );
      }
    }
  }
  visit(root);
  return entries.join('\n');
}

test('control-plane dispatcher argv binds approval to task and recovery to durable state', () => {
  assert.equal(
    controlPlaneUpdaterUsage(),
    [
      'Usage: pnpm workflow control-plane <command> [--json]',
      '  control-plane approve-and-apply <candidate-id> --task <parent-task-id>',
      '  control-plane recover <grant-id>',
      '  control-plane status <grant-id>',
    ].join('\n'),
  );
  assert.equal(controlPlaneUpdaterUsage().includes('--audit-root'), false);
});

test('approve-and-apply derives the summary, signs exact bytes, promotes, and reports status', async () => {
  const value = await setupProductionCandidate();
  const candidate = value.produced.candidate;
  const approval = productionApprovalDependencies(value);
  try {
    const promoted = dispatchProductionControlPlaneUpdaterCommand(
      bootstrapInterventionStateRoot,
      productionApprovalArgv(value),
      value.stateRoot,
      approval.dependencies,
      fs.realpathSync(value.repository),
    );
    assert.equal(promoted.action, 'approve-and-apply');
    assert.equal(promoted.record?.kind, 'persisted-control-plane-update.v3');
    if (promoted.record?.kind !== 'persisted-control-plane-update.v3') {
      assert.fail(
        'Production approval must persist a current V3 update record.',
      );
    }
    assert.equal(promoted.record.transaction.state, 'FINALIZED');
    assert.equal(
      promoted.supervisor.activeArtifact.artifactId,
      value.candidateArtifact.artifactId,
    );
    assert.deepEqual(value.reviewCalls, { present: 1, human: 1, sign: 1 });
    assert.equal(approval.signerCalls.present, 1);
    assert.equal(approval.signerCalls.identity, 1);
    assert.equal(approval.signerCalls.sign, 1);
    assert.deepEqual(approval.providerCalls, { human: 1, sign: 1 });
    assert.equal(approval.mandateCalls.resolve, 1);
    assert.equal(approval.mandateCalls.revalidate > 1, true);
    assert.equal(approval.mandatePhases[0], 'approval-preflight');
    assert.equal(approval.mandatePhases.includes('before-atomic-switch'), true);
    assert.deepEqual(promoted.record.envelope.payload.mandateBinding, {
      ...candidate.mandateBinding,
    });
    assert.deepEqual(
      candidate.bundle.material.mandateBinding,
      candidate.mandateBinding,
    );
    assert.deepEqual(approval.signedPayloads, [
      canonicalControlPlaneGrantPayloadV3(promoted.record.envelope.payload),
    ]);
    assert.equal(approval.summaries.length, 1);
    assert.equal(approval.summaries[0]?.candidateId, candidate.candidateId);
    assert.deepEqual(
      approval.summaries[0]?.mandateBinding,
      candidate.mandateBinding,
    );
    assert.deepEqual(approval.summaries[0]?.affectedCapabilities, [
      'adoption.journal',
      'control-plane.update',
    ]);
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      /Independent reviewer approved the exact successor material, predecessor lineage, and recovery evidence\./,
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(candidate.bundle.material.recoveryBundle.bundleDigest),
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(candidate.mandateBinding.parentTaskId),
    );
    assert.match(
      approval.summaries[0]?.humanReadable ?? '',
      new RegExp(candidate.mandateBinding.externalAuditRoot),
    );
    assert.equal(approval.audit.length > 0, true);
    for (const record of approval.audit) {
      assert.deepEqual(record.mandateBinding, candidate.mandateBinding);
      assert.equal(record.parentTaskId, candidate.mandateBinding.parentTaskId);
      assert.equal(record.changeId, candidate.mandateBinding.changeId);
      assert.equal(
        record.externalAuditRoot,
        candidate.mandateBinding.externalAuditRoot,
      );
    }
    const status = dispatchProductionControlPlaneUpdaterCommand(
      bootstrapInterventionStateRoot,
      ['status', promoted.grantId],
      value.stateRoot,
      approval.dependencies,
      fs.realpathSync(value.repository),
    );
    assert.equal(status.action, 'status');
    assert.equal(status.record?.grantState, 'consumed');
    const mainCliStatus = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.resolve(
            import.meta.dirname,
            '../bootstrap/workflow-engine-host.ts',
          ),
          'control-plane',
          'status',
          promoted.grantId,
          '--json',
        ],
        { cwd: value.repository, encoding: 'utf8' },
      ),
    ) as {
      ok: boolean;
      result: { action: string; stateRoot: string };
    };
    assert.equal(mainCliStatus.ok, true);
    assert.equal(mainCliStatus.result.action, 'status');
    assert.equal(mainCliStatus.result.stateRoot, value.stateRoot);
  } finally {
    value.cleanup();
  }
});

test('candidate persistence requires the exact parent Task Mandate binding', async () => {
  const value = await setupProductionCandidate();
  try {
    const before = snapshotTree(value.stateRoot);
    assert.throws(
      () =>
        persistControlPlaneApprovalCandidateV3(
          value.stateRoot,
          {
            txId: 'cli-promotion-1',
            mandateBinding: {
              ...value.produced.candidate.mandateBinding,
              changeId: 'another-change',
            },
            beforeManifest: value.beforeManifest,
            afterManifest: value.produced.candidate.afterManifest,
            bundle: value.produced.candidate.bundle,
          },
          CURRENT_NOW,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
    );
    assert.equal(snapshotTree(value.stateRoot), before);
  } finally {
    value.cleanup();
  }
});

test('approval rejects cross-task, cross-root, revoked, and replaced mandates before switch', async (suite) => {
  await suite.test('cross-task argv', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value);
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            [
              'approve-and-apply',
              value.produced.candidate.candidateId,
              '--task',
              'another-task',
            ],
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_PARENT_TASK_MISMATCH',
      );
      assert.equal(approval.mandateCalls.resolve, 0);
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      value.cleanup();
    }
  });

  for (const field of ['changeId', 'externalAuditRoot'] as const) {
    await suite.test(`cross-${field}`, async () => {
      const value = await setupProductionCandidate();
      try {
        const approval = productionApprovalDependencies(value, {
          resolveMandate: () => ({
            ...value.produced.candidate.mandateBinding,
            [field]:
              field === 'changeId'
                ? 'another-change'
                : path.join(value.repository, 'another-audit-root'),
          }),
        });
        assert.throws(
          () =>
            dispatchProductionControlPlaneUpdaterCommand(
              bootstrapInterventionStateRoot,
              productionApprovalArgv(value),
              value.stateRoot,
              approval.dependencies,
              fs.realpathSync(value.repository),
            ),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === 'CONTROL_PLANE_TASK_MANDATE_BINDING_MISMATCH',
        );
        assert.equal(approval.signerCalls.present, 0);
      } finally {
        value.cleanup();
      }
    });
  }

  await suite.test('revoked before approval', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value, {
        resolveMandate: () => {
          throw workflowError(
            'TASK_MANDATE_REVOKED',
            'Parent Task Mandate is revoked.',
            ExitCode.staleState,
          );
        },
      });
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_MANDATE_REVOKED',
      );
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      value.cleanup();
    }
  });

  await suite.test('replaced immediately before atomic switch', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value, {
        revalidateMandate(_binding, phase) {
          if (phase === 'before-atomic-switch') {
            throw workflowError(
              'TASK_MANDATE_BINDING_STALE',
              'Parent Task Mandate was replaced.',
              ExitCode.staleState,
            );
          }
        },
      });
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'TASK_MANDATE_BINDING_STALE',
      );
      assert.equal(
        readControlPlaneSupervisorState(value.stateRoot).activeArtifact
          .artifactId,
        value.initialized.activeArtifact.artifactId,
      );
      assert.equal(approval.signerCalls.sign, 1);
      assert.equal(approval.summaries.length, 1);
      assert.equal(
        approval.mandatePhases.includes('before-atomic-switch'),
        true,
      );
    } finally {
      value.cleanup();
    }
  });
});

test('main CLI routes approve-and-apply through Task Mandate preflight', async () => {
  const value = await setupProductionCandidate();
  try {
    const before = snapshotTree(value.stateRoot);
    const invoked = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(
          import.meta.dirname,
          '../bootstrap/workflow-engine-host.ts',
        ),
        'control-plane',
        'approve-and-apply',
        value.produced.candidate.candidateId,
        '--task',
        value.frozen.mandateBinding.mandateTaskId,
        '--json',
      ],
      { cwd: value.repository, encoding: 'utf8' },
    );
    assert.notEqual(invoked.status, 0);
    const failure = JSON.parse(invoked.stderr) as { error: { code: string } };
    assert.equal(failure.error.code, 'TASK_MANDATE_NOT_FOUND');
    assert.equal(snapshotTree(value.stateRoot), before);
  } finally {
    value.cleanup();
  }
});

test('production updater rejects caller-supplied signed promotion request JSON without mutation', async () => {
  const value = await setupProductionCandidate();
  const approval = productionApprovalDependencies(value);
  try {
    const before = snapshotTree(value.stateRoot);
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          bootstrapInterventionStateRoot,
          ['promote', '--request', 'caller-request.json'],
          value.stateRoot,
          approval.dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_CALLER_SUPPLIED_REQUEST_DISABLED',
    );
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          bootstrapInterventionStateRoot,
          [
            'recover',
            'caller-grant',
            '--audit-root',
            value.produced.candidate.mandateBinding.externalAuditRoot,
          ],
          value.stateRoot,
          approval.dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'CONTROL_PLANE_CALLER_AUDIT_ROOT_DISABLED',
    );
    assert.equal(snapshotTree(value.stateRoot), before);
  } finally {
    value.cleanup();
  }
});

test('approval failures are read-only before the atomic switch', async (suite) => {
  await suite.test('missing controlling TTY', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value, { tty: false });
      const before = snapshotTree(value.stateRoot);
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_APPROVAL_TTY_REQUIRED',
      );
      assert.equal(snapshotTree(value.stateRoot), before);
      assert.equal(approval.signerCalls.sign, 0);
      assert.deepEqual(approval.summaries, []);
    } finally {
      value.cleanup();
    }
  });

  await suite.test('untrusted signer', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value, {
        signerIdentity: 'attacker@example.test',
      });
      const before = snapshotTree(value.stateRoot);
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      );
      assert.equal(snapshotTree(value.stateRoot), before);
    } finally {
      value.cleanup();
    }
  });

  await suite.test('candidate bytes drift', async () => {
    const value = await setupProductionCandidate();
    try {
      const target = controlPlaneApprovalCandidatePath(
        value.stateRoot,
        value.produced.candidate.candidateId,
      );
      const drifted = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<
        string,
        unknown
      >;
      drifted.txId = 'drifted';
      fs.writeFileSync(target, `${canonicalJson(drifted)}\n`, { mode: 0o600 });
      const approval = productionApprovalDependencies(value);
      const before = snapshotTree(value.stateRoot);
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT',
      );
      assert.equal(snapshotTree(value.stateRoot), before);
      assert.equal(approval.signerCalls.present, 0);
    } finally {
      value.cleanup();
    }
  });

  await suite.test('control-plane grant signature failure', async () => {
    const value = await setupProductionCandidate();
    try {
      const approval = productionApprovalDependencies(value, {
        grantSignature: 'invalid-control-plane-signature',
      });
      const before = snapshotTree(value.stateRoot);
      assert.throws(
        () =>
          dispatchProductionControlPlaneUpdaterCommand(
            bootstrapInterventionStateRoot,
            productionApprovalArgv(value),
            value.stateRoot,
            approval.dependencies,
            fs.realpathSync(value.repository),
          ),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'CONTROL_PLANE_GRANT_SIGNATURE_INVALID',
      );
      assert.equal(snapshotTree(value.stateRoot), before);
    } finally {
      value.cleanup();
    }
  });
});

test('approve-and-apply rolls back an unhealthy candidate and consumes the one-shot grant', async () => {
  const value = await setupProductionCandidate();
  try {
    const approval = productionApprovalDependencies(value, {
      afterAtomicSwitch() {
        const candidatePath = readControlPlaneSupervisorState(value.stateRoot)
          .activeArtifact.executablePath;
        fs.renameSync(candidatePath, `${candidatePath}.unavailable`);
      },
    });
    const result = dispatchProductionControlPlaneUpdaterCommand(
      bootstrapInterventionStateRoot,
      productionApprovalArgv(value),
      value.stateRoot,
      approval.dependencies,
      fs.realpathSync(value.repository),
    );
    assert.equal(result.record?.kind, 'persisted-control-plane-update.v3');
    assert.equal(result.record?.transaction.state, 'ROLLED_BACK');
    assert.equal(result.record?.grantState, 'consumed');
    assert.equal(
      result.supervisor.activeArtifact.artifactId,
      value.initialized.activeArtifact.artifactId,
    );
  } finally {
    value.cleanup();
  }
});

test('approve-and-apply replay is rejected without a second signature or mutation', async () => {
  const value = await setupProductionCandidate();
  try {
    const approval = productionApprovalDependencies(value);
    dispatchProductionControlPlaneUpdaterCommand(
      bootstrapInterventionStateRoot,
      productionApprovalArgv(value),
      value.stateRoot,
      approval.dependencies,
      fs.realpathSync(value.repository),
    );
    const before = snapshotTree(value.stateRoot);
    const signaturesBefore = approval.signerCalls.sign;
    assert.throws(
      () =>
        dispatchProductionControlPlaneUpdaterCommand(
          bootstrapInterventionStateRoot,
          productionApprovalArgv(value),
          value.stateRoot,
          approval.dependencies,
          fs.realpathSync(value.repository),
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code ===
          'INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED',
    );
    assert.equal(snapshotTree(value.stateRoot), before);
    assert.equal(approval.signerCalls.sign, signaturesBefore);
  } finally {
    value.cleanup();
  }
});

import { controlPlaneCandidateArtifacts } from './control-plane-promotion-fixture.ts';
