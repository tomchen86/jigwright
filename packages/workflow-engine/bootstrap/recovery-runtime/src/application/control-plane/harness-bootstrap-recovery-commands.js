import { recoveryAuthorityStateRoot, hasRecoveryOperationalTrustRootFence, isExactAbsolutePath, readExternalRecoveryExpectations, readExternalRecoveryInput, ensureRecoveryAuthorityStateRoot, requireRecoveryAuthorityStateRoot, readExternalRecoveryTrustRootAuditRoot, readExternalRecoveryEnvelope, assertPrivateRecoveryDirectory, } from "./harness-bootstrap-external-input.js";
import { workflowError, ExitCode, } from "../../foundation/errors/errors.js";
import fs from 'node:fs';
import { throwControlPlaneRecoveryAlreadyConsumed } from "../../modules/authority/control-plane-recovery-grant.js";
import { canonicalControlPlaneRecoveryGrantPayload } from "../../modules/authority/control-plane-recovery-grant-records.js";
import { HARNESS_RECOVERY_SIGNATURE_NAMESPACE } from "../../modules/authority/control-plane-recovery-grant-values.js";
import { preflightControlPlaneRecoveryRollback, executeControlPlaneRecoveryRollback, } from "./intervention-control-updater.js";
export function createHarnessBootstrapRecoveryCommands(bindings) {
    const { discoverRepository, bootstrapInterventionStateRoot, bootstrapInterventionUsage, importRecoveryAuthorityDescriptor, readRecoveryAuthorityDescriptor, verifyRecoveryAuthorityDescriptor, executeRecoveryOperationalTrustRootRestore, executeRecoveryQuarantineEnter, executeRecoveryQuarantineRelease, readRecoveryQuarantineMarker, recoveryOperationalTrustRootDependencies, recoveryQuarantineDependencies, createHarnessRecoveryDependencies, } = bindings;
    function isRecoveryAuthorityCommand(args) {
        return args[0] === 'recovery-authority';
    }
    function isRecoveryQuarantineCommand(args) {
        return args[0] === 'recovery-quarantine';
    }
    function isControlPlaneRecoveryCommand(args) {
        return args[0] === 'control-plane';
    }
    function assertHarnessRecoveryQuarantineRouting(args, cwd, observeRefusalAuthority) {
        let repository;
        try {
            repository = discoverRepository(cwd);
        }
        catch (error) {
            if (args.length === 0 ||
                args[0] === '--help' ||
                args[0] === '-h' ||
                args[0] === 'help') {
                return;
            }
            throw error;
        }
        const marker = readOptionalRecoveryQuarantineMarker(recoveryAuthorityStateRoot(repository.gitCommonDirectory));
        if (marker !== null) {
            observeRefusalAuthority({
                repositoryRoot: repository.repositoryRealPath,
                marker,
            });
        }
        const operationalTrustFence = hasRecoveryOperationalTrustRootFence(recoveryAuthorityStateRoot(repository.gitCommonDirectory));
        if (marker !== null) {
            if (isExactControlPlaneRollback(args) ||
                isExactRecoveryQuarantineCommand(args, 'release') ||
                isExactRecoveryAuthorityRestoreCommand(args)) {
                return;
            }
            throw workflowError('WORKFLOW_RECOVERY_QUARANTINED', 'Only exact sealed Recovery Quarantine release, trust-root restore, or control-plane rollback is available while quarantine is active.', ExitCode.guard);
        }
        if (operationalTrustFence) {
            if (isExactRecoveryQuarantineCommand(args, 'enter'))
                return;
            throw workflowError('RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED', 'A restored operational trust root exists without an out-of-band pinned activation channel; only exact Recovery Quarantine entry remains available.', ExitCode.guard);
        }
    }
    function dispatchRecoveryAuthorityCommand(args, cwd, overrides) {
        const repository = discoverRepository(cwd);
        const boundary = recoveryImportBoundary(repository);
        if (args.length === 5 &&
            args[0] === 'recovery-authority' &&
            args[1] === 'import' &&
            isExactAbsolutePath(args[2]) &&
            args[3] === '--expectations' &&
            isExactAbsolutePath(args[4])) {
            const expectations = readExternalRecoveryExpectations(args[4], boundary);
            const descriptor = verifyRecoveryAuthorityDescriptor(readExternalRecoveryInput(args[2], boundary), expectations);
            const stateRoot = ensureRecoveryAuthorityStateRoot(repository.gitCommonDirectory);
            assertRecoveryQuarantineInactive(stateRoot);
            return importRecoveryAuthorityDescriptor(args[2], stateRoot, expectations, boundary);
        }
        if (isExactRecoveryAuthorityRestoreCommand(args)) {
            return dispatchRecoveryOperationalTrustRootRestore(args, repository, boundary, overrides);
        }
        if (args.length === 4 &&
            args[0] === 'recovery-authority' &&
            args[1] === 'status' &&
            args[2] === '--expectations' &&
            isExactAbsolutePath(args[3])) {
            const expectations = readExternalRecoveryExpectations(args[3], boundary);
            const stateRoot = requireRecoveryAuthorityStateRoot(repository.gitCommonDirectory);
            assertRecoveryQuarantineInactive(stateRoot);
            return {
                kind: 'recovery-authority-status.v1',
                descriptor: readRecoveryAuthorityDescriptor(stateRoot, expectations, boundary),
                quarantine: null,
            };
        }
        throw workflowError('HARNESS_RECOVERY_COMMAND_UNSUPPORTED', harnessBootstrapUsage(), ExitCode.usage);
    }
    function dispatchRecoveryOperationalTrustRootRestore(args, repository, boundary, overrides) {
        const envelopePath = args[2];
        const expectationsPath = args[4];
        const expectations = readExternalRecoveryExpectations(expectationsPath, boundary);
        const stateRoot = requireRecoveryAuthorityStateRoot(repository.gitCommonDirectory);
        const descriptor = readRecoveryAuthorityDescriptor(stateRoot, expectations, boundary);
        const externalAuditRoot = readExternalRecoveryTrustRootAuditRoot(envelopePath, boundary);
        const markerDigest = requireMatchingRecoveryQuarantine(stateRoot, descriptor, externalAuditRoot);
        const dependencies = recoveryOperationalTrustRootDependencies(descriptor, expectations, externalAuditRoot, repository.repositoryRealPath, overrides);
        overrides.beforeRecoveryTrustRootExecute?.();
        const markerDigestAtExecution = requireMatchingRecoveryQuarantine(stateRoot, descriptor, externalAuditRoot);
        if (markerDigestAtExecution !== markerDigest) {
            throw recoveryTrustRootQuarantineMismatch();
        }
        return executeRecoveryOperationalTrustRootRestore(envelopePath, stateRoot, boundary, dependencies);
    }
    function requireMatchingRecoveryQuarantine(stateRoot, descriptor, externalAuditRoot) {
        const marker = readRecoveryQuarantineMarker(stateRoot);
        if (marker === null) {
            throw workflowError('RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED', 'Operational trust-root restore requires an active canonical Recovery Quarantine marker.', ExitCode.guard);
        }
        if (marker.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
            marker.authorityDescriptorDigest !== descriptor.descriptorDigest ||
            marker.authorityGeneration !== descriptor.generation ||
            marker.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
            marker.externalAuditRoot !== externalAuditRoot) {
            throw recoveryTrustRootQuarantineMismatch();
        }
        return marker.markerDigest;
    }
    function recoveryTrustRootQuarantineMismatch() {
        return workflowError('RECOVERY_TRUST_ROOT_QUARANTINE_MISMATCH', 'Operational trust-root restore does not bind the exact active Recovery Quarantine marker.', ExitCode.verification);
    }
    function dispatchRecoveryQuarantineCommand(args, cwd, overrides) {
        const operation = args[1] === 'enter'
            ? 'enter'
            : args[1] === 'release'
                ? 'release'
                : null;
        if (operation === null ||
            !isExactRecoveryQuarantineCommand(args, operation)) {
            throw workflowError('HARNESS_RECOVERY_COMMAND_UNSUPPORTED', harnessBootstrapUsage(), ExitCode.usage);
        }
        const repository = discoverRepository(cwd);
        const boundary = recoveryImportBoundary(repository);
        const expectations = readExternalRecoveryExpectations(args[4], boundary);
        const stateRoot = requireRecoveryAuthorityStateRoot(repository.gitCommonDirectory);
        const descriptor = readRecoveryAuthorityDescriptor(stateRoot, expectations, boundary);
        const envelope = readExternalRecoveryEnvelope(args[2], boundary);
        const dependencies = recoveryQuarantineDependencies(descriptor, expectations, envelope, repository.repositoryRealPath, overrides);
        if (operation === 'enter')
            assertRecoveryQuarantineInactive(stateRoot);
        return operation === 'enter'
            ? executeRecoveryQuarantineEnter(stateRoot, envelope, dependencies)
            : executeRecoveryQuarantineRelease(stateRoot, envelope, dependencies);
    }
    function assertRecoveryQuarantineInactive(storageRoot) {
        if (readRecoveryQuarantineMarker(storageRoot) !== null) {
            throw workflowError('WORKFLOW_RECOVERY_QUARANTINED', 'Recovery Authority import, status, and enter are unavailable while quarantine is active.', ExitCode.guard);
        }
    }
    function isExactControlPlaneRollback(args) {
        return (args.length === 3 &&
            args[0] === 'control-plane' &&
            args[1] === 'rollback' &&
            isExactCliIdentifier(args[2]));
    }
    function isExactRecoveryQuarantineCommand(args, operation) {
        return (args.length === 5 &&
            args[0] === 'recovery-quarantine' &&
            args[1] === operation &&
            isExactAbsolutePath(args[2]) &&
            args[3] === '--expectations' &&
            isExactAbsolutePath(args[4]));
    }
    function isExactRecoveryAuthorityRestoreCommand(args) {
        return (args.length === 5 &&
            args[0] === 'recovery-authority' &&
            args[1] === 'restore-trust-root' &&
            isExactAbsolutePath(args[2]) &&
            args[3] === '--expectations' &&
            isExactAbsolutePath(args[4]));
    }
    function recoveryImportBoundary(repository) {
        return {
            repositoryWorktreeRoot: repository.repositoryRealPath,
            gitCommonDirectory: repository.gitCommonDirectory,
        };
    }
    function readOptionalRecoveryQuarantineMarker(storageRoot) {
        if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
            return null;
        }
        assertPrivateRecoveryDirectory(storageRoot);
        return readRecoveryQuarantineMarker(storageRoot);
    }
    function dispatchSealedControlPlaneRecovery(args, cwd, overrides) {
        if (args.length !== 3 ||
            args[0] !== 'control-plane' ||
            args[1] !== 'rollback' ||
            !isExactCliIdentifier(args[2])) {
            throw workflowError('HARNESS_RECOVERY_COMMAND_UNSUPPORTED', harnessBootstrapUsage(), ExitCode.usage);
        }
        const repository = discoverRepository(cwd);
        const stateRoot = bootstrapInterventionStateRoot(repository.gitCommonDirectory);
        const { dependencies, signer } = createHarnessRecoveryDependencies(cwd, repository.repositoryRoot, overrides);
        const sourceControlPlaneGrantId = args[2];
        const existing = dependencies.recoveryGrants.findForSource(stateRoot, sourceControlPlaneGrantId);
        if (existing?.state === 'consumed') {
            throwControlPlaneRecoveryAlreadyConsumed();
        }
        let envelope;
        if (existing?.state === 'reserved' ||
            existing?.state === 'completion-pending') {
            envelope = existing.envelope;
        }
        else {
            signer.assertHumanPresent();
            const issuedAt = (overrides.now?.() ?? new Date()).toISOString();
            const preflight = preflightControlPlaneRecoveryRollback(stateRoot, sourceControlPlaneGrantId, {
                humanSigner: signer.identity(),
                issuedAt,
            }, dependencies);
            (overrides.presentRecoverySummary ?? defaultRecoverySummaryPresenter)(preflight.summary);
            envelope = {
                payload: preflight.payload,
                signature: signer.sign(canonicalControlPlaneRecoveryGrantPayload(preflight.payload), HARNESS_RECOVERY_SIGNATURE_NAMESPACE),
            };
        }
        return executeControlPlaneRecoveryRollback(stateRoot, envelope, dependencies);
    }
    function defaultRecoverySummaryPresenter(summary) {
        process.stderr.write(`\n${summary.humanReadable}\n\n`);
    }
    function harnessBootstrapUsage() {
        return [
            bootstrapInterventionUsage(),
            '  pnpm harness-bootstrap control-plane rollback <control-plane-grant-id> [--json]',
            '  pnpm harness-bootstrap recovery-authority import <external-descriptor.json> --expectations <external-expectations.json> [--json]',
            '  pnpm harness-bootstrap recovery-authority status --expectations <external-expectations.json> [--json]',
            '  pnpm harness-bootstrap recovery-authority restore-trust-root <external-pre-signed-envelope.json> --expectations <external-expectations.json> [--json]',
            '  pnpm harness-bootstrap recovery-quarantine enter <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
            '  pnpm harness-bootstrap recovery-quarantine release <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
        ].join('\n');
    }
    function isExactCliIdentifier(value) {
        return (typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 255 &&
            value.trim() === value &&
            !value.startsWith('-') &&
            !value.includes('\0') &&
            !value.includes('\n') &&
            !value.includes('\r'));
    }
    return {
        isRecoveryAuthorityCommand,
        isRecoveryQuarantineCommand,
        isControlPlaneRecoveryCommand,
        assertHarnessRecoveryQuarantineRouting,
        dispatchRecoveryAuthorityCommand,
        dispatchRecoveryQuarantineCommand,
        dispatchSealedControlPlaneRecovery,
        harnessBootstrapUsage,
    };
}
