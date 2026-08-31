import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  HARNESS_JSONL_V1_LIMITS,
  ProviderWrapperProtocolError,
  createProviderWrapperProtocolParser,
  type ProviderWrapperProtocolExecution,
  type ProviderWrapperProtocolReceipt,
} from './harness-jsonl-v1.ts';
import {
  HARNESS_JSONL_V2_LIMITS,
  ProviderWrapperSessionProtocolError,
  createProviderWrapperSessionProtocolParser,
  type ProviderWrapperSessionProtocolExecution,
  type ProviderWrapperSessionProtocolOutcome,
} from './harness-jsonl-v2.ts';

export const BOUNDED_PROVIDER_PROCESS_CONTRACT_VERSION =
  'jigwright.agent-runtime.bounded-provider-process.v1' as const;
export const BOUNDED_PROVIDER_PROCESS_V2_CONTRACT_VERSION =
  'jigwright.agent-runtime.bounded-provider-process.v2' as const;

export const BOUNDED_PROVIDER_PROCESS_TERMINATIONS = [
  'exited',
  'timed-out',
  'cancelled',
  'output-limit',
  'spawn-error',
  'protocol-error',
] as const;

export type BoundedProviderProcessTermination =
  (typeof BOUNDED_PROVIDER_PROCESS_TERMINATIONS)[number];

export type BoundedProviderProcessActivity = Readonly<{
  type: 'spawned' | 'stdout' | 'stderr' | BoundedProviderProcessTermination;
  elapsedMs: number;
  bytes?: number;
}>;

type BoundedProviderProcessBaseInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdinContent?: Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onActivity?: (event: BoundedProviderProcessActivity) => void;
}>;

/** The retained v1 input surface remains unchanged for existing callers. */
export type BoundedProviderProcessInput = BoundedProviderProcessBaseInput &
  Readonly<{
    wrapperProtocol?: ProviderWrapperProtocolExecution;
  }>;

export type BoundedProviderSessionProcessInput =
  BoundedProviderProcessBaseInput &
    Readonly<{
      wrapperSessionProtocol: ProviderWrapperSessionProtocolExecution;
    }>;

type BoundedProviderProcessBaseOutcome = Readonly<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnErrorCode: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  terminationReason: BoundedProviderProcessTermination;
}>;

/** The retained v1 outcome surface and receipt field remain unchanged. */
export type BoundedProviderProcessOutcome = BoundedProviderProcessBaseOutcome &
  Readonly<{
    wrapperProtocolReceipt?: ProviderWrapperProtocolReceipt;
  }>;

export type BoundedProviderSessionProcessOutcome =
  BoundedProviderProcessBaseOutcome &
    Readonly<{
      /**
       * The public outcome contains only the digest-bound protocol receipt.
       * Raw native identity can leave the parser only through the explicitly
       * supplied private sink capability on wrapperSessionProtocol.
       */
      wrapperSessionProtocolOutcome?: ProviderWrapperSessionProtocolOutcome;
    }>;

type AnyBoundedProviderProcessInput =
  BoundedProviderProcessInput | BoundedProviderSessionProcessInput;

type AnyBoundedProviderProcessOutcome =
  BoundedProviderProcessOutcome | BoundedProviderSessionProcessOutcome;

type WrapperProtocolParser =
  | Readonly<{
      protocol: 'harness-jsonl-v1';
      parser: ReturnType<typeof createProviderWrapperProtocolParser>;
    }>
  | Readonly<{
      protocol: 'harness-jsonl-v2';
      parser: ReturnType<typeof createProviderWrapperSessionProtocolParser>;
    }>;

type WrapperProtocolError =
  ProviderWrapperProtocolError | ProviderWrapperSessionProtocolError;

/**
 * Launch one provider process without a shell and observe it asynchronously.
 * The primitive retains at most aggregateOutputBytes + one sentinel byte across
 * both streams, terminates on timeout/output overflow, and accepts an explicit
 * cancellation signal. Wrapper framing is interpreted only after an explicit
 * protocol declaration; undeclared Codex/Claude output remains opaque.
 */
export function spawnBoundedProviderProcess(
  input: BoundedProviderProcessInput,
): Promise<BoundedProviderProcessOutcome> {
  return spawnBoundedProviderProcessInternal(
    input,
  ) as Promise<BoundedProviderProcessOutcome>;
}

/** Launch the versioned session-aware harness without widening the v1 API. */
export function spawnBoundedProviderSessionProcess(
  input: BoundedProviderSessionProcessInput,
): Promise<BoundedProviderSessionProcessOutcome> {
  return spawnBoundedProviderProcessInternal(
    input,
  ) as Promise<BoundedProviderSessionProcessOutcome>;
}

function spawnBoundedProviderProcessInternal(
  input: AnyBoundedProviderProcessInput,
): Promise<AnyBoundedProviderProcessOutcome> {
  assertBoundedProcessInput(input);
  const protocolParser = createDeclaredProtocolParser(
    declaredProtocolExecution(input),
  );
  const started = process.hrtime.bigint();
  if (input.signal?.aborted === true) {
    return Promise.resolve(
      Object.freeze({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnErrorCode: 'ABORT_ERR',
        elapsedMs: 0,
        stdout: '',
        stderr: '',
        terminationReason: 'cancelled' as const,
      }),
    );
  }

  return new Promise<AnyBoundedProviderProcessOutcome>((resolve) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let terminationReason: BoundedProviderProcessTermination | null = null;
    let spawnErrorCode: string | null = null;
    let outputBytes = 0;
    let retainedBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let cancelKillTimer: NodeJS.Timeout | undefined;
    let cancellationForced = false;
    let protocolError: WrapperProtocolError | null = null;
    let wrapperProtocolReceipt: ProviderWrapperProtocolReceipt | undefined;
    let wrapperSessionProtocolOutcome:
      ProviderWrapperSessionProtocolOutcome | undefined;
    let settled = false;

    const elapsedMs = () =>
      Number((process.hrtime.bigint() - started) / 1_000_000n);
    const emit = (
      type: BoundedProviderProcessActivity['type'],
      bytes?: number,
    ) => {
      try {
        input.onActivity?.({
          type,
          elapsedMs: elapsedMs(),
          ...(bytes === undefined ? {} : { bytes }),
        });
      } catch {
        // Activity observation must not gain process-control authority.
      }
    };
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // A process that already exited needs no further termination.
        }
      }
    };
    const terminate = (reason: BoundedProviderProcessTermination) => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      if (reason === 'cancelled') {
        killProcessGroup('SIGTERM');
        cancelKillTimer = setTimeout(() => {
          cancellationForced = true;
          killProcessGroup('SIGKILL');
        }, protocolCancelGraceMs(protocolParser));
        cancelKillTimer.unref();
      } else {
        killProcessGroup('SIGKILL');
      }
    };
    const retain = (
      target: Buffer[],
      chunk: Buffer,
      stream: 'stdout' | 'stderr',
    ) => {
      outputBytes += chunk.length;
      const remaining = input.maxOutputBytes + 1 - retainedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        target.push(retained);
        retainedBytes += retained.length;
      }
      emit(stream, chunk.length);
      if (
        stream === 'stdout' &&
        protocolParser !== null &&
        protocolError === null
      ) {
        try {
          protocolParser.parser.push(chunk);
          if (
            terminationReason === 'cancelled' &&
            !cancellationForced &&
            protocolParser.parser.hasNaturalTerminal()
          ) {
            terminationReason = null;
            if (cancelKillTimer !== undefined) {
              clearTimeout(cancelKillTimer);
              cancelKillTimer = undefined;
            }
          }
        } catch (error) {
          protocolError = normalizeProtocolError(error, protocolParser);
          spawnErrorCode = protocolError.code;
          terminate('protocol-error');
        }
      }
      if (outputBytes > input.maxOutputBytes) {
        terminate('output-limit');
      }
    };
    const onAbort = () => {
      let cancellationAdmitted = true;
      if (
        protocolParser !== null &&
        protocolError === null &&
        (terminationReason === null || terminationReason === 'cancelled')
      ) {
        try {
          cancellationAdmitted = protocolParser.parser.requestCancellation();
        } catch (error) {
          protocolError = normalizeProtocolError(error, protocolParser);
          spawnErrorCode = protocolError.code;
          terminate('protocol-error');
          return;
        }
      }
      if (!cancellationAdmitted) return;
      terminate('cancelled');
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => terminate('timed-out'), input.timeoutMs);
    timeout.unref();

    child.once('spawn', () => emit('spawned'));
    child.stdout.on('data', (chunk: Buffer) => retain(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => retain(stderr, chunk, 'stderr'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? 'SPAWN_FAILED';
      terminationReason ??= 'spawn-error';
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancelKillTimer !== undefined) clearTimeout(cancelKillTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (
        protocolParser !== null &&
        protocolError === null &&
        (terminationReason === null || terminationReason === 'cancelled')
      ) {
        try {
          if (protocolParser.protocol === 'harness-jsonl-v1') {
            wrapperProtocolReceipt = protocolParser.parser.finish({
              cancellationForced,
            });
          } else {
            wrapperSessionProtocolOutcome = protocolParser.parser.finish({
              cancellationForced,
            });
          }
        } catch (error) {
          protocolError = normalizeProtocolError(error, protocolParser);
          spawnErrorCode = protocolError.code;
          terminationReason = 'protocol-error';
        }
      }
      const reason =
        protocolError === null
          ? (terminationReason ?? 'exited')
          : 'protocol-error';
      const retainedStderr = Buffer.concat(stderr).toString('utf8');
      emit(reason);
      resolve(
        Object.freeze({
          exitCode,
          signal,
          timedOut: reason === 'timed-out',
          spawnErrorCode: reason === 'cancelled' ? 'ABORT_ERR' : spawnErrorCode,
          elapsedMs: elapsedMs(),
          stdout:
            protocolParser?.protocol === 'harness-jsonl-v2'
              ? ''
              : Buffer.concat(stdout).toString('utf8'),
          stderr:
            protocolParser?.protocol === 'harness-jsonl-v2'
              ? ''
              : retainedStderr,
          terminationReason: reason,
          ...(wrapperProtocolReceipt === undefined
            ? {}
            : { wrapperProtocolReceipt }),
          ...(wrapperSessionProtocolOutcome === undefined
            ? {}
            : { wrapperSessionProtocolOutcome }),
        }),
      );
    });

    child.stdin.once('error', () => {
      // EPIPE is reflected by the process close outcome; never convert it into
      // a second terminal event or an unhandled stream error.
    });
    child.stdin.end(input.stdinContent);
  });
}

function createDeclaredProtocolParser(
  execution:
    | ProviderWrapperProtocolExecution
    | ProviderWrapperSessionProtocolExecution
    | undefined,
): WrapperProtocolParser | null {
  if (execution === undefined) return null;
  if (execution.protocol === 'harness-jsonl-v1') {
    return Object.freeze({
      protocol: execution.protocol,
      parser: createProviderWrapperProtocolParser({
        binding: execution.binding,
        ...(execution.onFrame === undefined
          ? {}
          : { onFrame: execution.onFrame }),
      }),
    });
  }
  if (execution.protocol === 'harness-jsonl-v2') {
    return Object.freeze({
      protocol: execution.protocol,
      parser: createProviderWrapperSessionProtocolParser({
        binding: execution.binding,
        ...(execution.onFrame === undefined
          ? {}
          : { onFrame: execution.onFrame }),
        ...(execution.privateNativeSessionIdentitySink === undefined
          ? {}
          : {
              privateNativeSessionIdentitySink:
                execution.privateNativeSessionIdentitySink,
            }),
      }),
    });
  }
  throw new ProviderWrapperProtocolError();
}

function normalizeProtocolError(
  error: unknown,
  parser: WrapperProtocolParser,
): WrapperProtocolError {
  if (parser.protocol === 'harness-jsonl-v2') {
    return error instanceof ProviderWrapperSessionProtocolError
      ? error
      : new ProviderWrapperSessionProtocolError();
  }
  return error instanceof ProviderWrapperProtocolError
    ? error
    : new ProviderWrapperProtocolError();
}

function protocolCancelGraceMs(parser: WrapperProtocolParser | null): number {
  return parser?.protocol === 'harness-jsonl-v2'
    ? HARNESS_JSONL_V2_LIMITS.cancelGraceMs
    : HARNESS_JSONL_V1_LIMITS.cancelGraceMs;
}

function declaredProtocolExecution(
  input: AnyBoundedProviderProcessInput,
):
  | ProviderWrapperProtocolExecution
  | ProviderWrapperSessionProtocolExecution
  | undefined {
  const v1 = 'wrapperProtocol' in input ? input.wrapperProtocol : undefined;
  const v2 =
    'wrapperSessionProtocol' in input
      ? input.wrapperSessionProtocol
      : undefined;
  if (v1 !== undefined && v2 !== undefined) {
    throw new ProviderWrapperProtocolError();
  }
  return v2 ?? v1;
}

function assertBoundedProcessInput(
  input: AnyBoundedProviderProcessInput,
): void {
  if (!path.isAbsolute(input.executable) || !path.isAbsolute(input.cwd)) {
    throw new TypeError('Provider executable and cwd must be absolute paths.');
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes <= 0
  ) {
    throw new RangeError(
      'Provider process bounds must be positive safe integers.',
    );
  }
  if (!input.args.every((argument) => typeof argument === 'string')) {
    throw new TypeError('Provider arguments must be strings.');
  }
  const protocol = declaredProtocolExecution(input)?.protocol;
  if (
    protocol !== undefined &&
    protocol !== 'harness-jsonl-v1' &&
    protocol !== 'harness-jsonl-v2'
  ) {
    throw new ProviderWrapperProtocolError();
  }
}
