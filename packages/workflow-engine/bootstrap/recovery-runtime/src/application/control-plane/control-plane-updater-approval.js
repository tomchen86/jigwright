export function createControlPlaneUpdaterApproval(bindings) {
    function persistControlPlaneApprovalCandidateV3(storageRoot, input, now = new Date()) {
        const boundServices = bindings();
        const { controlPlanePromotionBundleDigestV3, normalizeControlPlaneTaskMandateBinding, assertSameControlPlaneTaskMandateBinding, approvalCandidateCorrupt, exactDate, withRecordDigest, withUpdaterLock, ensureUpdaterDirectories, serializeCanonical, fs, canonicalJson, workflowError, ExitCode, ensurePrivateDirectory, createPrivateFileExclusive, deepFreeze, } = boundServices;
        const assertNonEmpty = boundServices.assertNonEmpty;
        controlPlanePromotionBundleDigestV3(input.bundle);
        const mandateBinding = normalizeControlPlaneTaskMandateBinding(input.mandateBinding);
        assertSameControlPlaneTaskMandateBinding(mandateBinding, input.bundle.material.mandateBinding);
        const impact = assertApprovalCandidateBindingsV3(input.beforeManifest, input.afterManifest, input.bundle);
        if (impact.class !== 'C') {
            throw approvalCandidateCorrupt('Approval candidate v3 does not modify the protected control plane.');
        }
        assertNonEmpty(input.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
        const createdAt = exactDate(now, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT').toISOString();
        const candidate = withRecordDigest({
            kind: 'persisted-control-plane-approval-candidate.v3',
            mandateBinding,
            candidateId: input.bundle.bundleDigest,
            txId: input.txId,
            beforeManifest: structuredClone(input.beforeManifest),
            afterManifest: structuredClone(input.afterManifest),
            bundle: structuredClone(input.bundle),
            createdAt,
        });
        return withUpdaterLock(storageRoot, 'persist-approval-candidate', () => {
            const paths = ensureUpdaterDirectories(storageRoot);
            const target = controlPlaneApprovalCandidatePath(storageRoot, candidate.candidateId);
            const content = serializeCanonical(candidate);
            if (fs.existsSync(target)) {
                const existing = readPersistedControlPlaneApprovalCandidateV3(storageRoot, candidate.candidateId);
                if (canonicalJson(existing) !== canonicalJson(candidate)) {
                    throw workflowError('CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT', 'Candidate id is already bound to different approval bytes.', ExitCode.conflict);
                }
                return existing;
            }
            ensurePrivateDirectory(paths.approvalCandidates);
            createPrivateFileExclusive(target, content);
            return deepFreeze(structuredClone(candidate));
        });
    }
    function controlPlaneApprovalCandidatePath(storageRoot, candidateId) {
        const boundServices = bindings();
        const { path, updaterPaths } = boundServices;
        const assertDigest = boundServices.assertDigest;
        assertDigest(candidateId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
        return path.join(updaterPaths(storageRoot).approvalCandidates, `${candidateId.slice('sha256:'.length)}.json`);
    }
    function readPersistedControlPlaneApprovalCandidateV3(storageRoot, candidateId) {
        const boundServices = bindings();
        const { readCanonicalPrivateRecord, isRecord, hasExactKeys, verifyRecordDigest, approvalCandidateCorrupt, normalizeControlPlaneTaskMandateBinding, isCanonicalIso, controlPlanePromotionBundleDigestV3, assertSameControlPlaneTaskMandateBinding, deepFreeze, } = boundServices;
        const assertNonEmpty = boundServices.assertNonEmpty;
        const value = readCanonicalPrivateRecord(controlPlaneApprovalCandidatePath(storageRoot, candidateId), 'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND');
        if (!isRecord(value) ||
            !hasExactKeys(value, [
                'afterManifest',
                'beforeManifest',
                'bundle',
                'candidateId',
                'createdAt',
                'kind',
                'mandateBinding',
                'recordDigest',
                'txId',
            ]) ||
            value.kind !== 'persisted-control-plane-approval-candidate.v3' ||
            value.candidateId !== candidateId ||
            !verifyRecordDigest(value)) {
            throw approvalCandidateCorrupt();
        }
        try {
            const candidate = value;
            const mandateBinding = normalizeControlPlaneTaskMandateBinding(candidate.mandateBinding);
            assertNonEmpty(candidate.txId, 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT');
            if (!isCanonicalIso(candidate.createdAt)) {
                throw approvalCandidateCorrupt();
            }
            controlPlanePromotionBundleDigestV3(candidate.bundle);
            assertSameControlPlaneTaskMandateBinding(mandateBinding, candidate.bundle.material.mandateBinding);
            if (candidate.bundle.bundleDigest !== candidate.candidateId) {
                throw approvalCandidateCorrupt('Candidate id does not match the exact reviewed successor bundle.');
            }
            const impact = assertApprovalCandidateBindingsV3(candidate.beforeManifest, candidate.afterManifest, candidate.bundle);
            if (impact.class !== 'C') {
                throw approvalCandidateCorrupt('Persisted candidate v3 no longer classifies as control-plane.');
            }
            return deepFreeze(structuredClone({ ...candidate, mandateBinding }));
        }
        catch (error) {
            if (error instanceof Error &&
                'code' in error &&
                error.code === 'CONTROL_PLANE_APPROVAL_CANDIDATE_CORRUPT') {
                throw error;
            }
            throw approvalCandidateCorrupt();
        }
    }
    function readPersistedControlPlaneApprovalCandidateCurrent(storageRoot, candidateId) {
        const boundServices = bindings();
        const { readCanonicalPrivateRecord, isRecord, workflowError, ExitCode } = boundServices;
        const value = readCanonicalPrivateRecord(controlPlaneApprovalCandidatePath(storageRoot, candidateId), 'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND');
        if (!isRecord(value) ||
            value.kind !== 'persisted-control-plane-approval-candidate.v3') {
            throw workflowError('CONTROL_PLANE_APPROVAL_CANDIDATE_UNSUPPORTED_SCHEMA', 'Current control-plane approval accepts only persisted candidate schema v3.', ExitCode.guard);
        }
        return readPersistedControlPlaneApprovalCandidateV3(storageRoot, candidateId);
    }
    function findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer(storageRoot, promotionMaterialDigest, promotionLineageDigest, reviewer) {
        const boundServices = bindings();
        const { updaterPaths, fs, approvalCandidateCorrupt, readCanonicalPrivateRecord, path, isRecord, workflowError, ExitCode, } = boundServices;
        const assertDigest = boundServices.assertDigest;
        const assertNonEmpty = boundServices.assertNonEmpty;
        assertDigest(promotionMaterialDigest, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
        assertDigest(promotionLineageDigest, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
        assertNonEmpty(reviewer, 'CONTROL_PLANE_APPROVAL_CANDIDATE_INVALID');
        const directory = updaterPaths(storageRoot).approvalCandidates;
        const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (stats === undefined)
            return null;
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw approvalCandidateCorrupt('Approval candidate storage is not a private directory.');
        }
        const matches = [];
        for (const name of fs.readdirSync(directory).sort()) {
            if (!/^[0-9a-f]{64}\.json$/.test(name)) {
                throw approvalCandidateCorrupt('Approval candidate storage contains an unknown entry.');
            }
            const candidateId = `sha256:${name.slice(0, -'.json'.length)}`;
            const raw = readCanonicalPrivateRecord(path.join(directory, name), 'CONTROL_PLANE_APPROVAL_CANDIDATE_NOT_FOUND');
            if (isRecord(raw) &&
                raw.kind === 'persisted-control-plane-approval-candidate.v3') {
                const candidate = readPersistedControlPlaneApprovalCandidateV3(storageRoot, candidateId);
                if (candidate.bundle.promotionMaterialDigest ===
                    promotionMaterialDigest &&
                    candidate.bundle.promotionLineageDigest === promotionLineageDigest &&
                    candidate.bundle.independentReviewAttestation.payload.reviewer ===
                        reviewer) {
                    matches.push(candidate);
                }
            }
        }
        if (matches.length > 1) {
            throw workflowError('CONTROL_PLANE_APPROVAL_CANDIDATE_CONFLICT', 'Multiple signed approval candidates bind the same successor material, lineage, and reviewer.', ExitCode.conflict);
        }
        return matches[0] ?? null;
    }
    function preflightControlPlaneApprovalCandidateV3(storageRoot, candidateId, context) {
        const boundServices = bindings();
        const { fs, controlPlaneUpdateRecordPath, readPersistedControlPlaneUpdate, workflowError, ExitCode, controlPlaneIndependentReviewAttestationDigestV3, verifyControlPlaneIndependentReviewAttestationV3, readControlPlaneSupervisorState, assertSupervisorMatchesOldClosureV2, deepFreeze, } = boundServices;
        const assertNonEmpty = boundServices.assertNonEmpty;
        assertNonEmpty(context.grantId, 'CONTROL_PLANE_GRANT_INVALID');
        assertNonEmpty(context.humanSigner, 'CONTROL_PLANE_GRANT_INVALID');
        if (fs.existsSync(controlPlaneUpdateRecordPath(storageRoot, context.grantId))) {
            readPersistedControlPlaneUpdate(storageRoot, context.grantId);
            throw workflowError('INTERVENTION_CONTROL_GRANT_ALREADY_RESERVED_OR_CONSUMED', 'Control-Plane Grant already has a durable transaction.', ExitCode.conflict);
        }
        const candidate = readPersistedControlPlaneApprovalCandidateV3(storageRoot, candidateId);
        const impact = assertApprovalCandidateBindingsV3(candidate.beforeManifest, candidate.afterManifest, candidate.bundle);
        const attestationDigest = controlPlaneIndependentReviewAttestationDigestV3(candidate.bundle.independentReviewAttestation);
        verifyControlPlaneIndependentReviewAttestationV3(candidate.bundle.independentReviewAttestation, {
            material: candidate.bundle.material,
            lineage: candidate.bundle.lineage,
            expectedDigest: attestationDigest,
            grantHumanSigner: context.humanSigner,
            grantIssuedAt: context.issuedAt,
            verifyHumanSignature: context.verifyHumanSignature,
        });
        const supervisor = readControlPlaneSupervisorState(storageRoot);
        assertSupervisorMatchesOldClosureV2(supervisor, candidate.bundle.material);
        if (supervisor.generation !== candidate.bundle.lineage.previousGeneration ||
            supervisor.recordDigest !==
                candidate.bundle.lineage.previousSupervisorRecordDigest) {
            throw workflowError('CONTROL_PLANE_PROMOTION_LINEAGE_STALE', 'The successor lineage does not extend the current supervisor generation.', ExitCode.staleState);
        }
        const summary = controlPlaneApprovalSummaryV3(candidate, impact, attestationDigest);
        return deepFreeze({ candidate, summary, supervisor });
    }
    function assertApprovalCandidateBindingsV3(beforeManifest, afterManifest, bundle) {
        const boundServices = bindings();
        const { controlPlanePromotionBundleDigestV3, classifyProtectedCandidateImpactV2, controlPlaneCandidateDigestV2, approvalCandidateCorrupt, } = boundServices;
        controlPlanePromotionBundleDigestV3(bundle);
        const material = bundle.material;
        const impact = classifyProtectedCandidateImpactV2({
            beforeManifest,
            afterManifest,
            changes: material.exactChanges,
        });
        if (material.beforeClosureDigest !== beforeManifest.manifestDigest ||
            material.afterClosureDigest !== afterManifest.manifestDigest ||
            material.candidateDigest !==
                controlPlaneCandidateDigestV2(material.exactChanges)) {
            throw approvalCandidateCorrupt('Persisted manifests do not match the exact successor promotion material.');
        }
        return impact;
    }
    function controlPlaneApprovalSummaryV3(candidate, impact, attestationDigest) {
        const boundServices = bindings();
        const { deepFreeze } = boundServices;
        const { material } = candidate.bundle;
        const review = candidate.bundle.independentReviewAttestation.payload;
        const affected = impact.affectedCapabilities.join(', ');
        const changedPaths = material.exactChanges
            .map(({ path: changedPath, beforeDigest, afterDigest, beforeMode, afterMode, }) => `- ${changedPath}: ${beforeDigest ?? '<absent>'} (${beforeMode ?? '<absent>'}) -> ${afterDigest ?? '<absent>'} (${afterMode ?? '<absent>'})`)
            .join('\n');
        const lineage = candidate.bundle.lineage;
        const humanReadable = [
            'Control-plane successor approval candidate v3',
            `Candidate id: ${candidate.candidateId}`,
            `Promotion lineage: ${lineage.lineageDigest}`,
            `History anchor: ${lineage.historyAnchorDigest}`,
            `Previous terminal: ${lineage.previousTerminalRecordDigest}`,
            `Previous supervisor: ${lineage.previousSupervisorRecordDigest}`,
            `Supervisor generation: ${lineage.previousGeneration} -> ${lineage.candidateGeneration}`,
            `Rollback generation: ${lineage.rollbackGeneration}`,
            `Trust commit: ${lineage.previousActiveTrustCommit} -> ${lineage.candidateTrustCommit}`,
            `Frozen Class-C candidate: ${material.frozenCandidateBundleDigest}`,
            `Promotion material: ${candidate.bundle.promotionMaterialDigest}`,
            `Reviewed promotion bundle: ${candidate.bundle.bundleDigest}`,
            `Parent task: ${candidate.mandateBinding.parentTaskId}`,
            `Task mandate: ${candidate.mandateBinding.mandateId} (${candidate.mandateBinding.mandateDigest})`,
            `Change: ${candidate.mandateBinding.changeId}`,
            `External authority audit root: ${candidate.mandateBinding.externalAuditRoot}`,
            `Repository: ${material.repositoryId}`,
            `Affected capabilities: ${affected}`,
            `Before control-plane closure: ${material.beforeClosureDigest}`,
            `After control-plane closure: ${material.afterClosureDigest}`,
            `Candidate executable provenance: ${material.candidateExecutableProvenanceDigest}`,
            `Recovery bundle: ${material.recoveryBundle.bundleDigest}`,
            `Recovery executable provenance: ${material.recoveryBundle.restartExecutableProvenanceDigest}`,
            `Rollback test report: ${material.recoveryBundle.rollbackTestReportDigest}`,
            `Independent review: PASS — ${attestationDigest}`,
            `Reviewer: ${review.reviewer} at ${review.reviewedAt}`,
            `Review summary: ${review.reviewSummary}`,
            `Behavior change: ${material.behaviorChangeSummary}`,
            `Exact mode-aware changes (${material.exactChanges.length}):`,
            changedPaths,
        ].join('\n');
        return deepFreeze({
            kind: 'control-plane-approval-summary.v3',
            mandateBinding: structuredClone(candidate.mandateBinding),
            candidateId: candidate.candidateId,
            candidateRecordDigest: candidate.recordDigest,
            repositoryId: material.repositoryId,
            frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
            candidateDigest: material.candidateDigest,
            promotionMaterialDigest: candidate.bundle.promotionMaterialDigest,
            promotionLineageDigest: lineage.lineageDigest,
            promotionBundleDigest: candidate.bundle.bundleDigest,
            exactChanges: material.exactChanges.map((change) => ({ ...change })),
            affectedCapabilities: [...impact.affectedCapabilities],
            beforeClosureDigest: material.beforeClosureDigest,
            afterClosureDigest: material.afterClosureDigest,
            recoveryBundleDigest: material.recoveryBundle.bundleDigest,
            rollbackTestReportDigest: material.recoveryBundle.rollbackTestReportDigest,
            independentReview: {
                attestationDigest,
                reviewer: review.reviewer,
                reviewedAt: review.reviewedAt,
                verdict: review.verdict,
                reviewSummary: review.reviewSummary,
            },
            behaviorChangeSummary: material.behaviorChangeSummary,
            previousGeneration: lineage.previousGeneration,
            candidateGeneration: lineage.candidateGeneration,
            rollbackGeneration: lineage.rollbackGeneration,
            previousSupervisorRecordDigest: lineage.previousSupervisorRecordDigest,
            previousTerminalRecordDigest: lineage.previousTerminalRecordDigest,
            humanReadable,
        });
    }
    return {
        persistControlPlaneApprovalCandidateV3,
        controlPlaneApprovalCandidatePath,
        readPersistedControlPlaneApprovalCandidateV3,
        readPersistedControlPlaneApprovalCandidateCurrent,
        findPersistedControlPlaneApprovalCandidateV3ByMaterialLineageAndReviewer,
        preflightControlPlaneApprovalCandidateV3,
        assertApprovalCandidateBindingsV3,
    };
}
