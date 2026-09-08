/**
 * Read and validate bounded native or wrapper provider output and structured schema errors.
 *
 * Invariants:
 * - Output byte limits, protocol receipts, semantic checks, and error payloads stay exact.
 * - Native outputs never substitute for wrapper authority evidence.
 */

import fs from 'node:fs';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  type ProviderProcessOutcome,
  assertProviderProcessSucceeded,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type { AgentRuntimeAsyncSingleShotOptions } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  type ProviderWrapperProtocolReceipt,
  assertProviderWrapperProtocolReceipt,
  ProviderWrapperProtocolError,
} from '../../modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  outputLimitExceeded,
  nativeOutputInvalid,
  wrapperProtocolInvalid,
  requestUnbound,
  nativeOutputRepair,
  isRecord,
  deepFreeze,
} from './provider-runner-values.ts';
import { type ProviderRunInput } from './provider-runner.ts';
import { openNoFollowRead } from './provider-runner-files.ts';

export function enforceProcessOutcome(
  outcome: ProviderProcessOutcome,
  timeoutMs: number,
): void {
  assertProviderProcessSucceeded(outcome, timeoutMs);
}

export function enforceRawOutputLimit(
  outcome: ProviderProcessOutcome,
  aggregateOutputBytes: number,
): void {
  const bytes =
    Buffer.byteLength(outcome.stdout, 'utf8') +
    Buffer.byteLength(outcome.stderr, 'utf8');
  if (bytes > aggregateOutputBytes) {
    throw outputLimitExceeded();
  }
}

/**
 * Read and parse the provider-native output, enforcing the aggregate cap over
 * raw stdout, raw stderr, the provider-native semantic file/wrapper, and the
 * canonical normalized semantic output. Claude's native wrapper is the raw
 * stdout (already counted); Codex's is a bounded no-follow read of the
 * `--output-last-message` file, so a large semantic file fails even when the
 * event stdout is tiny.
 */
export function readNativeSemanticOutput(
  providerId: ProviderId,
  outcome: ProviderProcessOutcome,
  semanticOutputPath: string,
  aggregateOutputBytes: number,
): unknown {
  const stdoutBytes = Buffer.byteLength(outcome.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(outcome.stderr, 'utf8');

  let output: unknown;
  let nativeBytes: number;
  if (providerId === 'claude') {
    output = parseClaudeNativeOutput(outcome.stdout);
    nativeBytes = 0;
  } else {
    const file = readCodexSemanticFile(
      semanticOutputPath,
      stdoutBytes + stderrBytes,
      aggregateOutputBytes,
    );
    output = parseJsonOrInvalid(file.content);
    nativeBytes = file.bytes;
  }

  let normalized: string;
  try {
    normalized = canonicalJson(output);
  } catch {
    throw nativeOutputInvalid();
  }
  const aggregate =
    stdoutBytes +
    stderrBytes +
    nativeBytes +
    Buffer.byteLength(normalized, 'utf8');
  if (aggregate > aggregateOutputBytes) {
    throw outputLimitExceeded();
  }
  return output;
}

export function readWrapperProtocolReceipt(
  input: ProviderRunInput,
  outcome: ProviderProcessOutcome,
): ProviderWrapperProtocolReceipt | null {
  if (input.wrapperProtocol === undefined) {
    if (outcome.wrapperProtocolReceipt !== undefined) {
      throw wrapperProtocolInvalid();
    }
    return null;
  }
  if (input.acceptanceBinding === undefined) throw requestUnbound();
  let receipt: ProviderWrapperProtocolReceipt;
  try {
    receipt = assertProviderWrapperProtocolReceipt(
      outcome.wrapperProtocolReceipt,
      {
        invocationId: input.request.invocationId,
        requestDigest: input.request.requestDigest,
        attemptId: input.acceptanceBinding.executionAttemptId,
      },
    );
  } catch (error) {
    if (error instanceof ProviderWrapperProtocolError) {
      throw wrapperProtocolInvalid();
    }
    throw error;
  }
  return receipt;
}

/**
 * A process failure keeps its historical classification. If the wrapper also
 * produced a valid, exactly bound terminal receipt, retain that independent
 * evidence without letting malformed protocol output replace the process
 * failure that already occurred.
 */
export function tryReadWrapperProtocolReceipt(
  input: ProviderRunInput,
  outcome: ProviderProcessOutcome,
): ProviderWrapperProtocolReceipt | null {
  if (
    input.wrapperProtocol === undefined ||
    input.acceptanceBinding === undefined ||
    outcome.wrapperProtocolReceipt === undefined
  ) {
    return null;
  }
  try {
    return assertProviderWrapperProtocolReceipt(
      outcome.wrapperProtocolReceipt,
      {
        invocationId: input.request.invocationId,
        requestDigest: input.request.requestDigest,
        attemptId: input.acceptanceBinding.executionAttemptId,
      },
    );
  } catch {
    return null;
  }
}

export function observeProtocolReceipt(
  observer: AgentRuntimeAsyncSingleShotOptions['onProtocolReceipt'],
  receipt: ProviderWrapperProtocolReceipt,
): void {
  try {
    observer?.(receipt);
  } catch {
    // Receipt observation has no process-control or failure-classification
    // authority. The original terminal failure remains the durable cause.
  }
}

export function readWrapperSemanticOutput(
  outcome: ProviderProcessOutcome,
  semanticOutputPath: string,
  aggregateOutputBytes: number,
): unknown {
  const stdoutBytes = Buffer.byteLength(outcome.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(outcome.stderr, 'utf8');
  const file = readCodexSemanticFile(
    semanticOutputPath,
    stdoutBytes + stderrBytes,
    aggregateOutputBytes,
  );
  const output = parseJsonOrInvalid(file.content);
  let normalized: string;
  try {
    normalized = canonicalJson(output);
  } catch {
    throw nativeOutputInvalid();
  }
  if (
    stdoutBytes +
      stderrBytes +
      file.bytes +
      Buffer.byteLength(normalized, 'utf8') >
    aggregateOutputBytes
  ) {
    throw outputLimitExceeded();
  }
  return output;
}

function parseClaudeNativeOutput(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_JSON_PARSE_FAILED',
        'Provider native output was not valid JSON; return one complete object matching the target schema.',
      ),
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== 'result' ||
    parsed.subtype !== 'success' ||
    !('structured_output' in parsed)
  ) {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_WRAPPER_INVALID',
        'Provider native output did not contain the required successful structured-output wrapper; return one complete object matching the target schema.',
      ),
    );
  }
  return parsed.structured_output;
}

function readCodexSemanticFile(
  semanticOutputPath: string,
  consumedBytes: number,
  aggregateOutputBytes: number,
): { content: string; bytes: number } {
  const descriptor = openNoFollowRead(semanticOutputPath);
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw nativeOutputInvalid();
    }
    const size = stats.size;
    // Bound the read: a semantic file that alone pushes the aggregate over the
    // cap fails before it is read into memory.
    if (consumedBytes + size > aggregateOutputBytes) {
      throw outputLimitExceeded();
    }
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        read,
        size - read,
        read,
      );
      if (bytesRead <= 0) {
        break;
      }
      read += bytesRead;
    }
    return { content: buffer.subarray(0, read).toString('utf8'), bytes: read };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseJsonOrInvalid(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw nativeOutputInvalid(
      nativeOutputRepair(
        'NATIVE_JSON_PARSE_FAILED',
        'Provider native output was not valid JSON; return one complete object matching the target schema.',
      ),
    );
  }
}

export function validateSemanticOutput(
  input: ProviderRunInput,
  value: unknown,
): void {
  const validator = input.outputValidator;
  if (
    validator.id !== input.request.outputSchema.id ||
    validator.version !== input.request.outputSchema.version ||
    validator.digest !== input.request.outputSchema.digest
  ) {
    throw nativeOutputInvalid();
  }
  const frozen = deepFreeze(structuredClone(value));
  let valid: boolean;
  try {
    valid = validator.validate(frozen);
  } catch {
    throw nativeOutputInvalid();
  }
  if (valid !== true) {
    const validationErrors = collectSchemaValidationErrors(
      input.semanticOutputSchema,
      frozen,
    );
    // A repair that only says "it failed" makes the next attempt a re-roll: the
    // provider sees its own output back and no reason to change it. Prefer the
    // validator's own account of which field it rejected and why.
    const semanticErrors = validator.explain?.(frozen) ?? [];
    throw nativeOutputInvalid({
      repairKind: validationErrors.length === 0 ? 'semantic' : 'schema',
      previousOutput: frozen,
      validationErrors:
        validationErrors.length > 0
          ? validationErrors
          : semanticErrors.length > 0
            ? semanticErrors
            : [
                {
                  path: '/',
                  code: 'SEMANTIC_VALIDATION_FAILED',
                  message:
                    'Output matched the structural schema but failed the bound semantic validator.',
                },
              ],
    });
  }
}

export type ProviderValidationError = {
  path: string;
  code: string;
  message: string;
};

function collectSchemaValidationErrors(
  schema: unknown,
  value: unknown,
): ProviderValidationError[] {
  const errors: ProviderValidationError[] = [];
  const visit = (
    candidate: unknown,
    current: unknown,
    pointer: string,
  ): void => {
    if (errors.length >= 64 || !isRecord(candidate)) return;
    if (Array.isArray(candidate.enum)) {
      const match = candidate.enum.some(
        (allowed) => canonicalJson(allowed) === canonicalJson(current),
      );
      if (!match) {
        errors.push({
          path: pointer || '/',
          code: 'ENUM_MISMATCH',
          message: 'Value is not one of the schema enum alternatives.',
        });
        return;
      }
    }
    if (candidate.type === 'object') {
      if (!isRecord(current)) {
        errors.push({
          path: pointer || '/',
          code: 'TYPE_OBJECT_REQUIRED',
          message: 'Expected an object.',
        });
        return;
      }
      const properties = isRecord(candidate.properties)
        ? candidate.properties
        : {};
      if (Array.isArray(candidate.required)) {
        for (const name of candidate.required) {
          if (typeof name === 'string' && !Object.hasOwn(current, name)) {
            errors.push({
              path: appendJsonPointer(pointer, name),
              code: 'REQUIRED_FIELD_MISSING',
              message: `Required field ${name} is missing.`,
            });
          }
        }
      }
      for (const [name, child] of Object.entries(current)) {
        if (Object.hasOwn(properties, name)) {
          visit(properties[name], child, appendJsonPointer(pointer, name));
        } else if (candidate.additionalProperties === false) {
          errors.push({
            path: appendJsonPointer(pointer, name),
            code: 'ADDITIONAL_PROPERTY_FORBIDDEN',
            message: `Property ${name} is not allowed.`,
          });
        }
      }
      return;
    }
    if (candidate.type === 'array') {
      if (!Array.isArray(current)) {
        errors.push({
          path: pointer || '/',
          code: 'TYPE_ARRAY_REQUIRED',
          message: 'Expected an array.',
        });
        return;
      }
      if (
        Number.isSafeInteger(candidate.minItems) &&
        current.length < Number(candidate.minItems)
      ) {
        errors.push({
          path: pointer || '/',
          code: 'MIN_ITEMS',
          message: `Expected at least ${String(candidate.minItems)} items.`,
        });
      }
      if (
        Number.isSafeInteger(candidate.maxItems) &&
        current.length > Number(candidate.maxItems)
      ) {
        errors.push({
          path: pointer || '/',
          code: 'MAX_ITEMS',
          message: `Expected at most ${String(candidate.maxItems)} items.`,
        });
      }
      if (candidate.items !== undefined) {
        current.forEach((child, index) =>
          visit(
            candidate.items,
            child,
            appendJsonPointer(pointer, String(index)),
          ),
        );
      }
      return;
    }
    if (candidate.type === 'string' && typeof current !== 'string') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_STRING_REQUIRED',
        message: 'Expected a string.',
      });
    } else if (candidate.type === 'number' && typeof current !== 'number') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_NUMBER_REQUIRED',
        message: 'Expected a number.',
      });
    } else if (candidate.type === 'integer' && !Number.isSafeInteger(current)) {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_INTEGER_REQUIRED',
        message: 'Expected an integer.',
      });
    } else if (candidate.type === 'boolean' && typeof current !== 'boolean') {
      errors.push({
        path: pointer || '/',
        code: 'TYPE_BOOLEAN_REQUIRED',
        message: 'Expected a boolean.',
      });
    }
  };
  visit(schema, value, '');
  return errors
    .slice(0, 64)
    .sort((left, right) =>
      `${left.path}\0${left.code}`.localeCompare(
        `${right.path}\0${right.code}`,
      ),
    );
}

function appendJsonPointer(pointer: string, segment: string): string {
  const escaped = segment.replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer}/${escaped}`;
}
