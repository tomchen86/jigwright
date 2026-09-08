export function createControlPlaneUpdaterSupervisor(bindings) {
    function initializeControlPlaneSupervisorState(storageRoot, input) {
        const boundServices = bindings();
        const { withUpdaterLock, ensureUpdaterDirectories, verifyEngineArtifact, decodeCanonicalBase64, rawDigest, workflowError, ExitCode, exactDate, withRecordDigest, fs, canonicalJson, createPrivateFileExclusive, serializeCanonical, } = boundServices;
        const assertNonEmpty = boundServices.assertNonEmpty;
        const assertDigest = boundServices.assertDigest;
        return withUpdaterLock(storageRoot, 'initialize-supervisor', () => {
            const paths = ensureUpdaterDirectories(storageRoot);
            assertNonEmpty(input.repositoryId, 'CONTROL_PLANE_SUPERVISOR_INVALID');
            assertDigest(input.closureDigest, 'CONTROL_PLANE_SUPERVISOR_INVALID');
            const artifact = verifyEngineArtifact(input.artifact);
            const bytes = decodeCanonicalBase64(input.executableBase64, 'CONTROL_PLANE_SUPERVISOR_INVALID');
            if (rawDigest(bytes) !== artifact.executableDigest) {
                throw workflowError('CONTROL_PLANE_SUPERVISOR_INVALID', 'Initial executable does not match the engine artifact.', ExitCode.verification);
            }
            const executablePath = materializeExecutable(paths, artifact, bytes);
            const at = exactDate(input.now, 'CONTROL_PLANE_SUPERVISOR_INVALID');
            const state = withRecordDigest({
                kind: 'control-plane-supervisor-state.v1',
                repositoryId: input.repositoryId,
                activeArtifact: {
                    artifactId: artifact.artifactId,
                    executableDigest: artifact.executableDigest,
                    closureDigest: input.closureDigest,
                    executablePath,
                },
                generation: 1,
                transition: null,
                updatedAt: at.toISOString(),
            });
            if (fs.existsSync(paths.supervisor)) {
                const existing = readControlPlaneSupervisorState(storageRoot);
                if (canonicalJson(existing) !== canonicalJson(state)) {
                    throw workflowError('CONTROL_PLANE_SUPERVISOR_ALREADY_INITIALIZED', 'A different control-plane supervisor state already exists.', ExitCode.conflict);
                }
                return existing;
            }
            createPrivateFileExclusive(paths.supervisor, serializeCanonical(state));
            return state;
        });
    }
    function readControlPlaneSupervisorState(storageRoot) {
        const boundServices = bindings();
        const { updaterPaths, readCanonicalPrivateRecord, isRecord, hasExactKeys, verifyRecordDigest, supervisorCorrupt, isDigest, validTransition, isCanonicalIso, assertConfinedExecutable, deepFreeze, } = boundServices;
        const paths = updaterPaths(storageRoot);
        const value = readCanonicalPrivateRecord(paths.supervisor, 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND');
        if (!isRecord(value) ||
            !hasExactKeys(value, [
                'activeArtifact',
                'generation',
                'kind',
                'recordDigest',
                'repositoryId',
                'transition',
                'updatedAt',
            ]) ||
            value.kind !== 'control-plane-supervisor-state.v1' ||
            !verifyRecordDigest(value)) {
            throw supervisorCorrupt();
        }
        const state = value;
        if (typeof state.repositoryId !== 'string' ||
            state.repositoryId.length === 0 ||
            !Number.isSafeInteger(state.generation) ||
            state.generation < 1 ||
            !isRecord(state.activeArtifact) ||
            !hasExactKeys(state.activeArtifact, [
                'artifactId',
                'closureDigest',
                'executableDigest',
                'executablePath',
            ]) ||
            !isDigest(state.activeArtifact.artifactId) ||
            !isDigest(state.activeArtifact.executableDigest) ||
            !isDigest(state.activeArtifact.closureDigest) ||
            !validTransition(state.transition) ||
            !isCanonicalIso(state.updatedAt)) {
            throw supervisorCorrupt();
        }
        assertConfinedExecutable(paths, state.activeArtifact.executablePath, state.activeArtifact.executableDigest, state.activeArtifact.artifactId);
        return deepFreeze(structuredClone(state));
    }
    function materializeBundleExecutables(paths, bundle) {
        const boundServices = bindings();
        const { decodeCanonicalBase64 } = boundServices;
        materializeExecutable(paths, bundle.candidateArtifact, decodeCanonicalBase64(bundle.candidateExecutableBase64, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT'));
        materializeExecutable(paths, bundle.recoveryBundle.restartArtifact, decodeCanonicalBase64(bundle.recoveryBundle.restartExecutableBase64, 'CONTROL_PLANE_PROMOTION_BUNDLE_CORRUPT'));
    }
    function materializeExecutable(paths, artifact, bytes) {
        const boundServices = bindings();
        const { MAX_EXECUTABLE_BYTES, rawDigest, workflowError, ExitCode, path, ensurePrivateDirectory, fs, assertPrivateExecutable, createPrivateExecutableExclusive, } = boundServices;
        if (bytes.length === 0 ||
            bytes.length > MAX_EXECUTABLE_BYTES ||
            rawDigest(bytes) !== artifact.executableDigest) {
            throw workflowError('CONTROL_PLANE_EXECUTABLE_INVALID', 'Executable bytes do not match the engine artifact.', ExitCode.verification);
        }
        const artifactDirectory = path.join(paths.artifacts, artifact.artifactId.slice('sha256:'.length));
        ensurePrivateDirectory(artifactDirectory);
        const executablePath = path.join(artifactDirectory, 'engine');
        const existing = fs.lstatSync(executablePath, { throwIfNoEntry: false });
        if (existing) {
            assertPrivateExecutable(executablePath, artifact.executableDigest);
            return executablePath;
        }
        createPrivateExecutableExclusive(executablePath, bytes);
        assertPrivateExecutable(executablePath, artifact.executableDigest);
        return executablePath;
    }
    function buildSupervisorSelection(storageRoot, current, artifact, closureDigest, record, phase, now) {
        const boundServices = bindings();
        const { updaterPaths, materializedExecutablePath, assertConfinedExecutable, withRecordDigest, exactDate, } = boundServices;
        const paths = updaterPaths(storageRoot);
        const executablePath = materializedExecutablePath(paths, artifact);
        assertConfinedExecutable(paths, executablePath, artifact.executableDigest);
        return withRecordDigest({
            kind: 'control-plane-supervisor-state.v1',
            repositoryId: current.repositoryId,
            activeArtifact: {
                artifactId: artifact.artifactId,
                executableDigest: artifact.executableDigest,
                closureDigest,
                executablePath,
            },
            generation: current.generation + 1,
            transition: {
                grantId: record.envelope.payload.grantId,
                txId: record.transaction.txId,
                phase,
            },
            updatedAt: exactDate(now, 'CONTROL_PLANE_SUPERVISOR_INVALID').toISOString(),
        });
    }
    function publishSupervisorSelection(storageRoot, current, next) {
        const boundServices = bindings();
        const { replacePrivateFileAtomicCas, updaterPaths, serializeCanonical } = boundServices;
        replacePrivateFileAtomicCas(updaterPaths(storageRoot).supervisor, current.recordDigest, serializeCanonical(next));
    }
    function selectV3SupervisorArtifactWithHistory(storageRoot, current, artifact, closureDigest, record, bundle, phase, now, testHooks) {
        const boundServices = bindings();
        const { readControlPlaneSupervisorHistoryProgress, workflowError, ExitCode, exactDate, createControlPlaneSupervisorHistoryTransition, canonicalDigest, appendControlPlaneSupervisorHistoryRecord, } = boundServices;
        const lineage = bundle.storedBundle.lineage;
        let progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
        let transition;
        if (progress.leaf.kind === 'control-plane-supervisor-history-transition.v1' &&
            progress.leaf.phase === phase) {
            transition = progress.leaf;
            if (transition.grantId !== record.envelope.payload.grantId ||
                transition.txId !== record.transaction.txId ||
                transition.sourceJournalDigest !== record.transaction.journalDigest) {
                throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_FORK', 'The durable supervisor transition belongs to different authority bytes.', ExitCode.conflict);
            }
        }
        else {
            if ((phase === 'candidate-selected' &&
                progress.leaf.recordDigest !==
                    lineage.previousTerminalRecordDigest) ||
                (phase === 'rollback-restored' &&
                    (progress.leaf.kind !==
                        'control-plane-supervisor-history-transition.v1' ||
                        progress.leaf.phase !== 'candidate-selected' ||
                        progress.leaf.grantId !== record.envelope.payload.grantId ||
                        progress.leaf.txId !== record.transaction.txId ||
                        progress.leaf.promotionBundleDigest !== bundle.bundleDigest ||
                        progress.leaf.promotionLineageDigest !== lineage.lineageDigest))) {
                throw workflowError('CONTROL_PLANE_PROMOTION_LINEAGE_STALE', 'The supervisor history leaf cannot accept this transition.', ExitCode.staleState);
            }
            const selectedAt = exactDate(now, 'CONTROL_PLANE_SUPERVISOR_INVALID');
            const next = buildSupervisorSelection(storageRoot, current, artifact, closureDigest, record, phase, selectedAt);
            transition = createControlPlaneSupervisorHistoryTransition({
                previous: progress.leaf,
                phase,
                toSupervisorRecordDigest: next.recordDigest,
                activeArtifact: {
                    artifactId: next.activeArtifact.artifactId,
                    executableDigest: next.activeArtifact.executableDigest,
                    closureDigest: next.activeArtifact.closureDigest,
                },
                activeTrustCommit: phase === 'candidate-selected'
                    ? lineage.candidateTrustCommit
                    : lineage.previousActiveTrustCommit,
                grantId: record.envelope.payload.grantId,
                txId: record.transaction.txId,
                grantEnvelopeDigest: canonicalDigest(record.envelope),
                promotionBundleDigest: bundle.bundleDigest,
                promotionLineageDigest: lineage.lineageDigest,
                sourceTransactionState: phase === 'candidate-selected'
                    ? 'RECOVERY_VERIFIED'
                    : 'ROLLBACK_REQUIRED',
                sourceJournalDigest: record.transaction.journalDigest,
                recordedAt: selectedAt.toISOString(),
            });
            appendControlPlaneSupervisorHistoryRecord(storageRoot, transition);
            testHooks?.afterSupervisorHistoryTransition?.();
            progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
            if (progress.leaf.recordDigest !== transition.recordDigest) {
                throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_FORK', 'The published supervisor transition is not the unique history leaf.', ExitCode.conflict);
            }
        }
        const expected = buildSupervisorSelection(storageRoot, current, artifact, closureDigest, record, phase, new Date(transition.recordedAt));
        if (expected.recordDigest !== transition.toSupervisorRecordDigest ||
            expected.generation !== transition.toGeneration ||
            expected.generation !==
                (phase === 'candidate-selected'
                    ? lineage.candidateGeneration
                    : lineage.rollbackGeneration)) {
            throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_TRANSITION_INVALID', 'The supervisor bytes do not match the durable history transition.', ExitCode.verification);
        }
        publishSupervisorSelection(storageRoot, current, expected);
        return expected;
    }
    function assertV3SupervisorTransition(storageRoot, record, bundle, supervisor, phase) {
        const boundServices = bindings();
        const { readControlPlaneSupervisorHistoryProgress, workflowError, ExitCode, } = boundServices;
        const progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
        const leaf = progress.leaf;
        if (leaf.kind !== 'control-plane-supervisor-history-transition.v1' ||
            leaf.phase !== phase ||
            leaf.grantId !== record.envelope.payload.grantId ||
            leaf.txId !== record.transaction.txId ||
            leaf.promotionBundleDigest !== bundle.bundleDigest ||
            leaf.promotionLineageDigest !== bundle.promotionLineageDigest ||
            leaf.toSupervisorRecordDigest !== supervisor.recordDigest ||
            leaf.toGeneration !== supervisor.generation) {
            throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_TRANSITION_INVALID', 'The selected supervisor lacks its exact durable V3 history transition.', ExitCode.verification);
        }
    }
    function sealV3SupervisorHistory(storageRoot, record, supervisor) {
        const boundServices = bindings();
        const { readControlPlaneSupervisorHistoryProgress, workflowError, ExitCode, createControlPlaneSupervisorHistoryTerminal, appendControlPlaneSupervisorHistoryRecord, } = boundServices;
        const progress = readControlPlaneSupervisorHistoryProgress(storageRoot);
        if (progress.leaf.kind === 'control-plane-supervisor-history-terminal.v1') {
            if (progress.leaf.updateRecordDigest !== record.recordDigest ||
                progress.leaf.transactionJournalDigest !==
                    record.transaction.journalDigest ||
                progress.leaf.supervisorRecordDigest !== supervisor.recordDigest ||
                progress.leaf.terminalState !== record.transaction.state) {
                throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_FORK', 'The terminal history seal differs from the persisted V3 transaction.', ExitCode.conflict);
            }
            return;
        }
        if (progress.leaf.kind !== 'control-plane-supervisor-history-transition.v1' ||
            (record.transaction.state !== 'FINALIZED' &&
                record.transaction.state !== 'ROLLED_BACK')) {
            throw workflowError('CONTROL_PLANE_SUPERVISOR_HISTORY_NOT_TERMINAL', 'A terminal V3 transaction must seal its exact supervisor transition.', ExitCode.conflict);
        }
        const terminal = createControlPlaneSupervisorHistoryTerminal({
            previous: progress.leaf,
            terminalState: record.transaction.state,
            updateRecordDigest: record.recordDigest,
            transactionJournalDigest: record.transaction.journalDigest,
            recordedAt: record.updatedAt,
        });
        appendControlPlaneSupervisorHistoryRecord(storageRoot, terminal);
    }
    function assertSupervisorIsOldClosure(supervisor, envelope, bundle) {
        const boundServices = bindings();
        const { workflowError, ExitCode } = boundServices;
        if (supervisor.repositoryId !== envelope.payload.repositoryId ||
            supervisor.activeArtifact.artifactId !==
                bundle.recoveryBundle.restartArtifact.artifactId ||
            supervisor.activeArtifact.executableDigest !==
                bundle.recoveryBundle.restartArtifact.executableDigest ||
            supervisor.activeArtifact.closureDigest !== bundle.beforeClosureDigest) {
            throw workflowError('CONTROL_PLANE_OLD_CLOSURE_MISMATCH', 'Supervisor is not selecting the exact grant-bound old closure.', ExitCode.staleState);
        }
    }
    function assertSupervisorMatchesOldClosureV2(supervisor, material) {
        const boundServices = bindings();
        const { workflowError, ExitCode } = boundServices;
        if (supervisor.repositoryId !== material.repositoryId ||
            supervisor.activeArtifact.artifactId !==
                material.recoveryBundle.restartArtifact.artifactId ||
            supervisor.activeArtifact.executableDigest !==
                material.recoveryBundle.restartArtifact.executableDigest ||
            supervisor.activeArtifact.closureDigest !== material.beforeClosureDigest) {
            throw workflowError('CONTROL_PLANE_OLD_CLOSURE_MISMATCH', 'Supervisor is not selecting the exact v2 grant-bound old closure.', ExitCode.staleState);
        }
    }
    function assertSupervisorIsCandidate(supervisor, bundle) {
        const boundServices = bindings();
        const { workflowError, ExitCode } = boundServices;
        if (supervisor.repositoryId !== bundle.repositoryId ||
            supervisor.activeArtifact.artifactId !==
                bundle.candidateArtifact.artifactId ||
            supervisor.activeArtifact.executableDigest !==
                bundle.candidateArtifact.executableDigest ||
            supervisor.activeArtifact.closureDigest !== bundle.afterClosureDigest) {
            throw workflowError('CONTROL_PLANE_CANDIDATE_SUPERVISOR_MISMATCH', 'Supervisor is not selecting the exact candidate closure.', ExitCode.staleState);
        }
    }
    function runSelfTest(paths, executablePath, executableDigest, expectedClosureDigest) {
        const boundServices = bindings();
        const { hasExactKeys, processVerificationFailed, canonicalDigest } = boundServices;
        const value = runControlPlaneProcess(paths, executablePath, executableDigest, '--control-plane-self-test');
        if (!hasExactKeys(value, ['closureDigest', 'healthy', 'kind']) ||
            value.kind !== 'control-plane-self-test.v1' ||
            typeof value.healthy !== 'boolean' ||
            value.closureDigest !== expectedClosureDigest) {
            throw processVerificationFailed('Candidate self-test response is invalid.');
        }
        return {
            healthy: value.healthy,
            closureDigest: expectedClosureDigest,
            evidenceDigest: canonicalDigest(value),
        };
    }
    function runRestartProbe(paths, executablePath, executableDigest, expectedClosureDigest) {
        const boundServices = bindings();
        const { hasExactKeys, processVerificationFailed, canonicalDigest } = boundServices;
        const value = runControlPlaneProcess(paths, executablePath, executableDigest, '--control-plane-restart-probe');
        if (!hasExactKeys(value, ['closureDigest', 'kind', 'ready']) ||
            value.kind !== 'control-plane-restart.v1' ||
            value.ready !== true ||
            value.closureDigest !== expectedClosureDigest) {
            throw processVerificationFailed('Recovery restart response is invalid.');
        }
        return {
            closureDigest: expectedClosureDigest,
            evidenceDigest: canonicalDigest(value),
        };
    }
    function runControlPlaneProcess(paths, executablePath, executableDigest, mode) {
        const boundServices = bindings();
        const { assertConfinedExecutable, path, childProcess, PROCESS_TIMEOUT_MS, PROCESS_MAX_BUFFER_BYTES, processVerificationFailed, isRecord, } = boundServices;
        assertConfinedExecutable(paths, executablePath, executableDigest);
        const cwd = path.dirname(executablePath);
        const result = childProcess.spawnSync(executablePath, [mode], {
            cwd,
            env: {
                PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
                LANG: 'C',
                LC_ALL: 'C',
                TMPDIR: cwd,
            },
            encoding: 'utf8',
            timeout: PROCESS_TIMEOUT_MS,
            maxBuffer: PROCESS_MAX_BUFFER_BYTES,
            windowsHide: true,
        });
        if (result.error || result.signal || result.status !== 0) {
            throw processVerificationFailed('Control-plane process did not exit cleanly.');
        }
        if (typeof result.stdout !== 'string' ||
            Buffer.byteLength(result.stdout) > PROCESS_MAX_BUFFER_BYTES) {
            throw processVerificationFailed('Control-plane process output is invalid.');
        }
        let value;
        try {
            value = JSON.parse(result.stdout.trim());
        }
        catch {
            throw processVerificationFailed('Control-plane process returned invalid JSON.');
        }
        if (!isRecord(value)) {
            throw processVerificationFailed('Control-plane process response is not an object.');
        }
        return value;
    }
    return {
        initializeControlPlaneSupervisorState,
        readControlPlaneSupervisorState,
        materializeBundleExecutables,
        selectV3SupervisorArtifactWithHistory,
        assertV3SupervisorTransition,
        sealV3SupervisorHistory,
        assertSupervisorIsOldClosure,
        assertSupervisorMatchesOldClosureV2,
        assertSupervisorIsCandidate,
        runSelfTest,
        runRestartProbe,
    };
}
