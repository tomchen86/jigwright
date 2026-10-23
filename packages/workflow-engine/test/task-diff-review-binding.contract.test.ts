import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  prepareTaskDiffReviewReservation,
  parseTaskDiffReviewReservation,
  prepareTaskDiffReviewResultBinding,
  parseTaskDiffReviewResultBinding,
  prepareTaskDiffReviewContinuationReservation,
  parseTaskDiffReviewContinuationReservation,
  prepareTaskDiffReviewContinuationResultBinding,
  parseTaskDiffReviewContinuationResultBinding,
  prepareTaskDiffFinalAssuranceBinding,
  parseTaskDiffFinalAssuranceBinding,
  prepareTaskDiffReviewLineageSupersession,
  parseTaskDiffReviewLineageSupersession,
} from '../src/modules/assurance/task-diff-review-binding-codec.ts';
import {
  bindingInputs,
  digest,
  goldenRecords,
} from './support/task-diff-review-binding-fixture.ts';

const inputs = bindingInputs();
const before = structuredClone(inputs);
const cases = [
  {
    name: 'reservation',
    prepare: () => prepareTaskDiffReviewReservation(inputs.reservation),
    parse: parseTaskDiffReviewReservation,
    key: 'reservationDigest',
  },
  {
    name: 'result',
    prepare: () => prepareTaskDiffReviewResultBinding(inputs.result),
    parse: parseTaskDiffReviewResultBinding,
    key: 'bindingDigest',
  },
  {
    name: 'continuationReservation',
    prepare: () =>
      prepareTaskDiffReviewContinuationReservation(
        inputs.continuationReservation,
      ),
    parse: parseTaskDiffReviewContinuationReservation,
    key: 'reservationDigest',
  },
  {
    name: 'continuationResult',
    prepare: () =>
      prepareTaskDiffReviewContinuationResultBinding(inputs.continuationResult),
    parse: parseTaskDiffReviewContinuationResultBinding,
    key: 'bindingDigest',
  },
  {
    name: 'finalAssurance',
    prepare: () => prepareTaskDiffFinalAssuranceBinding(inputs.finalAssurance),
    parse: parseTaskDiffFinalAssuranceBinding,
    key: 'bindingDigest',
  },
  {
    name: 'supersession',
    prepare: () =>
      prepareTaskDiffReviewLineageSupersession(inputs.supersession),
    parse: parseTaskDiffReviewLineageSupersession,
    key: 'supersessionDigest',
  },
] as const;

for (const { name, prepare, parse, key } of cases) {
  test(`${name}: pure preparation preserves original wire identity, exact shape, prototypes and frozen values`, () => {
    const record = prepare();
    assert.equal(Reflect.get(record, key), goldenRecords[name].digest);
    assert.deepEqual(parse(JSON.parse(JSON.stringify(record))), record);
    assertFrozen(record);
    assert.deepEqual(inputs, before);
    assert.deepEqual(parse(Object.assign(Object.create(null), record)), record);
    assert.throws(
      () => parse(Object.assign(Object.create({ inherited: true }), record)),
      storeError,
    );
    assert.throws(
      () => parse({ ...record, [key]: digest('different-digest') }),
      storeError,
    );
    assert.throws(
      () => parse(redigest(record, key, { unexpectedField: true })),
      storeError,
    );
    assert.throws(
      () => parse(redigest(record, key, { schemaVersion: 2 })),
      storeError,
    );
    const { kind: _kind, ...missingKind } = record;
    assert.throws(() => parse(redigest(missingKind, key, {})), storeError);
  });
}

test('recomputed record digests cannot detach embedded review facts from their bindings', () => {
  const reservation = prepareTaskDiffReviewReservation(inputs.reservation);
  assert.throws(
    () =>
      parseTaskDiffReviewReservation(
        redigest(reservation, 'reservationDigest', {
          changeId: 'another-change',
        }),
      ),
    storeError,
  );
  assert.throws(
    () =>
      parseTaskDiffReviewReservation(
        redigest(reservation, 'reservationDigest', {
          manifest: { ...reservation.manifest, sessionId: 'another-session' },
        }),
      ),
    storeError,
  );
  const result = prepareTaskDiffReviewResultBinding(inputs.result);
  assert.throws(
    () =>
      parseTaskDiffReviewResultBinding(
        redigest(result, 'bindingDigest', {
          roleResult: {
            ...result.roleResult,
            targetDigest: digest('another-subject'),
          },
        }),
      ),
    storeError,
  );
  const continuation = prepareTaskDiffReviewContinuationReservation(
    inputs.continuationReservation,
  );
  assert.throws(
    () =>
      parseTaskDiffReviewContinuationReservation(
        redigest(continuation, 'reservationDigest', {
          implementationActor: {
            ...continuation.implementationActor,
            providerId: 'claude',
          },
        }),
      ),
    storeError,
  );
  const continuationResult = prepareTaskDiffReviewContinuationResultBinding(
    inputs.continuationResult,
  );
  assert.throws(
    () =>
      parseTaskDiffReviewContinuationResultBinding(
        redigest(continuationResult, 'bindingDigest', {
          responseDigest: digest('another-response'),
        }),
      ),
    storeError,
  );
  const assurance = prepareTaskDiffFinalAssuranceBinding(inputs.finalAssurance);
  assert.throws(
    () =>
      parseTaskDiffFinalAssuranceBinding(
        redigest(assurance, 'bindingDigest', {
          subjectDigest: digest('another-subject'),
        }),
      ),
    storeError,
  );
  const supersession = prepareTaskDiffReviewLineageSupersession(
    inputs.supersession,
  );
  assert.throws(
    () =>
      parseTaskDiffReviewLineageSupersession(
        redigest(supersession, 'supersessionDigest', {
          successorReviewScopeDigest: digest('another-scope'),
        }),
      ),
    storeError,
  );
  assert.throws(
    () =>
      parseTaskDiffReviewLineageSupersession(
        redigest(supersession, 'supersessionDigest', {
          predecessorReviewRecordDigest:
            supersession.successorReviewRecordDigest,
        }),
      ),
    storeError,
  );
});

test('caller timestamps retain existing parsing while supersession stays session-free', () => {
  for (const { name, prepare, parse, key } of cases) {
    const record = prepare();
    if (name === 'supersession') {
      for (const field of ['createdAt', 'sessionId', 'generation']) {
        assert.equal(field in record, false);
        assert.throws(
          () =>
            parse(redigest(record, key, { [field]: 'not-part-of-lineage' })),
          storeError,
        );
      }
    } else {
      const changed = redigest(record, key, { createdAt: '2026-08-14' });
      assert.equal(Reflect.get(parse(changed), 'createdAt'), '2026-08-14');
      assert.notEqual(Reflect.get(changed, key), Reflect.get(record, key));
      assert.throws(
        () => parse(redigest(record, key, { createdAt: 'not-a-date' })),
        storeError,
      );
    }
  }
});

function redigest(
  record: object,
  key: string,
  changes: Record<string, unknown>,
) {
  const next = { ...record, ...changes };
  const semantic = Object.fromEntries(
    Object.entries(next).filter(([name]) => name !== key),
  );
  return { ...semantic, [key]: digest(canonicalJson(semantic)) };
}

function storeError(error: unknown): boolean {
  return (
    error instanceof WorkflowError &&
    error.code === 'TASK_DIFF_REVIEW_STORE_UNSAFE' &&
    error.message ===
      'TaskDiffReview durable state is missing, malformed, or unsafe.' &&
    error.exitCode === ExitCode.guard
  );
}

function assertFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertFrozen(nested);
}
