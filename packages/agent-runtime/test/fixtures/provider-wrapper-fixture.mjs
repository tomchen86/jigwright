const mode = process.argv[2];
let sequence = 1;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

if (mode === 'host-start' || mode === 'host-resume') {
  const nativeSessionId =
    mode === 'host-start' ? 'native-host-wrapper-1' : process.argv[3];
  const requestFile = mode === 'host-start' ? process.argv[3] : process.argv[4];
  const request = JSON.parse(
    await import('node:fs').then(({ readFileSync }) =>
      readFileSync(requestFile, 'utf8'),
    ),
  );
  const { writeFileSync } = await import('node:fs');
  if (request.kind === 'agent-runtime-host-wrapper-probe-request.v1') {
    writeFileSync(
      request.outputFile,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'agent-runtime-host-wrapper-probe-result.v1',
        providerVersion: 'fixture-wrapper-v1',
        authentication: 'authenticated',
      }),
    );
    process.exit(0);
  }
  writeFileSync(
    request.outputFile,
    JSON.stringify({
      reference: request.invocationId,
      terms: [{ kind: 'symbol', value: 'protectedBranches' }],
    }),
  );
  emit({
    schemaVersion: 2,
    type: 'hello',
    sequence: sequence++,
    protocol: 'harness-jsonl-v2',
  });
  emit({
    schemaVersion: 2,
    type: 'session',
    sequence: sequence++,
    action: mode === 'host-start' ? 'start' : 'resume',
    nativeSessionId,
  });
  emit({
    schemaVersion: 2,
    type: 'result',
    sequence: sequence++,
    outputSlot: 'primary',
  });
} else if (mode.startsWith('v2-')) {
  emit({
    schemaVersion: 2,
    type: 'hello',
    sequence: sequence++,
    protocol: 'harness-jsonl-v2',
  });

  const emitSession = (action, nativeSessionId) => {
    emit({
      schemaVersion: 2,
      type: 'session',
      sequence: sequence++,
      action,
      nativeSessionId,
    });
  };
  const emitResult = () => {
    emit({
      schemaVersion: 2,
      type: 'result',
      sequence: sequence++,
      outputSlot: 'primary',
    });
  };

  if (mode === 'v2-start-observed') {
    const nativeSessionId = 'native-bounded-observed-1';
    emitSession('start', nativeSessionId);
    process.stderr.write(`v2-start-observed ${nativeSessionId}\n`);
    emitResult();
  } else if (mode === 'v2-resume') {
    emitSession('resume', process.argv[3]);
    emitResult();
  } else if (mode === 'v2-mismatch') {
    emitSession('resume', 'native-bounded-mismatched');
    emitResult();
  } else if (mode === 'v2-missing') {
    emitResult();
  } else if (mode === 'v2-duplicate') {
    emitSession('start', 'native-bounded-duplicate');
    emitSession('start', 'native-bounded-duplicate');
    emitResult();
  } else if (mode === 'v2-post-terminal') {
    emitSession('start', 'native-bounded-post-terminal');
    emitResult();
    emit({
      schemaVersion: 2,
      type: 'progress',
      sequence: sequence++,
      phase: 'finalizing',
    });
  } else if (mode === 'v2-timeout') {
    emitSession('start', process.argv[3]);
    process.stderr.write('v2-timeout-diagnostic\n');
    setInterval(() => {}, 1_000);
  } else if (mode === 'v2-cancel-ack') {
    emitSession('start', 'native-bounded-cancel');
    process.stderr.write('v2-cancel-diagnostic\n');
    process.once('SIGTERM', () => {
      emit({ schemaVersion: 2, type: 'cancel-ack', sequence: sequence++ });
      setTimeout(() => process.exit(0), 10);
    });
    setInterval(() => {}, 1_000);
  } else if (mode === 'v2-result-before-abort') {
    emitSession('start', 'native-bounded-result-before-abort');
    emitResult();
    setTimeout(() => process.exit(0), 25);
  } else if (mode === 'v2-cancel-result') {
    process.once('SIGTERM', () => {
      emitResult();
      setTimeout(() => process.exit(0), 10);
    });
    emitSession('start', 'native-bounded-cancel-result');
    setInterval(() => {}, 1_000);
  } else if (mode === 'v2-cancel-error') {
    process.once('SIGTERM', () => {
      emit({
        schemaVersion: 2,
        type: 'error',
        sequence: sequence++,
        code: 'PROVIDER_FAILED',
      });
      setTimeout(() => process.exit(2), 10);
    });
    emitSession('start', 'native-bounded-cancel-error');
    setInterval(() => {}, 1_000);
  } else if (mode === 'v2-error') {
    emitSession('start', 'native-bounded-error');
    emit({
      schemaVersion: 2,
      type: 'error',
      sequence: sequence++,
      code: 'PROVIDER_FAILED',
    });
    process.stderr.write('v2-error-diagnostic\n');
    process.exitCode = 2;
  } else if (mode === 'v2-error-no-session') {
    emit({
      schemaVersion: 2,
      type: 'error',
      sequence: sequence++,
      code: 'PROVIDER_FAILED',
    });
    process.exitCode = 2;
  } else if (mode === 'v2-unobserved-stderr') {
    process.stderr.write('unobserved-native-session-secret\n');
    emitResult();
  } else {
    process.exitCode = 2;
  }
} else {
  emit({
    schemaVersion: 1,
    type: 'hello',
    sequence: sequence++,
    protocol: 'harness-jsonl-v1',
  });

  if (mode === 'success') {
    emit({
      schemaVersion: 1,
      type: 'progress',
      sequence: sequence++,
      phase: 'tool',
    });
    emit({
      schemaVersion: 1,
      type: 'result',
      sequence: sequence++,
      outputSlot: 'primary',
    });
  } else if (mode === 'cancel-ack') {
    process.once('SIGTERM', () => {
      emit({ schemaVersion: 1, type: 'cancel-ack', sequence: sequence++ });
      setTimeout(() => process.exit(0), 10);
    });
    setInterval(() => {}, 1_000);
  } else if (mode === 'cancel-ignore') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  } else if (mode === 'result-before-abort') {
    emit({
      schemaVersion: 1,
      type: 'result',
      sequence: sequence++,
      outputSlot: 'primary',
    });
    setTimeout(() => process.exit(0), 25);
  } else if (mode === 'cancel-result') {
    process.once('SIGTERM', () => {
      emit({
        schemaVersion: 1,
        type: 'result',
        sequence: sequence++,
        outputSlot: 'primary',
      });
      setTimeout(() => process.exit(0), 10);
    });
    setInterval(() => {}, 1_000);
  } else if (mode === 'cancel-error') {
    process.once('SIGTERM', () => {
      emit({
        schemaVersion: 1,
        type: 'error',
        sequence: sequence++,
        code: 'PROVIDER_FAILED',
      });
      setTimeout(() => process.exit(2), 10);
    });
    setInterval(() => {}, 1_000);
  } else {
    process.exitCode = 2;
  }
}
