import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIGEST = /^[0-9a-f]{64}$/u;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

try {
  if (process.argv.length !== 5 || process.argv[2] !== 'start') {
    throw new TypeError('Portable provider wrapper arguments are invalid.');
  }
  const requestPath = path.resolve(process.argv[3]);
  const submissionPath = path.resolve(process.argv[4]);
  assertRegularFile(requestPath, 0o600);
  const request = readJson(requestPath);
  if (request.kind === 'agent-runtime-host-wrapper-probe-request.v1') {
    handleProbe(requestPath, request);
  } else {
    assertRegularFile(submissionPath, 0o600);
    handleTurn(requestPath, submissionPath, request);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function handleProbe(requestPath, probe) {
  assertExactKeys(probe, [
    'schemaVersion',
    'kind',
    'invocationId',
    'requestDigest',
    'executionAttemptId',
    'acceptanceBindingDigest',
    'assignmentBindingDigest',
    'providerFamily',
    'profileDigest',
    'providerDefinitionBindingDigest',
    'outputFile',
  ]);
  if (
    probe.schemaVersion !== 1 ||
    probe.kind !== 'agent-runtime-host-wrapper-probe-request.v1' ||
    !INVOCATION_ID.test(probe.invocationId) ||
    !DIGEST.test(probe.requestDigest) ||
    !INVOCATION_ID.test(probe.executionAttemptId) ||
    !DIGEST.test(probe.acceptanceBindingDigest) ||
    !DIGEST.test(probe.assignmentBindingDigest) ||
    !['claude', 'codex'].includes(probe.providerFamily) ||
    !DIGEST.test(probe.profileDigest) ||
    !DIGEST.test(probe.providerDefinitionBindingDigest) ||
    typeof probe.outputFile !== 'string'
  ) {
    throw new TypeError('Portable provider probe request is invalid.');
  }
  const outputPath = path.resolve(probe.outputFile);
  if (
    path.dirname(outputPath) !== path.dirname(requestPath) ||
    path.basename(outputPath) !== 'probe-result.json'
  ) {
    throw new TypeError('Portable provider probe output path is invalid.');
  }
  assertRegularFile(outputPath, 0o600, 0);
  writeOutput(outputPath, {
    schemaVersion: 1,
    kind: 'agent-runtime-host-wrapper-probe-result.v1',
    providerVersion: 'portability-task-diff-wrapper-v1',
    authentication: 'authenticated',
  });
}

function handleTurn(requestPath, submissionPath, turn) {
  assertExactKeys(turn, [
    'schemaVersion',
    'kind',
    'invocationId',
    'requestDigest',
    'action',
    'prompt',
    'outputFile',
  ]);
  if (
    turn.schemaVersion !== 1 ||
    turn.kind !== 'agent-runtime-host-wrapper-turn-request.v1' ||
    !INVOCATION_ID.test(turn.invocationId) ||
    !DIGEST.test(turn.requestDigest) ||
    turn.action !== 'start' ||
    typeof turn.prompt !== 'string' ||
    typeof turn.outputFile !== 'string'
  ) {
    throw new TypeError('Portable provider turn request is invalid.');
  }
  const outputPath = path.resolve(turn.outputFile);
  if (
    path.dirname(outputPath) !== path.dirname(requestPath) ||
    path.basename(outputPath) !== 'semantic-output.json'
  ) {
    throw new TypeError('Portable provider output path is invalid.');
  }
  assertRegularFile(outputPath, 0o600, 0);

  const prompt = parseJson(turn.prompt);
  assertExactKeys(prompt, ['schemaVersion', 'kind', 'request']);
  if (
    prompt.schemaVersion !== 1 ||
    prompt.kind !== 'agent-runtime-host-wrapper-request.v1'
  ) {
    throw new TypeError('Portable provider prompt envelope is invalid.');
  }
  const request = prompt.request;
  assertExactKeys(request, [
    'schemaVersion',
    'invocationId',
    'nonce',
    'purpose',
    'providerId',
    'roleAssignment',
    'roleAssignmentDigest',
    'capabilityProfile',
    'repositoryId',
    'baseCommit',
    'baseTree',
    'targetDigest',
    'inputManifestDigest',
    'authorizationNodeId',
    'writeAllowedPaths',
    'outputSchema',
    'evaluatorVersion',
    'policyDigest',
    'limits',
    'requestDigest',
  ]);
  if (
    request.schemaVersion !== 1 ||
    request.invocationId !== turn.invocationId ||
    request.requestDigest !== turn.requestDigest ||
    request.purpose !== 'task-diff-review' ||
    request.providerId !== 'claude' ||
    request.roleAssignment?.providerId !== request.providerId ||
    request.capabilityProfile !== 'repository-read-only' ||
    !Array.isArray(request.writeAllowedPaths) ||
    request.writeAllowedPaths.length !== 0 ||
    request.outputSchema?.id !== 'workflow.task-diff-review-output.v1' ||
    request.outputSchema?.version !== 1 ||
    !DIGEST.test(request.outputSchema?.digest) ||
    !DIGEST.test(request.roleAssignmentDigest) ||
    !DIGEST.test(request.targetDigest) ||
    !DIGEST.test(request.inputManifestDigest) ||
    !DIGEST.test(request.policyDigest)
  ) {
    throw new TypeError('Portable TaskDiff provider request is invalid.');
  }

  const sidecar = readJson(submissionPath);
  assertExactKeys(sidecar, [
    'schemaVersion',
    'kind',
    'invocationId',
    'submission',
  ]);
  if (
    sidecar.schemaVersion !== 1 ||
    sidecar.kind !== 'portability-task-diff-provider-input.v1' ||
    sidecar.invocationId !== turn.invocationId
  ) {
    throw new TypeError('Portable TaskDiff provider sidecar is invalid.');
  }
  assertExactKeys(sidecar.submission, [
    'schemaVersion',
    'verdict',
    'coverage',
    'scopeAssessment',
    'findings',
    'suggestions',
    'riskPathDispositions',
    'residualRisk',
    'uncertainty',
    'documentationAssessment',
  ]);
  if (
    sidecar.submission.schemaVersion !== 1 ||
    sidecar.submission.verdict !== 'advisory-approve' ||
    !Array.isArray(sidecar.submission.coverage) ||
    !Array.isArray(sidecar.submission.findings) ||
    !Array.isArray(sidecar.submission.suggestions) ||
    !Array.isArray(sidecar.submission.riskPathDispositions)
  ) {
    throw new TypeError('Portable TaskDiff submission is invalid.');
  }

  writeOutput(outputPath, sidecar.submission);
  let sequence = 1;
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
    action: 'start',
    nativeSessionId: `portability-${crypto
      .createHash('sha256')
      .update(turn.invocationId)
      .digest('hex')
      .slice(0, 32)}`,
  });
  emit({
    schemaVersion: 2,
    type: 'result',
    sequence,
    outputSlot: 'primary',
  });
}

function readJson(filePath) {
  return parseJson(fs.readFileSync(filePath, 'utf8'));
}

function parseJson(source) {
  const value = JSON.parse(source);
  if (!isRecord(value)) {
    throw new TypeError('Portable provider JSON value is invalid.');
  }
  return value;
}

function assertExactKeys(value, keys) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  ) {
    throw new TypeError('Portable provider object shape is invalid.');
  }
}

function assertRegularFile(filePath, mode, size) {
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== mode ||
    (size !== undefined && stats.size !== size)
  ) {
    throw new TypeError('Portable provider file boundary is invalid.');
  }
}

function writeOutput(outputPath, submission) {
  const descriptor = fs.openSync(
    outputPath,
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.writeFileSync(descriptor, `${canonicalJson(submission)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function emit(frame) {
  process.stdout.write(`${canonicalJson(frame)}\n`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareUtf8(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
